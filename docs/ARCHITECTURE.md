# ARCHITECTURE — xrp-zcode

## 系统概述

本插件是 xrl-router 的**委托供应商**：一个独立进程，对内暴露一个本地 HTTP 端点，对外通过 WebSocket 把自己登记进 router。

```
客户端（Claude Code / CCSwitch / 任意 OpenAI 兼容客户端）
   │  /v1/messages · /v1/chat/completions · /v1/responses
   ▼
xrl-router :19068
   │  ├─ IR 协议层：客户端协议 ↔ Anthropic Messages 双向转换
   │  ├─ 供应商故障转移 / 用量统计 / 组合（V24 起不再管理插件密钥）
   │  └─ 对插件恒发占位凭证
   │  HTTP POST http://localhost:19065/v1/messages
   │        头：x-api-key: xrl-router（占位，插件忽略）
   ▼
xrp-zcode (plugin-zcode) :19065
   │  ├─ 从 .env 的 ZCODE_KEYS 取凭证（顺序故障转移）
   │  ├─ 判定凭证形态（三段点分 JWT / 其他）
   │  ├─ JWT → 取无痕验证参数（jsdom 子进程求解，TTL 缓存）
   │  ├─ 装 ZCode 业务头
   │  └─ 流式透传 / 非流式聚合
   │  HTTPS POST
   ▼
zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages   （JWT，需验证码）
open.bigmodel.cn/api/anthropic/v1/messages           （国内站 API Key，默认）
api.z.ai/api/anthropic/v1/messages                    （国际站 API Key，ZCODE_SITE=zai）
   ▲
   └─ WebSocket /ws/plugin：register（无 keys，带 workdir）/ heartbeat
```

## 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 入口 | `src/index.ts` | Hono 应用、路由、启动横幅、优雅退出；导出 `createApp()` 供测试 |
| 配置 | `src/config.ts` | Settings 单例；所有环境变量只在这里读一次（含 `ZCODE_KEYS`） |
| 端口 | `src/port.ts` | 端口占用探测；占用时 `exit 0`，不杀占用者 |
| 插件客户端 | `src/pluginClient.ts` | WebSocket 注册（V24 无 keys）/ 心跳 / 指数退避重连 |
| 转发 | `src/zcode/client.ts` | 转发主流程：凭证选择与故障转移、验证码获取、错误映射、透传或聚合 |
| 凭证与请求构造 | `src/zcode/auth.ts` | 纯函数：`classifySecret` / `buildUpstreamRequest`（按站点选端点）/ `isCaptchaRejection` |
| OAuth 兑换 | `src/zcode/exchange.ts` | access_token → API Key：国内站 `bigmodel.cn` 3 步 / 国际站 `api.z.ai` 4 步 |
| 上游配置 | `src/zcode/configs.ts` | `client/configs`：验证码场景参数 + 模型清单自动发现（带缓存） |
| 验证码管理 | `src/zcode/captcha.ts` | 场景配置拉取（带回退）、TTL 缓存、并发去重、重试、`invalidate()` |
| 求解器调用 | `src/zcode/solver.ts` | 子进程调用 `captcha/solver.cjs`，超时强杀，解析 `VERIFY_PARAM=` |
| 求解器 | `captcha/solver.cjs` | jsdom 中加载阿里云 SDK，跑 `startTracelessVerification` |
| SSE 聚合 | `src/zcode/aggregate.ts` | Anthropic SSE 事件流 → 单条 message JSON |
| 模型清单 | `src/zcode/models.ts` | `ZCODE_MODELS` 解析（`模型ID=展示名`）、名称归一化 |

## 模块关系

- `index.ts` 只做装配：`createApp()` 建 Hono，路由把 `POST /v1/messages` 交给 `client.ts`
- `client.ts` 依赖 `auth.ts`（纯函数）、`captcha.ts`（有状态单例）、`aggregate.ts`
- `captcha.ts` → `solver.ts` → 子进程 `solver.cjs`：**单向、无回调**
- `pluginClient.ts` 与转发链路**完全解耦**——WS 断开不影响本地转发能力，反之亦然
- `config.ts` 被所有模块读、不被任何模块写；`models.ts` 的解析结果在 `config.ts` 里完成

## 数据流

### 一次流式请求（主路径）

```
1. router → POST /v1/messages  +  x-api-key: xrl-router（占位，忽略）
2. 从 settings.keys 取一把（上次成功的那把优先）
3. classifySecret → 若 JWT：captchaManager.getVerifyParam()   ← 命中缓存则零成本
4. buildUpstreamRequest → fetch（signal 绑定客户端连接）
5. 上游 2xx → 返回 Web ReadableStream，字节原样透传
6. 上游 401/402/403/429 → 换下一把凭证重试；其余非 2xx 见下表
```

### 错误映射（决定 router 的 provider 冷却 / failover）

| 上游响应 | 插件行为 | router 反应 |
|----------|----------|-------------|
| 2xx | 透传 / 聚合 | 成功 |
| 401 / 403（非验证码）/ 402 / 429 | 先换下一把凭证；全部耗尽后原样透传最后一个状态码 | 透传错误（占位密钥无健康黏性） |
| 403 / 400 + captcha 关键字 | 刷新验证码重试；连续 `MAX_CAPTCHA_REFRESH`(3) 次仍失败 → **502** | 5xx 触发 provider 冷却 60s |
| 5xx | 原样透传 | provider 冷却 60s |

### 无痕验证求解

```
captchaManager.getVerifyParam()
  ├─ 缓存命中（TTL 45s）→ 直接返回
  └─ 未命中 → inflight 去重 → fetchSceneConfig()
                                ├─ 成功 → 缓存 600s
                                └─ 失败 → 回退 env/内置默认值，负缓存 60s
                              → spawn node captcha/solver.cjs <scene> <region> <prefix>
                                ├─ jsdom + 浏览器 API 桩（matchMedia/canvas/WebGL/Worker/OffscreenCanvas）
                                ├─ 加载 o.alicdn.com 的 AliyunCaptcha.js
                                └─ initAliyunCaptcha → success 回调 → stdout: VERIFY_PARAM=...
                              → 写缓存
```

### 登录链路（唯一入口）

```
pnpm run login
  ├─ POST {ZCODE_OAUTH_BASE}/oauth/cli/init（Bearer 本地随机 poll token）
  ├─ 浏览器授权（默认 bigmodel.cn；ZCODE_SITE=zai 时 chat.z.ai）
  ├─ GET {ZCODE_OAUTH_BASE}/oauth/cli/poll/{flow_id} 轮询至 ready
  ├─ resolveCodingPlanApiKey(access_token)：国内站 3 步 / 国际站 4 步
  └─ 写入 .env 的 ZCODE_KEYS（优先 API Key；兑换失败回退 JWT）
```

这是本插件**唯一**的登录链路：不依赖 ZCode 桌面端，不读取 App 登录态、本地数据库或凭证文件。登录完成后，运行时只消费 `.env` 里由这次 OAuth 产出的凭证。

## 外部系统

| 系统 | 用途 | 失败时的行为 |
|------|------|-------------|
| xrl-router `/ws/plugin` | 注册、心跳 | 指数退避重连（1s → 最大 60s）；本地转发不受影响 |
| `zcode.z.ai` 推理端点 | JWT 形态的主上游 | 按上表映射 |
| `open.bigmodel.cn` 推理端点 | 国内站 API Key 形态的默认上游（免验证码） | 按上表映射 |
| `bigmodel.cn/api/biz/*` | 国内站 OAuth 兑换链（仅 `pnpm run login`，唯一登录入口） | 兑换失败 → 回退存 JWT 并告警 |
| `zcode.z.ai/api/v1/client/configs` | 拉验证码场景参数 | 回退内置默认值并负缓存 |
| `zcode.z.ai/api/v1/zcode-plan/*` | 额度 / 套餐 / 用量查询 | 仅 `pnpm capture-key` 使用，失败只影响体检输出 |
| `api.z.ai` 推理端点 | 国际站 API Key 形态的上游（`ZCODE_SITE=zai`） | 按上表映射 |
| `o.alicdn.com` | 阿里云无痕 SDK | 求解失败 → 重试 → 502 |

## 重要技术边界

1. **插件不做协议转换。** 注册 `kind: "messages"` 是刻意的：router 的 IR 层已经把三种客户端协议与 Messages 互转，插件再做一次是重复且易错。见 `DECISIONS.md` D-1。
2. **V24 下凭证由插件自持。** Router 只发占位凭证，插件用 `.env` 的 `ZCODE_KEYS` 访问上游；多把凭证按顺序顺延，成功的一把粘滞。不建完整密钥池 / 健康度系统，见 D-11。
3. **验证码求解在子进程。** jsdom 需要 `runScripts: 'dangerously'` 跑混淆 SDK，隔离出去才能超时强杀、崩溃不污染主进程，见 D-3。
4. **上游一律按流式请求。** 非流式客户端由插件聚合，避免依赖上游的非流式行为是否可用，见 D-5。
5. **登录只有自包含网页 OAuth 一条链路。** 唯一入口是 `pnpm run login`：浏览器授权 + 轮询取票 + 兑换 API Key；不依赖 ZCode 桌面端，不读取本地登录态。见 D-13。
