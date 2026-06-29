/**
 * Regression for card-action dedup bug:
 *   different buttons on the same card by the same user must NOT collapse
 *   under SeenCache. The channel layer ensures distinct eventIds by hashing
 *   action.tag + action.value into the key; this test locks in the pipeline
 *   contract that distinct eventIds run independently while repeat ones
 *   still dedup.
 */

import { internalCache } from '../../internal';
import { SafetyPipeline } from '../index';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
} as any;

function makePipeline(): SafetyPipeline {
  return new SafetyPipeline({
    cache: internalCache,
    logger: silentLogger,
    onReject: () => {},
    onMessage: async () => {},
    // queue + batch off so this test only exercises dedup+lock.
    config: { chatQueue: { enabled: false } },
  });
}

function makeQueuedPipeline(): SafetyPipeline {
  return new SafetyPipeline({
    cache: internalCache,
    logger: silentLogger,
    onReject: () => {},
    onMessage: async () => {},
    // queue ON: exercises the manager.run<T> serialized path where the
    // handler's return value must flow back through pushAction.
    config: { chatQueue: { enabled: true } },
  });
}

/** A promise plus its resolver, so a test can hold a handler in-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('SafetyPipeline.pushAction dedup', () => {
  test('distinct eventIds both execute (different buttons, same card+user)', async () => {
    const pipeline = makePipeline();
    let calls = 0;
    const handler = async () => {
      calls++;
    };

    await pipeline.pushAction('card:m1:u1:button||{"cmd":"A"}', 'chat1', handler);
    await pipeline.pushAction('card:m1:u1:button||{"cmd":"B"}', 'chat1', handler);

    expect(calls).toBe(2);
  });

  test('repeated eventId is deduped (genuine Feishu re-delivery)', async () => {
    const pipeline = makePipeline();
    let calls = 0;
    const handler = async () => {
      calls++;
    };

    const key = 'card:m2:u1:button||{"cmd":"A"}';
    await pipeline.pushAction(key, 'chat2', handler);
    await pipeline.pushAction(key, 'chat2', handler);

    expect(calls).toBe(1);
  });
});

describe('SafetyPipeline.pushAction return value (callback response transparency)', () => {
  test('queue path transparently returns the handler return value; dedup hit returns undefined', async () => {
    const pipeline = makeQueuedPipeline();
    const key = 'card:m_ret:u1:button||{"cmd":"X"}';

    const first = await pipeline.pushAction(key, 'chat_ret', async () => 'X');
    // Same eventId again => dedup hit => no response (Feishu retry semantics).
    const second = await pipeline.pushAction(key, 'chat_ret', async () => 'X');

    expect(first).toBe('X');
    expect(second).toBeUndefined();
  });

  test('in-flight lock hit returns undefined and does not re-run the handler', async () => {
    const pipeline = makeQueuedPipeline();
    const key = 'card:m_inflight:u1:button||{"cmd":"X"}';

    let runs = 0;
    const gate = deferred<void>();
    const slowHandler = async () => {
      runs++;
      await gate.promise; // stay in-flight until released
      return 'first';
    };

    // Start the first call but don't await — it parks on the gate while
    // holding the processing lock for `key`.
    const firstPromise = pipeline.pushAction(key, 'chat_inflight', slowHandler);

    // Second concurrent call for the same eventId hits the in-flight lock.
    const second = await pipeline.pushAction(key, 'chat_inflight', async () => {
      runs++;
      return 'second';
    });

    expect(second).toBeUndefined();

    gate.resolve();
    const first = await firstPromise;

    expect(first).toBe('first');
    // Only the first handler executed; the locked-out call never ran.
    expect(runs).toBe(1);
  });
});
