import { type ProcessingLease, ProcessingLock } from '../processing-lock';

function expectLease(lease: ProcessingLease | undefined): ProcessingLease {
  expect(lease).toBeDefined();
  return lease as ProcessingLease;
}

describe('ProcessingLock', () => {
  let lock: ProcessingLock;
  afterEach(() => {
    lock?.dispose();
    vi.useRealTimers();
  });

  test('first acquire returns a lease and competing acquire fails until exact release', () => {
    lock = new ProcessingLock();
    const first = expectLease(lock.acquire('m1'));
    expect(first.id).toBe('m1');
    expect(typeof first.ownerToken).toBe('symbol');
    expect(lock.acquire('m1')).toBeUndefined();
    lock.release(first);
    expect(lock.acquire('m1')).toBeDefined();
  });

  test('different ids are independent', () => {
    lock = new ProcessingLock();
    expect(lock.acquire('m1')).toBeDefined();
    expect(lock.acquire('m2')).toBeDefined();
    expect(lock.acquire('m1')).toBeUndefined();
    expect(lock.acquire('m2')).toBeUndefined();
  });

  test('renews an acquired lease across multiple original ttl periods', async () => {
    vi.useFakeTimers();
    lock = new ProcessingLock(50, 10);
    const lease = expectLease(lock.acquire('m1'));
    await vi.advanceTimersByTimeAsync(120);
    expect(lock.acquire('m1')).toBeUndefined();
    lock.stopRenewal(lease);
    await vi.advanceTimersByTimeAsync(51);
    expect(lock.acquire('m1')).toBeUndefined();
    lock.release(lease);
    expect(lock.acquire('m1')).toBeDefined();
  });

  test('stale owner release cannot delete a replacement lease', () => {
    lock = new ProcessingLock();
    const stale = expectLease(lock.acquire('m1'));
    lock.release(stale);
    const current = expectLease(lock.acquire('m1'));

    lock.release(stale);

    expect(lock.acquire('m1')).toBeUndefined();
    lock.release(current);
  });

  test('stale owner stopRenewal cannot stop a replacement lease', () => {
    vi.useFakeTimers();
    lock = new ProcessingLock(50, 10);
    const stale = expectLease(lock.acquire('m1'));
    lock.release(stale);
    const current = expectLease(lock.acquire('m1'));

    lock.stopRenewal(stale);

    expect((lock as any).locks.get('m1').state).toBe('active');
    expect(vi.getTimerCount()).toBe(1);
    expect(lock.acquire('m1')).toBeUndefined();
    lock.release(current);
  });

  test('active owner remains exclusive after fake clock passes ttl', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    lock = new ProcessingLock(50, 10);
    const lease = expectLease(lock.acquire('m1'));

    vi.setSystemTime(2_000);

    expect(lock.acquire('m1')).toBeUndefined();
    lock.release(lease);
  });

  test('multiple active ids renew independently', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    lock = new ProcessingLock(50, 10);
    const first = expectLease(lock.acquire('m1'));
    const second = expectLease(lock.acquire('m2'));
    await vi.advanceTimersByTimeAsync(10);
    const firstExpiry = (lock as any).locks.get('m1').expiresAt;
    const secondExpiry = (lock as any).locks.get('m2').expiresAt;

    lock.stopRenewal(first);
    await vi.advanceTimersByTimeAsync(20);

    expect((lock as any).locks.get('m1').expiresAt).toBe(firstExpiry);
    expect((lock as any).locks.get('m2').expiresAt).toBeGreaterThan(secondExpiry);
    expect(lock.acquire('m1')).toBeUndefined();
    expect(lock.acquire('m2')).toBeUndefined();
    lock.release(first);
    lock.release(second);
  });

  test('finalizing lease remains exclusive until exact release', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    lock = new ProcessingLock(50, 10);
    const lease = expectLease(lock.acquire('m1'));
    lock.stopRenewal(lease);
    vi.setSystemTime(2_000);

    expect(lock.acquire('m1')).toBeUndefined();
    lock.release(lease);
    expect(lock.acquire('m1')).toBeDefined();
  });

  test('release of a non-current lease is a no-op', () => {
    lock = new ProcessingLock();
    const unknown = Object.freeze({ id: 'unknown', ownerToken: Symbol('unknown') });
    expect(() => lock.release(unknown)).not.toThrow();
  });

  test('dispose clears the renewal timer', () => {
    vi.useFakeTimers();
    lock = new ProcessingLock(50, 10);
    lock.acquire('m1');
    expect(vi.getTimerCount()).toBe(1);
    lock.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    [0, 1],
    [-1, 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
    [50.5, 10],
    [50, 10.5],
    [2_147_483_648, 10],
    [2_147_483_647, 2_147_483_648],
    [50, 0],
    [50, 50],
    [50, 60],
  ])('invalid ttl/renew config fails loudly (%s, %s)', (ttlMs, renewIntervalMs) => {
    expect(() => new ProcessingLock(ttlMs, renewIntervalMs)).toThrow(RangeError);
  });
});
