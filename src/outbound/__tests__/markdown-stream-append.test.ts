/**
 * Coverage for MarkdownStreamControllerImpl's write semantics:
 *   - `append(chunk)` is a delta — it appends verbatim, byte-for-byte,
 *     with NO overlap-merge / dedup heuristic. This is the core fix:
 *     the old `mergeStreamingText` heuristic dropped repeated boundary
 *     characters (e.g. `共 3` + `3 条` rendered as `共 3 条`).
 *   - `setContent(full)` is a full replacement that the next `append`
 *     continues from.
 *
 * Observation point: the controller drains all pending updates when
 * `run()` resolves, so the final rendered snapshot is the third argument
 * of the last `updateCardElementContent` call (`mock.calls.at(-1)[2]`).
 */

import { MarkdownStreamControllerImpl } from '../streaming/markdown-stream';

interface SenderCalls {
  createCardInstance: ReturnType<typeof vi.fn>;
  sendCardByReference: ReturnType<typeof vi.fn>;
  updateCardElementContent: ReturnType<typeof vi.fn>;
  finishStreamingCard: ReturnType<typeof vi.fn>;
}

function makeStubSender(opts: { cap?: number; throttleMs?: number; throttleChars?: number } = {}): {
  sender: any;
  calls: SenderCalls;
} {
  let cardCounter = 0;
  let messageCounter = 0;
  const logger = { warn: vi.fn() };

  const calls: SenderCalls = {
    createCardInstance: vi.fn(async () => `card_${++cardCounter}`),
    sendCardByReference: vi.fn(async () => `om_${++messageCounter}`),
    updateCardElementContent: vi.fn(async () => {}),
    finishStreamingCard: vi.fn(async () => {}),
  };

  const sender = {
    ...calls,
    logger,
    config: {
      // Fire on every write so each append/setContent is observable.
      streamThrottleMs: opts.throttleMs ?? 0,
      streamThrottleChars: opts.throttleChars ?? 1,
      streamMaxElementChars: opts.cap ?? 1000,
    },
  };

  return { sender, calls };
}

/** The content rendered to the card element by the last update. */
function lastSnapshot(calls: SenderCalls): string {
  const all = calls.updateCardElementContent.mock.calls;
  return all[all.length - 1][2];
}

describe('MarkdownStreamController append/setContent semantics', () => {
  test('production regression: repeated CJK+digit boundary chars are kept (共 33 条)', async () => {
    const { sender, calls } = makeStubSender();
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.append('共 3');
      await c.append('3 条');
    });

    expect(lastSnapshot(calls)).toBe('共 33 条');
  });

  test('overlapping head delta is not merged away (foo + oo bar = foooo bar)', async () => {
    const { sender, calls } = makeStubSender();
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.append('foo');
      await c.append('oo bar');
    });

    expect(lastSnapshot(calls)).toBe('foooo bar');
  });

  test('append is pure concatenation with no dedup (abc + abc = abcabc)', async () => {
    const { sender, calls } = makeStubSender();
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.append('abc');
      await c.append('abc');
    });

    expect(lastSnapshot(calls)).toBe('abcabc');
  });

  test('empty chunk is a no-op: content unchanged and no extra push', async () => {
    const { sender, calls } = makeStubSender();
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.append('x');
      await c.append(''); // must early-return: no content change, no throttle
    });

    expect(lastSnapshot(calls)).toBe('x');

    // The empty append must not enqueue an additional update. Compare
    // against a baseline run that does only the single 'x' append.
    const { sender: baseSender, calls: baseCalls } = makeStubSender();
    const baseCtrl = new MarkdownStreamControllerImpl(baseSender, 'oc_x', 'chat_id', {});
    await baseCtrl.run(async (c) => {
      await c.append('x');
    });

    expect(calls.updateCardElementContent.mock.calls.length).toBe(
      baseCalls.updateCardElementContent.mock.calls.length,
    );
  });

  test('append continues after setContent (setContent("full") + append(" more") = "full more")', async () => {
    const { sender, calls } = makeStubSender();
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.setContent('full');
      await c.append(' more');
    });

    expect(lastSnapshot(calls)).toBe('full more');
  });

  test('setContent overrides prior append (append("xxx") + setContent("reset") = "reset")', async () => {
    const { sender, calls } = makeStubSender();
    const ctrl = new MarkdownStreamControllerImpl(sender, 'oc_x', 'chat_id', {});

    await ctrl.run(async (c) => {
      await c.append('xxx');
      await c.setContent('reset');
    });

    expect(lastSnapshot(calls)).toBe('reset');
  });
});
