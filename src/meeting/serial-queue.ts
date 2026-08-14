/**
 * Runs tasks one at a time.
 *
 * A session has two producers — the push router and the probe's gap-recovery read —
 * and letting them interleave breaks both the documented "a handler is awaited before
 * the next item" and the duplicate check, whose read-then-write would see two misses
 * for one re-sent activity.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Queue `task` and resolve with its result. Awaiting the result applies
   * backpressure; a rejection reaches the caller without stalling the queue.
   *
   * The barrier is published before the task can start: `.then` defers the call while
   * `this.tail` is reassigned in the same synchronous step. A task's synchronous
   * prefix can re-enter `run` — a settled caption invokes a handler, the handler calls
   * `leave()`, teardown queues `end` — and any arrangement that runs the task first
   * would let that nested call queue behind the *previous* barrier.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(noop, noop);
    return result;
  }
}

function noop(): void {
  /* a failed task must not stall everything behind it */
}
