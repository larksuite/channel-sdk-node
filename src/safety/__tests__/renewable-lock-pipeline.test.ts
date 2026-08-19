import type { NormalizedMessage } from '../../types';
import { SafetyPipeline } from '../index';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
} as any;

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
  expect((pipeline as any).lock.acquire('om_renew')).toBe(true);
  (pipeline as any).lock.release('om_renew');

  await pipeline.pushMessage(message('om_renew'));
  await wait(0);
  expect(handlerCalls).toBe(1);
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

  await pipeline.pushMessage(message('om_first'));
  await pipeline.pushMessage(message('om_waiting'));
  await wait(50);
  await pipeline.pushMessage(message('om_waiting'));
  expect(handled).toEqual(['om_first']);

  firstGate.resolve();
  await (pipeline as any).manager.flushAll();
  expect(handled).toEqual(['om_first', 'om_waiting']);
  await pipeline.dispose();
});

test.each([
  { ttlMs: 0, renewIntervalMs: 1 },
  { ttlMs: 20, renewIntervalMs: 0 },
  { ttlMs: 20, renewIntervalMs: 20 },
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
