# Spec — 配置（module-config）

## 要构建什么

一处集中、可覆盖的配置入口。所有环境变量只在 `src/config.ts` 读一次。

实现：`src/config.ts`；模板 `.env.example`。

## 行为

读取规则：环境变量为空串或未定义 → 用 fallback。数值项解析失败 → 用 fallback。

`settings` 在模块加载时构造一次：启动后修改 `.env` 不会生效，需重启进程（V24 不再有 `.env` 轮询）。

### 变量表

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ZCODE_PORT` | `19065` | 本地监听端口 |
| `XRL_ROUTER_URL` | `http://localhost:19068` | router 地址，注册时替换 scheme 为 `ws` |
| `ZCODE_KEYS` | 空 | 逗号分隔、**顺序敏感**的凭据列表；由插件自持并按顺序故障转移（见 D-11） |
| `ZCODE_SITE` | `bigmodel` | 站点：`bigmodel` = 国内站（默认），`zai` = 国际站；影响 OAuth、兑换链与 API Key 推理端点 |
| `ZCODE_MODELS` | 空 | 显式指定注册给 router 的模型；**留空则启动时自动发现**（见下）。支持 `模型ID=展示名` |
| `ZCODE_BASE_URL` | `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | JWT 主端点（两个站点共用） |
| `BIGMODEL_ANTHROPIC_URL` | `https://open.bigmodel.cn/api/anthropic/v1/messages` | 国内站 API Key 推理端点（默认路线 A） |
| `BIGMODEL_API_BASE_URL` | `https://bigmodel.cn` | 国内站业务基址；`login` 兑换链使用 |
| `BIGMODEL_OPEN_BASE_URL` | `https://open.bigmodel.cn` | 国内站开放平台基址；`capture-key` 探活使用 |
| `ZAI_FALLBACK_URL` | `https://api.z.ai/api/anthropic/v1/messages` | 国际站 API Key 推理端点（`ZCODE_SITE=zai`） |
| `ZAI_API_BASE` | `https://api.z.ai` | 国际站基址；`capture-key` 探活与兑换链使用 |
| `ZCODE_BILLING_BASE` | `https://zcode.z.ai/api/v1/zcode-plan` | 额度 / 计费查询基址 |
| `ZCODE_CAPTCHA_CONFIG_URL` | `https://zcode.z.ai/api/v1/client/configs` | 客户端配置接口（**不能带查询参数**） |
| `ZCODE_CAPTCHA_SCENE` | `11xygtvd` | 场景 ID |
| `ZCODE_CAPTCHA_REGION` | `cn` | 场景区域（上游当前公布值；社区旧文档的 `sgp` 已过期） |
| `ZCODE_CAPTCHA_PREFIX` | `no8xfe` | 场景前缀 |
| `ZCODE_CAPTCHA_TIMEOUT` | `40` | 单次求解超时（**秒**） |
| `ZCODE_CAPTCHA_RETRIES` | `4` | 单次求解内部重试次数 |
| `ZCODE_CAPTCHA_CACHE_TTL` | `45000` | verifyParam 缓存（**毫秒**） |
| `ZCODE_CAPTCHA_CONFIG_CACHE_TTL` | `600000` | 场景配置缓存（**毫秒**） |
| `ZCODE_CAPTCHA_REMOTE` | 未设 | 设为 `0` 时完全不请求远端场景配置 |
| `ZCODE_NODE_PATH` | `node` | 求解器使用的 Node 可执行文件 |
| `ZCODE_SOLVER_PATH` | `<root>/captcha/solver.cjs` | 求解器脚本路径（e2e 用假脚本替换） |
| `ZCODE_APP_VERSION` | `3.0.1` | 上游 `X-ZCode-App-Version` |
| `ZCODE_AGENT` | `glm` | 上游 `X-ZCode-Agent` |
| `ZCODE_USER_AGENT` | `ZCode/3.0.1` | 上游 `User-Agent` |
| `ZCODE_HEARTBEAT_INTERVAL_MS` | `30000` | 心跳间隔（e2e 可缩短） |
| `ZCODE_RECONNECT_BASE_MS` | `1000` | 重连退避基数 |
| `ZCODE_RECONNECT_MAX_MS` | `60000` | 重连退避封顶 |
| `ZCODE_OAUTH_BASE` | `https://zcode.z.ai/api/v1` | 仅 `scripts/login.ts` 读取 |

### `ZCODE_KEYS` 的语义

- 逗号分隔，保留书写顺序；空项被丢弃
- 顺序即故障转移顺序：插件从粘性成功 key 开始环形尝试
- 同时支持 JWT（三段点分）与 API Key（`apiKeyId.secretKey`），逐把判定形态
- 插件**不再**把列表推给 router，也不轮询 `.env`；改动后重启即可

### `ZCODE_SITE` 的语义

```
bigmodel（默认）                     zai
├─ OAuth provider: "bigmodel"       ├─ OAuth provider: "zai"
├─ 授权页: bigmodel.cn/login         ├─ 授权页: chat.z.ai
├─ 兑换: bigmodel.cn/api/biz/*       ├─ 兑换: api.z.ai/api/auth/z/login → /api/biz/*
│  （access_token 直接作 Bearer）     │  （先换 biz token）
└─ 推理: BIGMODEL_ANTHROPIC_URL      └─ 推理: ZAI_FALLBACK_URL
```

站点只影响 OAuth、兑换链与 API Key 推理；JWT 主端点 `ZCODE_BASE_URL` 两个站点相同。理由见 D-12。

### 模型清单的三级优先

```
ZCODE_MODELS 显式配置  >  client/configs 的 builtinModels 自动发现  >  内置默认 GLM-5.3,GLM-5.3-Flash
```

- 显式配置 → `modelsExplicit = true`，`modelsSource = "ZCODE_MODELS"`，启动不请求 configs
- 未显式配置 → `startServer()` 在构造 `PluginClient` **之前** `await fetchClientConfigs()`，
  成功则 `modelsSource = "上游 configs 自动发现（N 个）"`
- 自动发现失败（网络/解析/字段缺失）→ 保留内置默认值，`modelsSource = "内置默认 (…)"`，不阻塞启动

自动发现只取 `builtinModels`，不混入 `providers[].models`（后者是自带 API Key 通道的清单）。
理由见 `docs/DECISIONS.md` D-8。

### 时间单位不统一是刻意的

`ZCODE_CAPTCHA_TIMEOUT` 用秒（对齐社区 zcode2api 的 `ZCODE_CAPTCHA_TIMEOUT`），
`ZCODE_CAPTCHA_CACHE_TTL` 用毫秒（对齐其 `CAPTCHA_CACHE_TTL`）。两处单位都在变量表与
`.env.example` 注释里写明。

## 输入 / 输出

- **输入**：进程环境变量 + `.env`（仅启动时）
- **输出**：`settings` 单例、`PLUGIN_ID`、`PROVIDER_KIND`、`PROVIDER_API_PATH`、`KEYS_ENV_KEY`

## 约束

- 除 `scripts/login.ts` 的 `ZCODE_OAUTH_BASE` 外，所有变量只由 `src/config.ts` 读取
- `.env.example` 必须覆盖全部变量并带注释；不得包含任何真实凭证
- 不得重新引入 `.env` 轮询或向 router 推送密钥池（V24 契约，见 D-11）

## 边界条件

- `ZCODE_MODELS` 为空或只含空白 → 走自动发现；发现失败再用内置默认值
- `ZCODE_MODELS` 条目写成 `GLM-5.3=` → 展示名回退为 `model_id`
- 数值变量写错（如 `abc`）→ 用 fallback，不崩溃
- `ZCODE_KEYS` 为空或全是空白 → `keys = []`，转发返回 503
- `client/configs` 带查询参数会被上游拒绝（`parameter error`）→ 插件**从不带参数**请求

## 验收标准

- [x] `pnpm e2e` 全部用例都是在覆盖 `ZCODE_*` 环境变量后跑通的（证明覆盖生效）
- [x] `ZCODE_SOLVER_PATH` 生效（e2e 用 `scripts/mock-solver.cjs` 替换真求解器）
- [x] `ZCODE_MODELS=GLM-5.2=glm-5.2,GLM-5-Turbo` 被正确解析并注册
- [x] `ZCODE_KEYS` 多值按顺序解析，并用于故障转移
- [x] `pnpm e2e` 第 10 节：configs 请求不带查询参数；自动发现的清单与去重正确；结果被缓存不重复请求
- [x] `pnpm e2e` 第 8 节：默认站点下 API Key 走 BigModel 端点；`site: 'zai'` 时走国际站端点
- [x] 未配置 `ZCODE_MODELS` 时能对真实上游自动发现出模型（已实机验证）

## 完成定义

`.env.example` 与实际读取的变量集合一致；改任一变量后重启即可生效。
