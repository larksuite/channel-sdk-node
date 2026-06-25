/**
 * Continuation-chunk reply chaining.
 *
 * When `channel.send({ markdown | text })` splits a long body into multiple
 * chunks, continuation chunks (i>0) must STAY anchored to the same thread /
 * reply chain instead of "escaping" as independent top-level messages.
 *
 * Behavior under test (spec choice A):
 *   const anchored = opts.replyTo != null || opts.replyInThread === true;
 *   replyTo: i === 0 ? opts.replyTo : (anchored ? ids[i-1] : undefined)
 *
 * - chunk 0: unchanged (reply to opts.replyTo if set, else create).
 * - chunk i>0 when anchored: reply to the previous chunk's id → chain.
 * - chunk i>0 when NOT anchored: stays a top-level create (regression guard).
 *
 * These tests force chunking deterministically with a tiny textChunkLimit so
 * short strings split into several chunks, independent of the default 3500.
 */

import { OutboundSender } from '../sender';

function makeClient(
  opts: { reply?: ReturnType<typeof vi.fn>; create?: ReturnType<typeof vi.fn> } = {},
): any {
  return {
    im: {
      v1: {
        message: {
          reply: opts.reply ?? vi.fn(),
          create: opts.create ?? vi.fn(),
        },
      },
    },
  };
}

function okResponse(messageId: string) {
  return { data: { message_id: messageId } };
}

function apiErr(feishuCode: number, status?: number) {
  const err: any = new Error(`feishu error ${feishuCode}`);
  err.response = { status: status ?? 400, data: { code: feishuCode, msg: `code ${feishuCode}` } };
  return err;
}

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
} as any;

// Tiny chunk limit so short bodies split into multiple chunks; fast retry so
// the reply-gone fallback path doesn't sleep.
const chunkConfig = { textChunkLimit: 10, retry: { maxAttempts: 1, baseDelayMs: 0 } } as any;
// Generous limit so a short body stays a single chunk.
const noChunkConfig = { textChunkLimit: 10000, retry: { maxAttempts: 1, baseDelayMs: 0 } } as any;

// Three short lines, each under the limit. The markdown splitter works
// line-by-line (a single over-limit line would NOT split), so newlines are
// required to force 3 chunks; the plain splitter slices by char and also
// yields 3 at limit 10. Both paths → exactly 3 chunks deterministically.
const THREE_CHUNK_BODY = 'aaaaaaaaa\nbbbbbbbbb\nccccccccc'; // limit 10 → 3 chunks

describe('continuation chunks chain via replyTo when anchored (markdown/post)', () => {
  test('TC1: anchored by replyTo → each continuation replies to the previous chunk', async () => {
    const reply = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_0'))
      .mockResolvedValueOnce(okResponse('om_1'))
      .mockResolvedValueOnce(okResponse('om_2'));
    // Default-resolve create so the CURRENT (unfixed) code — which routes
    // continuation chunks through create — completes and fails on the
    // behavioral assertion below, rather than crashing on an undefined
    // response. After the fix, create is never called.
    const create = vi.fn().mockResolvedValue(okResponse('om_unexpected'));
    const sender = new OutboundSender(makeClient({ reply, create }), chunkConfig, logger);

    const r = await sender.send('oc_abc', { markdown: THREE_CHUNK_BODY }, { replyTo: 'om_parent' });

    expect(create).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(3);
    // chunk 0 → opts.replyTo; chunk 1 → om_0; chunk 2 → om_1
    expect(reply.mock.calls[0][0].path.message_id).toBe('om_parent');
    expect(reply.mock.calls[1][0].path.message_id).toBe('om_0');
    expect(reply.mock.calls[2][0].path.message_id).toBe('om_1');

    expect(r.messageId).toBe('om_0');
    expect(r.chunkIds).toEqual(['om_0', 'om_1', 'om_2']);
  });

  test('TC2: anchored by replyInThread (no replyTo) → chunk0 creates, continuations reply with reply_in_thread', async () => {
    // chunk0 → om_0 via create; default-resolve the rest so the CURRENT
    // code (which wrongly creates every continuation) completes and fails on
    // the behavioral assertion instead of crashing.
    const create = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_0'))
      .mockResolvedValue(okResponse('om_unexpected'));
    const reply = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_1'))
      .mockResolvedValueOnce(okResponse('om_2'));
    const sender = new OutboundSender(makeClient({ reply, create }), chunkConfig, logger);

    const r = await sender.send('oc_abc', { markdown: THREE_CHUNK_BODY }, { replyInThread: true });

    // chunk 0 has no replyTo → goes through create
    expect(create).toHaveBeenCalledTimes(1);
    // continuations reply to the previous chunk id, threaded
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[0][0].path.message_id).toBe('om_0');
    expect(reply.mock.calls[1][0].path.message_id).toBe('om_1');
    expect(reply.mock.calls[0][0].data.reply_in_thread).toBe(true);
    expect(reply.mock.calls[1][0].data.reply_in_thread).toBe(true);

    expect(r.chunkIds).toEqual(['om_0', 'om_1', 'om_2']);
  });

  test('TC3: brand-new send (no replyTo, no replyInThread) → all chunks are top-level creates, no reply', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_0'))
      .mockResolvedValueOnce(okResponse('om_1'))
      .mockResolvedValueOnce(okResponse('om_2'));
    const reply = vi.fn();
    const sender = new OutboundSender(makeClient({ reply, create }), chunkConfig, logger);

    const r = await sender.send('oc_abc', { markdown: THREE_CHUNK_BODY });

    expect(reply).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(3);
    expect(r.chunkIds).toEqual(['om_0', 'om_1', 'om_2']);
  });

  test('TC4: continuation reply target gone → falls back to create, later chunks chain to the fallback id', async () => {
    // chunk0 replies to om_parent → om_0
    // chunk1 replies to om_0 → target gone → create fallback → om_1b
    // chunk2 replies to om_1b → om_2
    const reply = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_0')) // chunk0
      .mockRejectedValueOnce(apiErr(230020, 404)) // chunk1 reply → gone
      .mockResolvedValueOnce(okResponse('om_2')); // chunk2 reply to om_1b
    // chunk1's reply-gone fallback → om_1b; default-resolve any further
    // create so the CURRENT code (which creates continuations directly)
    // completes and fails on the chunkIds assertion instead of crashing.
    const create = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_1b'))
      .mockResolvedValue(okResponse('om_unexpected'));
    const sender = new OutboundSender(makeClient({ reply, create }), chunkConfig, logger);

    const r = await sender.send('oc_abc', { markdown: THREE_CHUNK_BODY }, { replyTo: 'om_parent' });

    expect(r.chunkIds).toEqual(['om_0', 'om_1b', 'om_2']);
    // chunk2 must reply to the fallback id, not the gone om_0
    expect(reply.mock.calls[2][0].path.message_id).toBe('om_1b');
  });

  test('TC5: single chunk with replyTo → one reply, no create, chunkIds undefined', async () => {
    const reply = vi.fn().mockResolvedValueOnce(okResponse('om_only'));
    const create = vi.fn();
    const sender = new OutboundSender(makeClient({ reply, create }), noChunkConfig, logger);

    const r = await sender.send('oc_abc', { markdown: 'short' }, { replyTo: 'om_x' });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(reply.mock.calls[0][0].path.message_id).toBe('om_x');
    expect(r.messageId).toBe('om_only');
    expect(r.chunkIds).toBeUndefined();
  });
});

describe('continuation chunks chain via replyTo when anchored (text)', () => {
  test('TC1: anchored by replyTo → each continuation replies to the previous chunk', async () => {
    const reply = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_0'))
      .mockResolvedValueOnce(okResponse('om_1'))
      .mockResolvedValueOnce(okResponse('om_2'));
    // Default-resolve create so the CURRENT (unfixed) code completes and the
    // failure surfaces as a behavioral assertion, not an undefined-response
    // crash. After the fix, create is never called.
    const create = vi.fn().mockResolvedValue(okResponse('om_unexpected'));
    const sender = new OutboundSender(makeClient({ reply, create }), chunkConfig, logger);

    const r = await sender.send('oc_abc', { text: THREE_CHUNK_BODY }, { replyTo: 'om_parent' });

    expect(create).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(3);
    expect(reply.mock.calls[0][0].path.message_id).toBe('om_parent');
    expect(reply.mock.calls[1][0].path.message_id).toBe('om_0');
    expect(reply.mock.calls[2][0].path.message_id).toBe('om_1');

    expect(r.messageId).toBe('om_0');
    expect(r.chunkIds).toEqual(['om_0', 'om_1', 'om_2']);
  });

  test('TC2: anchored by replyInThread (no replyTo) → chunk0 creates, continuations reply with reply_in_thread', async () => {
    // chunk0 → om_0 via create; default-resolve the rest so the CURRENT
    // code (which wrongly creates every continuation) completes and fails on
    // the behavioral assertion instead of crashing.
    const create = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_0'))
      .mockResolvedValue(okResponse('om_unexpected'));
    const reply = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_1'))
      .mockResolvedValueOnce(okResponse('om_2'));
    const sender = new OutboundSender(makeClient({ reply, create }), chunkConfig, logger);

    const r = await sender.send('oc_abc', { text: THREE_CHUNK_BODY }, { replyInThread: true });

    expect(create).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[0][0].path.message_id).toBe('om_0');
    expect(reply.mock.calls[1][0].path.message_id).toBe('om_1');
    expect(reply.mock.calls[0][0].data.reply_in_thread).toBe(true);
    expect(reply.mock.calls[1][0].data.reply_in_thread).toBe(true);

    expect(r.chunkIds).toEqual(['om_0', 'om_1', 'om_2']);
  });

  test('TC3: brand-new send (no replyTo, no replyInThread) → all chunks are top-level creates, no reply', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_0'))
      .mockResolvedValueOnce(okResponse('om_1'))
      .mockResolvedValueOnce(okResponse('om_2'));
    const reply = vi.fn();
    const sender = new OutboundSender(makeClient({ reply, create }), chunkConfig, logger);

    const r = await sender.send('oc_abc', { text: THREE_CHUNK_BODY });

    expect(reply).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(3);
    expect(r.chunkIds).toEqual(['om_0', 'om_1', 'om_2']);
  });

  test('TC4: continuation reply target gone → falls back to create, later chunks chain to the fallback id', async () => {
    const reply = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_0'))
      .mockRejectedValueOnce(apiErr(230020, 404))
      .mockResolvedValueOnce(okResponse('om_2'));
    // chunk1's reply-gone fallback → om_1b; default-resolve any further
    // create so the CURRENT code completes and fails on the chunkIds
    // assertion instead of crashing on an undefined response.
    const create = vi
      .fn()
      .mockResolvedValueOnce(okResponse('om_1b'))
      .mockResolvedValue(okResponse('om_unexpected'));
    const sender = new OutboundSender(makeClient({ reply, create }), chunkConfig, logger);

    const r = await sender.send('oc_abc', { text: THREE_CHUNK_BODY }, { replyTo: 'om_parent' });

    expect(r.chunkIds).toEqual(['om_0', 'om_1b', 'om_2']);
    expect(reply.mock.calls[2][0].path.message_id).toBe('om_1b');
  });

  test('TC5: single chunk with replyTo → one reply, no create, chunkIds undefined', async () => {
    const reply = vi.fn().mockResolvedValueOnce(okResponse('om_only'));
    const create = vi.fn();
    const sender = new OutboundSender(makeClient({ reply, create }), noChunkConfig, logger);

    const r = await sender.send('oc_abc', { text: 'short' }, { replyTo: 'om_x' });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(reply.mock.calls[0][0].path.message_id).toBe('om_x');
    expect(r.messageId).toBe('om_only');
    expect(r.chunkIds).toBeUndefined();
  });
});
