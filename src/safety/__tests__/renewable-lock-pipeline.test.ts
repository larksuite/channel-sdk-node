import type { NormalizedMessage } from '../../types';
import { SafetyPipeline } from '../index';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
} as any;

afterEach(() => vi.useRealTimers());

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function message(messageId: string, chatId = 'oc_lock'): NormalizedMessage {
  return {
    messageId,
    chatId,
    chatType: 'p2p',
    senderId: 'ou_sender',
    content: messageId,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}

function makeCache() {
  const values = new Map<string, string>();
  return {
    values,
    cache: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: string) => {
        values.set(key, value);
        return true;
      },
    } as any,
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('handler pending across two ttl periods retains lock, then marks seen and releases', async () => {
  const gate = deferred();
  const { cache, values } = makeCache();
  let handlerCalls = 0;
  const pipeline = new SafetyPipeline({
    cache,
    logger,
    onReject: () => {},
    onMessage: async () => {
      handlerCalls++;
      await gate.promise;
    },
    config: {
      chatQueue: { enabled: false },
      processingLock: { ttlMs: 20, renewIntervalMs: 5 },
    },
  });

  await pipeline.pushMessage(message('om_renew'));
  await wait(50);
  await pipeline.pushMessage(message('om_renew'));
  expect(handlerCalls).toBe(1);

  gate.resolve();
  await wait(0);
  expect(values.has('om_renew')).toBe(true);
  const reacquired = (pipeline as any).lock.acquire('om_renew');
  expect(reacquired).toBeDefined();
  (pipeline as any).lock.release(reacquired);

  await pipeline.pushMessage(message('om_renew'));
  await wait(0);
  expect(handlerCalls).toBe(1);
  await pipeline.dispose();
});

test('event-loop stall beyond ttl cannot create a second handler lease', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const gate = deferred();
  const { cache } = makeCache();
  let handlerCalls = 0;
  const pipeline = new SafetyPipeline({
    cache,
    logger,
    onReject: () => {},
    onMessage: async () => {
      handlerCalls++;
      await gate.promise;
    },
    config: {
      chatQueue: { enabled: false },
      processingLock: { ttlMs: 20, renewIntervalMs: 5 },
    },
  });

  await pipeline.pushMessage(message('om_stalled'));
  await Promise.resolve();
  expect(handlerCalls).toBe(1);

  // Move wall clock beyond the lease TTL without executing any timer callback.
  vi.setSystemTime(2_000);
  await pipeline.pushMessage(message('om_stalled'));
  expect(handlerCalls).toBe(1);

  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await pipeline.dispose();
  vi.useRealTimers();
});

test('batching carries each source exact lease through cleanup', async () => {
  const { cache } = makeCache();
  const markSeen = vi.spyOn(cache, 'set');
  const pipeline = new SafetyPipeline({
    cache,
    logger,
    onReject: () => {},
    onMessage: async () => {},
    config: {
      chatQueue: { enabled: true },
      batch: { text: { delayMs: 10_000, maxMessages: 2 } },
      processingLock: { ttlMs: 50, renewIntervalMs: 10 },
    },
  });
  const lock = (pipeline as any).lock;
  const acquire = vi.spyOn(lock, 'acquire');
  const stopRenewal = vi.spyOn(lock, 'stopRenewal');
  const release = vi.spyOn(lock, 'release');

  await pipeline.pushMessage(message('om_batch_1'));
  await pipeline.pushMessage(message('om_batch_2'));
  await (pipeline as any).manager.flushAll();

  const firstLease = acquire.mock.results[0].value;
  const secondLease = acquire.mock.results[1].value;
  expect(stopRenewal.mock.calls[0][0]).toBe(firstLease);
  expect(stopRenewal.mock.calls[1][0]).toBe(secondLease);
  expect(release.mock.calls[0][0]).toBe(firstLease);
  expect(release.mock.calls[1][0]).toBe(secondLease);
  expect(stopRenewal.mock.invocationCallOrder[0]).toBeLessThan(
    markSeen.mock.invocationCallOrder[0],
  );
  expect(markSeen.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
  expect(stopRenewal.mock.invocationCallOrder[1]).toBeLessThan(
    markSeen.mock.invocationCallOrder[1],
  );
  expect(markSeen.mock.invocationCallOrder[1]).toBeLessThan(release.mock.invocationCallOrder[1]);
  await pipeline.dispose();
});

test('pushAction finalizes and releases the exact acquired lease', async () => {
  const { cache } = makeCache();
  const markSeen = vi.spyOn(cache, 'set');
  const pipeline = new SafetyPipeline({
    cache,
    logger,
    onReject: () => {},
    onMessage: async () => {},
    config: {
      chatQueue: { enabled: false },
      processingLock: { ttlMs: 50, renewIntervalMs: 10 },
    },
  });
  const lock = (pipeline as any).lock;
  const acquire = vi.spyOn(lock, 'acquire');
  const stopRenewal = vi.spyOn(lock, 'stopRenewal');
  const release = vi.spyOn(lock, 'release');

  await pipeline.pushAction('action_exact', 'oc_action', async () => 'ok');

  const lease = acquire.mock.results[0].value;
  expect(stopRenewal.mock.calls[0][0]).toBe(lease);
  expect(release.mock.calls[0][0]).toBe(lease);
  expect(stopRenewal.mock.invocationCallOrder[0]).toBeLessThan(
    markSeen.mock.invocationCallOrder[0],
  );
  expect(markSeen.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
  await pipeline.dispose();
});

test('lease stays renewable while a queued message waits behind another handler', async () => {
  const firstGate = deferred();
  const { cache } = makeCache();
  const handled: string[] = [];
  const pipeline = new SafetyPipeline({
    cache,
    logger,
    onReject: () => {},
    onMessage: async (msg) => {
      handled.push(msg.messageId);
      if (msg.messageId === 'om_first') await firstGate.promise;
    },
    config: {
      chatQueue: { enabled: true },
      batch: { text: { delayMs: 0, maxMessages: 1 } },
      processingLock: { ttlMs: 20, renewIntervalMs: 5 },
    },
  });
  const lock = (pipeline as any).lock;
  const acquire = vi.spyOn(lock, 'acquire');
  const stopRenewal = vi.spyOn(lock, 'stopRenewal');
  const release = vi.spyOn(lock, 'release');

  await pipeline.pushMessage(message('om_first'));
  await pipeline.pushMessage(message('om_waiting'));
  await wait(50);
  await pipeline.pushMessage(message('om_waiting'));
  expect(handled).toEqual(['om_first']);

  firstGate.resolve();
  await (pipeline as any).manager.flushAll();
  expect(handled).toEqual(['om_first', 'om_waiting']);
  const firstLease = acquire.mock.results[0].value;
  const waitingLease = acquire.mock.results[1].value;
  expect(stopRenewal.mock.calls[0][0]).toBe(firstLease);
  expect(stopRenewal.mock.calls[1][0]).toBe(waitingLease);
  expect(release.mock.calls[0][0]).toBe(firstLease);
  expect(release.mock.calls[1][0]).toBe(waitingLease);
  await pipeline.dispose();
});

test.each([
  { ttlMs: 0, renewIntervalMs: 1 },
  { ttlMs: 20, renewIntervalMs: 0 },
  { ttlMs: 20, renewIntervalMs: 20 },
  { ttlMs: 20.5, renewIntervalMs: 5 },
  { ttlMs: 20, renewIntervalMs: 5.5 },
  { ttlMs: Number.POSITIVE_INFINITY, renewIntervalMs: 5 },
  { ttlMs: 2_147_483_648, renewIntervalMs: 5 },
  { ttlMs: 2_147_483_647, renewIntervalMs: 2_147_483_648 },
])('SafetyConfig rejects invalid processing lock config: %o', (processingLock) => {
  const { cache } = makeCache();
  expect(
    () =>
      new SafetyPipeline({
        cache,
        logger,
        onReject: () => {},
        onMessage: async () => {},
        config: { processingLock },
      }),
  ).toThrow(RangeError);
});
