/**
 * The interactive-approval deadlock, reproduced through the real dispatcher.
 *
 * A `message` handler starts an agent turn, sends a card, and awaits the click.
 * With card actions on the same per-chat queue as messages, the click lands
 * behind the handler that is waiting for it and Feishu's callback times out
 * (larksuite/channel-sdk-node#16). `safety.chatQueue.cardActions: 'separate'`
 * puts clicks on their own lane so the approval can complete.
 *
 * The pipeline-level suite proves the lane semantics; this file pins the one
 * call site the channel owns — that `card.action.trigger` actually reaches the
 * lane the option selects — plus the default wiring and `disconnect()` draining
 * the lane.
 */

import {
  createTestChannel,
  dispatchEvent,
  flushMicrotasks,
  markConnected,
} from '../meeting/__tests__/fixtures';

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

/**
 * A cache scoped to one channel that also records every key written, in order.
 * `createTestChannel` spreads `extra` after its own isolated cache, so passing
 * this one replaces it.
 */
function makeRecordingCache() {
  const store = new Map<string, string>();
  const sets: string[] = [];
  const scoped = (k: unknown, opts?: { namespace?: string }) => `${opts?.namespace ?? ''}|${k}`;
  return {
    sets,
    get: async (k: unknown, opts?: { namespace?: string }) => store.get(scoped(k, opts)),
    set: async (k: unknown, v: string, _expiredTime?: number, opts?: { namespace?: string }) => {
      sets.push(String(k));
      store.set(scoped(k, opts), v);
      return true;
    },
  };
}

/** A promise plus its resolver, so a test can hold a handler in-flight. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Is `p` settled once the microtask queue drains, or still parked on something? */
function stateAfterSettle(p: Promise<unknown>): Promise<'resolved' | 'pending'> {
  return Promise.race([
    p.then(() => 'resolved' as const),
    flushMicrotasks().then(() => 'pending' as const),
  ]);
}

/**
 * Turn "never resolves" into a clean failure. A click queued behind the handler
 * that awaits it would otherwise hang until the vitest timeout, which reads as
 * a slow test rather than the deadlock it is.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms: the card action never came back`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function channelWith(safety: Record<string, unknown>) {
  const cache = makeRecordingCache();
  const { ch, logger } = createTestChannel({
    // Message delivery on the pure-serial path, so it depends on microtasks only.
    safety: { ...safety, batch: { text: { delayMs: 0 } } },
    // Group messages are rejected unless the bot is mentioned; the fixture message carries no mention.
    policy: { requireMention: false },
    cache,
  });
  markConnected(ch);
  return { ch, logger, cache };
}

function groupText(messageId: string, text: string): unknown {
  return {
    sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: 'oc_test',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function cardClick(messageId: string, value: unknown): unknown {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    context: { open_message_id: messageId, open_chat_id: 'oc_test' },
    operator: { open_id: 'ou_alice' },
    action: { tag: 'button', value },
  };
}

const APPROVED = { toast: { type: 'success', content: 'Approved' } };

// ─────────────────────────────────────────────────────────────
// Cases
// ─────────────────────────────────────────────────────────────

describe("with chatQueue.cardActions: 'separate'", () => {
  test('a message handler that awaits a card click in the same chat completes once the user clicks', async () => {
    const { ch, logger } = channelWith({ chatQueue: { enabled: true, cardActions: 'separate' } });
    // A recognized mode is accepted silently; only unknown values warn.
    expect(logger.warn).not.toHaveBeenCalled();
    const decision = deferred<string>();
    let messageDone = false;

    ch.on('message', async () => {
      await decision.promise;
      messageDone = true;
    });
    ch.on('cardAction', () => {
      decision.resolve('allow');
      return APPROVED;
    });

    // Resolves as soon as the message is enqueued; the handler itself runs on
    // the microtask queue and is parked on `decision` by the time the click lands.
    await dispatchEvent(ch, 'im.message.receive_v1', groupText('om_turn', 'run it'));
    await flushMicrotasks();
    expect(messageDone).toBe(false);

    const response = await withTimeout(
      dispatchEvent(ch, 'card.action.trigger', cardClick('om_card', { decision: 'allow' })),
      500,
    );
    await flushMicrotasks();

    expect(response).toEqual(APPROVED);
    expect(messageDone).toBe(true);
  });

  test('disconnect() waits for an in-flight click to settle and its dedup mark to land', async () => {
    const { ch, cache } = channelWith({ chatQueue: { enabled: true, cardActions: 'separate' } });
    const gate = deferred();
    const handler = vi.fn(async () => {
      await gate.promise;
    });
    ch.on('cardAction', handler);

    const clicked = dispatchEvent(ch, 'card.action.trigger', cardClick('om_slow', { cmd: 'A' }));
    await flushMicrotasks();
    expect(handler).toHaveBeenCalledTimes(1);

    const disconnected = ch.disconnect().then(() => {
      cache.sets.push('disposed');
    });
    expect(await stateAfterSettle(disconnected)).toBe('pending');

    gate.resolve();
    await disconnected;
    await clicked;

    const disposedAt = cache.sets.indexOf('disposed');
    const clickMarkAt = cache.sets.findIndex((k) => k.startsWith('card:'));
    expect(clickMarkAt).toBeGreaterThan(-1);
    expect(clickMarkAt).toBeLessThan(disposedAt);
  });
});

describe('with cardActions left unset', () => {
  test('a click still queues behind the in-flight message handler of its chat', async () => {
    const { ch } = channelWith({});
    const gate = deferred();
    const cardAction = vi.fn(() => APPROVED);

    ch.on('message', async () => {
      await gate.promise;
    });
    ch.on('cardAction', cardAction);

    await dispatchEvent(ch, 'im.message.receive_v1', groupText('om_busy', 'run it'));
    await flushMicrotasks();

    const clicked = dispatchEvent(ch, 'card.action.trigger', cardClick('om_wait', { cmd: 'A' }));
    await flushMicrotasks();
    expect(cardAction).not.toHaveBeenCalled();

    gate.resolve();
    await flushMicrotasks();
    expect(cardAction).toHaveBeenCalledTimes(1);
    expect(await clicked).toEqual(APPROVED);
  });
});
