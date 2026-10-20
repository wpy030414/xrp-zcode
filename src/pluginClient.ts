/**
 * pluginClient.ts — 连接 xrl-router 的 WebSocket 客户端（V24 契约）。
 *
 * 协议见 xrl-router `docs/specs/module-plugin-system.md`：
 *   插件 → Router：register / heartbeat
 *   Router → 插件：registered / reconnected / error / deleted
 *
 * V24 要点：
 * - register **不能带 keys**（带了 router 直接拒绝并断开）
 * - 心跳只发 `{"type":"heartbeat"}`，router 自己打时间戳
 * - 凭证由插件自持，不再有 keys_update
 *
 * 生命周期：启动即连接 → 注册（首次落 pending，用户确认后转 active）→
 * 每 30s 心跳 → 断线指数退避重连。
 */

import { WebSocket } from 'ws';

import { PLUGIN_ID, PROVIDER_API_PATH, PROVIDER_KIND, settings } from './config';

export interface PluginClientOptions {
  /** 注入给 e2e 用：观察到 Router 发来的消息 */
  onMessage?: (msg: any) => void;
}

export class PluginClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private reconnectAttempts = 0;
  private connected = false;

  private readonly onMessage?: (msg: any) => void;

  /** 供 e2e 断言 */
  public readonly sentMessages: any[] = [];

  constructor(options: PluginClientOptions = {}) {
    this.onMessage = options.onMessage;
    this.connect();
  }

  private get wsUrl(): string {
    return settings.xrlRouterUrl.replace(/^http/, 'ws') + '/ws/plugin';
  }

  private connect(): void {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log(`[plugin] 已连接 xrl-router（${settings.xrlRouterUrl}）`);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.sendRegister();
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => this.handleMessage(data.toString()));

    this.ws.on('close', () => {
      if (this.connected) console.warn('[plugin] 与 xrl-router 的连接已断开');
      this.connected = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      // 连接失败会紧跟 close，重连交给 scheduleReconnect，这里只留痕。
      // ws 在 ECONNREFUSED 场景下可能给出空 message，补上 code/errno 便于排查。
      const detail = err.message || (err as NodeJS.ErrnoException).code || String(err);
      if (this.reconnectAttempts <= 1) {
        console.warn(`[plugin] 暂时连不上 xrl-router（${detail}），将持续重连…`);
      }
    });
  }

  /** 构造注册消息（V24：无 keys，带 workdir） */
  buildRegisterMessage(): Record<string, unknown> {
    return {
      type: 'register',
      plugin_id: PLUGIN_ID,
      provider: {
        // 告诉 router「本上游说的是 Anthropic Messages」——router 的 IR 层
        // 会替我们做客户端协议 ↔ Messages 的双向转换
        kind: PROVIDER_KIND,
        base_url: `http://localhost:${settings.port}`,
        api_path: PROVIDER_API_PATH,
      },
      models: settings.models.map((m) => ({
        model_id: m.modelId,
        display_name: m.displayName,
        tier: 'custom',
      })),
      workdir: process.cwd(),
    };
  }

  private sendRegister(): void {
    this.send(this.buildRegisterMessage());
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    this.onMessage?.(msg);

    switch (msg?.type) {
      case 'registered':
        console.log(
          `[plugin] 注册成功：provider ${msg.provider_id}（${msg.status ?? 'active'}）` +
            (msg.status === 'pending_confirmation' ? '，等待在 xrl-router 界面确认' : ''),
        );
        break;
      case 'reconnected':
        console.log(`[plugin] 已重连既有 provider ${msg.provider_id}`);
        break;
      case 'deleted':
        console.warn('[plugin] 插件记录已被 xrl-router 删除，重连后将重新注册');
        break;
      case 'error':
        console.error(`[plugin] xrl-router 返回错误：${msg.reason ?? JSON.stringify(msg)}`);
        break;
      default:
        break;
    }
  }

  private send(message: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sentMessages.push(message);
      this.ws.send(JSON.stringify(message));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, settings.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      settings.reconnectBaseMs * 2 ** this.reconnectAttempts,
      settings.reconnectMaxMs,
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  close(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}
