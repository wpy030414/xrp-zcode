# xrl-router-plugin-zcode

把 ZCode（`zcode.z.ai`）的额度包装成 xrl-router 里一个普通可路由的供应商。

## 这是什么？

- **定位**：xrl-router 的**委托供应商插件**（WebSocket 注册，见 xrl-router `docs/specs/module-plugin-system.md`）。
- **解决的核心问题**：ZCode 的额度只能在其官方客户端里花掉——上游是私有 Anthropic Messages 端点，且要求阿里云「无痕验证」参数。本插件把这层私有性抹平，让 Claude Code / CCSwitch / 任意 OpenAI 兼容客户端都能用上这份额度。

```
客户端 → xrl-router → 本插件（:19065）→ open.bigmodel.cn / zcode.z.ai / api.z.ai
         ↑ 协议转换、       ↑ 凭证自持、业务头注入、无痕验证
           故障转移、用量统计
```

## 为什么存在？

协议转换、供应商故障转移、用量统计——这些 xrl-router 都已经有了。社区项目 `zcode2api` 证明了**怎么访问** ZCode 上游（端点、业务头、无痕验证），但它把自己实现成了带后台 UI 与 SQLite 账号池的独立网关，与 router 的职责重叠。本插件只保留其中无法被 router 替代的那一层。

> **V24 契约**：xrl-router 不再为插件管理密钥，对插件只发占位凭证 `xrl-router`。
> 凭证由插件自持（`.env` 的 `ZCODE_KEYS`），注册时**不发送** `keys`，也不再有心跳密钥同步。

## 如何安装和运行？

**前置要求**：Node.js ≥ 20、pnpm、一个运行中的 xrl-router（默认 `http://localhost:19068`）。

```bash
pnpm install

# 1. 拿凭证（默认国内站 BigModel OAuth，浏览器授权）
pnpm run login

# 2. 体检：确认凭证可用并查看剩余额度
pnpm capture-key

# 3. 启动（默认端口 19065）
pnpm serve
```

启动后在 xrl-router 界面确认插件上线 → 添加供应商 → 用注册的模型别名调用。

模型清单**默认自动发现**（从上游 `/api/v1/client/configs` 的 `builtinModels`），不写 `ZCODE_MODELS` 也能用。
想自定义别名再在 `.env` 里写。

```bash
curl http://localhost:19065/health
```

## 两条凭证路线

ZCode 的 Coding Plan 额度有**两条**可用路线，本插件默认走免验证码的那条：

| 路线 | 凭证 | 端点 | 无痕验证 | 状态 |
|------|------|------|:---:|------|
| **A（默认）** OAuth 兑换 | `apiKeyId.secretKey`（长期 API Key） | 国内站 `open.bigmodel.cn/api/anthropic` / 国际站 `api.z.ai/api/anthropic` | ❌ 不需要 | ✅ 国内站真实账号已验证鉴权 |
| **B（兜底）** Coding Plan JWT | 三段点分 JWT | `zcode.z.ai/.../zcode-plan/anthropic` | ✅ 需要 | ⚠️ 撞 3012 账号级风控 |

### 国内站优先（默认）

`ZCODE_SITE` 默认 **`bigmodel`**，面向国内用户：

- OAuth 授权页是 **`bigmodel.cn/login`**
- 兑换链走 `bigmodel.cn/api/biz/*`（access_token 直接作 Bearer，**无需** `/api/auth/z/login`）
- 免验证码推理端点是 **`open.bigmodel.cn/api/anthropic`**
- `pnpm capture-key` 用 `open.bigmodel.cn/api/paas/v4/models` 探活

国际站需显式设置 `ZCODE_SITE=zai`：授权页 `chat.z.ai`，兑换先调 `api.z.ai/api/auth/z/login`，
推理走 `api.z.ai/api/anthropic`。站点选择只影响 OAuth 与 API Key 路线；JWT 主端点两个站点相同。

`pnpm run login` 默认走 **路线 A**：OAuth 授权后，把 `access_token` 兑换成一个名为
`zcode-api-key` 的长期 API Key，再用它打对应站点的 Anthropic 兼容端点——**全程不碰无痕验证**。
这正是 ZCode 官方客户端自己在用的链路（逆向自本机 `app.asar`）。

兑换失败时自动回退保存 JWT（路线 B），并告警该形态需要无痕验证。

## ⚠️ 路线 B（JWT + 无痕验证）撞账号级风控

如果你手上只有 Coding Plan 的 JWT、走路线 B，请注意：ZCode 的 zcode-plan 端点要求一个
阿里云「无痕验证」签发的请求头。本插件用 Node + jsdom 跑阿里云官方 SDK 求这个参数，
链路本身是通的（SDK 加载 → 设备指纹请求 → 拿到 `certifyId`）。

- **F001（疑似攻击请求）已被硬化指纹桩突破**——伪装 Chrome UA、补 `navigator.webdriver`、
  `chrome`/`screen`/canvas/WebGL 指纹等改动已生效
- **当前阻塞是 ESA WAF 的账号/IP 维度风控**：`400 code:3007` / `3012 unusual activity`，
  同一账号在本机反复求解后被判异常。这不是 jsdom 指纹问题，继续调桩没有意义

**所以路线 B 当前仍不可用，请用路线 A（`pnpm run login` 默认即是）。**
详见 [docs/reverse/ZCODE_REVERSE.md](./docs/reverse/ZCODE_REVERSE.md) 第 6.7 节与
[docs/DECISIONS.md](./docs/DECISIONS.md) D-9 / D-10。

## 当前状态

- **阶段**：开发中。HTTP 网关已迁移到 **Hono** 与 xrl-router **V24 插件契约**
  （无 keys 注册 / 心跳无 timestamp / 端口占用幂等退出 / 插件自持凭证）。
  转发 / 聚合 / 错误映射 / 兑换链（国内站 3 步、国际站 4 步）/ 模型自动发现 /
  注册载荷 / 凭证故障转移由 `pnpm e2e` 的 69 条离线断言覆盖并全绿。
- **已知限制**：
  - **路线 A（国内站）已完成真实账号验证的登录、兑换与鉴权**：`/copy` 兑换链成功产出
    `apiKeyId.secretKey`；`capture-key` 探活 `open.bigmodel.cn/api/paas/v4/models` → 200；
    真实推理请求返回上游 `429 code:1310「您已达到每周/每月使用上限」`（重置时间
    2026-10-22 11:23:27），而非 401——说明 key 已通过鉴权并绑定账户套餐额度。
    额度重置后的成功生成与计费扣减明细仍待复测，见 `docs/reverse` 第 7 节
  - 路线 B（JWT + 无痕验证）撞账号/IP 级 `3012` 风控，见上一节
  - 额度 / 计费字段结构基于社区观测，不同套餐可能有差异

## 核心技术

Node.js 20+ · TypeScript 5 · Hono 4 · @hono/node-server · ws · jsdom（跑阿里云无痕 SDK 求 `verifyParam`）· pnpm

## 延伸阅读

- [AGENTS.md](./AGENTS.md) — 项目边界与 Non Goals
- [docs/PRD.md](./docs/PRD.md) — 功能需求与存在的意义
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 架构、模块、数据流
- [docs/DECISIONS.md](./docs/DECISIONS.md) — 设计决策背后的历史原因
- [docs/reverse/ZCODE_REVERSE.md](./docs/reverse/ZCODE_REVERSE.md) — ZCode 上游逆向成果与致谢
- [docs/specs/](./docs/specs/) — 各模块规格
