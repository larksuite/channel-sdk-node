import { LarkChannelError, type LarkChannelErrorCode } from '../types';

/**
 * Classify a raw error (typically from axios/fetch or a Feishu API response)
 * into a LarkChannelError with a stable code.
 */
export function classifyError(
  err: unknown,
  context?: { to?: string; messageId?: string; attempt?: number },
): LarkChannelError {
  if (err instanceof LarkChannelError) return err;

  const message = extractMessage(err);
  const code = inferCode(err, message);
  return new LarkChannelError(code, message, { cause: err, context });
}

function inferCode(err: unknown, message: string): LarkChannelErrorCode {
  const raw = err as any;
  const status = raw?.response?.status ?? raw?.status;
  const feishuCode = raw?.response?.data?.code ?? raw?.data?.code ?? raw?.code;
  const msg = message.toLowerCase();

  if (typeof feishuCode === 'number') {
    if (feishuCode === 230020 || feishuCode === 230017) return 'target_revoked';
    if (feishuCode === 99991400 || feishuCode === 99991401) return 'permission_denied';
    if (feishuCode === 230002 || feishuCode === 230001) return 'format_error';
  }

  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'permission_denied';
  if (status === 400) return isWithdrawnReplyTarget(msg) ? 'target_revoked' : 'format_error';
  if (status === 404) return 'target_revoked';

  if (msg.startsWith('ssrf_blocked')) return 'ssrf_blocked';
  if (msg.includes('timeout') || raw?.code === 'ETIMEDOUT' || raw?.code === 'ECONNABORTED') {
    return 'send_timeout';
  }

  return 'unknown';
}

/**
 * Feishu answers a reply whose target message has already been withdrawn
 * with HTTP 400 and a plain-text body ("The message was withdrawn.") that
 * carries no numeric platform code. Callers pass the lower-cased message.
 * A substring probe keeps this linear in the (server-controlled) body length.
 */
function isWithdrawnReplyTarget(msg: string): boolean {
  return msg.includes('withdrawn');
}

function extractMessage(err: unknown): string {
  const raw = err as any;
  const candidates = [raw?.response?.data?.msg, raw?.response?.data?.message, raw?.message];
  const found = candidates.find((c) => typeof c === 'string' && c.length > 0);
  return found ?? String(err);
}

export function isRetryable(err: LarkChannelError): boolean {
  return err.code === 'rate_limited' || err.code === 'unknown';
}

export function isFormatError(err: LarkChannelError): boolean {
  return err.code === 'format_error';
}

export function isReplyTargetGone(err: LarkChannelError): boolean {
  return err.code === 'target_revoked';
}
