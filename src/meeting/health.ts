/**
 * Parse-health counters for one inbound link.
 *
 * Counting "activities received" separately from "activities that unpacked to nothing"
 * separates "the platform never sent it" from "it arrived and could not be read". The
 * partial case (`0 < empty < received`) hides best: a single total looks healthy while
 * a subset vanishes.
 */

import type { MeetingActivityStats, MeetingLinkHealth } from './types';

/** Which transport an activity arrived over. Health is counted per link, not per mode. */
export type MeetingLink = 'push' | 'poll';

/**
 * Ceiling on distinct keys, matching `LoopGuard.MAX_KEYS`. The keys are server-chosen
 * strings and these counters live as long as the process.
 */
const MAX_DISTINCT_KEYS = 5000;

/** Where types past the ceiling are folded, so totals stay honest. */
const OVERFLOW_KEY = '__other__';

export class MeetingHealth {
  private received = 0;
  private lastAt: number | undefined;
  private readonly perType = new Map<string, MeetingActivityStats>();

  /**
   * Record one received activity. `itemCount` of 0 counts as empty, including for an
   * unrecognized activity type — that is the "SDK has fallen behind" signal.
   * `forwardCompatible` opts out, for a sub-variant the platform just added.
   */
  record(activityType: string, itemCount: number, opts?: { forwardCompatible?: boolean }): void {
    this.received++;
    this.lastAt = Date.now();

    const key = this.keyFor(activityType);
    const stats = this.perType.get(key) ?? { received: 0, empty: 0 };
    stats.received++;
    if (itemCount === 0 && !opts?.forwardCompatible) stats.empty++;
    this.perType.set(key, stats);
  }

  stats(): Record<string, MeetingActivityStats> {
    return Object.fromEntries([...this.perType].map(([k, v]) => [k, { ...v }]));
  }

  counters(): MeetingLinkHealth {
    return {
      received: this.received,
      ...(this.lastAt ? { lastAt: this.lastAt } : {}),
      stats: this.stats(),
    };
  }

  private keyFor(activityType: string): string {
    if (this.perType.has(activityType)) return activityType;
    return this.perType.size >= MAX_DISTINCT_KEYS ? OVERFLOW_KEY : activityType;
  }
}
