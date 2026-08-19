import { DEFAULT_LOCK_RENEW_INTERVAL_MS, DEFAULT_LOCK_TTL_MS } from './types';

interface LockEntry {
  expiresAt: number;
  renewable: boolean;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Short-TTL in-memory lock to prevent concurrent processing of the same
 * event — complements SeenCache by covering the "currently in flight"
 * window, during which the event is not yet committed to SeenCache.
 */
export class ProcessingLock {
  private readonly locks = new Map<string, LockEntry>();
  private renewalTimer?: NodeJS.Timeout;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;

  constructor(
    ttlMs: number = DEFAULT_LOCK_TTL_MS,
    renewIntervalMs: number = Math.min(DEFAULT_LOCK_RENEW_INTERVAL_MS, ttlMs / 3),
  ) {
    assertDuration('processingLock.ttlMs', ttlMs);
    assertDuration('processingLock.renewIntervalMs', renewIntervalMs, MAX_TIMER_DELAY_MS);
    if (renewIntervalMs >= ttlMs) {
      throw new RangeError('processingLock.renewIntervalMs must be less than processingLock.ttlMs');
    }
    this.ttlMs = ttlMs;
    this.renewIntervalMs = renewIntervalMs;
  }

  /**
   * Acquire a renewable lease. The lease remains live until `stopRenewal` is
   * called, even when its handler is waiting in a queue or batch.
   */
  acquire(id: string): boolean {
    const now = Date.now();
    const current = this.locks.get(id);
    if (current && current.expiresAt > now) return false;
    this.locks.set(id, { expiresAt: now + this.ttlMs, renewable: true });
    this.ensureRenewalTimer();
    return true;
  }

  /** Stop extending a lease while leaving it held until explicit release. */
  stopRenewal(id: string): void {
    const entry = this.locks.get(id);
    if (entry) entry.renewable = false;
    this.stopTimerIfIdle();
  }

  release(id: string): void {
    this.locks.delete(id);
    this.stopTimerIfIdle();
  }

  private ensureRenewalTimer(): void {
    if (this.renewalTimer) return;
    this.renewalTimer = setInterval(() => this.renew(), this.renewIntervalMs);
    this.renewalTimer.unref?.();
  }

  private renew(): void {
    const now = Date.now();
    for (const [id, entry] of this.locks) {
      if (entry.renewable) entry.expiresAt = now + this.ttlMs;
      else if (entry.expiresAt <= now) this.locks.delete(id);
    }
    this.stopTimerIfIdle();
  }

  private stopTimerIfIdle(): void {
    if (!this.renewalTimer) return;
    for (const entry of this.locks.values()) {
      if (entry.renewable) return;
    }
    clearInterval(this.renewalTimer);
    this.renewalTimer = undefined;
  }

  dispose(): void {
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    this.renewalTimer = undefined;
    this.locks.clear();
  }
}

function assertDuration(name: string, value: number, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isFinite(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be between 1 and ${max} milliseconds`);
  }
}
