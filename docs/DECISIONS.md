# DECISIONS

> 本文件记录关键设计决策背后的**历史原因**，防止架构漂移。
> 每条决策回答的是「为什么」而非「怎么做」。

---

## D-1: 为什么注册 `kind: "messages"` 而不是 `chat_completions`？

**背景**：qwenwork 插件注册的是 `kind: "openai"`（router 归一为 `ChatCompletions`），并在插件里做「解包外层 SSE envelope → 重组 tool_calls 分片」的转换工作。照抄那条路似乎是默认选择。

**观察**：ZCode 上游**本身就是 Anthropic Messages 端点**。同时 router 已实现完整 IR 协议层（`api/proxy/ir/`）：

- 请求方向：客户端三种协议 → IR → 按 `provider_kind` 渲染成上游格式（`stream.rs:288`）
- 响应方向：上游 SSE → 按 `provider_kind` 解析 → IR → 渲染回客户端格式（`forward.rs:175`）
- `provider_kind == "messages"` 时 router 注入 `x-api-key` + `anthropic-version: 2023-06-01`（`stream.rs:308`）

**决策**：注册 `kind: "messages"`、`api_path: "/v1/messages"`，插件**原样透传字节流**。

**收益**：

- 插件零协议转换代码——整个 `zcode/client.ts` 的转发部分是纯 I/O
- 不会出现「router 转了、插件又转一遍」的双重转换 bug
- 客户端可以用 Anthropic / OpenAI / Responses 任意协议调用，转换责任单一归属 router

**为什么不选 `chat_completions`**：那等于让插件把上游的 Messages SSE 反解成 Chat Completions，再由 router 转回客户端格式——一次无谓的往返，且 tool_calls 分片重组在 qwenwork 里已被证明容易出错（见其 `client.ts` 的 `seenToolCallIndex` 逻辑）。

**何时重新审视**：若将来需要暴露非 Messages 的上游语义（例如 ZCode 上线了独立的 Chat Completions 端点且行为不同）。

---

## D-2: 为什么错误码如实透传，唯独验证码失败要转 502？

**背景**：插件需要把上游错误上报给 router，而 router 会据此改变密钥池状态。

**证据**：`src-tauri/src/api/proxy/key_rotation.rs`：

```rust
401 | 403 => { pool.mark_key_invalid(provider_id, key); }   // 标红
402 | 429 => { pool.mark_key_low_quota(provider_id, key); } // 标黄
// 5xx 与其余 4xx 不触碰密钥池
```

**决策**：分两类处理。

1. **凭据级错误如实透传**（401 / 402 / 403 非验证码 / 429）——这正是 router 用来轮换密钥的信号。插件不做任何「聪明」的改写，否则账号轮换（比如第二个账号还有额度）就不会发生。
2. **验证码失败转 502**——上游对无痕验证问题返回 `403 + captcha 关键字`。若原样透传，router 会把一把完全有效的 JWT 标红；而实际故障在插件侧的求解链路。因此插件先内部刷新重试（`MAX_CAPTCHA_REFRESH = 3`），仍失败则返回 **502**——5xx 不触碰密钥池，语义正确。

**代价**：若某个上游真的用「403 + 含 verify 字样」表达凭证失效，会被我们误判为验证码问题，重试 3 次后返回 502，router 不标红而只是重试。这个方向上我们**刻意偏向「不误伤好密钥」**。

> **V24 补注（2026-10）**：router 已不再为插件管理密钥，也不会因插件返回 401/403 去标红任何东西。
> 但「错误码如实透传」仍然保留，因为 router 的 provider 级 failover / 冷却依赖 5xx 与 4xx 的区分；
> 验证码失败继续映射 502，避免一次求解抖动被当成 provider 故障。

**何时重新审视**：若观测到 ZCode 的凭证失效错误体里确实带 captcha/verify 字样。

---

## D-3: 为什么验证码求解器是子进程，而不是 in-process？

**背景**：求解器需要在 jsdom 里以 `runScripts: 'dangerously'` 加载阿里云官方混淆 SDK（53 行，移植自 zcode2api）。

**考虑过的方案**：

- **in-process `new JSDOM()`**——省一次进程 spawn，但混淆 SDK 崩溃会带走插件主进程，且无法用超时强杀
- **子进程 `spawn('node', ['captcha/solver.cjs', ...])`**——每次求解一次进程启动开销（~百毫秒级）

**决策**：子进程。

**原因**：求解天然是「可能失败、可能挂死」的操作，而它处在请求主路径上。隔离换来的性质更值钱：

- 单次求解可以被 `ZCODE_CAPTCHA_TIMEOUT`（默认 40s）强杀
- SDK 崩溃只丢一次求解，不丢整个插件
- 求解器可以用一个假脚本整体替换（`ZCODE_SOLVER_PATH`），这正是 `pnpm e2e` 能做到离线全绿的前提

**代价**：每次求解多一次进程启动。但求解有 45s TTL 缓存 + 并发去重，频率是「每分钟约一次」而非「每请求一次」，开销可忽略。

---

## D-4: 为什么模型清单要分 `model_id` 与 `display_name`？

**背景**：ZCode 上游的模型名**大小写敏感**（社区文档记录为 `GLM-5.2` / `GLM-5-Turbo`），而客户端喜欢写 `glm-5.2`。

**证据**：router 用 `display_name` 匹配客户端请求，然后把 `model_id` 填进上游请求体：

```rust
// api/proxy/stream.rs
obj.insert("model".to_string(), json!(cand.real_model_id));
```

**决策**：`ZCODE_MODELS` 支持 `模型ID=展示名` 语法。

> 清单**内容**从哪来见 D-8（显式配置 → 自动发现 → 内置默认值）。

```
ZCODE_MODELS=GLM-5.2=glm-5.2,GLM-5-Turbo
```

- `model_id` = 上游接受的形式（原样透传，不做大小写改写）
- `display_name` = 客户端调用的别名（省略则等于 `model_id`）

同时 `canonicalModelId()` 在插件侧做归一化：精确匹配 → 忽略大小写匹配 modelId → 忽略大小写匹配 displayName → 剥离 `provider/` 前缀后重试。这样直连插件（绕过 router）的调用也能用任意写法。

**为什么不统一成小写**：上游大小写敏感，改写上游名等于制造 404。保留原样才是安全的默认。

---

## D-5: 为什么上游一律按 `stream: true` 请求？

**背景**：`xrl-router` 无论客户端是否流式，都强制 `stream: true` 发上游（`stream.rs` 与 `non_stream.rs` 都是 `obj.insert("stream", json!(true))`），再自己聚合。

**决策**：插件沿用同一策略——**无条件向上游要流式**，客户端要非流式时由 `aggregate.ts` 聚合 SSE。

**原因**：

- 与 router 的行为一致，避免「router 要流式、插件却发了非流式」的错配
- 上游的非流式行为未被充分验证，流式是社区已验证的路径（zcode2api 全程流式）
- 少一条依赖上游行为的代码分支

**代价**：非流式请求要多走一次 SSE 聚合。但 router 发来的请求永远是 `stream: true`，这条路径只对直连调用有意义。

---

## D-6: 为什么不做 zcode2api 那套后台 UI / 账号池？

**背景**：社区项目 `zcode2api` 是独立网关，带 SQLite 账号池、round-robin 轮询、额度监控、后台管理 UI、Docker 部署。看起来「功能更全」。

**决策**：不照搬。插件只做 xrl-router 缺的那一层。

**原因**：那些能力在 xrl-router 里**已经存在且更成熟**：

| zcode2api 的能力 | xrl-router 的对应物 |
|------------------|---------------------|
| 多账号 round-robin | 密钥池轮换（`api/proxy/key_rotation.rs`） |
| 额度用完自动换号 | 402/429 → 标记 → 换下一把 key |
| 限流冷却后恢复 | `api/proxy/failover.rs` 的 provider cooling |
| 用量监控 | `usage_log` 表 + 用量统计模块 |
| 后台鉴权 / 管理 UI | router 的密钥管理界面 |

把账号池放进插件会制造**两份互相不同步的密钥池**——这正是 qwenwork 项目在 D-1 里踩过的坑（旧架构自带 key pool，与 router 重复，同步困难，最终整体删掉）。

**边界**：`ZCODE_KEYS` 支持多个逗号分隔凭证，但插件**只是把它们推给 router**，自己从不选择用哪一把。

> **V24 补注（2026-10）**：router 已把手伸回去了——V24 起插件密钥由插件自持，register 带 `keys` 会被
> 直接拒绝。本条关于「插件不建完整密钥池」的结论仍成立，但「推给 router / 自己从不选择」已过时，
> 见 D-11。

---

## D-7: 为什么密钥的权威来源是 `.env` 文件，而不是进程环境变量？

**背景**：插件用 5s 轮询 `.env` 发现密钥变化，再 `keys_update` 推给 router。

**决策**：以 `.env` 文件为权威来源；文件里没写时才回退 `process.env`。

**原因**：

- **可热更新**：进程环境变量在启动后无法改变，改密钥必须重启插件。`.env` 轮询让 `pnpm run login` 写完就能立刻生效
- **与环境变量不冲突**：回退分支保证容器 / CI 里直接注入 `ZCODE_KEYS` 也能工作

**没选 `fs.watch`**：跨平台行为不一致（inotify vs FSEvents vs ReadDirectoryChangesW），且需要额外处理编辑器写文件的中间态。5s 轮询的开销是「每 5 秒读一个 <1KB 文件」，与 qwenwork 的项目决策一致。

> **V24 补注（2026-10）**：5s 轮询与 `keys_update` 已随 V24 一起删除（router 收到 `keys_update`
> 会直接断开）。`.env` 仍是唯一权威来源，但改动只在进程启动时读取——`pnpm run login` 之后需要重启插件。
> 用可接受的一次重启换取「不用维护两条密钥同步通道」，见 D-11。

---

## D-8: 为什么模型清单要自动发现，而不是硬编码？

**背景**：最初的设计是硬编码默认模型清单（`GLM-5.2,GLM-5-Turbo`，抄自社区文档），由用户用 `ZCODE_MODELS` 覆盖。

**问题**：2026-09 实测发现那份清单**已经过期**——上游 `client/configs` 的 `builtinModels` 现在是 `GLM-5.3` / `GLM-5.3-Flash`。硬编码的清单必然随上游迭代而失效，用户会看到「模型注册了但调不通」。

**决策**：三级优先。

```
ZCODE_MODELS 显式配置  >  启动时从 client/configs 的 builtinModels 自动发现  >  内置默认值
```

**收益**：

- 零配置可用：不写 `ZCODE_MODELS` 也能注册出正确的模型
- 顺手复用了验证码本来就要调的那个接口（`configs.ts` 统一缓存），没有新增网络依赖
- 自动发现失败时静默降级到内置默认值，不阻塞启动

**为什么只取 `builtinModels` 不取 `providers[].models`**：后者是「自带 API Key」通道的清单（含 `GLM-5.2`/`GLM-5-Turbo`），混进来会注册出套餐里其实用不了的模型。

**代价**：启动多一次网络请求（5s 超时，失败即降级）。

---

## D-9: 无痕验证被风控拒绝（F001）——为什么保留现状而不引入真实浏览器

**背景**：D-3 决定求解器用 jsdom 跑阿里云 SDK。2026-09-22 实测发现：链路全通（SDK 加载 → 发起设备指纹请求 → 拿到 `certifyId`），但阿里云风险判定为
`{"success":true,"verifyResult":false,"verifyCode":"F001"}`——**F001 = 疑似攻击请求，风险策略不通过**。

试过 UA 伪装、`navigator.webdriver=false`、`window.chrome` / `screen` / canvas / WebGL 指纹桩、把 region 从过期的 `sgp` 改成上游公布的 `cn`：**全部仍是 F001**。

**考虑过的方案**：

| 方案 | 代价 | 判断 |
|------|------|------|
| 继续调 jsdom 指纹桩 | 无确定收敛路径，阿里云风控是异地黑盒 | ✗ |
| 换成真实无头浏览器（Playwright/Puppeteer） | Chromium ~150MB 依赖；插件从「轻量桥接」变成「带浏览器」；风控同样可能识别无头特征 | 留作备选 |
| 让用户手工提供 verifyParam | 该参数有时效性（社区实现按 45s 缓存），手工粘贴不可用 | ✗ |
| 保留现状 + 如实记录 + 把 API Key 回退通道保留 | 无额外成本 | ✓ |

**决策**：保留 jsdom 求解器（它对 API Key 路径无害，且一旦上游放开风控即可自动开始工作），
**把 F001 作为已知限制明确写进 README / AGENTS / 逆向文档**，并保留 `api.z.ai` 回退通道作为可用出口。

**为什么不做「假装能跑」**：一个静默失效的验证码链路比一个已知失效的更好看、但更糟——用户会花大量时间排查自己的账号。

**何时重新审视**：若使用者提供真实账号并愿意承担 Playwright 依赖 → 换真实浏览器；
或若上游 `builtinProviders` 里 `builtin:zai-coding-plan`（`baseUrl: https://api.z.ai/api/anthropic`）
那条「套餐凭证走 api.z.ai、无需验证码」的路线被证实可行 → 直接删掉整个求解器。

> **后续实测补注（2026-09-22）**：F001 已被「硬化指纹桩 + 每次求解间隔 ≥10–15s」突破
> （4/5 次成功）。当前阻塞已变为 ESA WAF 的**账号/IP 维度** `3012 unusual activity`，
> 与 jsdom 指纹无关。见 `docs/reverse/ZCODE_REVERSE.md` 6.7。结论不变：优先路线 A，
> 不要在指纹桩上继续无边界试错。

---

## D-10: 改走「OAuth 兑换 API Key」官方路线，绕开无痕验证（承接 D-9 的出路）

**背景**：D-9 结尾留了一条出路——若 `builtin:zai-coding-plan` 的免验证码路线成立，就删掉整个求解器。
本机装有 ZCode 桌面端，直接逆向它的打包产物拿到了**决定性证据**。

**逆向来源**：`%LOCALAPPDATA%/Programs/ZCode/resources/glm/zcode.cjs`（14MB 打包 bundle）。
关键函数：`createZaiCliOAuthClient`（OAuth）、`createCodingPlanApiKeyResolver`（兑换）、
`resolveZaiBizToken`、`resolveBizApiKey`、`pickOrgAndProject`。

**逆向出的官方真实链路**：

```
OAuth 授权 → poll ready 返回 { token: JWT, zai: { access_token } }
  ↓ 用 access_token（不是 JWT！）
POST api.z.ai/api/auth/z/login {token}                    → biz token
GET  api.z.ai/api/biz/customer/getCustomerInfo            → 默认机构 / 默认项目
GET/POST api.z.ai/.../organization/{o}/projects/{p}/api_keys  找/建 "zcode-api-key"
GET  .../api_keys/copy/{apiKeyId}                         → secretKey
  ⇒ 长期密钥 `${apiKeyId}.${secretKey}`
  ↓
POST api.z.ai/api/anthropic/v1/messages   x-api-key: apiKeyId.secretKey   ★ 无无痕验证
```

**决定性事实**：

1. 官方（国际站）对 Coding Plan 额度走的是 **api.z.ai**，不是 zcode-plan + 无痕验证。`builtinProviders`
   里 `builtin:zai-coding-plan` 的 `baseUrl` 正是 `https://api.z.ai/api/anthropic`，闭环。
2. 无痕验证（`X-Aliyun-Captcha-Verify-Param`）在 bundle 里只绑定 `{plan_id}` 的**套餐激活**请求，
   以及 zcode-plan provider 的可选 runtime headers——**不在推理主路径**。
3. 兑换链 4 个端点用假 token 实测**全部存活**（z/login→`code:500`、getCustomerInfo→`code:1001`/`401`）。

**决策**：`pnpm run login` 默认走兑换链，把 OAuth `access_token` 换成 `apiKeyId.secretKey` 存进
`.env`。转发层**无需改动**——`classifySecret` 早已把「非三段点分」判为 apiKey，自动走
`ZAI_FALLBACK_URL`（api.z.ai）免验证码分支。兑换失败时回退存 JWT（路线 B）并告警。

**为什么这样最优**：

- 转发层零改动，改动面收敛在 `login.ts` + 新增 `exchange.ts`
- 运行时**零客户端依赖**——兑换链是纯 HTTP，逆向只是用来搞清楚协议，最终产物不需要装 ZCode
- 绕开了整个 F001 死结，不引入 Chromium 依赖
- 与官方行为一致，上游改版的抗性比自建验证码方案强

**为什么不删求解器**：路线 B（JWT）仍保留为兜底——万一某账户兑换不出 key（无默认机构/项目），
还能退回 JWT。求解器代码留着，一旦阿里云放开风控即自动可用。这与 AGENTS.md「不删 API Key 回退通道」
是同一种保守取向。

**仍未确证的一环（诚实标注）**：「兑换出的 `apiKeyId.secretKey` 消耗的确实是 Coding Plan **订阅额度**
而非另计的 API 余额」——这一点逆向只能证明**官方这么用**，无法证明计费归属。需要一个真实订阅账号
端到端跑通才能确认。见 `docs/reverse/ZCODE_REVERSE.md` 第 7 节，已列为头号待验证项。

**何时重新审视**：真实账号验证后，若确认兑换 key 走的不是订阅额度 → 退回 D-9 的路线 B 攻坚；
若确认是订阅额度 → 可考虑把求解器与 zcode-plan 分支整体降级为可选/删除。

> **后续补注（2026-10-20）**：默认站点已改为国内站 BigModel。D-10 描述的是国际站 Z.AI 的
> 4 步兑换链；国内站是 3 步（access_token 直接作 Bearer），见 D-12。

---

## D-11: 迁移到 xrl-router V24 插件契约 —— 凭证改由插件自持

**背景**：插件初版是照 qwenwork 旧架构做的：Express + 注册时把 `ZCODE_KEYS` 作为 `keys` 推给
router、每 5s 轮询 `.env` 发 `keys_update`、请求时从入站 `x-api-key` 取真实凭证。之后 router
升级到 **V24**：插件密钥职责整体剥离给插件方，register 带 `keys` 会被**严格拒绝并断开**，
router 对插件请求恒发占位凭证 `xrl-router`。照旧跑的结果是每一条推理请求都拿 `xrl-router`
去打上游，必然 401。

**决策**：按 V24 契约重写接入层。

1. **HTTP 框架 Express → Hono**（`@hono/node-server`），SSE 直接返回 Web `ReadableStream`。
2. **register 去掉 `keys`，增加 `workdir`**；删除 `keys_update` 与 `.env` 轮询。
3. **凭证由插件自持**：启动时读 `.env` 的 `ZCODE_KEYS`，请求时按顺序尝试；成功的一把记住，
   401/402/403/429 顺延下一把，全部失败后透传最后一个状态码。
4. **入站凭证一律忽略**（包括 router 的占位值），不再从请求头取 key。
5. **端口幂等**：端口被占用时 `exit 0`，不再 taskkill/lsof 杀掉占用者。

**为什么不照抄 qwenwork 的端口处理**：qwenwork 仍保留「启动前杀占用者」的旧做法，与 V24
`serve` 幂等契约冲突；router 的伴生启动会先做 TCP 探测，杀进程反而可能打断用户手动启动的实例。

**为什么保留最小故障转移**：V24 把密钥管理整体推给插件后，`ZCODE_KEYS` 的多凭证语义若只取第一把，
等于悄悄丢弃其余配置。顺序顺延 + 成功粘滞是能维持「多账号可用」的最小子集，不引入健康度表、
额度监控或后台 UI。

**代价**：

- `.env` 改动不再热生效——`pnpm run login` 后需重启插件（router 伴生启动会负责重启）
- 多凭证只有请求级顺延，没有冷却、配额耗尽换号等策略
- 验证码失败不做跨凭证顺延：无痕验证是账号维度问题，换 key 往往只是多烧一次求解

**何时重新审视**：若 router 重新把插件密钥纳入密钥池（当前无此计划），或真实账号证明
验证码失败换账号能稳定自愈。

---

## D-12: 默认站点改为国内站 BigModel —— 国内用户优先

**背景**：明确要求「务必优先服务国内用户，登录站点必须是中国站」。初版默认走国际站
Z.AI（授权 `chat.z.ai`、推理 `api.z.ai`），对中国大陆用户不友好；智谱的国内官方入口是
BigModel（`bigmodel.cn` / `open.bigmodel.cn`）。

**证据（2026-10-20 实测 + 本机 bundle 逆向）**：

1. `POST https://zcode.z.ai/api/v1/oauth/cli/init`（Bearer poll token）按 body 里的
   `provider` 返回不同授权页：
   - `{"provider":"bigmodel"}` → `https://bigmodel.cn/login?appId=zcode&redirect=https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel&state=…`
   - `{"provider":"zai"}` → `chat.z.ai`
2. OAuth ready 载荷按 provider 分键：`data.bigmodel.access_token` / `data.zai.access_token`，
   另有 `data.token`（Coding Plan JWT）。
3. 官方 bundle 的 `resolveCodingPlanApiKey` 按 provider 分支：国际站先
   `POST api.z.ai/api/auth/z/login` 换 biz token；**国内站直接把 OAuth `access_token` 作为
   业务凭证打 `bigmodel.cn/api/biz/*`**，没有 z/login。
   注：本机 3.5.3 bundle 已改用 `/api_keys/{id}/access_tokens` 换**短时项目 token**；
   旧链路的 `/api_keys/copy/{id}`（返回长期 `secretKey`）在两个站点仍存活（假 token → 401）。
   本插件采用 `copy`，因为它能产出适合静态 `.env` 的长期密钥，而项目 token 需要运行时刷新。
4. `GET https://bigmodel.cn/api/biz/customer/getCustomerInfo` 用假 token → `401 token expired or incorrect`（端点存活，鉴权语义与 Z.AI 一致）。
5. `client/configs` 的 `builtinProviders` 含 `builtin:bigmodel-coding-plan`，`baseUrl` 为
   `https://open.bigmodel.cn/api/anthropic`；假 key 打 `/api/anthropic/v1/messages` → `401`。
6. `https://open.bigmodel.cn/api/paas/v4/models` 假 key → `401`，与
   `api.z.ai/api/paas/v4/models` 行为一致，可作探活端点。
7. 当前 bundle 对 BigModel 的 `getCustomerInfo` / `api_keys` 发**裸** `Authorization`
   （不带 `Bearer`），对 Z.AI 的 `api_keys` 才发 `Bearer`。实测两种前缀在 BigModel 上都返回
   同样的 `401 令牌已过期或验证不正确`，无法用假 token 区分；本插件统一用 `Bearer`，
   这一差异留待真实账号验证（见逆向文档第 7 节）。

**决策**：

- `ZCODE_SITE` 默认 `bigmodel`；`login` 的 init body 用该值，ready 取 `data[site].access_token`。
- 国内站兑换走 3 步，`access_token` 直接作 Bearer，base = `BIGMODEL_API_BASE_URL`
  （默认 `https://bigmodel.cn`）。
- 国内站 API Key 推理走 `BIGMODEL_ANTHROPIC_URL`
  （默认 `https://open.bigmodel.cn/api/anthropic/v1/messages`），只带 `x-api-key`，
  **不带** ZCode 身份头（标准 Anthropic 兼容端点）。
- 国内站探活走 `open.bigmodel.cn/api/paas/v4/models`。
- `ZCODE_SITE=zai` 保留原国际站行为（4 步兑换 + `api.z.ai` + ZCode 身份头）。

**为什么不做域名自动探测**：站点是账户归属问题，不能靠网络可达性猜；显式 `ZCODE_SITE`
让凭证与站点一一对应，避免把国内站 access_token 误发到国际站。

**代价**：多一组环境变量与分支；e2e 需同时覆盖 3 步与 4 步兑换链（已覆盖）。
两个站点的 JWT 主端点仍共用 `zcode.z.ai`。

**真实账号验证（2026-10-20）**：`pnpm run login` 在国内站完成 OAuth，`/copy` 链路成功
产出 49 字符的 `apiKeyId.secretKey`；`pnpm capture-key` 探活
`open.bigmodel.cn/api/paas/v4/models` → **200**；通过插件发真实推理请求，上游返回
`429 code:1310「您已达到每周/每月使用上限」`（重置时间 **2026-10-22 11:23:27**），而非 401。

这证明了两件事：

1. **旧 `/copy` 兑换链在真实 BigModel 账号上仍然可用**——此前「新版 bundle 已改用
   `/access_tokens`，旧端点是否还能产出长期 secretKey」的疑问已解决。
2. **兑换 key 能通过 BigModel 鉴权，并受账户套餐额度约束**。额度耗尽返回的是套餐上限
   而非 API 余额不足，这是「消耗订阅额度」的强证据；但正式扣减明细仍需对账。

**仍未确证**：额度重置后的成功生成、以及额度扣减是否落在 Coding Plan 套餐上（需
`billing/balance` 前后对比）。留待 2026-10-22 后复测。

**何时重新审视**：若复测发现扣减走的是另计 API 余额，回到 D-10 的结论重新评估；
若 BigModel 兑换链在真实账号上失效，可切回 `ZCODE_SITE=zai`，或依赖 `login` 的 JWT 兜底。

## D-13: 更名为 xrp-zcode，登录方式收敛为自包含网页 OAuth

**背景**：项目从旧项目名升级为 `xrp-zcode`。新定位只有一句话：**登录唯一走自包含网页 OAuth**——不依赖 ZCode 桌面端，不读取本地登录态。旧名散落在 `package.json`、README / AGENTS / docs 标题、注册用的 `plugin_id` 以及脚本日志里。

**决策**：

- 项目名统一为 `xrp-zcode`：`package.json`、README、AGENTS、docs 标题与 `.env.example` 头注释。
- `plugin_id` 改为 `plugin-zcode`，对齐 V24 的 `plugin-<name>` 命名约定（与 `plugin-qwenwork` / `plugin-workbuddy` 一致）。
- 登录唯一入口固定为 `pnpm run login`：OAuth init → 浏览器授权（默认 `bigmodel.cn`）→ 轮询 ready → 兑换站点 API Key → 写入 `.env`。
- 不新增 App 登录态解密、本地数据库读取、凭证文件抓取等旁路。兑换失败回退 JWT 仍来自**同一次 OAuth 登录**，属于凭证形态回退，不是第二种登录方式。
- 只使用本机登录用户自己的账号；抓取 / 复用他人凭证一律禁止。

**代价**：

- router 侧看到的 `plugin_id` 从旧值变为 `plugin-zcode`，升级后需要在 router 界面重新确认 / 启用一次 provider。
- 文档需采用「一次登录，两种凭证形态」的叙事，避免把路线 A / B 误读成两种登录方式。

**何时重新审视**：若官方提供新的网页登录端点或取消 OAuth CLI 轮询，再评估替换；在用户明确要求前，不添加任何 App / 本地登录态旁路。
