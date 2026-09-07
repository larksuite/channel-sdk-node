import type { Cache } from '@larksuiteoapi/node-sdk';
import type { Logger } from '../internal';
import type {
  BotIdentity,
  NormalizedMessage,
  PolicyConfig,
  RejectEvent,
  SafetyConfig,
} from '../types';

import { ChatPipelineManager } from './chat-pipeline';
import { SeenCache } from './dedup-cache';
import { LoopGuard } from './loop-guard';
import { PolicyGate } from './policy-gate';
import { ProcessingLock } from './processing-lock';
import { isStale } from './stale-detector';
import {
  type CardActionQueueMode,
  DEFAULT_STALE_MS,
  type OnMessageDispatch,
  type OnReject,
  resolveBatchConfig,
  resolveCardActionQueueMode,
} from './types';

export { ChatPipeline, ChatPipelineManager } from './chat-pipeline';
export { SeenCache } from './dedup-cache';
export { LoopGuard } from './loop-guard';
export type { PolicyDecision } from './policy-gate';
export { PolicyGate } from './policy-gate';
export { ProcessingLock } from './processing-lock';
export { isStale } from './stale-detector';

export interface SafetyPipelineOptions {
  config?: SafetyConfig;
  policy?: PolicyConfig;
  cache: Cache;
  botIdentity?: BotIdentity;
  logger: Logger;
  onReject: OnReject;
  onMessage: OnMessageDispatch;
}

/**
 * Pipeline entry facade for the channel's safety layer.
 *
 * Three tiers of protection, each targeting different event shapes:
 *   - pushMessage:    full pipeline (stale + dedup + policy + lock + batch + queue)
 *   - pushAction:     dedup + lock + queue (fileToken lane) — doc comments
 *   - pushCardAction: dedup + lock + queue — card clicks; the lane is chosen by
 *                     `chatQueue.cardActions`
 *   - pushLight:      dedup only — for reactions
 */
export class SafetyPipeline {
  private readonly seenCache: SeenCache;
  private readonly lock: ProcessingLock;
  private readonly policy: PolicyGate;
  private readonly loopGuard: LoopGuard;
  private readonly manager: ChatPipelineManager;
  private readonly cardActionManager: ChatPipelineManager;
  private readonly cardActionMode: CardActionQueueMode;
  private readonly staleWindow: number;
  private readonly queueEnabled: boolean;

  private readonly logger: Logger;
  private readonly onReject: OnReject;
  private readonly onMessage: OnMessageDispatch;

  constructor(opts: SafetyPipelineOptions) {
    this.logger = opts.logger;
    this.onReject = opts.onReject;
    this.onMessage = opts.onMessage;

    this.staleWindow = opts.config?.staleMessageWindowMs ?? DEFAULT_STALE_MS;
    this.queueEnabled = opts.config?.chatQueue?.enabled ?? true;

    this.seenCache = new SeenCache(opts.cache, {
      ttlMs: opts.config?.dedup?.ttl,
      maxMemEntries: opts.config?.dedup?.maxEntries,
      sweepMs: opts.config?.dedup?.sweepIntervalMs,
    });
    this.lock = new ProcessingLock();
    this.policy = new PolicyGate(opts.policy, opts.botIdentity, opts.logger);
    this.loopGuard = new LoopGuard(opts.policy?.botLoopGuard, opts.logger);
    const batch = resolveBatchConfig(opts.config);
    this.manager = new ChatPipelineManager(batch);
    // Card actions may get a lane of their own (`chatQueue.cardActions:
    // 'separate'`). A second manager rather than a prefixed scope in the first:
    // it only ever sees `run()`, so its pipelines are pure-serial, and it shares
    // no state with the message lane — a click can neither wait behind a message
    // handler nor flush that chat's debounce window early.
    this.cardActionManager = new ChatPipelineManager(batch);
    const rawMode = opts.config?.chatQueue?.cardActions;
    const { mode, unrecognized } = resolveCardActionQueueMode(rawMode);
    this.cardActionMode = mode;
    if (unrecognized) {
      this.logger.warn?.(
        `safety: unrecognized chatQueue.cardActions "${String(rawMode)}" (expected 'same' | 'separate'), falling back to 'same'`,
      );
    }
  }

  // ─── tier 1: full pipeline for IM messages ─────────────

  async pushMessage(msg: NormalizedMessage): Promise<void> {
    if (isStale(msg.createTime, this.staleWindow)) {
      this.logger.debug?.(`safety: drop stale message ${msg.messageId}`);
      return;
    }
    if (await this.seenCache.has(msg.messageId)) {
      this.logger.debug?.(`safety: drop duplicate message ${msg.messageId}`);
      return;
    }
    const decision = this.policy.evaluate(msg);
    if (!decision.allowed) {
      this.onReject({
        messageId: msg.messageId,
        chatId: msg.chatId,
        senderId: msg.senderId,
        reason: decision.reason ?? 'group_not_allowed',
      } as RejectEvent);
      return;
    }

    // Bot ping-pong guard (opt-in). Runs after dedup + policy so a re-delivery
    // can't inflate the count and a policy-rejected message never counts; a
    // human message (handled inside record) resets the window.
    if (this.loopGuard.enabled && this.loopGuard.record(msg)) {
      if (this.loopGuard.onTrip === 'reject') {
        this.onReject({
          messageId: msg.messageId,
          chatId: msg.chatId,
          senderId: msg.senderId,
          reason: 'bot_loop',
        } as RejectEvent);
      } else {
        this.logger.debug?.(`safety: drop bot-loop message ${msg.messageId}`);
      }
      return;
    }

    if (!this.lock.acquire(msg.messageId)) {
      this.logger.debug?.(`safety: drop in-flight message ${msg.messageId}`);
      return;
    }

    const dispatchHandler = async (batch: { message: NormalizedMessage; sourceIds: string[] }) => {
      try {
        await this.onMessage(batch.message);
      } catch (e) {
        this.logger.error?.(`safety: message handler threw`, e);
      } finally {
        for (const id of batch.sourceIds) {
          try {
            await this.seenCache.add(id);
          } catch {
            /* best effort */
          }
          this.lock.release(id);
        }
      }
    };

    if (this.queueEnabled) {
      this.manager.push(msg.chatId, msg, dispatchHandler);
    } else {
      // queueing disabled: fire-and-forget, no batch either
      void dispatchHandler({ message: msg, sourceIds: [msg.messageId] });
    }
  }

  // ─── tier 2: dedup + lock + queue for cardAction & comment ─────

  /**
   * Doc comments, or any action keyed by a non-chat scope. Serialized on the
   * shared manager under `queueScope`.
   */
  async pushAction<T>(
    eventId: string,
    queueScope: string,
    handler: () => Promise<T>,
  ): Promise<T | undefined> {
    return this.guardAction(eventId, handler, (task) =>
      this.queueEnabled ? this.manager.run(queueScope, task) : task(),
    );
  }

  /**
   * Card button clicks. Which per-chat lane they join is decided here, from
   * `chatQueue.cardActions`, so the channel only has to say "this is a card
   * action". Under `'same'` this is exactly the shared path `pushAction`
   * takes; under `'separate'` the click never touches the message lane.
   */
  async pushCardAction<T>(
    eventId: string,
    chatId: string,
    handler: () => Promise<T>,
  ): Promise<T | undefined> {
    return this.guardAction(eventId, handler, (task) => {
      if (!this.queueEnabled) return task();
      const lanes = this.cardActionMode === 'separate' ? this.cardActionManager : this.manager;
      return lanes.run(chatId, task);
    });
  }

  /**
   * What every action shares: drop redeliveries, hold the in-flight lock across
   * the handler, and always leave the dedup mark + release the lock whatever the
   * handler does. The lock is taken BEFORE `enqueue`, so a same-key redelivery
   * is dropped whether the first is queued, running or done — independent of
   * which lane runs it.
   *
   * The handler's return value is propagated back out so card-action callback
   * responses (e.g. a toast) can reach Feishu. A throwing handler is logged and
   * yields `undefined` (no response).
   */
  private async guardAction<T>(
    eventId: string,
    handler: () => Promise<T>,
    enqueue: (task: () => Promise<T | undefined>) => Promise<T | undefined>,
  ): Promise<T | undefined> {
    if (await this.seenCache.has(eventId)) {
      this.logger.debug?.(`safety: drop duplicate action ${eventId}`);
      return undefined;
    }
    if (!this.lock.acquire(eventId)) {
      this.logger.debug?.(`safety: drop in-flight action ${eventId}`);
      return undefined;
    }

    const task = async (): Promise<T | undefined> => {
      try {
        return await handler();
      } catch (e) {
        this.logger.error?.(`safety: action handler threw`, e);
        return undefined;
      } finally {
        try {
          await this.seenCache.add(eventId);
        } catch {
          /* best effort */
        }
        this.lock.release(eventId);
      }
    };

    return enqueue(task);
  }

  // ─── tier 3: dedup only (reactions) ────────────────────

  async pushLight(eventId: string, handler: () => void | Promise<void>): Promise<void> {
    if (await this.seenCache.has(eventId)) return;
    await this.seenCache.add(eventId);
    try {
      await handler();
    } catch (e) {
      this.logger.warn?.(`safety: light handler threw`, e);
    }
  }

  // ─── runtime config ────────────────────────────────────

  updatePolicy(partial: Partial<PolicyConfig>): void {
    this.policy.updateConfig(partial);
  }

  getPolicy(): Readonly<PolicyConfig> {
    return this.policy.getConfig();
  }

  setBotIdentity(bot: BotIdentity): void {
    this.policy.setBotIdentity(bot);
  }

  async dispose(): Promise<void> {
    // Both lanes drain before the cache and lock go away: a queued or running
    // action's `finally` still has to write its dedup mark.
    await Promise.all([this.manager.dispose(), this.cardActionManager.dispose()]);
    this.seenCache.dispose();
    this.lock.dispose();
  }
}
