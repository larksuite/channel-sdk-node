/**
 * Coverage for MarkdownStreamControllerImpl's keepalive — Feishu closes a
 * card's streaming mode 10 minutes after it was last switched on, so the
 * controller toggles it off and on before that, and falls back to
 * full-card updates when the streaming text API refuses a push.
 */

import { MarkdownStreamControllerImpl } from '../streaming/markdown-stream';

const MIN = 60_000;

interface SenderCalls {
  createCardInstance: ReturnType<typeof vi.fn>;
  sendCardByReference: ReturnType<typeof vi.fn>;
  updateCardElementContent: ReturnType<typeof vi.fn>;
  updateCardFull: ReturnType<typeof vi.fn>;
  setStreamingMode: ReturnType<typeof vi.fn>;
  finishStreamingCard: ReturnType<typeof vi.fn>;
}

function makeStubSender(
  opts: {
    cap?: number;
    updateContentImpl?: (cardId: string, elementId: string, content: string) => Promise<void>;
    updateFullImpl?: () => Promise<void>;
    setStreamingModeImpl?: () => Promise<void>;
  } = {},
): {
  sender: any;
  calls: SenderCalls;
  logger: { warn: ReturnType<typeof vi.fn> };
  seqs: Map<string, number[]>;
} {
  let cardCounter = 0;
  let messageCounter = 0;
  const logger = { warn: vi.fn() };
  // Every cardkit call on a card must carry a strictly increasing sequence.
  const seqs = new Map<string, number[]>();
  const seen = (cardId: string, seq: number) => {
    const list = seqs.get(cardId) ?? [];
    if (list.length && seq <= list[list.length - 1]) {
      throw new Error(`sequence not increasing on ${cardId}: ${list[list.length - 1]} -> ${seq}`);
    }
    list.push(seq);
    seqs.set(cardId, list);
  };

  const calls: SenderCalls = {
    createCardInstance: vi.fn(async () => `card_${++cardCounter}`),
    sendCardByReference: vi.fn(async () => `om_${++messageCounter}`),
    updateCardElementContent: vi.fn(
      async (cardId: string, elementId: string, content: string, seq: number) => {
        seen(cardId, seq);
        await opts.updateContentImpl?.(cardId, elementId, content);
      },
    ),
    updateCardFull: vi.fn(async (cardId: string, _card: object, seq: number) => {
      seen(cardId, seq);
      await opts.updateFullImpl?.();
    }),
    setStreamingMode: vi.fn(async (cardId: string, seq: number) => {
      seen(cardId, seq);
      await opts.setStreamingModeImpl?.();
    }),
    finishStreamingCard: vi.fn(async (cardId: string, seq: number) => {
      seen(cardId, seq);
    }),
  };

  const sender = {
    ...calls,
    logger,
    config: {
      streamThrottleMs: 0,
      streamThrottleChars: 1,
      streamMaxElementChars: opts.cap ?? 1000,
    },
  };

  return { sender, calls, logger, seqs };
}

// Let the throttle's timer fire and the update queue drain. Real timers:
// only Date.now is mocked below, so the throttle's setTimeout still runs.
const flushAll = () => new Promise<void>((r) => setTimeout(r, 10));
const last = <T>(a: T[]): T | undefined => a[a.length - 1];

let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const elementTexts = (calls: SenderCalls) =>
  calls.updateCardElementContent.mock.calls.map((c) => c[2]);
const fullTexts = (calls: SenderCalls) =>
  calls.updateCardFull.mock.calls.map((c) => (c[1] as any).body.elements[0].content);

describe('MarkdownStreamController keepalive', () => {
  test('under the reopen mark → streams as before, no toggle, no full update', async () => {
    const { sender, calls } = makeStubSender();
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.setContent('hello');
      await flushAll();
      now += 7 * MIN;
      await c.setContent('hello world');
      await flushAll();
    });

    expect(calls.setStreamingMode).not.toHaveBeenCalled();
    expect(calls.updateCardFull).not.toHaveBeenCalled();
    expect(calls.createCardInstance).toHaveBeenCalledTimes(1);
    expect(elementTexts(calls)).toContain('hello world');
    expect(calls.finishStreamingCard).toHaveBeenCalledTimes(1);
  });

  test('past the reopen mark → streaming_mode false then true on the same card, then the push', async () => {
    const { sender, calls } = makeStubSender();
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.setContent('part 1');
      await flushAll();
      now += 9 * MIN;
      await c.setContent('part 1 part 2');
      await flushAll();
    });

    const toggles = calls.setStreamingMode.mock.calls.map((c) => [c[0], c[2]]);
    expect(toggles).toEqual([
      ['card_1', false],
      ['card_1', true],
    ]);
    // The toggle happened before the push that carried the new content.
    const toggleOrder = calls.setStreamingMode.mock.invocationCallOrder[1];
    const pushOrder = last(calls.updateCardElementContent.mock.invocationCallOrder) as number;
    expect(toggleOrder).toBeLessThan(pushOrder);
    expect(last(elementTexts(calls))).toBe('part 1 part 2');
    // Same card throughout, and the cursor is only removed at the end.
    expect(calls.createCardInstance).toHaveBeenCalledTimes(1);
    expect(calls.updateCardFull).not.toHaveBeenCalled();
    expect(calls.finishStreamingCard).toHaveBeenCalledTimes(1);
  });

  test('the toggle restarts the clock → one reopen per window, not per push', async () => {
    const { sender, calls } = makeStubSender();
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.setContent('a');
      await flushAll();
      for (const text of ['a b', 'a b c', 'a b c d', 'a b c d e']) {
        now += 4.5 * MIN;
        await c.setContent(text);
        await flushAll();
      }
    });

    // Pushes at 4.5, 9, 13.5, 18 min after opening: reopened at 9 and 18.
    expect(calls.setStreamingMode.mock.calls.filter((c) => c[2] === true)).toHaveLength(2);
    expect(last(elementTexts(calls))).toBe('a b c d e');
  });

  test('toggle refused → the card continues with full-card updates and the final text lands', async () => {
    const { sender, calls, logger } = makeStubSender({
      setStreamingModeImpl: async () => {
        throw new Error('200810 card cannot be updated in streaming mode during a callback');
      },
    });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.setContent('a');
      await flushAll();
      now += 9 * MIN;
      await c.setContent('a b');
      await flushAll();
      await c.setContent('a b c');
      await flushAll();
    });

    expect(last(fullTexts(calls))).toBe('a b c');
    expect(calls.updateCardFull.mock.calls.every((c) => c[0] === 'card_1')).toBe(true);
    // Full-card updates carry streaming_mode: false — the stream is gone.
    expect((calls.updateCardFull.mock.calls[0][1] as any).config.streaming_mode).toBe(false);
    // No streaming push after the switch.
    const switchAt = calls.updateCardFull.mock.invocationCallOrder[0];
    expect(calls.updateCardElementContent.mock.invocationCallOrder.every((o) => o < switchAt)).toBe(
      true,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(calls.finishStreamingCard).toHaveBeenCalledTimes(1);
  });

  test('streaming push rejected (stream closed) → full-card updates, no new card, nothing lost', async () => {
    let closed = false;
    const { sender, calls } = makeStubSender({
      updateContentImpl: async () => {
        if (closed) throw new Error('200850 card streaming timeout');
      },
    });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    const result = await ctrl.run(async (c) => {
      await c.setContent('first');
      await flushAll();
      closed = true;
      await c.setContent('first second');
      await flushAll();
      await c.setContent('first second final');
      await flushAll();
    });

    expect(result.messageId).toBe('om_1');
    expect(calls.createCardInstance).toHaveBeenCalledTimes(1);
    expect(fullTexts(calls)).toContain('first second');
    expect(last(fullTexts(calls))).toBe('first second final');
    expect(calls.finishStreamingCard).toHaveBeenCalledTimes(1);
    expect(calls.finishStreamingCard.mock.calls[0][2]).toBe('first second final');
  });

  test('full-card update fails too → gives up quietly, run() still resolves', async () => {
    const { sender, calls, logger } = makeStubSender({
      updateContentImpl: async () => {
        throw new Error('200850 card streaming timeout');
      },
      updateFullImpl: async () => {
        throw new Error('full update failed');
      },
    });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    const result = await ctrl.run(async (c) => {
      await c.setContent('x');
      await flushAll();
      await c.setContent('x y');
      await flushAll();
    });

    expect(result.messageId).toBe('om_1');
    expect(logger.warn).toHaveBeenCalledWith('[stream] full-card update failed', expect.any(Error));
    // Later pushes are skipped once the card is given up on.
    expect(calls.updateCardFull).toHaveBeenCalledTimes(1);
    expect(calls.finishStreamingCard).toHaveBeenCalledTimes(1);
  });

  test('size rollover starts a fresh window: no toggle on the new card right after it', async () => {
    const { sender, calls } = makeStubSender({ cap: 20 });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.setContent('short');
      await flushAll();
      now += 9 * MIN;
      await c.setContent('line one is here\nline two is here too\nline three');
      await flushAll();
      await c.setContent('line one is here\nline two is here too\nline three\nline four');
      await flushAll();
    });

    // The old card got its toggle (it was 9 min old); the new card is fresh.
    expect(calls.setStreamingMode.mock.calls.every((c) => c[0] === 'card_1')).toBe(true);
    expect(calls.createCardInstance.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastCard = `card_${calls.createCardInstance.mock.calls.length}`;
    expect(last(calls.updateCardElementContent.mock.calls)?.[0]).toBe(lastCard);
  });
});
