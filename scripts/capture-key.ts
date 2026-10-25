#!/usr/bin/env tsx
/**
 * scripts/capture-key.ts — `pnpm capture-key`：校验 `.env` 里的凭证并查剩余额度。
 *
 * 只读，不修改任何文件。做三件事：
 *   1. 逐个凭证判定形态（JWT / API Key）
 *   2. JWT 打 `/billing/current`（套餐）、`/billing/balance`（各模型剩余额度）、
 *      `/usage`（近期用量）
 *   3. 打印脱敏摘要
 *
 * 与 `docs/specs/module-login.md` 配套：login 负责拿凭证，本脚本负责体检。
 */

import { KEYS_ENV_KEY, settings } from '../src/config';
import { classifySecret } from '../src/zcode/auth';
import { maskSecret, readEnvFileValue } from './envFile';

const ok = (s: string): void => console.log(`✅ ${s}`);
const warn = (s: string): void => console.warn(`⚠️  ${s}`);

interface ProbeOutcome {
  label: string;
  detail: string;
  healthy: boolean;
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 200)}`);
  }
}

/** 从 `{code,data:{...}}` 或裸对象里取有效载荷 */
function payloadOf(body: any): any {
  return body && typeof body === 'object' && 'data' in body ? body.data : body;
}

function formatUnits(value: unknown): string {
  return typeof value === 'number' ? String(value) : value === undefined || value === null ? '—' : String(value);
}

/**
 * 体检一个 API Key 形态的凭证（`apiKeyId.secretKey`，即 OAuth 兑换出的免验证码 key）。
 * 用对应站点的 paas /models（轻量 GET）探活：假 key 返回 401，有效 key 返回 200。
 */
async function probeApiKey(apiKey: string): Promise<ProbeOutcome> {
  const isBigmodel = settings.site === 'bigmodel';
  const probeUrl = `${isBigmodel ? settings.bigmodelOpenBase : settings.zaiApiBase}/api/paas/v4/models`;
  const label = isBigmodel
    ? 'API Key（国内站 · open.bigmodel.cn）'
    : 'API Key（国际站 · api.z.ai）';
  try {
    const resp = await fetch(probeUrl, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 401 || resp.status === 403) {
      const text = (await resp.text()).slice(0, 160);
      return {
        label,
        detail: `      探活失败 HTTP ${resp.status}：${text}\n      → 密钥无效或已过期，重跑 pnpm run login 重新兑换`,
        healthy: false,
      };
    }
    if (!resp.ok) {
      return {
        label,
        detail: `      探活返回 HTTP ${resp.status}（非 401，端点可达，密钥可能有效）`,
        healthy: true,
      };
    }
    return {
      label,
      detail: `      探活成功（GET ${new URL(probeUrl).pathname} → 200），密钥有效`,
      healthy: true,
    };
  } catch (err) {
    return {
      label,
      detail: `      探活异常：${(err as Error).message}`,
      healthy: false,
    };
  }
}

/** 体检一个 JWT 形态的 Coding Plan 凭证 */
async function probeJwt(jwt: string): Promise<ProbeOutcome> {
  const headers = { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' };
  const base = settings.billingBase;

  const lines: string[] = [];
  let healthy = true;

  // ── 套餐 ──
  try {
    const data = payloadOf(await getJson(`${base}/billing/current`, headers));
    const plan = (data?.plans ?? [])[0];
    lines.push(`套餐：${plan?.name ?? plan?.plan_name ?? JSON.stringify(plan ?? data).slice(0, 120)}`);
  } catch (err) {
    healthy = false;
    lines.push(`套餐：查询失败（${(err as Error).message}）`);
  }

  // ── 各模型剩余额度 ──
  try {
    const data = payloadOf(await getJson(`${base}/billing/balance`, headers));
    const balances: any[] = data?.balances ?? [];
    if (balances.length === 0) {
      lines.push('额度：接口未返回 balances 字段');
    } else {
      for (const b of balances) {
        const name = b.show_name ?? b.model ?? 'model';
        lines.push(
          `额度：${name}  剩余 ${formatUnits(b.remaining_units)} / 共 ${formatUnits(b.total_units)}` +
            `（已用 ${formatUnits(b.used_units)}）`,
        );
      }
    }
  } catch (err) {
    healthy = false;
    lines.push(`额度：查询失败（${(err as Error).message}）`);
  }

  // ── 近期用量（拿不到不算失败）──
  try {
    const data = payloadOf(await getJson(`${base}/usage`, headers));
    lines.push(`用量：${JSON.stringify(data).slice(0, 200)}`);
  } catch (err) {
    lines.push(`用量：查询失败（${(err as Error).message}）`);
  }

  return {
    label: 'JWT（Coding Plan）',
    detail: lines.map((l) => `      ${l}`).join('\n'),
    healthy,
  };
}

async function main(): Promise<void> {
  console.log('🔑 xrp-zcode · 凭证体检\n');

  const fromFile = readEnvFileValue(KEYS_ENV_KEY);
  const raw = fromFile || process.env[KEYS_ENV_KEY] || '';
  const keys = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    warn(`.env 里没有 ${KEYS_ENV_KEY}。先执行 pnpm run login，或手动写入 ZCODE_KEYS=<jwt>`);
    return;
  }

  console.log(`站点：${settings.site === 'bigmodel' ? '国内站 BigModel' : '国际站 Z.AI'}`);
  console.log(`计费端点：${settings.billingBase}`);
  console.log(`共 ${keys.length} 个凭证\n`);

  let healthyCount = 0;

  for (let i = 0; i < keys.length; i++) {
    const secret = keys[i];
    const kind = classifySecret(secret);
    console.log(`── [${i + 1}/${keys.length}] ${maskSecret(secret)} ─────────────────`);

    // 两种形态各自探活：apiKey 走对应站点的开放平台（免验证码主路线），JWT 走 zcode-plan 计费端点
    const outcome = kind === 'apiKey' ? await probeApiKey(secret) : await probeJwt(secret);
    console.log(`   形态：${outcome.label}`);
    console.log(outcome.detail);
    if (outcome.healthy) {
      healthyCount++;
      ok('该凭证可用');
    } else {
      warn('该凭证查询失败——可能已过期，重跑 pnpm run login');
    }
    console.log('');
  }

  console.log(`体检完成：${healthyCount} / ${keys.length} 个凭证可用`);
}

main().catch((err) => {
  console.error(`\n❌ 未预期的错误：${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
