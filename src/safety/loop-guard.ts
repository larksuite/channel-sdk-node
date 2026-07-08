import type { Logger } from '../internal';
import type { BotLoopGuardConfig, NormalizedMessage } from '../types';

interface WindowEntry {
  messageId: string;
  time: number;
}

interface KeyState {
  entries: WindowEntry[];
  warned: boolean;
}

const DEFAULTS = {
  windowMs: 60_000,
  maxBotMentions: 5,
  scope: 'chat' as const,
  onTrip: 'drop' as const,
};

/** Hard cap on tracked keys so the state map can't grow unbounded. */
const MAX_KEYS = 5000;

/**
 * Heuristic guard against two bots @-ing each other forever (opt-in, default
 * off). Only "another bot @'d me" messages count; a human message resets the
 * count; when the count reaches the threshold inside a sliding window the key
 * is tripped. `msg.createTime` is the clock, so counting is deterministic
 * (and, being event-supplied, only a best-effort — noted in the spec, not a
 * protocol-level defense).
 */
export class LoopGuard {
  readonly enabled: boolean;
  readonly onTrip: 'drop' | 'reject';
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly scope: 'chat' | 'chat+sender';
  private readonly states = new Map<string, KeyState>();

  constructor(
    cfg: BotLoopGuardConfig | undefined,
    private readonly logger: Logger,
  ) {
    this.enabled = cfg?.enabled ?? false;
    this.windowMs = cfg?.windowMs ?? DEFAULTS.windowMs;
    this.threshold = cfg?.maxBotMentions ?? DEFAULTS.maxBotMentions;
    this.scope = cfg?.scope ?? DEFAULTS.scope;
    this.onTrip = cfg?.onTrip ?? DEFAULTS.onTrip;
  }

  /**
   * Record a message; return whether its key is now tripped. A human message
   * resets the key and never trips; messages that aren't "another bot @'d me"
   * don't count. A re-delivered `messageId` already inside the window is
   * counted once. The first trip of a key emits exactly one warn.
   */
  record(msg: NormalizedMessage): boolean {
    if (!this.enabled) return false;
    const key = this.keyFor(msg);

    if (msg.senderType === 'user') {
      this.states.delete(key);
      return false;
    }
    if (!(msg.senderType === 'bot' && msg.mentionedBot)) return false;

    const state = this.states.get(key) ?? { entries: [], warned: false };
    const cutoff = msg.createTime - this.windowMs;
    state.entries = state.entries.filter((e) => e.time >= cutoff);
    if (!state.entries.some((e) => e.messageId === msg.messageId)) {
      state.entries.push({ messageId: msg.messageId, time: msg.createTime });
    }

    const tripped = state.entries.length >= this.threshold;
    if (tripped && !state.warned) {
      this.logger.warn?.(
        `channel: botLoopGuard tripped for ${key} — >=${this.threshold} bot @-mentions within ${this.windowMs}ms (onTrip=${this.onTrip})`,
      );
      state.warned = true;
    } else if (!tripped) {
      // Re-arm the one-time warn once the window has drained below threshold.
      state.warned = false;
    }

    this.remember(key, state);
    return tripped;
  }

  /** Store the key's state (LRU touch) and cap the number of tracked keys. */
  private remember(key: string, state: KeyState): void {
    this.states.delete(key);
    this.states.set(key, state);
    while (this.states.size > MAX_KEYS) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
  }

  private keyFor(msg: NormalizedMessage): string {
    return this.scope === 'chat+sender' ? `${msg.chatId}::${msg.senderId}` : msg.chatId;
  }
}
