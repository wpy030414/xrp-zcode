/**
 * zcode/auth.ts — 凭证形态判定、上游请求构造、错误分类。
 *
 * 本模块是纯函数集合，不持有状态、不发网络请求，便于单测与 e2e 断言。
 */

import { settings, type ZcodeSite } from '../config';

export type SecretKind = 'jwt' | 'apiKey';

/**
 * 判定凭证形态。
 *
 * ZCode Coding Plan 的凭证是 OAuth 签发的 JWT（三段点分）；其余形态一律
 * 当作 Z.AI API Key 处理——这正是 zcode2api 的 `secret.count(".") == 2`
 * 判定法，保持一致以免两边行为分叉。
 */
export function classifySecret(secret: string): SecretKind {
  const parts = (secret || '').trim().split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0) ? 'jwt' : 'apiKey';
}

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  kind: SecretKind;
}

/** 无痕验证参数请求头（阿里云） */
export const CAPTCHA_HEADER = 'x-aliyun-captcha-verify-param';

/**
 * 构造上游请求（端点 + 请求头）。
 *
 * - JWT → `ZCODE_BASE_URL`（Coding Plan 端点），带 `Authorization: Bearer`
 *   与无痕验证头 `X-Aliyun-Captcha-Verify-Param`
 * - API Key → 按站点选端点：国内站 `BIGMODEL_ANTHROPIC_URL`
 *   （open.bigmodel.cn），国际站 `ZAI_FALLBACK_URL`（api.z.ai）；都无需验证码
 *
 * `verifyParam` 仅在 JWT 形态下有意义；缺失时不带该头（让上游如实报错）。
 */
export function buildUpstreamRequest(
  secret: string,
  kind: SecretKind,
  verifyParam: string | null,
  site: ZcodeSite = settings.site,
): UpstreamRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'user-agent': settings.upstream.userAgent,
  };

  if (kind === 'jwt') {
    // ZCode 业务头只对 zcode-plan 端点有意义
    headers['x-zcode-app-version'] = settings.upstream.appVersion;
    headers['x-zcode-agent'] = settings.upstream.agent;
    headers['http-referer'] = 'https://zcode.z.ai/';
    headers['authorization'] = `Bearer ${secret}`;
    if (verifyParam) headers[CAPTCHA_HEADER] = verifyParam;
    return { url: settings.zcodeBaseUrl, headers, kind };
  }

  headers['x-api-key'] = secret;
  if (site === 'bigmodel') {
    // 国内站是标准 Anthropic 兼容端点，不需要 ZCode 业务头
    return { url: settings.bigmodelFallbackUrl, headers, kind };
  }

  headers['x-zcode-app-version'] = settings.upstream.appVersion;
  headers['x-zcode-agent'] = settings.upstream.agent;
  headers['http-referer'] = 'https://zcode.z.ai/';
  return { url: settings.zaiFallbackUrl, headers, kind };
}

/**
 * 判断上游响应是否属于「无痕验证失效」。
 *
 * 上游对验证码问题返回 403 + 含 captcha/verify 字样的错误体。必须把它与
 * 「凭证真的失效」区分开：前者应刷新验证码重试，后者才该让 xrl-router
 * 把密钥标红。
 */
export function isCaptchaRejection(status: number, body: string): boolean {
  if (status !== 403 && status !== 400) return false;
  const low = (body || '').toLowerCase();
  return (
    low.includes('captcha') ||
    low.includes('verify token') ||
    low.includes('verify failed') ||
    low.includes('verify_param') ||
    low.includes('无痕') ||
    low.includes('人机')
  );
}

/** 构造 Anthropic 形态的错误体（直连调用方看这个；router 只关心状态码） */
export function anthropicErrorBody(
  type: string,
  message: string,
): { type: 'error'; error: { type: string; message: string } } {
  return { type: 'error', error: { type, message } };
}
