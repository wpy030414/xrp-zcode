# Spec — 登录与凭证体检（module-login）

## 要构建什么

两个脚本：`pnpm run login` 拿 Coding Plan 凭证，`pnpm capture-key` 校验凭证并查额度。

实现：`scripts/login.ts`、`scripts/capture-key.ts`、`scripts/envFile.ts`（共享的 `.env` 读写与安全闸）。

## 行为

### `pnpm run login`

```
1. 本地生成随机 poll token（32 字节 hex）
2. POST {ZCODE_OAUTH_BASE}/oauth/cli/init
     Authorization: Bearer <poll token>
     {"provider": "<ZCODE_SITE>"}        // 默认 bigmodel；国际站 zai
   → { flow_id, authorize_url }
3. 打印 authorize_url 并尝试用系统默认浏览器打开
     bigmodel（默认）→ https://bigmodel.cn/login
     zai             → https://chat.z.ai/...
4. 每 2s 轮询 GET {ZCODE_OAUTH_BASE}/oauth/cli/poll/{flow_id}（Authorization: Bearer <poll token>），最多 100 次
     status = pending → 继续
     status = failed  → 中止并提示
     status = ready   → 取 data[ZCODE_SITE].access_token（及 data.token 的 Coding Plan JWT）
5. 首选：resolveCodingPlanApiKey(access_token) 走对应站点的兑换链
     国内站（默认）：GET bigmodel.cn/api/biz/*            3 步，access_token 直接作 Bearer
     国际站：POST api.z.ai/api/auth/z/login → /api/biz/*   4 步，先换 biz token
     → `apiKeyId.secretKey`（免验证码）
6. 把结果合并进 .env 的 ZCODE_KEYS（去重、保序、不覆盖其他变量）
```

- `ZCODE_OAUTH_BASE` 默认 `https://zcode.z.ai/api/v1`（两个站点的 OAuth 都从这里发起，`provider` 决定授权页）
- `init` 与 `poll` 必须用**同一个** poll token
- 写入前必须通过 `assertEnvIgnored()`：`git check-ignore .env` 不通过就中止
- **默认国内站**（D-12）：`ZCODE_SITE=bigmodel`，授权在 `bigmodel.cn`，推理在 `open.bigmodel.cn`
- **默认兑换 API Key**（路线 A），不是直接存 JWT：官方客户端对 Coding Plan 额度就是这么用的，且绕开无痕验证（D-10）
- 兑换失败（如无默认机构/项目）→ **不静默吞掉**：回退保存 JWT 并明确告警该形态需要无痕验证、当前可能不可用
- 若 `ready` 里既无 `access_token` 也无 `token` → 报错中止

### `pnpm capture-key`

**只读**，不修改任何文件。逐个凭证：

| 形态 | 行为 |
|------|------|
| API Key（国内站，默认） | `GET {BIGMODEL_OPEN_BASE_URL}/api/paas/v4/models` 轻量探活：401/403 → 不健康；其他可达响应 → 视为有效 |
| API Key（国际站） | `GET {ZAI_API_BASE}/api/paas/v4/models`，判定同上 |
| JWT | `GET {ZCODE_BILLING_BASE}/billing/current`（套餐）、`/billing/balance`（各模型剩余额度）、`/usage`（用量）；套餐或额度查询失败则标记该凭证不健康 |

输出一律脱敏（`maskSecret()`：保留前 8 后 6）。

## 输入 / 输出

- **输入**：`.env` 的 `ZCODE_KEYS`（缺失时回退进程环境变量）
- **输出**：终端报告；`login` 额外写 `.env`

## 约束

- 任何写 `.env` 的操作必须过 `assertEnvIgnored()`
- `.env` 写入保持 0600 权限（Windows 上尽力而为）
- 只读脚本不得写入
- 凭证在终端输出中必须脱敏

## 边界条件

- OAuth 端点不可达 → 打印明确失败原因，退出码非 0，不写 `.env`
- `ready` 但响应里既无 `<站点>.access_token` 也无 `token` → 报错中止
- `.env` 不存在 → `login` 会创建它；`capture-key` 提示先登录
- `.env` 已被忽略但用户手动写入了密钥 → 合并而非覆盖
- 凭证在列表中已存在 → 不重复写入并提示

## 验收标准

- [x] `pnpm run login` 在 OAuth 端点不可达时优雅失败（已手工验证）
- [x] `pnpm capture-key` 在无密钥时给出可执行的下一步提示（已手工验证）
- [x] `git check-ignore .env` 通过；`.env.example` 可入库
- [x] `pnpm e2e` 第 11 节：国内站按 3 步兑换（access_token 直接作 Bearer）、国际站按 4 步（z/login 先行），失败时抛错供 login 回退 JWT
- [x] 真实账号下 `pnpm run login` 从 `bigmodel.cn` 授权走到 `/copy` 兑换并写入 `.env`（2026-10-20 已验）
- [x] 真实账号下 `pnpm capture-key` 能探活兑换出的 API Key（`open.bigmodel.cn/api/paas/v4/models` → 200，2026-10-20 已验）

## 完成定义

两条命令在真实账号下跑通，且 `pnpm capture-key` 的输出足以判断「打不通」是凭证问题还是插件问题。
