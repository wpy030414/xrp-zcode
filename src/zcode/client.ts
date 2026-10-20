/**
 * zcode/client.ts — 转发 Anthropic Messages 请求到 ZCode 上游。
 *
 * 为什么本模块不做任何协议转换：xrl-router 注册供应商时我们报的 `kind` 是
 * `messages`，router 的 IR 层（`api/proxy/ir/`）已经把客户端三种协议
 * （messages / chat_completions / responses）统一转成 Anthropic Messages 再发过来，
 * 返回的 SSE 也由 router 按 messages 格式反解。所以这里**原样透传字节流**即可。
 *
 * 凭证来源（V24 契约）：Router 不再管理插件密钥，只会发占位凭证 `xrl-router`。
 * 插件必须忽略入站凭证，用自己 `.env` 里的 `ZCODE_KEYS` 访问上游。多把凭证按
 * 顺序尝试，成功的一把会被记住；401/402/403/429 视为「这把不行」顺延下一把，
 * 其余错误立即透传。
 *
 * 错误契约：
 *  - 上游的 401/402/403/429 → 换下一把凭证；全部失败后原样透传最后一个状态码
 *  - 无痕验证失效 → 内部刷新重试，仍失败返回 **502**（插件侧故障，不该污染凭证健康度）
 */

import { KEYS_ENV_KEY, settings } from '../config';
import { aggregateAnthropicStream } from './aggregate';
import {
  anthropicErrorBody,
  buildUpstreamRequest,
  classifySecret,
  isCaptchaRejection,
  type SecretKind,
} from './auth';
import { captchaManager } from './captcha';
import { canonicalModelId } from './models';

/**
 * 同一请求内「验证码失效 → 刷新 → 重试」的次数上限。
 * 注意与 `settings.captcha.retries` 的区别：后者是单次求解内部的重试。
 */
export const MAX_CAPTCHA_REFRESH = 3;

/** 这些状态码表示「换一把凭证可能还有救」，其余错误与凭证无关 */
const KEY_LEVEL_STATUS = new Set([401, 402, 403, 429]);

interface KeyAttempt {
  key: string;
  index: number;
  kind: SecretKind;
}

/** 上一把成功的凭证；下次请求从它开始，避免每次都先撞一遍坏凭证 */
let preferredKeyIndex = 0;

function orderedKeys(): KeyAttempt[] {
  const keys = settings.keys;
  if (keys.length === 0) return [];
  const start = Math.min(preferredKeyIndex, keys.length - 1);
  return keys.map((_, offset) => {
    const index = (start + offset) % keys.length;
    return { key: keys[index], index, kind: classifySecret(keys[index]) };
  });
}

function isAbortError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 原样返回上游错误体（状态码是 router 判断可用性的依据） */
function upstreamErrorResponse(status: number, text: string): Response {
  return new Response(
    text ||
      JSON.stringify(anthropicErrorBody('api_error', `上游返回 HTTP ${status}`)),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

/** 流式透传上游字节流（不做任何解析） */
function streamResponse(upstream: Response): Response {
  const headers = new Headers();
  headers.set('content-type', upstream.headers.get('content-type') || 'text/event-stream');
  headers.set('cache-control', 'no-cache');
  headers.set('x-accel-buffering', 'no');
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** 非流式客户端：上游仍是 SSE，聚合后一次性返回 */
async function aggregatedResponse(upstream: Response): Promise<Response> {
  try {
    if (!upstream.body) {
      return jsonResponse(502, anthropicErrorBody('api_error', '上游返回空响应体'));
    }
    return jsonResponse(200, await aggregateAnthropicStream(upstream.body));
  } catch (err) {
    const msg = errorMessage(err);
    console.error(`[zcode] 非流式聚合失败：${msg}`);
    return jsonResponse(502, anthropicErrorBody('api_error', `聚合上游响应失败：${msg}`));
  }
}

type AttemptResult =
  | { kind: 'response'; response: Response }
  | { kind: 'key_error'; status: number; text: string }
  | { kind: 'fatal'; response: Response }
  | { kind: 'aborted' };

/** 用一把凭证完成一次请求（含验证码刷新重试），失败原因交给上层决定是否换 key */
async function tryKey(
  attempt: KeyAttempt,
  upstreamBody: string,
  wantsStream: boolean,
  signal: AbortSignal,
): Promise<AttemptResult> {
  const maxAttempts = attempt.kind === 'jwt' ? MAX_CAPTCHA_REFRESH : 1;

  for (let round = 1; round <= maxAttempts; round++) {
    let verifyParam: string | null = null;
    if (attempt.kind === 'jwt') {
      try {
        verifyParam = await captchaManager.getVerifyParam();
      } catch (err) {
        const msg = errorMessage(err);
        console.error(`[zcode] 无痕验证不可用：${msg}`);
        return {
          kind: 'fatal',
          response: jsonResponse(502, anthropicErrorBody('captcha_error', `无痕验证不可用：${msg}`)),
        };
      }
    }

    const target = buildUpstreamRequest(attempt.key, attempt.kind, verifyParam);

    let upstream: Response;
    try {
      upstream = await fetch(target.url, {
        method: 'POST',
        headers: target.headers,
        body: upstreamBody,
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) return { kind: 'aborted' };
      const msg = errorMessage(err);
      console.error(`[zcode] 上游连接失败：${msg}`);
      return {
        kind: 'fatal',
        response: jsonResponse(502, anthropicErrorBody('api_error', `无法连接上游：${msg}`)),
      };
    }

    if (upstream.ok) {
      preferredKeyIndex = attempt.index;
      return {
        kind: 'response',
        response: wantsStream ? streamResponse(upstream) : await aggregatedResponse(upstream),
      };
    }

    const text = await upstream.text().catch(() => '');

    // 验证码失效：刷新后重试同一把密钥（不是密钥的问题）
    if (attempt.kind === 'jwt' && isCaptchaRejection(upstream.status, text)) {
      captchaManager.invalidate();
      console.warn(
        `[zcode] 无痕验证失效（HTTP ${upstream.status}），刷新后重试（第 ${round}/${maxAttempts} 次）`,
      );
      continue;
    }

    // 凭据级错误：交给上层换下一把
    if (KEY_LEVEL_STATUS.has(upstream.status)) {
      return { kind: 'key_error', status: upstream.status, text };
    }

    // 请求本身 / 上游故障：换 key 没有意义
    return { kind: 'fatal', response: upstreamErrorResponse(upstream.status, text) };
  }

  return {
    kind: 'fatal',
    response: jsonResponse(
      502,
      anthropicErrorBody(
        'captcha_error',
        `无痕验证连续 ${maxAttempts} 次失效，已放弃。这是插件侧故障，与密钥有效性无关。`,
      ),
    ),
  };
}

/**
 * 处理一次 `POST /v1/messages`。
 *
 * 入站凭证（Router 的占位值 `xrl-router`）一律忽略；凭证由插件自持。
 */
export async function forwardMessages(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  if (settings.keys.length === 0) {
    return jsonResponse(
      503,
      anthropicErrorBody(
        'configuration_error',
        `插件未配置凭证：请在 .env 写入 ${KEYS_ENV_KEY}（可执行 pnpm run login 获取）`,
      ),
    );
  }

  const model = canonicalModelId(String(body.model ?? ''), settings.models);
  const wantsStream = body.stream === true;
  // 上游一律按流式请求，非流式客户端由我们聚合（同 zcode2api / qwenwork 的做法）
  const upstreamBody = JSON.stringify({ ...body, model, stream: true });

  let lastError: { status: number; text: string } | null = null;

  for (const attempt of orderedKeys()) {
    const result = await tryKey(attempt, upstreamBody, wantsStream, signal);

    switch (result.kind) {
      case 'response':
      case 'fatal':
        return result.response;
      case 'aborted':
        return new Response(null, { status: 499 });
      case 'key_error':
        lastError = { status: result.status, text: result.text };
        console.warn(
          `[zcode] 凭证 #${attempt.index + 1} 返回 HTTP ${result.status}，尝试下一把`,
        );
        continue;
    }
  }

  // 所有凭证都在凭据级错误上失败：透传最后一个上游响应
  return lastError
    ? upstreamErrorResponse(lastError.status, lastError.text)
    : jsonResponse(503, anthropicErrorBody('configuration_error', '没有可用凭证'));
}
