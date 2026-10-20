# Spec — 转发（module-forward）

## 要构建什么

`POST /v1/messages` 的处理链路：插件自持凭据 → 判定形态 → 装上游头 → 转发 → 按客户端期望返回流式或聚合结果，并把上游错误如实映射成 router 能读懂的信号。

实现：`src/zcode/client.ts`（主流程）、`src/zcode/auth.ts`（纯函数）、`src/zcode/aggregate.ts`（聚合）。

## 行为

### 凭据来源

- **只从 `settings.keys`（`ZCODE_KEYS`）取凭据**，按顺序尝试
- 入站请求里的 `x-api-key` 是 router 注入的占位符 `xrl-router`，**必须忽略**
- 对入站请求不做本地鉴权（router 已负责）；无本地凭据时才返回 `503 configuration_error`
- 入站 `Authorization` 同样不使用，避免与占位符混淆

### 多凭据故障转移

```
orderedKeys()：从 preferredKeyIndex 开始，环形遍历 settings.keys
  ├─ 成功（2xx）→ preferredKeyIndex = 该 key 下标（粘性）
  ├─ 401 / 402 / 403 / 429 → 记录错误，尝试下一把
  └─ 其他错误 → 不换 key（不是凭据问题）
```

- 全部 key 都是凭证级错误时，原样透传**最后一把**的状态码与响应体
- `preferredKeyIndex` 仅在进程内，不落盘
- 验证码失败**不换 key**：同一把 key 刷新验证码重试，最终 502（换 key 对风控无意义）

### 形态判定

凭证含两个 `.` 且各段非空 → `jwt`；否则 `apiKey`。

### 上游选择与请求头

| 形态 / 站点 | 端点 | 凭证头 | 无痕验证头 |
|------|------|--------|-----------|
| `jwt`（两站点共用） | `ZCODE_BASE_URL` | `Authorization: Bearer` | 带上 |
| `apiKey` + `bigmodel`（默认） | `BIGMODEL_ANTHROPIC_URL` | `x-api-key` | 不带 |
| `apiKey` + `zai` | `ZAI_FALLBACK_URL` | `x-api-key` | 不带 |

所有形态都带：`content-type`、`anthropic-version: 2023-06-01`、`user-agent`。
JWT 形态额外带 ZCode 身份头 `x-zcode-app-version` / `x-zcode-agent` / `http-referer`；
国内站 API Key 走标准 Anthropic 兼容端点，**不带**这三个业务头；国际站 API Key 保留它们。

### 请求体

- `model` 归一化为上游接受的形式（规则与理由见 `docs/DECISIONS.md` D-4，实现见 `src/zcode/models.ts`）
- `stream` **强制为 `true`**
- 其余字段原样透传

### 响应

| 客户端 `stream` | 行为 |
|-----------------|------|
| `true` | 上游 SSE 字节流**原样透传**（含 Content-Type），逐块读写并处理背压 |
| `false` | 上游仍是 SSE，由 `aggregateAnthropicStream` 聚合成单条 message JSON |

### 错误映射

| 上游响应 | 插件行为 |
|----------|----------|
| 2xx | 成功路径 |
| 401 / 402 / 403（非验证码）/ 429 | 换下一把 key；全部失败则原样透传最后一把 |
| 403 / 400 且命中验证码关键词（`captcha` / `verify token` / `verify failed` / `verify_param` / `无痕` / `人机`） | `captchaManager.invalidate()` → 同一把 key 重试；连续 `MAX_CAPTCHA_REFRESH`(3) 次仍失败 → **502** |
| 其他非 2xx | 原样透传 |
| 网络失败 / 超时 | `502` |
| 无痕验证求解失败（拿不到参数） | `502` |
| 无本地凭据 | `503` + `configuration_error` |

### 连接生命周期

- 客户端断开（请求 `signal` abort）→ 取消上游请求，返回 499
- 上游流读取中断 → 关闭响应，不抛穿

## 输入 / 输出

- **输入**：Anthropic Messages 请求体；凭据来自进程内 `settings`
- **输出**：`text/event-stream` 字节流（透传），或 `application/json` 单条 message（聚合），或 Anthropic 形态错误体

## 约束

- 不做任何协议转换（router 的 IR 层负责）
- 不改写凭证级错误的状态码（那会破坏 router 对供应商的健康判断）
- 不把占位符 `xrl-router` 发给上游
- 不做完整密钥池：只做有序尝试 + 粘性成功 key，健康度/轮换仍由 router 的 provider 级策略兜底

## 边界条件

- 空 body / 非对象 body → 按 `{}` 处理，`model` 为空则原样透传，让上游报错
- 上游返回 2xx 但内容不是 SSE → 聚合器回退为「整个响应体当 JSON 解析」
- `content_block_stop` 时 `partial_json` 拼不成合法 JSON → 原样保留字符串而不吞掉
- 上游 `body` 为空（如 204）→ 聚合路径返回 502，透传路径直接结束响应

## 验收标准

- [x] `pnpm e2e` 第 1 节：`/`、`/health` 结构、404、无本地凭据 503
- [x] `pnpm e2e` 第 2 节：SSE 字节与上游逐帧一致；`stream` 被强制为 `true`
- [x] `pnpm e2e` 第 3 节：非流式聚合出正确文本 / `stop_reason` / `usage`
- [x] `pnpm e2e` 第 4 节：`glm-5.2` / `zai/GLM-5-Turbo` / `glm-5-turbo` 三种写法都归一化正确
- [x] `pnpm e2e` 第 5 节：JWT 走 Coding Plan 端点、带对头；入站占位符从未发往上游
- [x] `pnpm e2e` 第 7 节：402 / 429 / 401 原样透传；验证码持续失败返回 502；失效一次能自愈
- [x] `pnpm e2e` 第 8 节：JWT 401 时自动换到下一把 API Key 并成功；默认站点走 BigModel、`zai` 站点走国际站

## 完成定义

`pnpm e2e` 全绿且 `pnpm typecheck` 无错，并且上面每条验收都能在 `scripts/e2e.ts` 里指出对应的断言。
