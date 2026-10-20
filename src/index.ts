/**
 * index.ts — 插件入口：Hono 网关 + xrl-router 注册（V24 契约）。
 *
 * 对外只暴露一个业务端点：`POST /v1/messages`（Anthropic Messages 协议）。
 * 之所以是 Messages 而不是 Chat Completions：见 src/zcode/client.ts 顶部注释。
 *
 * 启动流程：端口幂等检查 → 解析模型清单 → 监听 → 连 xrl-router 注册 → 打印配置摘要。
 * 端口已有实例在监听时干净退出（exit 0），不抢占——这是 V24 对 `serve` 的要求。
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { KEYS_ENV_KEY, PLUGIN_ID, PROVIDER_API_PATH, PROVIDER_KIND, settings } from './config';
import { PluginClient } from './pluginClient';
import { isPortInUse } from './port';
import { anthropicErrorBody, classifySecret } from './zcode/auth';
import { forwardMessages, MAX_CAPTCHA_REFRESH } from './zcode/client';
import { fetchClientConfigs } from './zcode/configs';

export interface RunningServer {
  server: ReturnType<typeof serve>;
  pluginClient: PluginClient;
  port: number;
  /** 关闭 HTTP 服务与 WS 客户端 */
  close: () => Promise<void>;
}

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', cors());

  // 元信息（探针 / 人肉排障用）
  app.get('/', (c) =>
    c.json({
      version: '0.2.0',
      service: PLUGIN_ID,
      status: 'running',
      mode: 'plugin',
      contract: 'v24',
      site: settings.site,
      upstream: settings.zcodeBaseUrl,
      api_key_upstream:
        settings.site === 'bigmodel' ? settings.bigmodelFallbackUrl : settings.zaiFallbackUrl,
      endpoints: { messages: PROVIDER_API_PATH, health: '/health' },
      models: settings.models.map((m) => ({
        model_id: m.modelId,
        display_name: m.displayName,
      })),
    }),
  );

  app.get('/health', (c) =>
    c.json({
      status: 'healthy',
      mode: 'plugin',
      contract: 'v24',
      site: settings.site,
      provider_kind: PROVIDER_KIND,
      api_path: PROVIDER_API_PATH,
      base_url: `http://localhost:${settings.port}`,
      upstream: settings.zcodeBaseUrl,
      api_key_upstream:
        settings.site === 'bigmodel' ? settings.bigmodelFallbackUrl : settings.zaiFallbackUrl,
      models: settings.models.length,
      credentials_configured: settings.keys.length,
    }),
  );

  app.post(PROVIDER_API_PATH, async (c) => {
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return new Response(
        JSON.stringify(anthropicErrorBody('invalid_request_error', '请求体不是合法 JSON')),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    // 入站凭证（router 的占位值 xrl-router）一律忽略，凭证由插件自持
    return forwardMessages(body, c.req.raw.signal);
  });

  app.notFound((c) =>
    c.json(anthropicErrorBody('not_found', `本插件仅提供 POST ${PROVIDER_API_PATH}`), 404),
  );

  return app;
}

/**
 * 模型清单解析：显式配置优先，否则问上游 configs 接口要（拿不到就用内置默认）。
 * 必须在构造 PluginClient 之前完成——注册载荷里的 models 在那一刻定型。
 */
async function resolveModels(): Promise<void> {
  if (settings.modelsExplicit) return;

  const configs = await fetchClientConfigs();
  if (configs && configs.models.length > 0) {
    settings.models = configs.models;
    settings.modelsSource = `上游 configs 自动发现（${configs.models.length} 个）`;
  }
}

/** 打印启动配置摘要 + 提醒配置缺口 */
function printBanner(): void {
  const keys = settings.keys;
  const jwtCount = keys.filter((k) => classifySecret(k) === 'jwt').length;

  console.log('');
  console.log(`  ${PLUGIN_ID}`);
  console.log(`  监听      http://localhost:${settings.port}${PROVIDER_API_PATH}`);
  console.log(
    `  站点      ${settings.site === 'bigmodel' ? '国内站 BigModel（智谱）' : '国际站 Z.AI'}`,
  );
  console.log(`  注册      注册为 ${PROVIDER_KIND} 供应商 → ${settings.xrlRouterUrl}`);
  console.log(`  上游      ${settings.zcodeBaseUrl}`);
  console.log(
    `  API Key   ${settings.site === 'bigmodel' ? settings.bigmodelFallbackUrl : settings.zaiFallbackUrl}`,
  );
  console.log(`  模型源    ${settings.modelsSource}`);
  console.log(`  模型      ${settings.models.map((m) => (m.displayName === m.modelId ? m.modelId : `${m.modelId}(→${m.displayName})`)).join(', ')}`);
  console.log(`  凭证      ${keys.length} 项（JWT ${jwtCount} / 其他 ${keys.length - jwtCount}）`);
  console.log('');

  if (!settings.modelsExplicit) {
    console.log('  ℹ 未配置 ZCODE_MODELS，已按上游公布的清单注册。');
    console.log('    如需自定义别名，在 .env 写 ZCODE_MODELS=GLM-5.3=glm-5.3,...');
  }
  if (keys.length === 0) {
    console.warn(`  ⚠ ${KEYS_ENV_KEY} 为空，插件没有可用凭证。先跑 pnpm run login。`);
  } else if (jwtCount === keys.length) {
    console.warn('  ⚠ 当前全部凭证都是 Coding Plan JWT（路线 B），请求需要无痕验证，');
    console.warn('    且可能触发账号级 3012 风控。建议 pnpm run login 兑换 API Key（路线 A）。');
  }
}

/**
 * 启动网关。端口已被监听时返回 null（调用方应 exit 0），不抢占现有实例。
 */
export async function startServer(
  options: { port?: number } = {},
): Promise<RunningServer | null> {
  const port = options.port ?? settings.port;

  if (await isPortInUse(port)) {
    console.log(`[plugin] 端口 ${port} 已有实例在监听，按 V24 幂等契约干净退出。`);
    return null;
  }

  await resolveModels();

  const app = createApp();
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => resolve(s));
  });

  printBanner();

  const pluginClient = new PluginClient();

  const close = async (): Promise<void> => {
    pluginClient.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, pluginClient, port, close };
}

/* istanbul ignore next — 仅在作为入口脚本运行时启动 */
if (require.main === module) {
  startServer()
    .then((running) => {
      if (!running) {
        process.exit(0);
      }
      const shutdown = (signal: string): void => {
        console.log(`\n[plugin] 收到 ${signal}，正在退出…`);
        running
          .close()
          .catch(() => undefined)
          .finally(() => process.exit(0));
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((err) => {
      console.error(`[plugin] 启动失败：${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
}

export { MAX_CAPTCHA_REFRESH };
