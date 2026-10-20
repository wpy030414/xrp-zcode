#!/usr/bin/env tsx
/**
 * scripts/login.ts — `pnpm run login`：OAuth 登录 → 兑换成免验证码的长期 API Key。
 *
 * 【默认国内站】ZCODE_SITE 默认 `bigmodel`：OAuth init 传 `provider:"bigmodel"`，
 * 服务端返回的授权页是 https://bigmodel.cn/login；兑换走 bigmodel.cn/api/biz/*，
 * 得到的 API Key 打 https://open.bigmodel.cn/api/anthropic（免无痕验证）。
 * 国际站用 `ZCODE_SITE=zai`：授权页 chat.z.ai，兑换走 api.z.ai。
 *
 * 【为什么不是直接存 JWT】逆向 ZCode 官方客户端发现：官方对 Coding Plan 额度
 * 走的是「兑换成长期 API Key → 打各站点的 Anthropic 兼容端点（免无痕验证）」，
 * 而不是「JWT → zcode-plan 端点 + 阿里云无痕验证」。后者当前被风控拒。
 * 所以本脚本默认存**兑换后的 API Key**，让转发层自动走免验证码分支。
 * 详见 docs/reverse/ZCODE_REVERSE.md 第 4/8 节与 docs/DECISIONS.md D-10/D-12。
 *
 * 流程：
 *   1. POST {oauthBase}/oauth/cli/init      → flow_id / authorize_url（poll_token 本地随机生成）
 *   2. 浏览器授权（国内站 → bigmodel.cn，国际站 → chat.z.ai）
 *   3. GET  {oauthBase}/oauth/cli/poll/{id} → 轮询至 status=ready，
 *      取 data[provider].access_token（及 data.token=JWT）
 *   4. resolveCodingPlanApiKey(access_token) → `apiKeyId.secretKey`（免验证码凭证）
 *   5. 写回 .env 的 ZCODE_KEYS（合并、去重、不覆盖别的变量）
 *
 * 兜底：兑换失败时（例如账户无默认机构/项目），退回保存 JWT，并提示该形态需要
 * 无痕验证、当前可能不可用——保证 login 至少不丢凭证。
 *
 * 运行时零客户端依赖：全程纯 HTTP，不需要安装 ZCode 桌面端。
 */

import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { KEYS_ENV_KEY, settings } from '../src/config';
import { classifySecret } from '../src/zcode/auth';
import { resolveCodingPlanApiKey } from '../src/zcode/exchange';
import { maskSecret, mergeKeyList, readEnvFileValue, upsertEnvValue } from './envFile';

const OAUTH_BASE = settings.oauthBase;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 100; // ≈ 200s

const ok = (s: string): void => console.log(`✅ ${s}`);
const warn = (s: string): void => console.warn(`⚠️  ${s}`);
const fail = (s: string): void => console.error(`\n❌ ${s}`);

interface InitResult {
  flowId: string;
  authorizeUrl: string;
}

async function initFlow(pollToken: string): Promise<InitResult> {
  const resp = await fetch(`${OAUTH_BASE}/oauth/cli/init`, {
    method: 'POST',
    headers: { authorization: `Bearer ${pollToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: settings.site }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`init 失败 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);

  const data = (await resp.json())?.data ?? {};
  const flowId = data.flow_id;
  const authorizeUrl = data.authorize_url;
  if (!flowId || !authorizeUrl) throw new Error('init 返回的流程数据不完整');
  return { flowId, authorizeUrl };
}

async function pollOnce(pollToken: string, flowId: string): Promise<any> {
  const resp = await fetch(`${OAUTH_BASE}/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
    headers: { authorization: `Bearer ${pollToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`poll 失败 HTTP ${resp.status}`);
  return (await resp.json())?.data ?? {};
}

/** 尽力用系统默认浏览器打开（失败不阻断——URL 已打印） */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => undefined);
}

/** 把凭证合并进 .env 的 ZCODE_KEYS */
function persistKey(secret: string, hint: string): void {
  const existing = readEnvFileValue(KEYS_ENV_KEY) || process.env[KEYS_ENV_KEY] || '';
  const merged = mergeKeyList(existing, secret);
  try {
    const changed = upsertEnvValue(KEYS_ENV_KEY, merged);
    ok(`已写入 .env：${KEYS_ENV_KEY} = ${maskSecret(secret)}（${hint}）`);
    if (!changed) warn('该凭证已在列表中，未重复写入。');
    console.log(`   当前密钥池共 ${merged.split(',').filter(Boolean).length} 项。`);
  } catch (err) {
    fail((err as Error).message);
    console.log(`\n   手动写入也行：${KEYS_ENV_KEY}=${secret}`);
  }
}

async function main(): Promise<void> {
  const siteLabel =
    settings.site === 'bigmodel' ? '国内站 BigModel（open.bigmodel.cn）' : '国际站 Z.AI（api.z.ai）';
  console.log(`🔑 xrl-router-plugin · zcode 登录（OAuth → 兑换免验证码 API Key）`);
  console.log(`   站点：${siteLabel}\n`);

  const pollToken = randomBytes(32).toString('hex');

  let flow: InitResult;
  try {
    flow = await initFlow(pollToken);
  } catch (err) {
    fail(`OAuth 初始化失败：${(err as Error).message}`);
    return;
  }

  ok('OAuth 初始化成功，请在浏览器中完成授权：');
  console.log(`\n   ${flow.authorizeUrl}\n`);
  openBrowser(flow.authorizeUrl);
  console.log('   正在等待授权…（最多 200 秒）\n');

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let data: any;
    try {
      data = await pollOnce(pollToken, flow.flowId);
    } catch {
      continue; // 网络抖动忽略，继续轮询
    }

    const status = data?.status;
    if (status === 'failed') {
      fail('授权失败或被拒绝。');
      return;
    }
    if (status !== 'ready') continue;

    // ready 载荷（对齐官方 parseReadyData / Ota）：
    // { token: JWT, zai: { access_token }, bigmodel: { access_token }, user: {...} }
    // provider 字段名就是 "zai" / "bigmodel"
    const providerData = data?.[settings.site] ?? {};
    const accessToken: string | undefined =
      providerData?.access_token ?? providerData?.accessToken;
    const jwt: string | undefined = data?.token;

    if (!accessToken && !jwt) {
      fail(`授权完成，但响应里既没有 ${settings.site}.access_token 也没有 token，无法继续。`);
      return;
    }

    // ── 首选：兑换成免验证码的长期 API Key ──
    if (accessToken) {
      console.log('   正在把 OAuth 凭证兑换成长期 API Key（免无痕验证）…');
      try {
        const exchanged = await resolveCodingPlanApiKey(accessToken);
        persistKey(
          exchanged.apiKey,
          settings.site === 'bigmodel' ? '免验证码 · 走 open.bigmodel.cn' : '免验证码 · 走 api.z.ai',
        );
        if (exchanged.organizationName || exchanged.projectName) {
          console.log(`   机构/项目：${exchanged.organizationName ?? '?'} / ${exchanged.projectName ?? '?'}`);
        }
        console.log('\n   下一步：pnpm capture-key 校验凭据 → pnpm serve 启动');
        return;
      } catch (err) {
        warn(`兑换 API Key 失败：${(err as Error).message}`);
        console.log('   → 回退保存 Coding Plan JWT（该形态需要无痕验证，当前可能不可用）');
      }
    }

    // ── 兜底：存 JWT ──
    if (jwt) {
      if (classifySecret(jwt) !== 'jwt') warn('拿到的 token 不是三段点分 JWT，按原样保存。');
      persistKey(jwt, 'JWT · 需无痕验证');
      console.log('\n   注意：JWT 形态走 zcode-plan 端点，需要无痕验证；若被风控拒（F001）将返回 502。');
      return;
    }

    fail('既无 access_token 可兑换，也无 JWT 可保存。');
    return;
  }

  fail('登录超时，请重新执行 pnpm run login。');
}

main().catch((err) => {
  fail(`未预期的错误：${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
