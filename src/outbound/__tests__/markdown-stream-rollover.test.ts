/**
 * Coverage for MarkdownStreamControllerImpl's rollover logic — when
 * cumulative streaming content exceeds the configured per-element cap,
 * the controller finalizes the current card and creates a fresh streaming
 * card so generation can continue without hitting Feishu's "element
 * exceeds the limit" error.
 */

import { MarkdownStreamControllerImpl } from '../streaming/markdown-stream';

interface SenderCalls {
  createCardInstance: ReturnType<typeof vi.fn>;
  sendCardByReference: ReturnType<typeof vi.fn>;
  updateCardElementContent: ReturnType<typeof vi.fn>;
  finishStreamingCard: ReturnType<typeof vi.fn>;
}

function makeStubSender(
  opts: {
    cap?: number;
    throttleMs?: number;
    throttleChars?: number;
    maxCardAgeMs?: number;
    updateContentImpl?: () => Promise<void>;
  } = {},
): { sender: any; calls: SenderCalls; logger: { warn: ReturnType<typeof vi.fn> } } {
  let cardCounter = 0;
  let messageCounter = 0;
  const logger = { warn: vi.fn() };

  const calls: SenderCalls = {
    createCardInstance: vi.fn(async () => `card_${++cardCounter}`),
    sendCardByReference: vi.fn(async () => `om_${++messageCounter}`),
    updateCardElementContent: vi.fn(opts.updateContentImpl ?? (async () => {})),
    finishStreamingCard: vi.fn(async () => {}),
  };

  const sender = {
    ...calls,
    logger,
    config: {
      streamThrottleMs: opts.throttleMs ?? 0,
      streamThrottleChars: opts.throttleChars ?? 1,
      streamMaxElementChars: opts.cap ?? 1000,
      streamMaxCardAgeMs: opts.maxCardAgeMs,
    },
  };

  return { sender, calls, logger };
}

const flush = () => new Promise<void>((r) => setImmediate(r));
async function flushAll() {
  for (let i = 0; i < 10; i++) await flush();
}

describe('MarkdownStreamController rollover', () => {
  test('content under cap → no rollover, single card', async () => {
    const { sender, calls } = makeStubSender({ cap: 1000 });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.append('hello world');
    });

    expect(calls.createCardInstance).toHaveBeenCalledTimes(1);
    expect(calls.sendCardByReference).toHaveBeenCalledTimes(1);
    expect(calls.finishStreamingCard).toHaveBeenCalledTimes(1);
    // updateCardElementContent fires at least once for the streaming
    // content; the exact count depends on throttle timing but >= 1.
    expect((calls as any).updateContentImpl).toBeUndefined();
    expect(calls.updateCardElementContent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('content exceeds cap → rollover creates additional card(s)', async () => {
    const { sender, calls } = makeStubSender({ cap: 100 });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      // 200 chars of paragraphs — splitter should split at line boundary.
      const big = Array.from({ length: 20 }, (_, i) => `paragraph ${i}`).join('\n');
      await c.append(big);
    });

    // At least one rollover happened (head + ≥1 follow-up).
    const cardCount = calls.createCardInstance.mock.calls.length;
    expect(cardCount).toBeGreaterThanOrEqual(2);
    expect(calls.sendCardByReference).toHaveBeenCalledTimes(cardCount);
    // Each card gets finalized exactly once.
    expect(calls.finishStreamingCard).toHaveBeenCalledTimes(cardCount);
    // The head card was finalized first.
    expect(calls.finishStreamingCard.mock.calls[0][0]).toBe('card_1');
    // The last finalize targets the latest card.
    expect(calls.finishStreamingCard.mock.calls[cardCount - 1][0]).toBe(`card_${cardCount}`);
  });

  test('messageId returned is the head card (not rollover cards)', async () => {
    const { sender } = makeStubSender({ cap: 50 });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    const result = await ctrl.run(async (c) => {
      await c.append(`${'a'.repeat(40)}\n${'b'.repeat(40)}`);
    });

    // First sendCardByReference returned 'om_1' — that's the head.
    expect(result.messageId).toBe('om_1');
  });

  test('many small appends accumulating past cap → rollover triggers correctly', async () => {
    const { sender, calls } = makeStubSender({ cap: 200 });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      for (let i = 0; i < 50; i++) {
        await c.append(`line ${i}\n`);
      }
    });

    // 50 lines × ~8 chars ≈ 400 chars total → at least one rollover.
    expect(calls.createCardInstance.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('card age rollover continues in a follow-up card before auto-close', async () => {
    const { sender, calls } = makeStubSender({ cap: 1000, maxCardAgeMs: 1 });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.append('first chunk');
      await flushAll();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await c.append(' second chunk');
      await flushAll();
    });

    expect(calls.createCardInstance).toHaveBeenCalledTimes(2);
    expect(calls.sendCardByReference).toHaveBeenCalledTimes(2);

    const oldCardContinuation = calls.updateCardElementContent.mock.calls.find(
      ([cardId, _elementId, content]) =>
        cardId === 'card_1' && String(content).includes('输出已自动续到下一条消息'),
    );
    expect(oldCardContinuation).toBeTruthy();

    const secondCardSpec = calls.createCardInstance.mock.calls[1][0] as {
      body?: { elements?: Array<{ content?: string }> };
    };
    expect(secondCardSpec.body?.elements?.[0]?.content).toContain('接上一条消息继续输出');
    const updates = calls.updateCardElementContent.mock.calls;
    expect(updates[updates.length - 1]?.[2]).toContain('接上一条消息继续输出');
  });

  test('update API failure → marks streamingFailed and rejects at terminal flush', async () => {
    let updateCount = 0;
    const { sender, logger } = makeStubSender({
      cap: 1000,
      updateContentImpl: async () => {
        updateCount++;
        if (updateCount === 1) throw new Error('230099 element exceeds the limit');
      },
    });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await expect(
      ctrl.run(async (c) => {
        await c.append('first chunk');
        await c.append('second chunk');
      }),
    ).rejects.toThrow('230099 element exceeds the limit');

    expect(logger.warn).toHaveBeenCalled();
    // Subsequent updates should be skipped after the first failure.
    // (We can't assert exact count without timing knowledge, but the
    // streamingFailed flag prevents further enqueues.)
  });

  test('producer throws → ERROR_FOOTER appended on the latest card', async () => {
    const { sender, calls } = makeStubSender({ cap: 100 });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await expect(
      ctrl.run(async (c) => {
        // Trigger a rollover so the latest card is the rollover one.
        await c.append(`${'x'.repeat(80)}\n${'y'.repeat(50)}`);
        throw new Error('producer failure');
      }),
    ).rejects.toThrow('producer failure');

    // The final updateCardElementContent should target the latest
    // (rollover) card and contain the ERROR_FOOTER text.
    const allCalls = calls.updateCardElementContent.mock.calls;
    const lastUpdate = allCalls[allCalls.length - 1];
    const cardCount = calls.createCardInstance.mock.calls.length;
    expect(lastUpdate[0]).toBe(`card_${cardCount}`);
    expect(lastUpdate[2]).toContain('Generation interrupted');
  });

  test('accumulated-mode producer survives rollover (full text re-sent each chunk)', async () => {
    // After rollover, this.content is just the tail. If the producer is
    // accumulated-mode (each chunk is the full history), naive merge
    // would produce garbage because next no longer starts with prev.
    // The controller maintains fullAccumulated separately to merge
    // correctly.
    const { sender, calls } = makeStubSender({ cap: 100 });
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      const a = 'a'.repeat(60);
      const b = 'b'.repeat(60);
      const c2 = 'c'.repeat(60);
      // Simulate accumulated mode — each chunk includes everything so far.
      await c.append(a);
      await c.append(`${a}\n${b}`); // accumulated + new line
      await c.append(`${a}\n${b}\n${c2}`); // accumulated + another
    });

    // At least one rollover happened; final card's last update should
    // contain only the trailing portion (c-block) and not bizarre
    // duplicated content from a misapplied merge.
    const allCalls = calls.updateCardElementContent.mock.calls;
    const lastSnapshot: string = allCalls[allCalls.length - 1][2];
    expect(lastSnapshot).toContain('c'.repeat(10)); // tail content present
    // tail should not double-contain the head bytes.
    expect(lastSnapshot.match(/aaaaaaaaaa/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
