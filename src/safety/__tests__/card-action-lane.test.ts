/**
 * Card actions and messages share one per-chat queue by default. That is the
 * right order guarantee for ordinary handlers, but it deadlocks the interactive
 * approval pattern: a `message` handler runs an agent turn, sends a card, and
 * awaits the click — while the click sits in the same queue behind the very
 * handler that is waiting for it (larksuite/channel-sdk-node#16).
 *
 * `chatQueue.cardActions: 'separate'` gives card actions their own per-chat
 * lane. These cases prove the two lanes never wait on each other by observing
 * the ORDER in which handlers get called, and pin everything that must not
 * change alongside it: dedup, the in-flight lock, return-value transparency,
 * same-chat click ordering, the message path (serial + debounce), the comment
 * path, and `dispose()` draining both lanes.
 *
 * Two conventions keep these cases honest:
 *   - Every "handler not called yet" assertion is followed by releasing the
 *     gate and asserting it IS called. Otherwise the assertion also passes when
 *     the handler could never be reached at all.
 *   - Whether a promise is still pending is judged by racing it against a
 *     microtask drain, never by awaiting it — under a wrong implementation the
 *     card action sits behind a gated message handler and `await` would hang
 *     until the vitest timeout.
 */

import type { NormalizedMessage, SafetyConfig } from '../../types';
import { SafetyPipeline } from '../index';

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

/**
 * A cache scoped to one pipeline that also records every key written, in
 * order. node-sdk's `internalCache` is a module singleton: pipelines built in
 * the same file would share one dedup namespace and a repeated fixture key
 * would be silently dropped by an unrelated case.
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

function makeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

/** A promise plus its resolver, so a test can hold a handler in-flight. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Let queued microtasks settle. Generous on purpose: a delivery crosses two
 * dedup lookups and a promise chain, so a tight count would turn an
 * implementation detail into a flaky assertion. It cannot over-flush — a gated
 * handler stays gated no matter how many turns pass.
 */
async function settle(times = 24): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Is `p` settled once the microtask queue drains, or still parked on something? */
function stateAfterSettle(p: Promise<unknown>): Promise<'resolved' | 'pending'> {
  return Promise.race([p.then(() => 'resolved' as const), settle().then(() => 'pending' as const)]);
}

function makeMsg(id: string, chatId: string, content = 'hello'): NormalizedMessage {
  return {
    messageId: id,
    chatId,
    chatType: 'group',
    senderId: 'ou_alice',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}

/** `batch.text.delayMs: 0` puts message delivery on the pure-serial path, so it only depends on microtasks. */
const NO_DEBOUNCE: SafetyConfig['batch'] = { text: { delayMs: 0 } };

function makePipeline(config: SafetyConfig) {
  const cache = makeRecordingCache();
  const logger = makeLogger();
  const onMessage = vi.fn(async (_msg: NormalizedMessage) => {});
  const pipeline = new SafetyPipeline({
    cache,
    logger,
    onReject: () => {},
    onMessage,
    // Group messages are rejected by the policy gate unless the bot is
    // mentioned; the fixture messages carry no mention.
    policy: { requireMention: false },
    config,
  });
  return { pipeline, cache, logger, onMessage };
}

const SEPARATE: SafetyConfig = {
  chatQueue: { enabled: true, cardActions: 'separate' },
  batch: NO_DEBOUNCE,
};

// ─────────────────────────────────────────────────────────────
// The two lanes do not wait on each other
// ─────────────────────────────────────────────────────────────

describe("cardActions: 'separate' — the click lane does not wait on the message lane", () => {
  test('a card action arriving while the same chat has a message handler in flight runs immediately', async () => {
    const { pipeline, onMessage } = makePipeline(SEPARATE);
    const gate = deferred();
    let messageDone = false;
    onMessage.mockImplementationOnce(async () => {
      await gate.promise;
      messageDone = true;
    });

    await pipeline.pushMessage(makeMsg('m1', 'oc_1'));
    await settle();
    expect(onMessage).toHaveBeenCalledTimes(1);

    const handler = vi.fn(async () => 'ok');
    const clicked = pipeline.pushCardAction('card:k1', 'oc_1', handler);
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await stateAfterSettle(clicked)).toBe('resolved');
    expect(await clicked).toBe('ok');
    // The message handler is still parked on its gate: the click did not wait for it.
    expect(messageDone).toBe(false);

    gate.resolve();
    await settle();
    expect(messageDone).toBe(true);
  });

  test('a message arriving while the same chat has a card action in flight is delivered immediately', async () => {
    const { pipeline, onMessage } = makePipeline(SEPARATE);
    const gate = deferred();
    const handler = vi.fn(async () => {
      await gate.promise;
      return 'clicked';
    });

    const clicked = pipeline.pushCardAction('card:k1', 'oc_1', handler);
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);

    await pipeline.pushMessage(makeMsg('m1', 'oc_1'));
    await settle();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(await stateAfterSettle(clicked)).toBe('pending');

    gate.resolve();
    expect(await clicked).toBe('clicked');
  });
});

// ─────────────────────────────────────────────────────────────
// What the dedicated lane keeps unchanged
// ─────────────────────────────────────────────────────────────

describe("cardActions: 'separate' — card actions in one chat still run one at a time", () => {
  test('the second click of a chat starts only after the first one settles, and both return their own value', async () => {
    const { pipeline } = makePipeline(SEPARATE);
    const gate = deferred();
    const first = vi.fn(async () => {
      await gate.promise;
      return 'first';
    });
    const second = vi.fn(async () => 'second');

    const p1 = pipeline.pushCardAction('card:k1', 'oc_1', first);
    const p2 = pipeline.pushCardAction('card:k2', 'oc_1', second);
    await settle();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(await stateAfterSettle(p2)).toBe('pending');

    gate.resolve();
    await settle();
    expect(second).toHaveBeenCalledTimes(1);
    expect(await p1).toBe('first');
    expect(await p2).toBe('second');
  });
});

describe("cardActions: 'separate' — repeated deliveries of the same click are dropped", () => {
  test('a repeat is dropped whether the first delivery is in flight, completed, or threw', async () => {
    const { pipeline, cache } = makePipeline(SEPARATE);
    const gate = deferred();
    const k1Handler = vi.fn(async () => {
      await gate.promise;
      return 'done';
    });
    const k2Handler = vi.fn(async () => 'never');

    // In flight: the first call holds the processing lock while parked on the gate.
    const firstDelivery = pipeline.pushCardAction('card:k1', 'oc_1', k1Handler);
    const whileInFlight = await pipeline.pushCardAction('card:k1', 'oc_1', k1Handler);
    expect(whileInFlight).toBeUndefined();

    gate.resolve();
    expect(await firstDelivery).toBe('done');

    // Completed: the dedup mark is now in the cache.
    const afterCompletion = await pipeline.pushCardAction('card:k1', 'oc_1', k1Handler);
    expect(afterCompletion).toBeUndefined();

    // Threw: a failed handler still leaves its dedup mark behind.
    await pipeline.pushCardAction('card:k2', 'oc_1', async () => {
      throw new Error('boom');
    });
    const afterThrow = await pipeline.pushCardAction('card:k2', 'oc_1', k2Handler);
    expect(afterThrow).toBeUndefined();

    expect(k1Handler).toHaveBeenCalledTimes(1);
    expect(k2Handler).not.toHaveBeenCalled();
    expect(cache.sets.filter((k) => k === 'card:k1')).toHaveLength(1);
    expect(cache.sets.filter((k) => k === 'card:k2')).toHaveLength(1);
  });
});

describe("cardActions: 'separate' — callback response semantics", () => {
  test('the handler return value comes back as-is', async () => {
    const { pipeline } = makePipeline(SEPARATE);
    const response = { toast: { type: 'success' } };

    const result = await pipeline.pushCardAction('card:k1', 'oc_1', async () => response);

    expect(result).toEqual(response);
  });

  test('a throwing handler yields no response and is logged as an error', async () => {
    const { pipeline, logger } = makePipeline(SEPARATE);

    const result = await pipeline.pushCardAction('card:k2', 'oc_1', async () => {
      throw new Error('boom');
    });

    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain('action handler threw');
  });
});

// ─────────────────────────────────────────────────────────────
// Existing configurations behave as before
// ─────────────────────────────────────────────────────────────

describe('existing configurations keep the shared-queue behaviour', () => {
  /**
   * Hold a message handler on a gate, then deliver a click to the same chat and
   * report whether the click ran before the gate was released. The positive
   * control (release, then assert it ran) is part of the check, so a click that
   * could never be reached does not pass as "correctly queued".
   */
  async function clickRunsBehindGatedMessage(config: SafetyConfig): Promise<void> {
    const { pipeline, onMessage } = makePipeline(config);
    const gate = deferred();
    onMessage.mockImplementationOnce(async () => {
      await gate.promise;
    });

    await pipeline.pushMessage(makeMsg('m1', 'oc_1'));
    await settle();
    expect(onMessage).toHaveBeenCalledTimes(1);

    const handler = vi.fn(async () => 'ok');
    const clicked = pipeline.pushCardAction('card:k1', 'oc_1', handler);
    await settle();
    expect(handler).not.toHaveBeenCalled();
    expect(await stateAfterSettle(clicked)).toBe('pending');

    gate.resolve();
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await clicked).toBe('ok');
  }

  test('with cardActions unset, a click still queues behind the in-flight message handler of its chat', async () => {
    await clickRunsBehindGatedMessage({ chatQueue: { enabled: true }, batch: NO_DEBOUNCE });
  });

  test("with cardActions: 'same', a click still queues behind the in-flight message handler of its chat", async () => {
    await clickRunsBehindGatedMessage({
      chatQueue: { enabled: true, cardActions: 'same' },
      batch: NO_DEBOUNCE,
    });
  });

  test("with chatQueue.enabled: false, a click runs immediately regardless of cardActions: 'separate'", async () => {
    const { pipeline, onMessage } = makePipeline({
      chatQueue: { enabled: false, cardActions: 'separate' },
      batch: NO_DEBOUNCE,
    });
    const gate = deferred();
    onMessage.mockImplementationOnce(async () => {
      await gate.promise;
    });

    await pipeline.pushMessage(makeMsg('m1', 'oc_1'));
    await settle();
    expect(onMessage).toHaveBeenCalledTimes(1);

    const handler = vi.fn(async () => 'ok');
    const clicked = pipeline.pushCardAction('card:k1', 'oc_1', handler);
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await clicked).toBe('ok');

    gate.resolve();
    await settle();
  });
});

// ─────────────────────────────────────────────────────────────
// The message path and the comment path are untouched
// ─────────────────────────────────────────────────────────────

describe("cardActions: 'separate' leaves the message path alone", () => {
  test('messages of one chat are still delivered one at a time, in arrival order', async () => {
    const { pipeline, onMessage } = makePipeline(SEPARATE);
    const gate = deferred();
    onMessage.mockImplementationOnce(async () => {
      await gate.promise;
    });

    await pipeline.pushMessage(makeMsg('m1', 'oc_1', 'first'));
    await pipeline.pushMessage(makeMsg('m2', 'oc_1', 'second'));
    await settle();
    expect(onMessage).toHaveBeenCalledTimes(1);

    gate.resolve();
    await settle();
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls.map(([m]) => m.content)).toEqual(['first', 'second']);
  });

  test('a click does not flush a debounce window that is still open; the batch merges on its own schedule', async () => {
    const { pipeline, onMessage } = makePipeline({
      chatQueue: { enabled: true, cardActions: 'separate' },
      batch: { text: { delayMs: 30 } },
    });

    // Awaited one at a time so both are in the buffer before the click lands.
    await pipeline.pushMessage(makeMsg('m1', 'oc_1', 'a'));
    await pipeline.pushMessage(makeMsg('m2', 'oc_1', 'b'));

    const handler = vi.fn(async () => 'ok');
    const clicked = pipeline.pushCardAction('card:k1', 'oc_1', handler);
    await settle();

    expect(onMessage).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await clicked).toBe('ok');

    await new Promise((r) => setTimeout(r, 80));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].content).toBe('a\n\nb');
  });
});

describe("cardActions: 'separate' leaves the comment path alone", () => {
  test('two comments on the same file still run one after the other', async () => {
    const { pipeline } = makePipeline(SEPARATE);
    const gate = deferred();
    const first = vi.fn(async () => {
      await gate.promise;
    });
    const second = vi.fn(async () => {});

    const p1 = pipeline.pushAction('comment:c1', 'file_1', first);
    const p2 = pipeline.pushAction('comment:c2', 'file_1', second);
    await settle();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    gate.resolve();
    await settle();
    expect(second).toHaveBeenCalledTimes(1);
    await Promise.all([p1, p2]);
  });
});

// ─────────────────────────────────────────────────────────────
// Unrecognized values
// ─────────────────────────────────────────────────────────────

describe('an unrecognized cardActions value', () => {
  test("warns once at construction and behaves like 'same'", async () => {
    // A misspelt option must not take the bot down, but it must not be silent
    // either. 'bypass' is the wording the original request used; the type does
    // not admit it, so it is forced through the way a JS caller would pass it.
    const { pipeline, logger, onMessage } = makePipeline({
      chatQueue: { enabled: true, cardActions: 'bypass' as never },
      batch: NO_DEBOUNCE,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warning = String(logger.warn.mock.calls[0][0]);
    expect(warning).toContain('chatQueue.cardActions');
    expect(warning).toContain('bypass');

    const gate = deferred();
    onMessage.mockImplementationOnce(async () => {
      await gate.promise;
    });
    await pipeline.pushMessage(makeMsg('m1', 'oc_1'));
    await settle();
    expect(onMessage).toHaveBeenCalledTimes(1);

    const handler = vi.fn(async () => 'ok');
    const clicked = pipeline.pushCardAction('card:k1', 'oc_1', handler);
    await settle();
    expect(handler).not.toHaveBeenCalled();
    expect(await stateAfterSettle(clicked)).toBe('pending');

    gate.resolve();
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await clicked).toBe('ok');
  });

  test('leaving cardActions unset does not warn', () => {
    const { logger } = makePipeline({ chatQueue: { enabled: true }, batch: NO_DEBOUNCE });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("cardActions: 'separate' does not warn", () => {
    const { logger } = makePipeline(SEPARATE);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────

describe('dispose() drains queued and in-flight card actions before resolving', () => {
  /**
   * Hold one click in flight and queue a second, then dispose. Dispose must stay
   * pending until both handlers settle AND both dedup marks are written — a
   * deployment with a persistent cache exits right after `disconnect()`, and a
   * mark written after that is a mark lost.
   */
  async function disposeWaitsForBothClicks(config: SafetyConfig): Promise<void> {
    const { pipeline, cache } = makePipeline(config);
    const gate = deferred();
    const first = vi.fn(async () => {
      await gate.promise;
    });
    const second = vi.fn(async () => {});

    const p1 = pipeline.pushCardAction('card:k1', 'oc_1', first);
    const p2 = pipeline.pushCardAction('card:k2', 'oc_1', second);
    await settle();
    expect(first).toHaveBeenCalledTimes(1);

    const disposed = pipeline.dispose().then(() => {
      cache.sets.push('disposed');
    });
    expect(await stateAfterSettle(disposed)).toBe('pending');

    gate.resolve();
    await disposed;
    await Promise.all([p1, p2]);

    expect(second).toHaveBeenCalledTimes(1);
    const disposedAt = cache.sets.indexOf('disposed');
    expect(disposedAt).toBeGreaterThan(-1);
    expect(cache.sets.indexOf('card:k1')).toBeGreaterThan(-1);
    expect(cache.sets.indexOf('card:k1')).toBeLessThan(disposedAt);
    expect(cache.sets.indexOf('card:k2')).toBeGreaterThan(-1);
    expect(cache.sets.indexOf('card:k2')).toBeLessThan(disposedAt);
  }

  test("under cardActions: 'separate', the dedicated lane is drained", async () => {
    await disposeWaitsForBothClicks(SEPARATE);
  });

  test("under cardActions: 'same', the shared lane is drained just the same", async () => {
    await disposeWaitsForBothClicks({
      chatQueue: { enabled: true, cardActions: 'same' },
      batch: NO_DEBOUNCE,
    });
  });
});
