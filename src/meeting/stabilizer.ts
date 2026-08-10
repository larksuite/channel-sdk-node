/**
 * Caption settling.
 *
 * Nothing on the wire marks which send of a sentence is the final one, so
 * settling is a debounce: later sends of a `sentence_id` overwrite earlier ones,
 * and the caller hears about the sentence once it stops changing.
 *
 * Arrival order does not decide which send is later. A session ingests from two
 * transports — pushes, and the liveness probe's gap-recovery read on a shared cursor
 * that can lag behind them — so an earlier, shorter version of a sentence can arrive
 * after a longer one. `endMs` grows as the speaker keeps talking, which makes it the
 * ordering key; a strictly older `endMs` is ignored. Equal values keep last-arrival-wins,
 * because a transcription fix rewrites a sentence without extending it.
 *
 * Two ways to lose a caption, both silent, both avoided here. Tearing down while
 * a sentence is pending flushes it rather than dropping it with the timer — the
 * last thing said before a meeting ended is usually the part that mattered. And
 * when the pending buffer is full the oldest entry is pushed out to the caller,
 * not discarded: bounding memory is not a licence to lose data.
 */

import type { MeetingTranscriptEvent } from './types';

/** Enough for a long meeting's worth of unsettled sentences; see the ceiling note. */
const DEFAULT_MAX_PENDING = 200;

export interface StabilizerOptions {
  /** `0` forwards every update immediately. */
  stabilizeMs: number;
  maxPending?: number;
  onFlush: (event: MeetingTranscriptEvent) => void;
}

interface Pending {
  event: MeetingTranscriptEvent;
  timer: NodeJS.Timeout;
}

export class TranscriptStabilizer {
  private readonly stabilizeMs: number;
  private readonly maxPending: number;
  private readonly onFlush: (event: MeetingTranscriptEvent) => void;
  /** Insertion-ordered, which is what makes "evict the oldest" well defined. */
  private readonly pending = new Map<string, Pending>();
  private disposed = false;

  constructor(opts: StabilizerOptions) {
    this.stabilizeMs = opts.stabilizeMs;
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.onFlush = opts.onFlush;
  }

  push(event: MeetingTranscriptEvent): void {
    if (this.disposed) return;

    // Without a debounce window, or without an id to debounce on, there is
    // nothing to wait for.
    if (this.stabilizeMs <= 0 || !event.sentenceId) {
      this.onFlush(event);
      return;
    }

    const key = event.sentenceId;
    // Not even the timer is restarted for a stale send: a run of late arrivals would
    // otherwise keep pushing the flush out while adding nothing.
    if (this.isStale(event, this.pending.get(key)?.event)) return;

    this.clearTimer(key);

    const timer = setTimeout(() => this.flush(key), this.stabilizeMs);
    timer.unref?.();
    this.pending.set(key, { event, timer });

    this.evictOldestIfFull(key);
  }

  /** Flush everything still pending. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const key of [...this.pending.keys()]) this.flush(key);
  }

  /** True when `incoming` describes an earlier state of the sentence than `held`. */
  private isStale(incoming: MeetingTranscriptEvent, held?: MeetingTranscriptEvent): boolean {
    if (held?.endMs === undefined || incoming.endMs === undefined) return false;
    return incoming.endMs < held.endMs;
  }

  private evictOldestIfFull(justAdded: string): void {
    while (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined || oldest === justAdded) break;
      this.flush(oldest);
    }
  }

  private flush(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    this.onFlush(entry.event);
  }

  private clearTimer(key: string): void {
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing.timer);
  }
}
