# Spec — 插件注册（module-plugin-registration）

## 要构建什么

按 xrl-router V24 的插件协议把自己注册成委托供应商，并维持注册态。

实现：`src/pluginClient.ts`。

## 行为

### 连接

- 地址：`XRL_ROUTER_URL` 的 `http` → `ws`，路径 `/ws/plugin`
- 连接成功后立刻发 `register`，然后每 30s（`ZCODE_HEARTBEAT_INTERVAL_MS`）发一次 `heartbeat`
- 心跳载荷固定为 `{ "type": "heartbeat" }`，**不带时间戳或其他字段**
- 断线 → 指数退避重连：`ZCODE_RECONNECT_BASE_MS` × 2^n，封顶 `ZCODE_RECONNECT_MAX_MS`（默认 1s → 60s）

### register 载荷

```jsonc
{
  "type": "register",
  "plugin_id": "xrl-router-plugin-zcode",
  "provider": {
    "kind": "messages",                      // ← 关键：告诉 router 上游说的是 Anthropic Messages
    "base_url": "http://localhost:19065",
    "api_path": "/v1/messages"
  },
  "models": [
    { "model_id": "GLM-5.2", "display_name": "glm-5.2", "tier": "custom" }
  ],
  "workdir": "<插件进程的工作目录>"
}
```

- **不得包含 `keys` 字段**：V24 对 `kind=messages` 的插件不接受推送密钥池，出现 `keys` 会被回
  `{"type":"error","reason":"keys_not_supported"}` 并断连。凭据由插件自持（见 D-11）
- `models` 来自 `ZCODE_MODELS`：`model_id` 是上游名（原样），`display_name` 是客户端别名
- `tier` 固定 `custom`
- `workdir` 为 `process.cwd()`，供 router 展示与诊断

### 入站消息处理

| 消息 | 行为 |
|------|------|
| `registered`（`status: pending_confirmation`） | 日志提示「等待在 xrl-router 界面确认」 |
| `reconnected` | 日志提示已重连既有 provider |
| `deleted` | 日志提示已被 router 删除；不主动重注册，等待连接重建 |
| `error` | 日志输出 `reason` |
| 其他 | 忽略 |

### 生命周期对照

| 阶段 | 触发 | 结果 |
|------|------|------|
| 注册 | WS 连接建立 | 首次 → router 落 `pending`，前端弹确认框；重连 → 直接复用既有 provider |
| 确认 | 用户在 router 界面点确认 | provider `enabled = 1`，开始接流量 |
| 服务 | 心跳维持 | router 每 30s 检查，>90s 未心跳标记离线并禁用 provider |
| 离线 | WS 断开 | router 置 `status=offline`、`enabled=0`；插件持续重连 |

### 端口幂等

`startServer()` 启动前探测 19065：

- 已在监听（无论 loopback 还是通配地址）→ **不杀进程、不报错**，直接以 0 退出
- 未监听 → 正常启动

这是为了满足 `serve` 的幂等要求：重复执行 `pnpm serve` 不应影响已运行的实例。

## 输入 / 输出

- **输入**：`settings`（plugin_id / port / models / xrlRouterUrl / 各间隔）
- **输出**：WebSocket 文本帧；进程内 `sentMessages` 数组（供 e2e 断言）

## 约束

- `plugin_id` 必须是**插件名**而非 provider UUID —— router 用它作为 `plugins` 表主键做在线判定
- 注册消息中的 `base_url` 端口必须与本地实际监听端口一致，否则 router 会打到空端口
- WS 与转发链路**完全解耦**：WS 断开不影响已建立的本地转发能力
- 注册前必须先解析模型清单（`startServer()` 里 `await fetchClientConfigs()`），避免推空清单

## 边界条件

- router 未启动 → 连接失败，退避重连；本地 HTTP 服务照常可用（e2e 之外的日常形态）
- router 删除了本插件记录 → router 主动关闭连接 → 插件重连后重新注册（回到 pending）
- 无凭据（`ZCODE_KEYS` 为空）→ 仍正常注册；转发时返回 503 `configuration_error`
- 端口被其他程序占用 → `pnpm serve` 幂等退出 0，由用户自行判断是否是本插件实例

## 验收标准

- [x] `pnpm e2e` 第 8 节：`plugin_id` / `provider.kind` / `api_path` / `base_url` / `models` / `workdir` 全部正确
- [x] `pnpm e2e` 第 8 节：register 不含 `keys`，router 不回 `keys_not_supported`
- [x] `pnpm e2e` 第 8 节：心跳载荷只有 `type`，且按周期持续发送
- [x] `pnpm e2e` 第 1 节：端口占用探测能识别正在监听的实例
- [x] `models` 保留上游大小写并携带自定义展示名（`GLM-5.2` / `glm-5.2`）

## 完成定义

在真实 xrl-router 下 `pnpm serve` 后，router 界面出现待确认插件；确认后该 provider 可被模型别名路由到，且关掉插件后 router 侧转为离线。
