/**
 * botLoopGuard — bot ping-pong defense, opt-in, default off.
 *
 * Only "another bot @'d me" messages count (`senderType==='bot' &&
 * mentionedBot`). A sliding window keyed by chat (or chat+sender) uses
 * `msg.createTime` as the clock so it is fully deterministic. When the count
 * reaches the threshold within the window it trips. Details pinned here:
 *   - user messages reset the key; ineligible messages don't count,
 *   - the same messageId is de-duplicated within the window,
 *   - the first trip emits exactly one warn,
 *   - pipeline wiring: `drop` drops (no onMessage), `reject` fires onReject
 *     with reason 'bot_loop'; default (unconfigured) delivers as before.
 *
 */

import { internalCache } from '@larksuiteoapi/node-sdk';
import type { NormalizedMessage, PolicyConfig } from '../../types';
import { SafetyPipeline } from '../index';
import { LoopGuard } from '../loop-guard';

function noopLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any;
}

let seq = 0;
function msg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  seq += 1;
  return {
    messageId: `om_${seq}`,
    chatId: 'oc_loop',
    chatType: 'group',
    senderId: 'ou_botA',
    senderType: 'bot',
    senderIsBot: true,
    content: 'hi',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1_000_000,
    ...overrides,
  } as NormalizedMessage;
}

describe('LoopGuard.record counting', () => {
  test('reaching the threshold within the window trips', () => {
    const guard = new LoopGuard(
      { enabled: true, windowMs: 60_000, maxBotMentions: 3 },
      noopLogger(),
    );
    expect(guard.record(msg({ createTime: 0 }))).toBe(false);
    expect(guard.record(msg({ createTime: 1_000 }))).toBe(false);
    expect(guard.record(msg({ createTime: 2_000 }))).toBe(true);
  });

  test('entries older than the window slide out and do not accumulate', () => {
    const guard = new LoopGuard(
      { enabled: true, windowMs: 60_000, maxBotMentions: 2 },
      noopLogger(),
    );
    expect(guard.record(msg({ createTime: 0 }))).toBe(false);
    // Beyond the window: the first entry expires, so this is only count 1.
    expect(guard.record(msg({ createTime: 60_001 }))).toBe(false);
  });

  test('ineligible messages are not counted', () => {
    // maxBotMentions:1 means any counted message would trip immediately.
    const guard = new LoopGuard(
      { enabled: true, windowMs: 60_000, maxBotMentions: 1 },
      noopLogger(),
    );
    expect(
      guard.record(
        msg({ senderType: 'user', senderIsBot: false, mentionedBot: false, createTime: 0 }),
      ),
    ).toBe(false);
    expect(guard.record(msg({ senderType: 'bot', mentionedBot: false, createTime: 1_000 }))).toBe(
      false,
    );
  });

  test('a user message resets the key', () => {
    const guard = new LoopGuard(
      { enabled: true, windowMs: 60_000, maxBotMentions: 2 },
      noopLogger(),
    );
    expect(guard.record(msg({ createTime: 0 }))).toBe(false); // count 1
    // Without this reset, the next bot message would trip at count 2.
    expect(
      guard.record(
        msg({ senderType: 'user', senderIsBot: false, mentionedBot: false, createTime: 1_000 }),
      ),
    ).toBe(false);
    expect(guard.record(msg({ createTime: 2_000 }))).toBe(false); // count 1 again
    expect(guard.record(msg({ createTime: 3_000 }))).toBe(true); // count 2 -> trip
  });

  test('the same messageId within the window is counted once', () => {
    const guard = new LoopGuard(
      { enabled: true, windowMs: 60_000, maxBotMentions: 2 },
      noopLogger(),
    );
    const dup = msg({ messageId: 'om_dup', createTime: 0 });
    expect(guard.record(dup)).toBe(false); // count 1
    expect(guard.record({ ...dup })).toBe(false); // re-delivery: deduped, still 1
    expect(guard.record(msg({ messageId: 'om_new', createTime: 1_000 }))).toBe(true); // count 2 -> trip
  });
});

describe('LoopGuard scope', () => {
  test('chat+sender counts each sender independently', () => {
    const guard = new LoopGuard(
      { enabled: true, windowMs: 60_000, maxBotMentions: 2, scope: 'chat+sender' },
      noopLogger(),
    );
    expect(guard.record(msg({ senderId: 'ou_botA', createTime: 0 }))).toBe(false);
    expect(guard.record(msg({ senderId: 'ou_botB', createTime: 1_000 }))).toBe(false); // separate key
    expect(guard.record(msg({ senderId: 'ou_botA', createTime: 2_000 }))).toBe(true); // botA hits 2
  });

  test('chat merges different senders into one count', () => {
    const guard = new LoopGuard(
      { enabled: true, windowMs: 60_000, maxBotMentions: 2, scope: 'chat' },
      noopLogger(),
    );
    expect(guard.record(msg({ senderId: 'ou_botA', createTime: 0 }))).toBe(false);
    expect(guard.record(msg({ senderId: 'ou_botB', createTime: 1_000 }))).toBe(true); // merged -> 2
  });
});

describe('LoopGuard observability', () => {
  test('the first trip warns exactly once', () => {
    const logger = noopLogger();
    const guard = new LoopGuard({ enabled: true, windowMs: 60_000, maxBotMentions: 1 }, logger);
    expect(guard.record(msg({ createTime: 0 }))).toBe(true); // first trip -> warn
    expect(guard.record(msg({ createTime: 1_000 }))).toBe(true); // still tripped, same window
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

// ── pipeline wiring ─────────────────────────────────────────────

const flush = () => new Promise((r) => setTimeout(r, 0));

function makePipeline(policy: PolicyConfig) {
  const onMessage = vi.fn().mockResolvedValue(undefined);
  const onReject = vi.fn();
  const pipeline = new SafetyPipeline({
    config: { chatQueue: { enabled: false } },
    policy,
    cache: internalCache,
    botIdentity: { openId: 'ou_bot', name: 'B' },
    logger: noopLogger(),
    onReject,
    onMessage,
  });
  return { pipeline, onMessage, onReject };
}

// Fresh createTime so isStale() (30-min window from wall clock) never drops it.
function pipelineMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return msg({ senderId: 'ou_otherbot', createTime: Date.now(), ...overrides });
}

describe('pipeline wiring', () => {
  test('onTrip="drop" drops the tripped message (onMessage not called)', async () => {
    const { pipeline, onMessage } = makePipeline({
      botLoopGuard: { enabled: true, maxBotMentions: 1, windowMs: 60_000, onTrip: 'drop' },
    });
    await pipeline.pushMessage(pipelineMsg({ messageId: 'om_drop1' }));
    await flush();
    expect(onMessage).not.toHaveBeenCalled();
  });

  test('onTrip="reject" fires onReject with reason "bot_loop"', async () => {
    const { pipeline, onReject } = makePipeline({
      botLoopGuard: { enabled: true, maxBotMentions: 1, windowMs: 60_000, onTrip: 'reject' },
    });
    await pipeline.pushMessage(pipelineMsg({ messageId: 'om_rej1' }));
    await flush();
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ reason: 'bot_loop' }));
  });

  test('default (guard unconfigured): a bot@me message is delivered as before', async () => {
    const { pipeline, onMessage } = makePipeline({});
    await pipeline.pushMessage(pipelineMsg({ messageId: 'om_off1' }));
    await flush();
    expect(onMessage).toHaveBeenCalled();
  });
});
