# 逆向成果 — ZCode（zcode.z.ai）

> 本文件记录本插件所依赖的 ZCode 上游事实。
>
> 来源分两类，**分别标注**：
> - **【转述】** 来自社区项目 [zcode2api](https://github.com/liu5269/zcode2api)（AGPL-3.0）的公开逆向结论
> - **【实测】** 本仓库 2026-09-22 对公开接口的直接观测（无需凭证即可复现）
>
> 凭证属于个人资产，请只使用自己登录的账号。以下内容仅作技术记录。

---

## 1. 上游端点

| 用途 | 端点 | 凭证形态 | 无痕验证 |
|------|------|----------|----------|
| 推理（主） | `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | Coding Plan JWT | **需要** |
| 推理（国内站 API Key，默认） | `https://open.bigmodel.cn/api/anthropic/v1/messages` | BigModel API Key | 不需要 |
| 推理（国际站 API Key） | `https://api.z.ai/api/anthropic/v1/messages` | Z.AI API Key | 不需要 |
| 国内站授权页 / 兑换 | `https://bigmodel.cn/login`、`https://bigmodel.cn/api/biz/*` | OAuth access_token | — |
| 国际站兑换 | `https://api.z.ai/api/auth/z/login`、`https://api.z.ai/api/biz/*` | OAuth access_token → biz token | — |
| 计费 / 套餐 | `https://zcode.z.ai/api/v1/zcode-plan/billing/current` | JWT | 不需要 |
| 额度 | `https://zcode.z.ai/api/v1/zcode-plan/billing/balance` | JWT | 不需要 |
| 用量 | `https://zcode.z.ai/api/v1/zcode-plan/usage` | JWT | 不需要 |
| **客户端配置** | `https://zcode.z.ai/api/v1/client/configs` | **无需凭证** | — |
| OAuth 初始化 | `https://zcode.z.ai/api/v1/oauth/cli/init` | 临时 poll token | — |
| OAuth 轮询 | `https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}` | 临时 poll token | — |

推理/兑换端点在本插件里分别由 `ZCODE_BASE_URL` / `BIGMODEL_ANTHROPIC_URL` / `ZAI_FALLBACK_URL` /
`BIGMODEL_API_BASE_URL` / `ZAI_API_BASE` / `ZCODE_BILLING_BASE` 覆盖。

**【实测】`/api/v1/client/configs` 不能带任何查询参数。**
带 `?app_version=…&platform=…` 会返回 `{"code":3001,"msg":"parameter error"}`；
不带参数才返回完整配置。（zcode2api 用的是带参形式，已失效。）

无凭证直接打推理端点会得到 `401`，说明鉴权在验证码之前生效。

## 2. 请求头

主端点（JWT 形态）必须携带：

| 头 | 值 | 说明 |
|----|----|------|
| `Authorization` | `Bearer <JWT>` | Coding Plan 凭证 |
| `Anthropic-Version` | `2023-06-01` | Messages 协议版本 |
| `Content-Type` | `application/json` | |
| `X-Aliyun-Captcha-Verify-Param` | `<verifyParam>` | **无痕验证参数**，见第 3 节 |
| `X-ZCode-App-Version` | `3.0.1` | 客户端身份标识 |
| `X-ZCode-Agent` | `glm` | 客户端身份标识 |
| `HTTP-Referer` | `https://zcode.z.ai/` | |
| `User-Agent` | `ZCode/3.0.1` | |

`X-ZCode-*` 三个头是客户端身份标识，缺失或伪造容易被上游拒绝。本插件通过
`ZCODE_APP_VERSION` / `ZCODE_AGENT` / `ZCODE_USER_AGENT` 暴露为可配置项。

## 3. 无痕验证（阿里云）

Coding Plan（JWT）模式**必需**，API Key 模式不需要。

- 请求头 `X-Aliyun-Captcha-Verify-Param` 的值是
  `base64(JSON{certifyId, sceneId, isSign, securityToken})`，**由阿里云服务端签发**——
  本地无法凭空构造。
- 获取方式：在浏览器环境里加载阿里云官方 SDK（`o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`），
  调用 `initAliyunCaptcha(...)` 后在 `getInstance` 回调里执行 `startTracelessVerification()`，
  由 `success` 回调吐出该参数。
- **本项目的做法**：不启动真实浏览器，用 **Node + jsdom** 模拟浏览器环境跑同一份 SDK，
  并补齐 SDK 依赖的浏览器 API 桩。实现见 `captcha/solver.cjs`。

**【实测】场景参数**（来自 `client/configs`）：

```json
{ "enabled": true, "prefix": "no8xfe", "region": "cn", "sceneId": "11xygtvd" }
```

⚠️ `region` 是 **`cn`**；社区旧文档里的 `sgp` 已过期。

## 4. 凭证与登录

> 本节大量结论来自 **【本机逆向】**：`%LOCALAPPDATA%/Programs/ZCode/resources/glm/zcode.cjs`
> （ZCode 桌面端 3.5.3 的 14MB 打包 bundle）。关键函数名一并给出，便于复核。

- **Coding Plan 凭证** = OAuth 产出的 JWT，三段点分（`a.b.c`）。本插件以此作为形态判据。
- **官方对 Coding Plan 额度的真实用法不是打 zcode-plan 端点**，而是把 OAuth `access_token`
  兑换成一个长期 API Key，再打对应站点的 Anthropic 兼容端点（国内 `open.bigmodel.cn`、
  国际 `api.z.ai`），**均免无痕验证**。见下。

### 4.1 OAuth 登录流程（`createZaiCliOAuthClient` / `Xun`）

```
本地生成 pollToken = randomBytes(32).hex
POST {oauthBase}/oauth/cli/init   Authorization: Bearer <pollToken>   {"provider":"zai" | "bigmodel"}
     → data: { flow_id, authorize_url, poll_token, expires_at, poll_interval_sec }
浏览器完成授权
GET  {oauthBase}/oauth/cli/poll/{flow_id}   Authorization: Bearer <pollToken>
     → status: pending | failed | ready
     ready 时 data = { token: <CodingPlan JWT>, zai: { access_token }, bigmodel: { access_token }, user: {...} }
```

- `oauthBase` 默认 `https://zcode.z.ai/api/v1`（bundle 里 `J5s`）
- `provider` 决定授权站点（**实测**）：
  - `bigmodel` → `https://bigmodel.cn/login?appId=zcode&redirect=https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel&state=…`
  - `zai` → `chat.z.ai`
- 轮询用的临时 `pollToken` 由本地随机生成，与最终凭证无关
- 轮询间隔取 `max(Fqa, poll_interval_sec*1000)`，超时取 `min(now+timeout, expires_at*1000)`

### 4.2 ★ 国际站兑换链：access_token → api.z.ai API Key（`createCodingPlanApiKeyResolver` / `ZJr`）

**这是绕开无痕验证 F001 的关键路线**，官方客户端 `resolveCodingPlanApiKey`（`nWo`）实际调用：

```
输入：OAuth ready 里的 zai.access_token（注意：不是 JWT！family="zai"）

1. resolveZaiBizToken (V5s)：
   POST https://api.z.ai/api/auth/z/login   {token: access_token}
     → data.access_token（业务 token，下称 bizToken）

2. resolveBizApiKey (GJr)：authorization = `Bearer ${bizToken}`，host = https://api.z.ai
   GET  /api/biz/customer/getCustomerInfo
     → pickOrgAndProject (H5s)：机构里挑名字含「默认机构」的（否则第一个），
       项目里挑名字含「默认项目」的（否则第一个）
   GET  /api/biz/v1/organization/{orgId}/projects/{projId}/api_keys
     → 找 name === "zcode-api-key" 的项；没有则 POST 同 URL {name:"zcode-api-key"} 创建
     → 取 apiKeyId = item.apiKey
   GET  /api/biz/v1/organization/{orgId}/projects/{projId}/api_keys/copy/{apiKeyId}
     → data.secretKey
   ⇒ 返回 `${apiKeyId}.${secretKey}`
```

- 上游业务信封：`{code, msg, data}`，`code` 为 `null/0/200/"0"/"200"` 视为成功（`isSuccessfulRemoteCode` / `G5s`）
- 关键常量（bundle）：`JJr="https://api.z.ai"`、`HJr="zcode-api-key"`、`q5s="默认机构"`、`W5s="默认项目"`
- **【实测】** 兑换链 4 端点用假 token 探活全部存活：
  - `POST /api/auth/z/login {token:fake}` → HTTP 200 `{code:500,msg:"Z.ai user information is invalid"}`
  - `GET /api/biz/customer/getCustomerInfo`（无 auth）→ `{code:1001,msg:"Authentication parameter not received"}`
  - 同端点（假 biz token）→ `{code:401,msg:"token expired or incorrect"}`

### 4.3 兑换出的 key 如何推理（按站点）

- 兑换结果 `apiKeyId.secretKey` 只有 **1 个点** → 本插件 `classifySecret` 判为 `apiKey`
  → 按 `ZCODE_SITE` 选端点，**免无痕验证**：
  - 国内站（默认）→ `BIGMODEL_ANTHROPIC_URL` = `https://open.bigmodel.cn/api/anthropic/v1/messages`
  - 国际站 → `ZAI_FALLBACK_URL` = `https://api.z.ai/api/anthropic/v1/messages`
- 佐证：`builtinProviders` 里 `builtin:zai-coding-plan` 的 `baseUrl` 是
  `https://api.z.ai/api/anthropic`；`builtin:bigmodel-coding-plan` 的 baseUrl 是
  `https://open.bigmodel.cn/api/anthropic`
- **【实测】** 两个端点用假 key 都返回 `401 {message:"token expired or incorrect"}`，
  把值当 token 解析，不要求验证码头

### 4.4 zcode2api 的对应实现

zcode2api 的 `app/oauth.py::exchange_api_key` 是同一条链（`z/login → getCustomerInfo →
api_keys → copy`）。本插件的 `src/zcode/exchange.ts` 与之等价，但**默认启用**（zcode2api 里是可选步骤）。

### 4.5 ★ 国内站兑换链：access_token 直接作 Bearer（3 步）

国内站（`provider:"bigmodel"`）**没有** `/api/auth/z/login` 这一步。官方 bundle 的
`resolveCodingPlanApiKey` 按 provider 分支：bigmodel 直接拿 OAuth ready 里的
`data.bigmodel.access_token` 当业务 Bearer，base 为 `https://bigmodel.cn`：

```
输入：OAuth ready 里的 bigmodel.access_token（注意：不是 JWT！）

1. GET https://bigmodel.cn/api/biz/customer/getCustomerInfo
     Authorization: Bearer <access_token>
   → pickOrgAndProject：机构挑名字含「默认机构」的（否则第一个），
     项目挑名字含「默认项目」的（否则第一个）
2. GET https://bigmodel.cn/api/biz/v1/organization/{orgId}/projects/{projId}/api_keys
   → 找 name === "zcode-api-key" 的项；没有则 POST 同 URL {name:"zcode-api-key"}
   → 取 apiKeyId = item.apiKey
3. GET .../api_keys/copy/{apiKeyId}
   → data.secretKey
  ⇒ 返回 `${apiKeyId}.${secretKey}`
```

> **当前 bundle（3.5.3）的实现差异**：新版 `createCodingPlanApiKeyResolver` 不再调用
> `/copy/{id}`，而是 `POST .../api_keys/{apiKeyId}/access_tokens`
> `{clientType:"zcode",clientVersion}` 换一个**短时项目 token**（`token` 字段），并把它
> 与 `organizationId` / `projectId` 一起作为推理凭证。旧 `/copy/{id}` 端点**仍存活**
> （假 token → `401`，不是 404），本插件采用它来获得可长期存放的 `secretKey`。
> 新版对 BigModel 的 `getCustomerInfo` / `api_keys` 发裸 `Authorization`（不带 `Bearer`），
> 对 Z.AI 的 `api_keys` 才发 `Bearer`；假 token 无法区分前缀，本插件统一用 `Bearer`，
> 留待真实账号验证。

**【实测·2026-10-20】**：

```
GET  https://bigmodel.cn/api/biz/customer/getCustomerInfo（假 token）
     → 401 {"msg":"token expired or incorrect"}      // 端点存活，鉴权语义与 Z.AI 一致
GET  https://open.bigmodel.cn/api/paas/v4/models（假 key）
     → 401                                          // capture-key 探活端点可用
POST https://open.bigmodel.cn/api/anthropic/v1/messages（假 x-api-key）
     → 401 {"message":"token expired or incorrect"} // 推理端点存活，不要求验证码头
GET  https://zcode.z.ai/api/v1/client/configs
     → builtinProviders 含 builtin:bigmodel-coding-plan，baseUrl = https://open.bigmodel.cn/api/anthropic
```

**【实测·真实账号·2026-10-20】**（`pnpm run login` → `pnpm capture-key` → `pnpm serve`）：

```
OAuth（provider=bigmodel）→ 浏览器授权 bigmodel.cn → ready 返回 bigmodel.access_token
兑换链 3 步（getCustomerInfo → api_keys → copy）→ apiKeyId.secretKey（49 字符，1 个点）
GET  https://open.bigmodel.cn/api/paas/v4/models（兑换出的 key）→ 200
POST https://open.bigmodel.cn/api/anthropic/v1/messages（经本插件）
     → HTTP 429 {"error":{"type":"rate_limit_error","code":"1310",
        "message":"[1310][您已达到每周/每月使用上限，您的限额将在 2026-10-22 11:23:27 重置。]"}}
```

结论：

- **旧 `/copy` 兑换链在真实账号上仍可用**，产出的是形如 `apiKeyId.secretKey` 的长期 key
- 兑换 key 通过 BigModel 鉴权；推理请求被套餐额度上限（1310）拒绝而非 401
- 额度重置时间来自上游响应；成功后是否按订阅额度扣减，仍需 `billing/balance` 前后对账

## 5. 模型清单

**【实测】** `client/configs` 返回三组模型信息：

| 字段 | 内容 | 用途 |
|------|------|------|
| `builtinModels` | `GLM-5.3`、`GLM-5.3-Flash`（1M 上下文 / 128k 输出） | 上游针对当前套餐的**推荐清单** |
| `builtinProviders[]` | `builtin:bigmodel` / `builtin:zai-coding-plan` / `builtin:zai` / `team-plan:builtin`，`defaultModel: GLM-5.3` | 套餐 / 通道定义 |
| `providers[]` | `bigmodel`、`z-ai`（各含 anthropic 与 openai:chat 两种 schema），models 为 `GLM-5.2`、`GLM-5-Turbo` | **自带 API Key** 通道 |

本插件只取 `builtinModels`——`providers[]` 属于「自带 Key」通道，混进来会注册出套餐里用不了的模型。

上游模型名**大小写敏感**。真实清单会变（社区文档记录的 `GLM-5.2`/`GLM-5-Turbo` 已被 `builtinModels`
取代），因此本插件**不硬编码**：`ZCODE_MODELS` 优先，未配置则启动时从 `builtinModels` 自动发现，
再不行才用内置默认值。详见 `docs/DECISIONS.md` D-8。

## 6. 错误语义（对插件行为起决定作用）

| 上游表现 | 含义 | 本插件 |
|----------|------|--------|
| 401（无/坏凭证） | 鉴权失败 | 原样透传 → router 标红 |
| 403 + 含 `captcha` / `verify token` / `verify failed` / `人机` | 无痕验证失效 | 刷新验证码重试；连续失败后返回 502 |
| 402 或错误体含 `quota` / `insufficient` / `balance` / `额度` / `余额不足` | 额度耗尽 | 原样透传 402 → router 标黄并换密钥 |
| 429 | 限流 | 原样透传 |
| 401 / 403（非验证码） | 凭证失效 | 原样透传 |

> 额度字段与耗尽判定是启发式的，zcode2api 的作者也明确表示**未在付费账号上充分实测**。
> 若真实行为与此不符，以真实上游为准。

## 6.5 【实测】无痕验证当前被风控拒绝（F001）⚠️

**这是本插件目前最大的未决问题。**

用 `captcha/solver.cjs` 在 2026-09-22 实跑，链路本身是通的：

```
[debug] initAliyunCaptcha 已就绪
[jsdom xhr] POST https://no8xfe.captcha-open.aliyuncs.com/
[jsdom xhr] POST https://cloudauth-device-dualstack.cn-shanghai.aliyuncs.com
[debug] getInstance，开始无痕验证
[debug] SDK fail 回调 {"success":true,"verifyResult":false,"verifyCode":"F001","certifyId":"S2cJzuyWmg"}
```

- SDK 加载成功、走到 `getInstance`、向阿里云发起了设备指纹与验证请求、**拿到了 `certifyId`**
- 但服务端风险判定为 `verifyResult: false, verifyCode: "F001"`

`F001` 的官方含义是「**疑似攻击请求，风险策略不通过**」（阿里云验证码 2.0 客户端返回码说明）。
它不是「虚拟设备」那个码（那是 `F009`），说明风控没有直接认出 jsdom，而是综合信号判定为高风险。

试过的缓解手段（**均未改变结果**）：

| 手段 | 结果 |
|------|------|
| jsdom 默认 UA（含 `jsdom` 字样）→ 换成真实 Chrome UA | 仍 F001 |
| `navigator.webdriver = false` / 补 `languages` / `platform` / `hardwareConcurrency` | 仍 F001 |
| `window.chrome` 桩、`screen` 尺寸补全 | 仍 F001 |
| `region` 由 `sgp` 改为上游公布的 `cn` | 仍 F001 |
| 补 canvas / WebGL / Worker / OffscreenCanvas 指纹桩 | 仍 F001 |

**这意味着 Coding Plan（JWT）路径在本项目当前的实现下无法取到合法的 verifyParam。**
API Key 路径不受影响（国内站 `open.bigmodel.cn` / 国际站 `api.z.ai` 的兼容端点都不需要验证码）。

可能的出路见 `README.md` 的「已知限制」一节。

### 6.6 【实测·真实 JWT】验证码是 zcode-plan 端点的硬门槛（决定性证据）

上面 F001 还留有「会不会是 jsdom 环境的问题、换个能过风控的环境就行」的侥幸。
用一个**真实有效的 Coding Plan JWT**（来自 `.env`）直接打上游，彻底排除了这种侥幸：

```
POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
  authorization: Bearer <真实 JWT>   model: GLM-5.3   max_tokens: 1

不带验证码头        → HTTP 400 {"code":3007,"msg":"captcha verify failed"}
带假验证码头        → HTTP 400 {"code":3007,"msg":"captcha verify failed"}
```

三条铁证：

1. **真实 JWT 能过鉴权**——错误是 `400 captcha verify failed` 而非 `401`，说明凭证本身有效，
   卡点纯粹在验证码。
2. **验证码是硬门槛**——不带、带假的，都被 `code:3007` 拒。没有「凭证够硬就免验证码」的后门。
3. **错误形态是 `400 + code:3007`**（不是先前假设的 `403`）。本插件 `isCaptchaRejection`
   已覆盖 `400 + captcha 关键词`，会正确识别并映射为 502（见 `module-forward.md`）。

**顺带实测：两条路线的凭证不通用，兑换链只认 OAuth access_token。**

```
真实 JWT 打 api.z.ai/api/anthropic (x-api-key 或 Bearer)  → 401 token expired or incorrect
真实 JWT 喂 api.z.ai/api/auth/z/login {token}             → code:500 Z.ai user information is invalid
```

即：**手里的 JWT 既不能直接打 api.z.ai，也不能喂进兑换链**。兑换链要的是 OAuth 授权返回的
`zai.access_token`（见第 4.1 节 ready 载荷）。所以路线 A 必须走完整 `pnpm run login`（OAuth 授权
→ 拿 access_token → 兑换），无法用现成的 JWT 走捷径。这也解释了为何第 7 节把
「路线 A 端到端」列为头号待验证项——它需要一次真实 OAuth 授权才能跑通。

## 6.7 【实测·2026-09-22】F001 验证码闸门突破 + 3012 账号级风控

### 验证码突破（决定性证据）

硬化 `captcha/solver.cjs`（综合 SQMY-dor/zcode2api 指纹补丁 + TriDefender cookie priming 经验）后，**间隔 15s 节奏求解 4/5 成功**：

```
[1] ❌ F001（首次突发触发设备级风控）
[2] ✅ VERIFY_PARAM=eyJjZXJ0aWZ5SWQiOiIyd0dCNk9KTT…
[3] ✅ VERIFY_PARAM=eyJjZXJ0aWZ5SWQiOiJsc05ESmpCY2…
[4] ✅ VERIFY_PARAM=eyJjZXJ0aWZ5SWQiOiJ0MHl5UUxVeV…
[5] ✅ VERIFY_PARAM=eyJjZXJ0aWZ5SWQiOiJ4ZE5vMnBvcF…
```

param 解码为 `{"certifyId":"...","sceneId":"11xygtvd","isSign":true,"securityToken":"..."}`，结构完整。

**关键经验（缺一都可能 F001）**：

1. **navigator 指纹组是必要条件**：`userAgent`(真实 Chrome UA) / `appVersion` / `platform`(Win32) / `vendor`(Google Inc.) / `webdriver`(false) / `languages` / `language` / `hardwareConcurrency`(8) / `deviceMemory`(8) / `maxTouchPoints`(0) / `plugins`([1..5]) / `mimeTypes`([1,2])
2. **window 组**：`chrome`({runtime,app,csi,loadTimes}) / `devicePixelRatio`(1) / `requestIdleCallback`
3. **WebGL ANGLE 精确串**：`getParameter(0x1f00)` = `"Google Inc. (Intel)"`，`getParameter(0x1f01)` = `"ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)"`
4. **cookie priming**：调用方先 GET zcode.z.ai 拿 `acw_tc`/`cdn_sec_tc` cookie 注入 jsdom 会话
5. **fail 回调兜底**：SDK `fail` 回调也可能携带 `captchaVerifyParam`，不能只认 `success`
6. **确定性指纹**：所有值必须固定、绝不逐次随机——阿里云风控跨请求关联指纹稳定性
7. **求解节奏 ≥10-15s/次**：突发节奏触发设备级 F001（IP 维度约 10 分钟恢复）

### 端到端实测（真实 start-plan JWT）

用真实 JWT（`.env` 中，payload 结构 `{user_id,token_version,sub,iat}` 正是 start-plan 形态）+ 现求 param 打 zcode-plan 端点：

| 请求形态 | 响应 |
|----------|------|
| 不带 param | `400 {"code":3007,"captcha verify failed"}` |
| **带硬化 solver 现求的 param** | `405 {"code":3012,"unusual activity"}` |

**验证码闸门被攻破**——响应从 3007 变成 3012，param 被上游接受。

### 3012 账号级风控（新阻塞）

3012 不是验证码问题，是 ESA（阿里云边缘安全加速）WAF 的**账号维度拦截**。四组对照实验（`scripts/_diag3012-full.cjs`）一致证实：

| 实验 | 请求形态 | 响应 |
|------|----------|------|
| A 基线 | 直接 POST | 405 + 3012 |
| B cookie priming | 先 GET zcode.z.ai 拿 cookie，再 POST | 405 + 3012 |
| C visitor_id + 全套身份头 | cookie + visitor_id + x-platform/x-client-language 等 | 405 + 3012 |
| D off-peak 端点 | POST /api/v1/off-peak/anthropic/v1/messages | 400 + 3001 parameter error |

**结论**：

- ✅ 3012 **不是** TLS 指纹问题（node-fetch 与 curl 两套 TLS 栈同样被拦）
- ✅ 3012 **不是** cookie/session 问题（cookie priming 无效）
- ✅ 3012 **不是** 缺身份头问题（全套 x-platform/x-client-language 等无效）
- ⛔ 3012 **是** 账号/IP 维度风控，该 JWT 在探测过程中被 ESA WAF 标记为 unusual activity
- ⛔ off-peak 端点需要 ticket 体系（另一套机制），不可直连

### V4 签名对 zcode-plan **不适用**

TriDefender/zcode-api `src/proxy/client-signing.ts` 第 63-67 行明确：

```typescript
/** Paths the client never signs (decoded, trailing-slash-stripped). */
const UNSIGNED_PATHS = new Set([
  "/api/v1/zcode-plan/anthropic/v1/messages",  // ← 我们要打的端点
  "/api/v1/zcode-plan/chat/completions",
  "/api/v1/off-peak/anthropic/v1/messages",
]);
```

**官方客户端对 start-plan/zcode-plan 也不签**。V4 签名（Ed25519+PoW）只给付费 Coding Plan 用，所以 3012 不是「缺签名」的问题，实现签名层也不会让 zcode-plan 放行。

### 当前状态（2026-09-22）

| 阶段 | 状态 | 证据 |
|------|------|------|
| F001 验证码闸门 | ✅ **已攻破** | 硬化 solver 15s 节奏 4/5 通过 |
| 3007 captcha verify failed | ✅ **已越过** | 真实 JWT + 真 param → 3012 |
| 3012 unusual activity | ⛔ **账号级风控** | 四组对照实验证实，cookie/session 无法绕过 |
| V4 签名 | ✗ **不适用** | TriDefender 代码确认 zcode-plan 端点官方也不签 |

**代码完整可用**：`captcha/solver.cjs` 已硬化，求解链路完整，`pnpm e2e` 69/69 全绿。阻塞项是该 JWT 账号被 ESA WAF 标记——这是风控策略问题，不是代码缺陷。

**出路**：
- 账号冷却（等待风控标记过期，时间不确定）
- 用另一个未被标记的 start-plan 账号验证（应该能直接通）
- 付费 Coding Plan 走 exchange.ts 兑换链（默认国内站 `open.bigmodel.cn`，国际站 `api.z.ai`，均免验证码）

---

## 7. 未验证 / 存疑事项

- **【头号】兑换 key 的计费归属尚未完成扣减对账**：逆向证明官方把 Coding Plan 的 access_token
  兑换成 `zcode-api-key` 打对应站点的兼容端点（国内 `open.bigmodel.cn`、国际 `api.z.ai`）。
  2026-10-20 国内站真实账号已验证：登录/兑换成功、key 探活 200、推理端点返回套餐额度上限
  `1310`（非 401）——说明 key 与账户套餐额度绑定。但还没做 `billing/balance` 前后对比，
  无法排除「另计 API 余额」的可能。这是路线 A 成立与否的最后一环。
- **【国内站·已验证】OAuth → `/copy` 兑换链在真实账号上跑通**（2026-10-20）：产出 49 字符
  `apiKeyId.secretKey`，可过 BigModel 鉴权。**尚未**完成的是额度重置后的成功生成
  （当前账号 1310 限额，2026-10-22 11:23:27 重置）
- **【已解决】`Authorization` 前缀**：真实账号下 BigModel 业务请求用 `Bearer <access_token>`
  成功完成 getCustomerInfo / api_keys / copy，本插件统一 `Bearer` 的做法有效
- **【已解决】旧 `/copy` 端点**：3.5.3 bundle 虽改用 `/api_keys/{id}/access_tokens` 换短时
  项目 token，但旧 `/copy/{id}` 在真实账号上仍返回可用的长期 `secretKey`（D-12）
- `billing/current`、`billing/balance`、`usage` 的字段结构（`total_units` / `used_units` /
  `remaining_units` / `expires_at` 等）来自转述，不同套餐可能不一致
- 额度耗尽的判定关键词为启发式
- `builtinProviders` 里 `builtin:zai-coding-plan`（`baseUrl: https://api.z.ai/api/anthropic`）
  已被本机逆向证实为官方 Coding Plan 路线（见第 4.2 节），不再是存疑项
- 无痕验证 SDK 的指纹逻辑（feilin / cloudauth-device）会持续更新，jsdom 桩件需要同步
  （但只要路线 A 可用，求解器就是兜底而非主路径）
- OAuth ready 载荷里 `zai.access_token` 的有效期未测——若它比 JWT 短很多，兑换需更频繁；
  但兑换出的是**长期** API Key，正常只需兑换一次

## 8. 致谢与许可

- 上游协议结论、无痕验证方案、`captcha/solver.cjs` 的原型均来自
  [liu5269/zcode2api](https://github.com/liu5269/zcode2api)（AGPL-3.0）。
  本仓库的 `captcha/solver.cjs` 是该项目的移植版，保留同样的许可约束。
- 阿里云验证码返回码含义参考
  [阿里云验证码 2.0 客户端返回数据说明](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/description-of-data-returned-by-the-client)
- 社区讨论：[linux.do](https://linux.do)
