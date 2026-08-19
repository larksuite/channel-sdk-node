import { DEFAULT_LOCK_RENEW_INTERVAL_MS, DEFAULT_LOCK_TTL_MS } from './types';

export interface ProcessingLease {
  readonly id: string;
  readonly ownerToken: symbol;
}

interface LockEntry {
  lease: ProcessingLease;
  expiresAt: number;
  state: 'active' | 'finalizing';
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Short-TTL in-memory lock to prevent concurrent processing of the same
 * event — complements SeenCache by covering the "currently in flight"
 * window, during which the event is not yet committed to SeenCache. TTL is a
 * renewal deadline, never authority to steal an active or finalizing owner.
 */
export class ProcessingLock {
  private readonly locks = new Map<string, LockEntry>();
  private renewalTimer?: NodeJS.Timeout;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;

  constructor(
    ttlMs: number = DEFAULT_LOCK_TTL_MS,
    renewIntervalMs: number = defaultRenewInterval(ttlMs),
  ) {
    assertDuration('processingLock.ttlMs', ttlMs);
    assertDuration('processingLock.renewIntervalMs', renewIntervalMs);
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
  acquire(id: string): ProcessingLease | undefined {
    const now = Date.now();
    if (this.locks.has(id)) return undefined;
    const lease = Object.freeze({ id, ownerToken: Symbol(id) });
    this.locks.set(id, { lease, expiresAt: now + this.ttlMs, state: 'active' });
    this.ensureRenewalTimer();
    return lease;
  }

  /** Stop extending a lease while leaving it held until explicit release. */
  stopRenewal(lease: ProcessingLease): void {
    const entry = this.currentEntry(lease);
    if (entry) entry.state = 'finalizing';
    this.stopTimerIfIdle();
  }

  release(lease: ProcessingLease): void {
    if (this.currentEntry(lease)) this.locks.delete(lease.id);
    this.stopTimerIfIdle();
  }

  private currentEntry(lease: ProcessingLease): LockEntry | undefined {
    const entry = this.locks.get(lease.id);
    return entry?.lease.ownerToken === lease.ownerToken ? entry : undefined;
  }

  private ensureRenewalTimer(): void {
    if (this.renewalTimer) return;
    this.renewalTimer = setInterval(() => this.renew(), this.renewIntervalMs);
    this.renewalTimer.unref?.();
  }

  private renew(): void {
    const now = Date.now();
    for (const entry of this.locks.values()) {
      if (entry.state === 'active') entry.expiresAt = now + this.ttlMs;
    }
    this.stopTimerIfIdle();
  }

  private stopTimerIfIdle(): void {
    if (!this.renewalTimer) return;
    for (const entry of this.locks.values()) {
      if (entry.state === 'active') return;
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

function defaultRenewInterval(ttlMs: number): number {
  return Math.min(DEFAULT_LOCK_RENEW_INTERVAL_MS, Math.max(1, Math.floor(ttlMs / 3)));
}

function assertDuration(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `${name} must be a safe integer between 1 and ${MAX_TIMER_DELAY_MS} milliseconds`,
    );
  }
}
