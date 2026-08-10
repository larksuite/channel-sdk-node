/**
 * Error construction for the meeting path.
 *
 * A failed request's transport error never becomes `cause`. It arrives holding
 * `Authorization: Bearer <user token>`, and the resulting `LarkChannelError` reaches
 * both the SDK's logger and the caller's `error` handler — which typically forwards it
 * to a tracker that walks `cause`. So the credential is dropped at construction: only
 * the fields needed to diagnose the failure are carried over, `log_id` included.
 */

import { LarkChannelError, type LarkChannelErrorCode } from '../types';

/** Everything kept from a failed call. Deliberately flat, deliberately small. */
export interface ApiFailure {
  status?: number;
  feishuCode?: number;
  msg?: string;
  /** Feishu's request id — what support actually needs to trace a call. */
  logId?: string;
}

export interface MeetingErrorContext {
  meetingId?: string;
  /**
   * Signed one-click authorization link from a permission failure. A credential
   * in URL form: passed through byte for byte because re-encoding invalidates
   * the signature, but never logged, and dropped entirely unless it is `https:`.
   */
  consoleUrl?: string;
}

/** Statuses where a `bots/join` may have succeeded while the caller saw a failure. */
const INCONCLUSIVE_STATUS = new Set([408, 502, 504]);

/** Every inconclusive status is retryable, plus the ones that answered "later". */
const RETRYABLE_STATUS = new Set([...INCONCLUSIVE_STATUS, 429, 500, 503]);

/**
 * Codes that mean "this credential will not work until the caller fixes it".
 *
 * `99991668` is here because it is what an *expired user access token* actually
 * returns — observed on the live wire, arriving as HTTP 400. Without it the follow
 * loop still terminates (a 400 is not retryable either), but the caller sees
 * `format_error` and has no signal to refresh the token, which is the single most
 * common failure this path has.
 */
const PERMISSION_CODES = new Set([99991400, 99991401, 99991663, 99991668, 99991672, 20017]);

interface RawFailure {
  status?: number;
  code?: unknown;
  message?: string;
  response?: {
    status?: number;
    data?: Record<string, unknown>;
    headers?: Record<string, unknown>;
  };
  data?: Record<string, unknown>;
}

/** Where a Feishu error body lives, whichever transport shape it arrived in. */
function readFailureData(err: unknown): Record<string, unknown> | undefined {
  const raw = err as RawFailure | undefined;
  return raw?.response?.data ?? raw?.data;
}

/**
 * Reduce a transport error to the fields worth keeping. Nothing structural is copied —
 * no `config`, `headers`, `request`, or serialized body.
 */
export function summarizeApiFailure(err: unknown): ApiFailure {
  const raw = err as RawFailure | undefined;
  const data = readFailureData(err);
  return {
    status: raw?.response?.status ?? raw?.status,
    feishuCode: numberOrUndefined(data?.code),
    msg: stringOrUndefined(data?.msg) ?? raw?.message,
    logId:
      stringOrUndefined(data?.log_id) ?? stringOrUndefined(raw?.response?.headers?.['x-tt-logid']),
  };
}

/**
 * Pull out `console_url` if, and only if, it is an `https:` URL — returned unchanged or
 * not at all, so byte-for-byte pass-through holds. `domain` is configurable, so this
 * field is not from a trusted source, and a downstream rendering it as a link would turn
 * `javascript:` or `data:` into script execution.
 */
export function extractConsoleUrl(err: unknown): string | undefined {
  const data = readFailureData(err);
  const nested = data?.error as Record<string, unknown> | undefined;
  const candidate = stringOrUndefined(nested?.console_url) ?? stringOrUndefined(data?.console_url);
  if (!candidate) return undefined;
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function classifyMeetingError(err: unknown): LarkChannelErrorCode {
  const { status, feishuCode } = summarizeApiFailure(err);
  const code = (err as { code?: unknown } | undefined)?.code;

  if (feishuCode !== undefined && PERMISSION_CODES.has(feishuCode)) return 'permission_denied';
  if (status === 401 || status === 403) return 'permission_denied';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'format_error';
  if (status === 404) return 'target_revoked';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'send_timeout';
  return 'unknown';
}

/**
 * Wrap a transport error as a {@link LarkChannelError} carrying no credentials.
 *
 * Already-classified errors pass through untouched so a rethrow does not nest.
 */
export function meetingError(err: unknown, context?: MeetingErrorContext): LarkChannelError {
  if (err instanceof LarkChannelError) return err;

  const failure = summarizeApiFailure(err);
  const consoleUrl = extractConsoleUrl(err);
  const merged = { ...context, ...(consoleUrl ? { consoleUrl } : {}) };

  return new LarkChannelError(classifyMeetingError(err), failure.msg ?? String(err), {
    cause: failure,
    ...(Object.keys(merged).length > 0 ? { context: merged } : {}),
  });
}

/** Whether retrying stands a chance, or the credential/request needs fixing first. */
export function isRetryableMeetingError(err: LarkChannelError): boolean {
  if (err.code === 'permission_denied' || err.code === 'format_error') return false;
  const status = (err.cause as ApiFailure | undefined)?.status;
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  // No HTTP status at all means the request never landed — a socket reset or a
  // DNS blip, both of which a retry can genuinely clear.
  return true;
}

/**
 * Whether a failure leaves the request's outcome unknown: no HTTP status, or one of
 * {@link INCONCLUSIVE_STATUS}. Keying on `ECONNABORTED`-style codes alone would miss
 * socket resets.
 */
export function isInconclusiveFailure(err: unknown): boolean {
  if (err instanceof LarkChannelError) return false;
  const status = summarizeApiFailure(err).status;
  return status === undefined || INCONCLUSIVE_STATUS.has(status);
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
