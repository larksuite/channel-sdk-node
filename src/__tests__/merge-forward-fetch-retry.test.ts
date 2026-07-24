/**
 * Channel-layer wiring for the merge_forward sub-message fetch: the private
 * helper that wraps `im.v1.message.get` in `retry()` must
 *   - retry transient upstream failures (504, read-path timeouts) and return
 *     the fetched items on recovery, and
 *   - THROW a LarkChannelError once retries are exhausted or the error is not
 *     transient — never silently swallow the failure into `[]` (which is what
 *     collapsed a forwarded message into an empty `<forwarded_messages/>`).
 */
import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '../index';
import { LarkChannelError } from '../types';

// Tiny retry config keeps backoff sub-millisecond so the tests stay fast; it is
// injected through `outbound.retry` exactly the way a caller would tune it.
function makeChannel() {
  const ch = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'secret',
    loggerLevel: LoggerLevel.error,
    outbound: { retry: { maxAttempts: 3, baseDelayMs: 1 } },
  });
  (ch as any).botIdentity = { openId: 'ou_bot', name: 'Bot' };
  return ch;
}

describe('fetchMessageItemsWithRetry', () => {
  test('retries a transient 504 and resolves the items on the second attempt', async () => {
    const ch = makeChannel();
    // 'Bad Gateway' (no "timeout" substring) classifies as `unknown` — the base
    // 5xx retryable path, distinct from the timeout path exercised below.
    const get = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 504 }, message: 'Bad Gateway' })
      .mockResolvedValueOnce({ data: { items: [{ message_id: 'om_x' }] } });
    (ch.rawClient.im.v1.message as any).get = get;

    const items = await (ch as any).fetchMessageItemsWithRetry('om_x');
    expect(items).toEqual([{ message_id: 'om_x' }]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('throws a LarkChannelError after exhausting retries on persistent 504', async () => {
    const ch = makeChannel();
    const get = vi.fn().mockRejectedValue({ response: { status: 504 }, message: 'Bad Gateway' });
    (ch.rawClient.im.v1.message as any).get = get;

    // 504→unknown is retried via the existing isRetryable, then must reject —
    // never resolve to [] — so the converter can emit fetch_failed instead of an
    // indistinguishable empty forward. A single invocation retries maxAttempts
    // times before throwing.
    const err = await (ch as any).fetchMessageItemsWithRetry('om_x').then(
      (v: unknown) => {
        throw new Error(`expected rejection but resolved to ${JSON.stringify(v)}`);
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LarkChannelError);
    expect(err).toMatchObject({ code: 'unknown' });
    expect(get).toHaveBeenCalledTimes(3);
  });

  test('fails fast on a non-transient 403 without retrying', async () => {
    const ch = makeChannel();
    const get = vi.fn().mockRejectedValue({ response: { status: 403 } });
    (ch.rawClient.im.v1.message as any).get = get;

    await expect((ch as any).fetchMessageItemsWithRetry('om_x')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('retries a rate-limited 429 and resolves on recovery', async () => {
    const ch = makeChannel();
    const get = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 429 }, message: 'Too Many Requests' })
      .mockResolvedValueOnce({ data: { items: [{ message_id: 'om_x' }] } });
    (ch.rawClient.im.v1.message as any).get = get;

    const items = await (ch as any).fetchMessageItemsWithRetry('om_x');
    expect(items).toEqual([{ message_id: 'om_x' }]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('retries a read-path timeout (ECONNABORTED) and resolves on recovery', async () => {
    const ch = makeChannel();
    const get = vi
      .fn()
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout' })
      .mockResolvedValueOnce({ data: { items: [{ message_id: 'om_x' }] } });
    (ch.rawClient.im.v1.message as any).get = get;

    const items = await (ch as any).fetchMessageItemsWithRetry('om_x');
    expect(items).toEqual([{ message_id: 'om_x' }]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('retries the other read-path timeout code (ETIMEDOUT) and resolves on recovery', async () => {
    const ch = makeChannel();
    const get = vi
      .fn()
      .mockRejectedValueOnce({ code: 'ETIMEDOUT', message: 'socket timeout' })
      .mockResolvedValueOnce({ data: { items: [{ message_id: 'om_x' }] } });
    (ch.rawClient.im.v1.message as any).get = get;

    const items = await (ch as any).fetchMessageItemsWithRetry('om_x');
    expect(items).toEqual([{ message_id: 'om_x' }]);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
