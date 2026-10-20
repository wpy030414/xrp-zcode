# Spec — 无痕验证（module-captcha）

## 要构建什么

为 Coding Plan（JWT）请求稳定地提供一个可用的 `X-Aliyun-Captcha-Verify-Param`，且不让它成为请求主路径上的瓶颈。

实现：`src/zcode/captcha.ts`（管理器）、`src/zcode/solver.ts`（子进程调用）、`captcha/solver.cjs`（求解器）。

## 行为

### 三层缓存 / 去重

```
getVerifyParam()
  ├─ 命中 verifyParam 缓存（TTL 45s）        → 直接返回，零成本
  ├─ 已有 inflight 求解                       → 复用同一个 Promise（并发去重）
  └─ 否则                                     → 进入 solve()
```

### solve()

```
1. fetchSceneConfig()      ← 场景参数（sceneId / region / prefix）
2. 循环最多 captcha.retries 次：
     spawn node solver.cjs <scene> <region> <prefix>
     解析 stdout 的 VERIFY_PARAM= 行
     成功 → 写缓存并返回
3. 全部失败 → 抛错（调用方映射为 502）
```

### 场景配置来源

由 `src/zcode/configs.ts` 统一提供（与模型自动发现共用同一个接口与缓存）：

| 来源 | 优先级 |
|------|--------|
| `GET {ZCODE_CAPTCHA_CONFIG_URL}` → `data.configs.captcha` | 优先尝试 |
| `ZCODE_CAPTCHA_SCENE` / `_REGION` / `_PREFIX` 环境变量 | 兜底，始终可用 |

- **请求不得携带任何查询参数**——带上 `?app_version=…` 上游返回 `{"code":3001,"msg":"parameter error"}`
- 成功 → 缓存 `ZCODE_CAPTCHA_CONFIG_CACHE_TTL`（默认 600s）
- 失败 → 回退环境变量值，并做 **60s 负缓存**（避免每个请求都陪一次超时）
- `ZCODE_CAPTCHA_REMOTE=0` → 完全不请求远端，只用环境变量

### 失效刷新

上游返回验证码类错误时，调用方调 `invalidate()` 清空 verifyParam 缓存，下一次请求重新求解。
`invalidate()` **不**清空场景配置缓存。

### 求解器（`captcha/solver.cjs`）

- 在 jsdom 中加载 `https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`
- 通过 `beforeParse` 补齐浏览器 API 桩：`matchMedia`、canvas / WebGL 指纹、`Worker`、`OffscreenCanvas`
- `initAliyunCaptcha` → `getInstance` 回调里调 `startTracelessVerification()` → `success` 回调输出 `VERIFY_PARAM=<param>`
- 退出码：`0` 成功 / `2` 总超时 / `3` 异常 / `4` SDK fail / `5` SDK onError

## 输入 / 输出

- **输入**：无（内部读取 `settings.captcha`）
- **输出**：`getVerifyParam(): Promise<string>`；失败抛 `Error`

## 约束

- 求解器**必须**以子进程运行——jsdom 需要 `runScripts: 'dangerously'` 跑混淆 SDK，隔离出去才能超时强杀、崩溃不波及主进程
- 求解器路径可由 `ZCODE_SOLVER_PATH` 覆盖（e2e 用假求解器替换的前提）
- 单次求解超时 `ZCODE_CAPTCHA_TIMEOUT`（默认 40s）到期强杀（SIGKILL）
- `configs` 接口请求**不得带查询参数**

## ⚠️ 已知阻塞：账号/IP 级 3012 风控

2026-09-22 首次实测：求解链路全通（SDK 加载 → 设备指纹请求 → 拿到 `certifyId`），但阿里云风险判定为
`{"success":true,"verifyResult":false,"verifyCode":"F001"}`（疑似攻击请求）。

后续实测：**F001 已被硬化指纹桩 + ≥10–15s 求解节奏突破（4/5 成功）**；当前阻塞变为
ESA WAF 的账号/IP 维度 `3012 unusual activity`（上游表现为 `400 code:3007` 或 `403`）。
这不是 jsdom 指纹问题，继续调桩没有收敛路径。

本模块的**代码行为仍然正确**（超时会重试、失败会抛错、上层映射 502、缓存与去重都按规格工作），
但**在当前风控环境下不一定能拿到可用的 verifyParam**。缓解尝试与出路见
`docs/reverse/ZCODE_REVERSE.md` 6.7 节与 `docs/DECISIONS.md` D-9 的补注。

因此本模块的验收以「机制正确」为准，而非「当前能取到参数」。默认路线 A（兑换 API Key）不需要本模块。

## 边界条件

- 求解器脚本不存在 → 子进程启动失败 → 计入重试，最终抛错
- Node 可执行文件不存在（`ZCODE_NODE_PATH` 配错）→ 同样计入重试
- 求解器退出码 0 但没有 `VERIFY_PARAM=` 行 → 视为失败，继续重试
- 远端场景配置接口返回非 JSON / 缺字段 → 回退默认值
- 求解期间客户端断开 → 上游请求被 abort，但求解进程不中断（结果仍进缓存，下一个请求受益）

## 验收标准

- [x] `pnpm e2e` 第 5 节：求得的参数被带上请求头，且内容确实来自场景配置（`mock-scene`）
- [x] `pnpm e2e` 第 6 节：多个 JWT 请求合计只 spawn 一次求解器；TTL 内继续请求不新增求解
- [x] `pnpm e2e` 第 7 节：上游报验证码失效时能刷新重试；持续失效时返回 502（不是 403）
- [x] 远端场景配置返回结构正确时被采用（e2e 的 `/configs` mock 覆盖此路径）

## 完成定义

`pnpm e2e` 的验证码相关断言全绿；在真实账号下 `pnpm serve` 能连续处理多个 JWT 请求且不出现 jsdom 进程泄漏。
