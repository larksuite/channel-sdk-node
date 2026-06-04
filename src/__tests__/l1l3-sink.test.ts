/**
 * L1 + L3 sink batch:
 *   - ChatPipeline mergeWhileBusy: messages arriving while a flush is in
 *     flight accumulate and are delivered as a single merged next batch
 *     (delivery shape unchanged — one NormalizedMessage).
 *   - keepalive watchdog: force-reconnects only after DEAD_THRESHOLD ticks
 *     of "network reachable but WS not connected", and surfaces a failed
 *     reconnect via onUnrecoverable.
 */

import type { Logger, WSConnectionStatus } from '../internal';
import { startKeepalive } from '../keepalive';
import { ChatPipeline } from '../safety/chat-pipeline';
import type { BatchConfig, BatchedDispatch } from '../safety/types';
import type { NormalizedMessage } from '../types';

const silent: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

function msg(id: string, content = id): NormalizedMessage {
  return {
    messageId: id,
    chatId: 'oc_1',
    chatType: 'group',
    senderId: 'ou_u',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1_700_000_000_000,
  };
}

function cfg(over: Partial<BatchConfig> = {}): BatchConfig {
  return {
    delayMs: 0, // serial mode: flush immediately
    longThresholdChars: 1000,
    longDelayMs: 0,
    maxMessages: 100,
    maxChars: 1_000_000,
    mergeWhileBusy: false,
    ...over,
  };
}

describe('ChatPipeline mergeWhileBusy', () => {
  test('accumulates messages arriving during an in-flight flush into one batch', async () => {
    const p = new ChatPipeline(cfg({ mergeWhileBusy: true }), false);
    const batches: BatchedDispatch[] = [];
    let releaseFirst!: () => void;
    const handler = (d: BatchedDispatch): Promise<void> => {
      batches.push(d);
      if (batches.length === 1) {
        return new Promise<void>((r) => {
          releaseFirst = r;
        });
      }
      return Promise.resolve();
    };

    p.push(msg('a'), handler); // flush #1 starts, pipeline now busy
    p.push(msg('b'), handler); // accumulate while busy
    p.push(msg('c'), handler); // accumulate while busy
    await Promise.resolve();
    // Only the first batch has dispatched so far.
    expect(batches).toHaveLength(1);
    expect(batches[0].sourceIds).toEqual(['a']);

    releaseFirst(); // first handler resolves → settle hook flushes b+c
    await p.flushNow();

    expect(batches).toHaveLength(2);
    expect(batches[1].sourceIds).toEqual(['b', 'c']);
    expect(batches[1].message.content).toBe('b\n\nc');
  });

  test('without mergeWhileBusy, each serial message dispatches on its own', async () => {
    const p = new ChatPipeline(cfg({ mergeWhileBusy: false }), false);
    const batches: BatchedDispatch[] = [];
    const handler = (d: BatchedDispatch): Promise<void> => {
      batches.push(d);
      return Promise.resolve();
    };
    p.push(msg('a'), handler);
    p.push(msg('b'), handler);
    await p.flushNow();
    expect(batches.map((b) => b.sourceIds)).toEqual([['a'], ['b']]);
  });
});

describe('keepalive watchdog', () => {
  let state: WSConnectionStatus['state'];
  const status = (): WSConnectionStatus => ({ state, reconnectAttempts: 0 });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 } as Response));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('connected → never force-reconnects', async () => {
    state = 'connected';
    const forceReconnect = vi.fn().mockResolvedValue(undefined);
    const h = startKeepalive({
      getConnectionStatus: status,
      domain: 'https://open.feishu.cn',
      forceReconnect,
      logger: silent,
      intervalMs: 15_000,
    });
    await vi.advanceTimersByTimeAsync(15_000 * 4);
    expect(forceReconnect).not.toHaveBeenCalled();
    h.stop();
  });

  test('stuck + network reachable → force-reconnects after DEAD_THRESHOLD ticks', async () => {
    state = 'failed';
    const forceReconnect = vi.fn().mockResolvedValue(undefined);
    const h = startKeepalive({
      getConnectionStatus: status,
      domain: 'https://open.feishu.cn',
      forceReconnect,
      logger: silent,
      intervalMs: 15_000,
    });
    // tick 1, 2 — accumulate; tick 3 — fires
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(forceReconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(forceReconnect).toHaveBeenCalledTimes(1);
    h.stop();
  });

  test('failed reconnect surfaces via onUnrecoverable', async () => {
    state = 'failed';
    const forceReconnect = vi.fn().mockRejectedValue(new Error('still down'));
    const onUnrecoverable = vi.fn();
    const h = startKeepalive({
      getConnectionStatus: status,
      domain: 'https://open.feishu.cn',
      forceReconnect,
      onUnrecoverable,
      logger: silent,
      intervalMs: 15_000,
    });
    await vi.advanceTimersByTimeAsync(15_000 * 3);
    expect(forceReconnect).toHaveBeenCalledTimes(1);
    expect(onUnrecoverable).toHaveBeenCalledTimes(1);
    h.stop();
  });
});
