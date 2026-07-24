import type { LarkChannelError } from '../types';
import { classifyError, isRetryable } from './errors';

export interface RetryOptions {
  maxAttempts?: number; // default 3
  baseDelayMs?: number; // default 500
  /**
   * Also retry `send_timeout` errors. Off by default so send paths keep their
   * fail-fast-on-timeout behavior (a timed-out send may have landed — retrying
   * risks a duplicate). Idempotent read paths (e.g. fetching merge-forward
   * sub-messages) turn this on: a timed-out GET is safe to re-issue.
   */
  retryTimeouts?: boolean;
}

/**
 * Execute `op` with exponential backoff. Only retries errors classified as
 * retryable (rate_limited / unknown), plus `send_timeout` when
 * `retryTimeouts` is set. Business errors (format / revoked / permission)
 * fail fast and bubble up.
 */
export async function retry<T>(
  op: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 500;

  let lastErr: LarkChannelError | undefined;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await op(attempt);
    } catch (raw) {
      const err = classifyError(raw, { attempt });
      lastErr = err;
      const retryable = isRetryable(err) || (!!opts.retryTimeouts && err.code === 'send_timeout');
      if (attempt >= max || !retryable) {
        throw err;
      }
      const delay = base * 3 ** (attempt - 1);
      await sleep(delay);
    }
  }
  throw lastErr!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
