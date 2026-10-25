# AGENTS.md — xrp-zcode

本文件为 AI Agent 划定项目边界。在本仓库工作时，必须遵守以下约束。

## 概述

`xrp-zcode` 是一个 **xrl-router 插件**：把 ZCode（`zcode.z.ai`）的额度包装成 OpenAI / Anthropic 兼容的本地服务，通过 WebSocket 注册为 router 的委托供应商。

注册形态：`kind: "messages"` + `api_path: "/v1/messages"`，默认端口 `19065`，`plugin_id` 为 `plugin-zcode`（V24 命名约定）。

凭证：**仅支持自包含网页 OAuth 登录**——唯一入口是 `pnpm run login`（浏览器授权 → 轮询取票 → 兑换站点 API Key），不依赖 ZCode 桌面端，也不读取或导入任何本地登录态 / 凭证文件。

## 边界与范围

### 范围内

- 代理 `POST /v1/messages`（Anthropic Messages 协议）到 ZCode 上游
- 自包含网页 OAuth 登录（唯一登录入口，不依赖 ZCode 桌面端）
- 注入 ZCode 业务头 + 阿里云无痕验证参数
- 凭证形态判定：三段点分 JWT → Coding Plan 端点；其余 → Z.AI 回退端点
- 插件自持凭证（`.env` 的 `ZCODE_KEYS`）：按顺序尝试，401/402/403/429 顺延下一把
- 上游错误码如实透传（供 router 的 provider 冷却 / failover 判定）
- 向 xrl-router 注册（V24：`plugin_id` / `provider` / `models` / `workdir`）+ 心跳
- `pnpm run login` 自包含网页 OAuth → 兑换站点 API Key（默认国内站 BigModel；兑换失败回退 JWT，仍来自同一次 OAuth）、`pnpm capture-key` 做凭证体检

### 非目标（明确排除）

- **不做协议转换** — 本插件注册 `kind=messages`，router 的 IR 层（`api/proxy/ir/`）已负责客户端三种协议 ↔ Messages 的双向转换。**不要**在插件里加 OpenAI ↔ Messages 的转换代码
- **不做本地模型推理** — 纯桥接，所有请求走 ZCode 远端
- **不做完整密钥池 / 额度统计 / 后台管理 UI** — 这些不是插件该有的形态。V24 起 router
  不再管理插件密钥，插件只保留「按 `ZCODE_KEYS` 顺序尝试 + 记住成功的一把」这一层最小故障转移
- **不做多账号轮询 / 额度监控 / 冷却恢复** — 不做成 zcode2api 那样的独立网关；
  请求级顺延已足够，长期额度管理交给使用者维护 `.env`
- **~~不做 api.z.ai 的 API Key 兑换~~**（已推翻，见 D-10/D-12）— 逆向官方客户端后发现，Coding Plan 额度的**官方用法**正是「OAuth access_token → 兑换长期 API Key → 免验证码推理」。所以 `scripts/login.ts` **默认就做这个兑换**，`src/zcode/exchange.ts` 是实现。被推翻的只是「兑换付费 API Key」这个旧顾虑——兑换出的是消耗订阅额度的 `zcode-api-key`，不是另计费的付费 key。**默认站点是国内站 BigModel（`ZCODE_SITE=bigmodel`）**，国际站 Z.AI 需显式设置
- **不实现非 Messages 端点** — `/v1/models`、`/v1/embeddings`、`/v1/chat/completions` 一律不加（模型清单经 WebSocket 注册推送）
- **不实现本地 HTTP 鉴权** — 本地网关默认只供 router / 本机使用；V24 下入站凭证（占位值 `xrl-router`）一律忽略，不据此鉴权
- **不读取 / 不导入 ZCode 桌面端或本地登录态** — 登录唯一入口是 `pnpm run login` 的自包含网页 OAuth；不要添加 App 登录态解密、本地数据库读取、凭证文件抓取等旁路

## Agent 操作指南

### 全局规则

- **包管理器：pnpm**（不要用 npm）。依赖走中国境内镜像（`.npmrc` 已配 npmmirror）
- **执行任何改动前先跑 `pnpm e2e`**了解基线；改完必须再跑一次且全绿
- **契约优先**：`pnpm e2e` 覆盖的是对外行为契约（协议透传、错误码映射、注册载荷）。改这些行为必须同步改断言
- **V24 契约**：`plugin_id` 固定为 `plugin-zcode`；register **不能带 `keys`**（带了 router 直接断开）、不发 `keys_update`、心跳只发 `{"type":"heartbeat"}`、register 带 `workdir`、Router 发占位凭证 `xrl-router`（插件用自身凭证访问上游）、`serve` 端口占用时 exit 0
- 提交遵循约定式提交（`feat:` / `fix:` / `docs:` / `chore:` / `test:`）

### 改代码前先看这几条设计判断

1. **为什么注册 `messages` 而不是 `chat_completions`** — 见 `src/zcode/client.ts` 顶部与 `docs/DECISIONS.md` D-1
2. **为什么错误码必须如实透传、唯独验证码失败要转 502** — 见 `src/zcode/client.ts` 顶部与 D-2
3. **为什么 V24 下凭证改由插件自持** — 见 `docs/DECISIONS.md` D-11
4. **为什么模型清单要分 `model_id` / `display_name`** — 见 `src/zcode/models.ts` 顶部与 D-4
5. **为什么默认国内站 BigModel 而不是国际站 Z.AI** — 国内用户优先；`ZCODE_SITE=bigmodel` 走 `bigmodel.cn` 授权、`open.bigmodel.cn` 推理。见 D-12
6. **为什么登录只保留自包含网页 OAuth** — 不依赖 ZCode 桌面端、不读取本地登录态；OAuth 后优先兑换 API Key。见 D-13

## 目录速查

```
src/
├── index.ts            Hono 入口：/、/health、POST /v1/messages、启动与优雅退出
├── config.ts           Settings 单例：全部环境变量只在这里读（含 ZCODE_SITE / ZCODE_KEYS）
├── port.ts             端口占用探测（占用时 exit 0，不杀进程）
├── pluginClient.ts     WS：注册（V24 无 keys）/ 心跳 / 指数退避重连
└── zcode/
    ├── client.ts       转发主流程：凭证选择与故障转移、错误映射、SSE 透传 / 非流式聚合
    ├── auth.ts         纯函数：凭证形态判定、按站点构造上游请求、错误分类
    ├── exchange.ts     OAuth access_token → API Key 兑换链（国内站 3 步 / 国际站 4 步）
    ├── configs.ts      上游 client/configs：验证码场景参数 + 模型清单自动发现（带缓存）
    ├── captcha.ts      验证码管理器：TTL 缓存 / 并发去重 / 重试
    ├── solver.ts       子进程调用求解器
    ├── aggregate.ts    Anthropic SSE → 单条 message JSON
    └── models.ts       模型清单解析与名称归一化

captcha/solver.cjs      jsdom 无痕验证求解器（移植自 zcode2api，子进程运行）

scripts/
├── login.ts            pnpm run login：自包含网页 OAuth → 兑换 API Key → 写入 .env（失败回退 JWT）
├── capture-key.ts      pnpm capture-key：只读体检 + 查额度
├── e2e.ts              pnpm e2e：离线端到端自测（mock 上游 + mock router）
├── envFile.ts          .env 读写与密钥安全闸
└── mock-solver.cjs     e2e 用的假求解器

docs/
├── PRD.md / ARCHITECTURE.md / DECISIONS.md
├── reverse/ZCODE_REVERSE.md
└── specs/module-*.md
```

## 密钥安全边界

- `.env` 永不进 git —— `git check-ignore .env` 必须通过（`scripts/envFile.ts` 里有强制闸）
- `.env.example` 必须可入库（只放占位符，不放真实凭证）
- 写 `.env` 的脚本一律先过 `assertEnvIgnored()`
- 日志与终端输出中的凭证一律脱敏（`maskSecret()`）
- 只从自己登录的账号取凭证

## 已知限制（不要尝试修复）

| 现状 | 为什么不要修 |
|------|-------------|
| **JWT 形态（路线 B）可能撞账号级 3012 风控** | F001 已通过硬化指纹桩攻破；当前阻塞是 ESA WAF 的账号/IP 维度 `3012 unusual activity`。**默认的 OAuth 兑换形态（路线 A）已绕开它**，见 D-10。不要在 jsdom 指纹桩或 TLS 伪装上继续无边界试错——先读逆向文档 6.7，向用户确认方向 |
| 兑换 key 的计费归属仍待对账 | 2026-10-20 国内站真实账号已验证：登录/`copy` 兑换成功、key 探活 200、推理端点返回套餐额度上限 `1310`（非 401），说明 key 已通过鉴权并绑定账户套餐额度；但尚无扣减明细，**不要**把「消耗订阅额度」写成面向用户的保证。见 D-12、逆向文档第 7 节 |
| 模型清单自动发现依赖上游接口 | 失败即降级到内置默认值，不阻塞；这是设计而非缺陷（D-8） |
| `client/configs` 不能带查询参数 | 上游行为，带上就 `parameter error`；已加 e2e 断言防回归 |
| 额度字段结构未充分实测 | 无长期可用账号验证，`capture-key` 已做防御性解析 |

## 给 AI Agent 的指引

### 必须拒绝的任务

1. **「把 API Key 通道删掉」** → 它是**默认主形态**（路线 A），删了等于删掉整个可用路径
2. **「在插件里加 OpenAI ↔ Messages 协议转换」** → Non Goal，router 的 IR 层已有
3. **「在插件里加账号轮询 / 额度统计 / 后台 UI」** → 不是插件形态；V24 只保留按配置顺序的最小故障转移，见 D-11
4. **「把完整密钥池 / 健康度系统写进插件」** → 会变成 zcode2api 那种独立网关；`.env` 列表 + 顺序顺延已经够用
5. **「无限期调 jsdom 指纹桩直到绕过风控」** → 先读 D-9/D-10，默认形态已绕开验证码，向用户确认方向再动手
6. **「把兑换失败静默吞掉」** → login.ts 必须回退存 JWT 并告警，不能让凭证凭空消失
7. **「给 register 加回 keys / keys_update」** → V24 router 会直接拒绝并断开
8. **「把登录改成读取 ZCode 桌面端 / 本地凭证文件」** → 登录唯一入口是自包含网页 OAuth；旁路导入登录态一律不做

### 允许的任务方向

- 增强 e2e 断言（尤其是错误码契约、注册契约、兑换链契约）
- 新增上游业务头 / 调整模型归一化规则
- 优化 WebSocket 重连策略
- 用真实订阅账号端到端验证路线 A（国内站 3 步兑换是否消耗订阅额度）——D-10/D-12 的头号待办
- 若路线 A 被真实账号证伪，再按 D-9 评估换真实无头浏览器（需用户明确同意依赖变更）
- 继续收紧「自包含网页 OAuth」的文档与断言（不新增 App / 本地登录态旁路）
