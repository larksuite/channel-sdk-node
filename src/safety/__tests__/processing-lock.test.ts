import { ProcessingLock } from '../processing-lock';

describe('ProcessingLock', () => {
  let lock: ProcessingLock;
  afterEach(() => {
    lock?.dispose();
    vi.useRealTimers();
  });

  test('first acquire succeeds, second fails until release', () => {
    lock = new ProcessingLock();
    expect(lock.acquire('m1')).toBe(true);
    expect(lock.acquire('m1')).toBe(false);
    lock.release('m1');
    expect(lock.acquire('m1')).toBe(true);
  });

  test('different ids are independent', () => {
    lock = new ProcessingLock();
    expect(lock.acquire('m1')).toBe(true);
    expect(lock.acquire('m2')).toBe(true);
    expect(lock.acquire('m1')).toBe(false);
    expect(lock.acquire('m2')).toBe(false);
  });

  test('renews an acquired lease across multiple original ttl periods', async () => {
    vi.useFakeTimers();
    lock = new ProcessingLock(50, 10);
    expect(lock.acquire('m1')).toBe(true);
    expect(lock.acquire('m1')).toBe(false);
    await vi.advanceTimersByTimeAsync(120);
    expect(lock.acquire('m1')).toBe(false);

    lock.stopRenewal('m1');
    await vi.advanceTimersByTimeAsync(51);
    expect(lock.acquire('m1')).toBe(true);
  });

  test('release of non-held id is a no-op', () => {
    lock = new ProcessingLock();
    expect(() => lock.release('unknown')).not.toThrow();
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
    [50, 0],
    [50, 50],
    [50, 60],
    [3_000_000_000, 2_147_483_648],
  ])('invalid ttl/renew config fails loudly (%s, %s)', (ttlMs, renewIntervalMs) => {
    expect(() => new ProcessingLock(ttlMs, renewIntervalMs)).toThrow(RangeError);
  });
});
