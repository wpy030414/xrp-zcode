#!/usr/bin/env tsx
/**
 * scripts/e2e.ts — 离线端到端自测（不需要任何真实凭证）。
 *
 * 做法：起两个 mock——一个假 ZCode 上游（HTTP），一个假 xrl-router（WS）——
 * 然后把插件指向它们，逐条验证对外行为契约。这样能在没有 Coding Plan 账号的
 * 情况下覆盖全部关键路径：协议透传、聚合、模型归一化、凭证分流、错误码映射、
 * 验证码缓存与刷新、注册载荷与心跳。
 *
 *   pnpm e2e
 *
 * 退出码 0 = 全绿；非 0 = 有断言失败。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';

// ── 断言工具 ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Mock ZCode 上游 ─────────────────────────────────────────────────────────

interface RecordedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

/** 每个 SSE 帧之间插入的延迟，用来模拟真实流式 */
const FRAME_DELAY_MS = 8;

function buildSseFrames(model: string): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '你好' },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '，前辈' },
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
}

interface MockUpstream {
  port: number;
  records: RecordedRequest[];
  /** 上游 configs 接口被请求过的原始 URL（用于断言「不能带查询参数」） */
  configUrls: string[];
  /** 只对第一个 captcha 场景返回 403，用于验证「刷新后重试成功」 */
  resetCaptchaOnce: () => void;
  close: () => Promise<void>;
}

async function startMockUpstream(): Promise<MockUpstream> {
  const records: RecordedRequest[] = [];
  const configUrls: string[] = [];
  let captchaOnceLeft = 0;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const url = req.url || '';

      // 验证码场景配置接口 + 模型清单自动发现接口（同一个端点）
      if (url.startsWith('/configs')) {
        configUrls.push(url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              configs: {
                captcha: { sceneId: 'mock-scene', region: 'mock-region', prefix: 'mock-prefix' },
              },
              builtinModels: [
                { modelId: 'GLM-5.3', name: 'GLM-5.3' },
                { modelId: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' },
                { modelId: 'GLM-5.3', name: 'GLM-5.3（重复项，用于验证去重）' },
              ],
              providers: [
                {
                  id: 'z-ai',
                  schema: 'anthropic',
                  models: [{ modelId: 'GLM-5.3' }, { modelId: 'GLM-5.2' }],
                },
              ],
            },
          }),
        );
        return;
      }

      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* 允许空体 */
      }
      records.push({ url, headers: req.headers, body });

      const scenario = String(body.mock_scenario || '');
      const fail = (status: number, message: string): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'mock_error', message } }));
      };

      if (scenario === '402') return fail(402, 'insufficient quota');
      if (scenario === '429') return fail(429, 'rate limit exceeded');
      if (scenario === '401') return fail(401, 'invalid api key');
      // 只让 JWT 失败，用于验证插件会顺延到下一把 API Key
      if (scenario === 'jwt401' && String(req.headers.authorization || '').startsWith('Bearer ')) {
        return fail(401, 'invalid jwt');
      }
      if (scenario === 'captcha403') return fail(403, 'captcha verify failed');
      // 真实上游形态：HTTP 400 + {"code":3007,"msg":"captcha verify failed"}（见 reverse 6.6）
      if (scenario === 'captcha400') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 3007, msg: 'captcha verify failed', logid: 'mock' }));
      }
      if (scenario === 'captcha403once') {
        if (captchaOnceLeft > 0) {
          captchaOnceLeft--;
          return fail(403, 'captcha verify failed');
        }
      }

      // 默认：按 Anthropic SSE 逐帧吐
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frames = buildSseFrames(body.model || 'unknown');
      let i = 0;
      const timer = setInterval(() => {
        if (i >= frames.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(frames[i++]);
      }, FRAME_DELAY_MS);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    records,
    configUrls,
    resetCaptchaOnce: () => {
      captchaOnceLeft = 1;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ── Mock xrl-router（只收 WS 消息）───────────────────────────────────────────

interface MockRouter {
  port: number;
  messages: any[];
  waitFor: (type: string, timeoutMs?: number) => Promise<any | null>;
  close: () => Promise<void>;
}

async function startMockRouter(): Promise<MockRouter> {
  const messages: any[] = [];
  const waiters: Array<{ type: string; resolve: (m: any | null) => void }> = [];

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });

  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      messages.push(msg);

      // 复刻 V24 router：register 带 keys 即回错并断开
      if (msg.type === 'register' && Object.prototype.hasOwnProperty.call(msg, 'keys')) {
        messages.push({ type: 'error', reason: 'keys_not_supported' });
        socket.send(JSON.stringify({ type: 'error', reason: 'keys_not_supported' }));
        socket.close();
        return;
      }

      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === msg.type) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    });
  });

  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const port = (wss.address() as { port: number }).port;

  return {
    port,
    messages,
    waitFor: (type, timeoutMs = 3000) =>
      new Promise((resolve) => {
        const existing = messages.find((m) => m.type === type);
        if (existing) return resolve(existing);
        const waiter = { type, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) {
            waiters.splice(idx, 1);
            resolve(null);
          }
        }, timeoutMs);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

// ── Mock 兑换业务端（国内站 3 步 / 国际站 4 步）──────────────────────────────

interface MockZaiApi {
  port: number;
  hits: string[];
  /** 与 hits 一一对应的 Authorization 头（验证国内站直接用 access_token） */
  auths: string[];
  close: () => Promise<void>;
}

const EXCHANGED_KEY_ID = 'mockkeyid123';
const EXCHANGED_SECRET = 'mocksecret456';
/** 国际站经过 z/login 换来的业务 token */
const ZAI_BIZ_TOKEN = 'Bearer mock-biz-token';
/** 国内站：OAuth access_token 直接作为业务 token */
const BIGMODEL_OAUTH_TOKEN = 'Bearer mock-oauth-access-token';

async function startMockZaiApi(): Promise<MockZaiApi> {
  const hits: string[] = [];
  const auths: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const url = req.url || '';
      hits.push(`${req.method} ${url}`);
      auths.push(String(req.headers.authorization ?? ''));
      const auth = String(req.headers.authorization ?? '');
      const bizAuthOk = auth === ZAI_BIZ_TOKEN || auth === BIGMODEL_OAUTH_TOKEN;
      const json = (data: any): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 0, msg: '', data, success: true }));
      };
      const unauthorized = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 401, msg: 'token expired or incorrect', success: false }));
      };

      // 仅国际站：OAuth access_token → biz token
      if (url === '/api/auth/z/login') {
        const body = JSON.parse(raw || '{}');
        if (body.token !== 'mock-oauth-access-token') return json(null);
        return json({ access_token: 'mock-biz-token' });
      }
      // getCustomerInfo → 默认机构/项目
      if (url === '/api/biz/customer/getCustomerInfo') {
        if (!bizAuthOk) return unauthorized();
        return json({
          organizations: [
            { organizationId: 'org-1', organizationName: '我的默认机构', projects: [
              { projectId: 'proj-1', projectName: '默认项目' },
              { projectId: 'proj-2', projectName: '其他项目' },
            ] },
          ],
        });
      }
      // 3/4. api_keys 列表 / 创建 / copy
      const keysMatch = url.match(/^\/api\/biz\/v1\/organization\/org-1\/projects\/proj-1\/api_keys(\/copy\/(.+))?$/);
      if (keysMatch) {
        if (!bizAuthOk) return unauthorized();
        if (keysMatch[2]) {
          // copy/{apiKeyId} → secretKey
          if (decodeURIComponent(keysMatch[2]) !== EXCHANGED_KEY_ID) return json(null);
          return json({ secretKey: EXCHANGED_SECRET });
        }
        if (req.method === 'GET') {
          // 已存在名为 zcode-api-key 的密钥
          return json([{ name: 'zcode-api-key', apiKey: EXCHANGED_KEY_ID }]);
        }
        // POST 创建
        return json({ name: 'zcode-api-key', apiKey: EXCHANGED_KEY_ID });
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 404, msg: 'not found', success: false }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    hits,
    auths,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtb2NrIn0.signature';
const API_KEY = 'sk-mock-zai-api-key';
const PLUGIN_PORT = 19165;
/** V24：router 对插件恒发占位凭证 */
const ROUTER_PLACEHOLDER = 'xrl-router';

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-e2e-'));
  const counterFile = path.join(tmpDir, 'solver-count.txt');
  fs.writeFileSync(counterFile, '');

  const upstream = await startMockUpstream();
  const router = await startMockRouter();
  const zaiApi = await startMockZaiApi();

  // ⚠ 必须在 require 插件模块之前设好——settings 在 import 时求值
  process.env.ZCODE_PORT = String(PLUGIN_PORT);
  process.env.ZCODE_SITE = 'bigmodel';
  process.env.ZCODE_BASE_URL = `http://127.0.0.1:${upstream.port}/zcode-messages`;
  process.env.ZAI_FALLBACK_URL = `http://127.0.0.1:${upstream.port}/zai-messages`;
  process.env.BIGMODEL_ANTHROPIC_URL = `http://127.0.0.1:${upstream.port}/bigmodel-messages`;
  process.env.ZCODE_CAPTCHA_CONFIG_URL = `http://127.0.0.1:${upstream.port}/configs`;
  process.env.ZAI_API_BASE = `http://127.0.0.1:${zaiApi.port}`;
  process.env.BIGMODEL_API_BASE_URL = `http://127.0.0.1:${zaiApi.port}`;
  process.env.BIGMODEL_OPEN_BASE_URL = `http://127.0.0.1:${zaiApi.port}`;
  process.env.ZCODE_SOLVER_PATH = path.join(__dirname, 'mock-solver.cjs');
  process.env.ZCODE_CAPTCHA_RETRIES = '1';
  process.env.ZCODE_CAPTCHA_CACHE_TTL = '60000';
  process.env.ZCODE_MODELS = 'GLM-5.2=glm-5.2,GLM-5-Turbo';
  process.env.ZCODE_KEYS = `${JWT},${API_KEY}`;
  process.env.XRL_ROUTER_URL = `http://127.0.0.1:${router.port}`;
  process.env.ZCODE_HEARTBEAT_INTERVAL_MS = '300';
  process.env.MOCK_SOLVER_COUNTER = counterFile;

  // 延迟加载：此刻 settings 才读到上面的值
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { createApp } = require('../src/index') as typeof import('../src/index');
  const { PluginClient } = require('../src/pluginClient') as typeof import('../src/pluginClient');
  const { isPortInUse } = require('../src/port') as typeof import('../src/port');
  const { fetchClientConfigs } = require('../src/zcode/configs') as typeof import('../src/zcode/configs');
  const { resolveCodingPlanApiKey } = require('../src/zcode/exchange') as typeof import('../src/zcode/exchange');
  const { classifySecret, buildUpstreamRequest } = require('../src/zcode/auth') as typeof import('../src/zcode/auth');

  const app = createApp();
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: PLUGIN_PORT, hostname: '127.0.0.1' }, () => resolve(s));
  });

  const pluginClient = new PluginClient();
  const base = `http://127.0.0.1:${PLUGIN_PORT}`;

  // 所有入站请求都带 router 的占位凭证，模拟真实链路
  const post = (body: any, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ROUTER_PLACEHOLDER, ...headers },
      body: JSON.stringify(body),
    });

  const solverCalls = (): number =>
    fs
      .readFileSync(counterFile, 'utf8')
      .split('\n')
      .filter(Boolean).length;

  try {
    // ── 1. 元信息端点 ──────────────────────────────────────────────────────
    section('1. 元信息端点');

    const health = await (await fetch(`${base}/health`)).json();
    check('GET /health 报 healthy + provider_kind=messages',
      health.status === 'healthy' && health.provider_kind === 'messages', JSON.stringify(health));
    check('GET /health 的 api_path 是 /v1/messages', health.api_path === '/v1/messages');
    check('GET /health 标明 V24 契约与自持凭证数量',
      health.contract === 'v24' && health.credentials_configured === 2, JSON.stringify(health));
    check('默认站点是国内站 BigModel', health.site === 'bigmodel', String(health.site));
    check('国内站默认的 API Key 上游是 open.bigmodel.cn 兼容端点',
      health.api_key_upstream === `http://127.0.0.1:${upstream.port}/bigmodel-messages`,
      String(health.api_key_upstream));

    const root = await (await fetch(`${base}/`)).json();
    check('GET / 暴露模型清单', Array.isArray(root.models) && root.models.length === 2,
      JSON.stringify(root.models));

    const notFound = await fetch(`${base}/v1/models`);
    check('未实现的端点返回 404', notFound.status === 404);

    check('端口占用探测能识别正在监听的实例', (await isPortInUse(PLUGIN_PORT)) === true);

    // ── 2. 流式透传 ────────────────────────────────────────────────────────
    section('2. 流式透传（字节级）');

    const expectedSse = buildSseFrames('GLM-5.2').join('');
    const streamRes = await post({
      model: 'GLM-5.2',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: '你好' }],
    });
    const streamText = await streamRes.text();
    check('流式响应 200', streamRes.status === 200, `HTTP ${streamRes.status}`);
    check(
      'Content-Type 透传为 text/event-stream',
      (streamRes.headers.get('content-type') || '').includes('text/event-stream'),
      streamRes.headers.get('content-type') || '',
    );
    check('SSE 字节与上游逐帧一致（无损透传）', streamText === expectedSse,
      `\n       期望 ${expectedSse.length} 字节 / 实收 ${streamText.length} 字节`);

    const lastRecord = upstream.records[upstream.records.length - 1];
    check('上游收到的 stream 被强制为 true', lastRecord.body.stream === true);

    // ── 3. 非流式聚合 ──────────────────────────────────────────────────────
    section('3. 非流式聚合');

    const nonStreamRes = await post({
      model: 'GLM-5.2',
      max_tokens: 64,
      stream: false,
      messages: [{ role: 'user', content: '你好' }],
    });
    const aggregated = await nonStreamRes.json();
    check('非流式响应 200 且为单条 message', nonStreamRes.status === 200 && aggregated.type === 'message',
      JSON.stringify(aggregated).slice(0, 200));
    check('聚合出的文本正确', aggregated.content?.[0]?.text === '你好，前辈',
      JSON.stringify(aggregated.content));
    check('聚合出的 stop_reason 正确', aggregated.stop_reason === 'end_turn');
    check('聚合出的 usage 合并了 message_delta', aggregated.usage?.output_tokens === 5,
      JSON.stringify(aggregated.usage));

    // ── 4. 模型名归一化 ────────────────────────────────────────────────────
    section('4. 模型名归一化');

    upstream.records.length = 0;
    await post({ model: 'glm-5.2', stream: false, max_tokens: 8, messages: [] });
    check('小写别名 glm-5.2 → 上游收到 GLM-5.2',
      upstream.records[0]?.body.model === 'GLM-5.2', upstream.records[0]?.body.model);

    upstream.records.length = 0;
    await post({ model: 'zai/GLM-5-Turbo', stream: false, max_tokens: 8, messages: [] });
    check('带前缀 zai/GLM-5-Turbo → 上游收到 GLM-5-Turbo',
      upstream.records[0]?.body.model === 'GLM-5-Turbo', upstream.records[0]?.body.model);

    upstream.records.length = 0;
    await post({ model: 'glm-5-turbo', stream: false, max_tokens: 8, messages: [] });
    check('按展示名匹配 glm-5-turbo → 上游收到 GLM-5-Turbo',
      upstream.records[0]?.body.model === 'GLM-5-Turbo', upstream.records[0]?.body.model);

    // ── 5. 凭证自持与 JWT 分流 ─────────────────────────────────────────────
    section('5. 凭证自持与 JWT 分流');

    upstream.records.length = 0;
    await post({ model: 'GLM-5.2', stream: false, max_tokens: 8, messages: [] });
    const jwtRec = upstream.records[0];
    check('JWT 走 Coding Plan 端点', jwtRec.url === '/zcode-messages', jwtRec.url);
    check('JWT 用 Authorization: Bearer', jwtRec.headers.authorization === `Bearer ${JWT}`,
      String(jwtRec.headers.authorization));
    check('router 的占位凭证没有被转发给上游',
      jwtRec.headers['x-api-key'] === undefined &&
        !String(jwtRec.headers.authorization || '').includes(ROUTER_PLACEHOLDER),
      `x-api-key=${String(jwtRec.headers['x-api-key'])} authorization=${String(jwtRec.headers.authorization)}`);
    check('JWT 带上无痕验证头', typeof jwtRec.headers['x-aliyun-captcha-verify-param'] === 'string',
      String(jwtRec.headers['x-aliyun-captcha-verify-param']));
    check('无痕验证头内容来自场景配置（透传到求解器）',
      String(jwtRec.headers['x-aliyun-captcha-verify-param']).includes('mock-scene'),
      String(jwtRec.headers['x-aliyun-captcha-verify-param']));
    check('带上 anthropic-version', jwtRec.headers['anthropic-version'] === '2023-06-01');
    check('带上 ZCode 业务头', typeof jwtRec.headers['x-zcode-agent'] === 'string');

    // ── 6. 验证码缓存 ──────────────────────────────────────────────────────
    section('6. 验证码缓存');

    // 第 2-5 节共发起了 6 个 JWT 请求（含流式/非流式/多种模型名），
    // 缓存正确的话求解器全程只该被 spawn 一次。
    check(
      '多个 JWT 请求合计只求解 1 次（verifyParam 缓存命中）',
      solverCalls() === 1,
      `实际求解 ${solverCalls()} 次`,
    );

    for (let i = 0; i < 3; i++) {
      await post({ model: 'GLM-5.2', stream: false, max_tokens: 8, messages: [] });
    }
    check('TTL 内再连发 3 个请求仍不新增求解', solverCalls() === 1,
      `实际求解 ${solverCalls()} 次`);

    // ── 7. 错误码映射 ──────────────────────────────────────────────────────
    section('7. 错误码映射（多凭证耗尽后透传）');

    for (const [scenario, expected] of [
      ['402', 402],
      ['429', 429],
      ['401', 401],
    ] as const) {
      const res = await post({ model: 'GLM-5.2', mock_scenario: scenario, messages: [] });
      check(`两把凭证都 ${scenario} → 插件透传 ${expected}`, res.status === expected, `实际 ${res.status}`);
    }

    const captchaAlways = await post({ model: 'GLM-5.2', mock_scenario: 'captcha403' });
    check('验证码持续失效 → 返回 502（而非 403，避免误标红密钥）',
      captchaAlways.status === 502, `实际 ${captchaAlways.status}`);

    // 真实上游形态（reverse 6.6）：HTTP 400 + code:3007 captcha verify failed
    const captcha400 = await post({ model: 'GLM-5.2', mock_scenario: 'captcha400' });
    check('真实上游形态 400+code:3007 → 也识别为验证码失效并返回 502',
      captcha400.status === 502, `实际 ${captcha400.status}`);

    upstream.resetCaptchaOnce();
    const captchaOnce = await post({ model: 'GLM-5.2', mock_scenario: 'captcha403once' });
    check('验证码失效一次 → 刷新后重试成功（200）', captchaOnce.status === 200,
      `实际 ${captchaOnce.status}`);

    // ── 8. 凭证故障转移（V24：router 不再轮换插件密钥）───────────────────────
    section('8. 凭证故障转移');

    upstream.records.length = 0;
    const failoverRes = await post({
      model: 'GLM-5.2',
      mock_scenario: 'jwt401',
      stream: false,
      max_tokens: 8,
      messages: [],
    });
    check('JWT 返回 401 → 自动顺延到下一把 API Key 并成功', failoverRes.status === 200,
      `实际 ${failoverRes.status}`);
    check('先尝试 Coding Plan 端点、再尝试国内站 BigModel 端点',
      upstream.records.map((r) => r.url).join(',') === '/zcode-messages,/bigmodel-messages',
      JSON.stringify(upstream.records.map((r) => r.url)));
    const failoverRec = upstream.records[1];
    check('API Key 走国内站 BigModel 端点', failoverRec?.url === '/bigmodel-messages', failoverRec?.url);
    check('API Key 用 x-api-key 头', failoverRec?.headers['x-api-key'] === API_KEY,
      String(failoverRec?.headers['x-api-key']));
    check('API Key 不带无痕验证头',
      failoverRec?.headers['x-aliyun-captcha-verify-param'] === undefined);
    check('国内站 API Key 不带 ZCode 业务头',
      failoverRec?.headers['x-zcode-agent'] === undefined &&
        failoverRec?.headers['x-zcode-app-version'] === undefined);

    // 同一份 API Key 在国际站要打 api.z.ai（且保留 ZCode 业务头）
    const zaiApiKeyReq = buildUpstreamRequest(API_KEY, 'apiKey', null, 'zai');
    check('ZCODE_SITE=zai 时 API Key 走国际站端点',
      zaiApiKeyReq.url === `http://127.0.0.1:${upstream.port}/zai-messages`, zaiApiKeyReq.url);
    check('国际站 API Key 保留 ZCode 业务头',
      typeof zaiApiKeyReq.headers['x-zcode-agent'] === 'string');
    check('占位凭证从未出现在任何上游请求里',
      upstream.records.every(
        (r) =>
          r.headers['x-api-key'] !== ROUTER_PLACEHOLDER &&
          !String(r.headers.authorization || '').includes(ROUTER_PLACEHOLDER),
      ));

    // ── 9. 注册载荷与心跳 ──────────────────────────────────────────────────
    section('9. 注册载荷与心跳');

    const register = await router.waitFor('register');
    check('已向 xrl-router 发送 register', register !== null);
    check('plugin_id 正确', register?.plugin_id === 'xrl-router-plugin-zcode', String(register?.plugin_id));
    check('provider.kind = messages', register?.provider?.kind === 'messages', String(register?.provider?.kind));
    check('provider.api_path = /v1/messages', register?.provider?.api_path === '/v1/messages');
    check('base_url 指向插件自身端口',
      register?.provider?.base_url === `http://localhost:${PLUGIN_PORT}`,
      String(register?.provider?.base_url));
    check('register 不含 keys 字段（V24 严格拒绝）',
      register !== null && !Object.prototype.hasOwnProperty.call(register, 'keys'),
      JSON.stringify(register));
    check('register 携带 workdir', typeof register?.workdir === 'string' && register.workdir.length > 0,
      String(register?.workdir));
    check('router 没有回 keys_not_supported',
      router.messages.every((m) => m.type !== 'error'), JSON.stringify(router.messages.filter((m) => m.type === 'error')));
    check('models 数量与 ZCODE_MODELS 一致', register?.models?.length === 2,
      JSON.stringify(register?.models));
    check('models 保留上游大小写 + 自定义展示名',
      register?.models?.[0]?.model_id === 'GLM-5.2' && register?.models?.[0]?.display_name === 'glm-5.2',
      JSON.stringify(register?.models?.[0]));

    const hbBefore = router.messages.filter((m) => m.type === 'heartbeat').length;
    await sleep(1000);
    const hbAfter = router.messages.filter((m) => m.type === 'heartbeat').length;
    check('心跳按周期持续发送（1s 内 ≥2 次）', hbAfter - hbBefore >= 2,
      `实际 ${hbAfter - hbBefore} 次`);
    const lastHb = [...router.messages].reverse().find((m) => m.type === 'heartbeat');
    check('心跳载荷只有 type（V24 不上报 timestamp）',
      lastHb !== undefined && Object.keys(lastHb).length === 1,
      JSON.stringify(lastHb));

    // ── 10. 上游配置接口（验证码场景 + 模型自动发现）─────────────────────────
    section('10. 上游 configs 接口');

    check('请求 configs 接口时不携带任何查询参数',
      upstream.configUrls.length > 0 && upstream.configUrls.every((u) => !u.includes('?')),
      JSON.stringify(upstream.configUrls));

    const configs = await fetchClientConfigs();
    check('自动发现取到上游模型清单',
      JSON.stringify(configs?.models.map((m) => m.modelId)) ===
        JSON.stringify(['GLM-5.3', 'GLM-5.3-Flash']),
      JSON.stringify(configs?.models));
    check('builtinModels 优先、去重保序，且不混入 providers 的清单',
      configs?.models.length === 2 && configs?.models[0]?.modelId === 'GLM-5.3',
      JSON.stringify(configs?.models));
    check('同一接口也提供验证码场景参数',
      configs?.captcha?.sceneId === 'mock-scene' && configs?.captcha?.region === 'mock-region',
      JSON.stringify(configs?.captcha));
    check('configs 结果被缓存（不重复请求上游）',
      upstream.configUrls.length === 1, `实际请求 ${upstream.configUrls.length} 次`);

    // ── 11. 兑换链：OAuth access_token → 免验证码 API Key（双站点）──────────
    section('11. 兑换链（国内站 3 步 / 国际站 4 步）');

    // 默认 = 国内站：access_token 直接作 Bearer，没有 z/login
    zaiApi.hits.length = 0;
    zaiApi.auths.length = 0;
    const bmExchanged = await resolveCodingPlanApiKey('mock-oauth-access-token');
    check('国内站兑换出 apiKeyId.secretKey 形态的密钥',
      bmExchanged.apiKey === `${EXCHANGED_KEY_ID}.${EXCHANGED_SECRET}`, bmExchanged.apiKey);
    check('兑换结果被 classifySecret 判为 apiKey（→ 走免验证码分支）',
      classifySecret(bmExchanged.apiKey) === 'apiKey', classifySecret(bmExchanged.apiKey));
    check('命中默认机构/默认项目',
      bmExchanged.organizationName === '我的默认机构' && bmExchanged.projectName === '默认项目',
      `${bmExchanged.organizationName} / ${bmExchanged.projectName}`);
    check('国内站按 3 步链路兑换（无 z/login）',
      zaiApi.hits.length === 3 &&
        zaiApi.hits[0] === 'GET /api/biz/customer/getCustomerInfo' &&
        zaiApi.hits[1].includes('/api_keys') &&
        zaiApi.hits[2].includes('/copy/'),
      JSON.stringify(zaiApi.hits));
    check('国内站直接拿 OAuth access_token 当业务 Bearer',
      zaiApi.auths.every((a) => a === BIGMODEL_OAUTH_TOKEN), JSON.stringify(zaiApi.auths));

    // 显式国际站：先 z/login 换 biz token，再走同样的三步
    zaiApi.hits.length = 0;
    zaiApi.auths.length = 0;
    const zaiExchanged = await resolveCodingPlanApiKey('mock-oauth-access-token', {
      site: 'zai',
      zaiApiBase: `http://127.0.0.1:${zaiApi.port}`,
    });
    check('国际站兑换出同样的 apiKeyId.secretKey',
      zaiExchanged.apiKey === `${EXCHANGED_KEY_ID}.${EXCHANGED_SECRET}`, zaiExchanged.apiKey);
    check('国际站按 4 步链路兑换（z/login 先行）',
      zaiApi.hits.length === 4 &&
        zaiApi.hits[0] === 'POST /api/auth/z/login' &&
        zaiApi.hits[1] === 'GET /api/biz/customer/getCustomerInfo' &&
        zaiApi.hits[2].includes('/api_keys') &&
        zaiApi.hits[3].includes('/copy/'),
      JSON.stringify(zaiApi.hits));
    check('国际站业务请求用 z/login 换来的 biz token',
      zaiApi.auths[0] === '' && zaiApi.auths.slice(1).every((a) => a === ZAI_BIZ_TOKEN),
      JSON.stringify(zaiApi.auths));

    // 兑换失败要抛错（login.ts 依赖此行为回退到存 JWT）
    let threw = false;
    try {
      await resolveCodingPlanApiKey('wrong-token');
    } catch {
      threw = true;
    }
    check('无效 access_token 兑换时抛错（供 login 回退 JWT）', threw);

    pluginClient.close();
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });    await upstream.close();
    await router.close();
    await zaiApi.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  通过 ${passed} / 共 ${passed + failed}`);
  console.log(`${'═'.repeat(64)}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 e2e 运行异常：', err);
  process.exit(1);
});
