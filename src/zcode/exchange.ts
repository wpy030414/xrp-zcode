/**
 * zcode/exchange.ts — 把 OAuth access_token 兑换成长期 API Key。
 *
 * 【这是绕开阿里云无痕验证 F001 的关键】逆向自 ZCode 官方客户端
 * （app.asar → glm/zcode.cjs 的 createCodingPlanApiKeyResolver / resolveZaiBizToken /
 *  resolveBizApiKey），详见 docs/reverse/ZCODE_REVERSE.md 第 4 节与第 8 节。
 *
 * 官方对 Coding Plan（订阅额度）的真实用法**不是**打 zcode-plan 端点+无痕验证，
 * 而是把 OAuth access_token 兑换成一个名为 "zcode-api-key" 的长期 API Key
 * （形态 `apiKeyId.secretKey`），再用它打各站点的 Anthropic 兼容端点——该端点
 * **不需要无痕验证**。
 *
 * 两条兑换链（按 ZCODE_SITE 分流）：
 *
 * 国内站 BigModel（默认）：
 *   1. GET  {bigmodelApiBase}/api/biz/customer/getCustomerInfo           → 机构/项目
 *   2. GET  .../organization/{org}/projects/{proj}/api_keys              → 找/建 "zcode-api-key"
 *   3. GET  .../api_keys/copy/{apiKeyId}                                 → secretKey
 *   （OAuth access_token 直接作为 Bearer，无需 /api/auth/z/login）
 *   ⇒ API Key 打 https://open.bigmodel.cn/api/anthropic
 *
 * 国际站 Z.AI（ZCODE_SITE=zai）：
 *   1. POST {zaiApiBase}/api/auth/z/login {token: accessToken}           → bizToken
 *   2. GET  {zaiApiBase}/api/biz/customer/getCustomerInfo                → 机构/项目
 *   3. GET  .../api_keys（没有则创建）→ GET .../copy/{apiKeyId}          → secretKey
 *   ⇒ API Key 打 https://api.z.ai/api/anthropic
 *
 * 上游业务码约定（COe/G5s）：code 为 null/0/200/"0"/"200" 视为成功，其余抛错。
 */

import { settings, type ZcodeSite } from '../config';

/** 兑换出的 API Key，形如 `<apiKeyId>.<secretKey>` */
export interface ExchangedKey {
  /** 完整密钥，可直接作为 x-api-key 使用 */
  apiKey: string;
  /** 仅 apiKeyId 部分（脱敏展示用） */
  apiKeyId: string;
  /** 命中的机构 / 项目名（诊断用） */
  organizationName?: string;
  projectName?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const FETCH_TIMEOUT_MS = 30_000;

/** 业务码是否为成功（对齐官方 isSuccessfulRemoteCode / G5s） */
function isOkCode(code: unknown): boolean {
  return code == null || code === 0 || code === 200 || code === '0' || code === '200';
}

/**
 * 调上游业务接口，解包 `{code,msg,data}` 信封。code 非成功即抛错。
 * `init` 为 fetch 的 RequestInit；返回 `data`（可能为 null）。
 */
async function requestRemoteData(
  url: string,
  init: RequestInit,
  authorization?: string,
): Promise<any> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (authorization) headers['authorization'] = authorization;

  const resp = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const text = await resp.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${url} 返回非 JSON（HTTP ${resp.status}）：${text.slice(0, 160)}`);
  }
  if (!isOkCode(payload?.code)) {
    throw new Error(`${url} 业务错误 code=${payload?.code}：${payload?.msg ?? '(无 msg)'}`);
  }
  return payload?.data ?? null;
}

export interface ExchangeOptions {
  /** 覆盖 settings.site（e2e 用来在一次进程内验证两条链） */
  site?: ZcodeSite;
  /** 覆盖 BigModel / Z.AI 业务根（e2e 指向 mock） */
  bigmodelApiBase?: string;
  zaiApiBase?: string;
}

/** 第 1 步（仅国际站）：OAuth access_token → api.z.ai 业务 token */
export async function resolveZaiBizToken(
  accessToken: string,
  base: string = settings.zaiApiBase,
): Promise<string> {
  const data = await requestRemoteData(`${base}/api/auth/z/login`, {
    method: 'POST',
    body: JSON.stringify({ token: accessToken }),
  });
  const bizToken = (data?.access_token ?? data?.accessToken ?? '').trim();
  if (!bizToken) throw new Error('z/login 未返回业务 access_token');
  return bizToken;
}

/** 从机构列表里挑「默认机构 / 默认项目」（对齐官方 pickOrgAndProject / H5s） */
function pickOrgAndProject(customerInfo: any): {
  organizationId: string;
  projectId: string;
  organizationName?: string;
  projectName?: string;
} | null {
  const orgs: any[] = customerInfo?.organizations ?? [];
  const org = orgs.find((o) => String(o?.organizationName ?? '').includes('默认机构')) ?? orgs[0];
  if (!org?.organizationId) return null;
  const projects: any[] = org.projects ?? [];
  const proj =
    projects.find((p) => String(p?.projectName ?? '').includes('默认项目')) ?? projects[0];
  if (!proj?.projectId) return null;
  return {
    organizationId: String(org.organizationId),
    projectId: String(proj.projectId),
    organizationName: org.organizationName,
    projectName: proj.projectName,
  };
}

/** 第 2-4 步：业务鉴权头 → 找/建 "zcode-api-key" → 取 secretKey */
export async function resolveBizApiKey(
  authorization: string,
  opts: { base: string; requireSecretKey?: boolean },
): Promise<ExchangedKey> {
  const auth = authorization;
  const base = opts.base;

  const customerInfo = await requestRemoteData(
    `${base}/api/biz/customer/getCustomerInfo`,
    { method: 'GET' },
    auth,
  );
  const picked = pickOrgAndProject(customerInfo);
  if (!picked) throw new Error('无法从账户信息中解析出机构与项目');

  const keysUrl = `${base}/api/biz/v1/organization/${picked.organizationId}/projects/${picked.projectId}/api_keys`;

  const existing: any[] = (await requestRemoteData(keysUrl, { method: 'GET' }, auth)) ?? [];
  let keyObj = existing.find((k) => k?.name === 'zcode-api-key');
  if (!keyObj) {
    keyObj = await requestRemoteData(
      keysUrl,
      { method: 'POST', body: JSON.stringify({ name: 'zcode-api-key' }) },
      auth,
    );
  }

  const apiKeyId = String(keyObj?.apiKey ?? keyObj?.api_key ?? '').trim();
  if (!apiKeyId) throw new Error('api_keys 响应缺少 apiKey 字段');

  const copy = await requestRemoteData(
    `${keysUrl}/copy/${encodeURIComponent(apiKeyId)}`,
    { method: 'GET' },
    auth,
  );
  const secretKey = String(copy?.secretKey ?? '').trim();
  const meta = {
    apiKeyId,
    organizationName: picked.organizationName,
    projectName: picked.projectName,
  };

  if (!secretKey) {
    if (opts.requireSecretKey) throw new Error('copy 响应缺少 secretKey');
    return { ...meta, apiKey: apiKeyId };
  }
  return { ...meta, apiKey: `${apiKeyId}.${secretKey}` };
}

/**
 * 完整兑换：OAuth access_token → 可直接使用的 API Key。
 * 失败抛错（调用方决定是否回退到 JWT）。
 */
export async function resolveCodingPlanApiKey(
  accessToken: string,
  options: ExchangeOptions = {},
): Promise<ExchangedKey> {
  const trimmed = (accessToken || '').trim();
  if (!trimmed) throw new Error('缺少 OAuth access_token');

  const site = options.site ?? settings.site;
  if (site === 'bigmodel') {
    // 国内站：access_token 本身就是 BigModel 业务 token，无需 z/login
    return resolveBizApiKey(`Bearer ${trimmed}`, {
      base: options.bigmodelApiBase ?? settings.bigmodelApiBase,
      requireSecretKey: true,
    });
  }

  const zaiBase = options.zaiApiBase ?? settings.zaiApiBase;
  const bizToken = await resolveZaiBizToken(trimmed, zaiBase);
  return resolveBizApiKey(`Bearer ${bizToken}`, { base: zaiBase, requireSecretKey: true });
}
