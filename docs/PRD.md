# PRD — xrp-zcode

## 产品目标

让 ZCode 的额度在 xrl-router 里变成一个**普通可路由的供应商**：客户端不必知道 ZCode、不必知道无痕验证、不必知道 JWT，只要知道一个模型别名。

登录方式唯一：**自包含网页 OAuth**（`pnpm run login`，浏览器授权 + 轮询取票），不需要安装 ZCode 桌面端，也不读取任何本地登录态文件。

## 用户与使用场景

- **目标用户**：已经在 xrl-router 里统一管理多个模型供应商、手上有一份 ZCode 额度（免费额度或 Coding Plan）的人。**默认服务国内用户**：登录与免验证码推理均走国内站 BigModel（`bigmodel.cn` / `open.bigmodel.cn`），国际站 Z.AI 需显式设置 `ZCODE_SITE=zai`。登录唯一走 `pnpm run login` 的自包含网页 OAuth，无需安装 ZCode 桌面端。
- **典型场景**：
  1. 在 CCSwitch / Claude Code / 任意 OpenAI 兼容客户端里，像调用其他模型一样调用 ZCode 提供的模型
  2. 把 ZCode 的额度挂进 xrl-router 的组合（combo）里，与其他供应商一起做故障转移
  3. 多个 ZCode 账号一起用——插件按 `.env` 里的凭证顺序做请求级故障转移，router 不再介入插件密钥

## 核心问题

ZCode 的上游是私有 Anthropic Messages 端点，且对 Coding Plan 凭证要求一个由阿里云「无痕验证」签发的请求头。结果是：

- 官方客户端之外**无法使用**这份额度
- 即使自己写转发，也要处理无痕验证（需要跑阿里云混淆 SDK 求参数）
- 社区已有的 `zcode2api` 把方案做成了独立网关，其密钥轮换 / 账号池 / 后台 UI 与插件的形态**重叠**，两份密钥池同步起来很难

## 功能及其意义

| 功能 | 解决什么 | 为什么需要 |
|------|----------|------------|
| 委托供应商注册（WS） | 让 router 认识这个上游 | 插件系统的接入方式；router 据此做路由、用量统计、provider 级故障转移 |
| Anthropic Messages 透传 | 桥接 ZCode 私有端点 | ZCode 上游就是 Messages 协议，注册同协议即可零转换 |
| 插件自持凭证 | V24 下 router 不再管理插件密钥 | 插件读 `.env` 的 `ZCODE_KEYS`，忽略 router 的占位凭证 |
| 凭证顺序故障转移 | 多账号可用性 | 401/402/403/429 顺延下一把，成功的一把粘滞 |
| 无痕验证参数供给 | Coding Plan 凭证的硬性要求 | 没有它，JWT 请求一律 400/403 |
| 验证码缓存 / 并发去重 / 重试 | 每个请求起一次 jsdom 求解不可接受 | 默认 45s TTL 内复用，进程内并发去重，偶发失败自动重试 |
| 凭证形态分流 | JWT 与 API Key 走不同端点 | JWT 走 Coding Plan 端点（需验证码），API Key 走回退端点 |
| 错误码如实透传 | 让 router 能判断 provider 可用性 | 5xx 触发 provider 冷却；4xx 透传给客户端 |
| 验证码失败转 502 | 区分「插件故障」与「provider 故障」 | 否则验证码一抖动，router 会把整个 provider 冷却 |
| 非流式聚合 | 兼容非流式客户端 | 上游一律流式请求，非流式由插件聚合 |
| 模型名归一化 | 上游模型名大小写敏感 | 客户端可以用好写的别名，上游拿到的是正确大小写 |
| 模型清单自动发现 | 上游模型集会变，硬编码必过期 | 零配置可用；用户想自定义别名时再用 `ZCODE_MODELS` 覆盖 |
| 自包含网页 OAuth 登录（唯一登录方式） | 拿免验证码凭证 | 默认国内站 BigModel：浏览器授权 → 轮询取票 → 兑换 `open.bigmodel.cn` API Key；`ZCODE_SITE=zai` 时走国际站；兑换失败回退 JWT（同一次登录产出） |
| 凭证体检脚本 | 判断凭证是否还有效/还有多少额度 | 排查「打不通」时先分清是凭证问题还是插件问题 |

## 功能之间的关系

```
pnpm run login（唯一登录入口）──写──▶ .env(ZCODE_KEYS)
                      │
pnpm serve ───────────┴──▶ 读自持凭证；register（无 keys）→ xrl-router
                      │
                      └──▶ 收到 /v1/messages → 选凭证 → 判定形态 → 取验证码 → 转发
                                                              │
pnpm capture-key ──读────────────────────────────────────────┘（独立，仅体检）
pnpm e2e ── mock 上游 + mock router，不依赖上面任何真实凭证
```

## 范围与非目标

**范围内**：转发、验证码、注册、登录（自包含网页 OAuth）、体检、离线自测、按配置顺序的凭证故障转移。

**范围外**：

- 完整密钥池 / 健康度表 / 额度统计 / 后台 UI —— zcode2api 的形态，不是插件
- 协议转换（OpenAI / Responses ↔ Messages）—— router 的 IR 层已有
- 多账号轮询与额度监控 —— 只做请求级顺序顺延，长期额度由使用者维护 `.env`
- 本地模型推理 —— 纯桥接
- App / 本地登录态导入 —— 登录唯一入口是自包含网页 OAuth，不读取 ZCode 桌面端或本地凭证文件
- 另计费的付费 API Key 购买 / 管理 —— 兑换出的是消耗订阅额度的 `zcode-api-key`
