/**
 * Handshake timeouts and the client they leave behind.
 *
 * A `WSClient` is created with `autoReconnect: true`, so when the outer
 * handshake budget expires and `connect()` rejects, that client is still alive:
 * it keeps dialing out and keeps pushing events into the shared dispatcher,
 * while the channel's own reference has already moved on. Nothing public can
 * reach it again.
 *
 * The assertions here therefore land on what an abandoned client *does*, not on
 * whether some teardown method was called. A suite that stubs `close` and
 * asserts it received `{ force: true }` stays green when the teardown is
 * reverted — it only ever proved that a line of code exists. So the fake client
 * below keeps a retry ticker running until `close()` reaches it, and the cases
 * ask whether the ticking stopped and whether events stopped arriving.
 *
 * What this file does not prove: that a real `close({ force: true })` can halt
 * a handshake that is still in flight. That is the underlying SDK's job, and
 * only versions from 1.73.1 on do it — the last case pins that floor.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { createLarkChannel, LarkChannelError } from '../index';

const wsFake = vi.hoisted(() => {
  /** How often a live autoReconnect client dials out in these cases. */
  const RECONNECT_TICK_MS = 10;

  interface Dispatcher {
    invoke(data: unknown, params: { needCheck: boolean }): Promise<unknown>;
  }

  /**
   * A `WSClient` whose handshake never completes.
   *
   * It never fires `onReady` or `onError`, so the only way out is the outer
   * timeout. `start()` begins a retry ticker that both counts outbound attempts
   * and pushes a synthetic message event through the dispatcher — the two
   * things a real orphan keeps doing. `close()` is the only thing that stops
   * the ticker, which is what makes "the ticker stopped" equivalent to "the
   * teardown reached *this* instance" without asserting on the call itself.
   */
  class FakeWSClient {
    /** Every instance built in the current case, in construction order. */
    static readonly created: FakeWSClient[] = [];

    readonly options: Record<string, unknown>;
    /** Outbound connection attempts made since `start()`. */
    outboundAttempts = 0;
    closed = false;
    private dispatcher?: Dispatcher;
    private ticker?: ReturnType<typeof setInterval>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeWSClient.created.push(this);
    }

    start(params: { eventDispatcher: Dispatcher }): void {
      this.dispatcher = params.eventDispatcher;
      const serial = FakeWSClient.created.indexOf(this);
      this.ticker = setInterval(() => {
        this.outboundAttempts += 1;
        const id = `${serial}_${this.outboundAttempts}`;
        // `create_time` is read at push time so the event is never outside the
        // staleness window, however far the fake clock has been advanced.
        const now = String(Date.now());
        const delivery = this.dispatcher?.invoke(
          {
            schema: '2.0',
            header: {
              event_id: `evt_${id}`,
              event_type: 'im.message.receive_v1',
              create_time: now,
            },
            event: {
              sender: { sender_id: { open_id: 'ou_stranger' }, sender_type: 'user' },
              message: {
                message_id: `om_${id}`,
                chat_id: 'oc_dm',
                chat_type: 'p2p',
                message_type: 'text',
                content: '{"text":"still here"}',
                create_time: now,
              },
            },
          },
          { needCheck: false },
        );
        void delivery?.catch(() => undefined);
      }, RECONNECT_TICK_MS);
    }

    close(_opts: { force?: boolean }): void {
      this.closed = true;
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  return { RECONNECT_TICK_MS, FakeWSClient };
});

vi.mock('@larksuiteoapi/node-sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, WSClient: wsFake.FakeWSClient };
});

const DEFAULT_BUDGET_MS = 15_000;

/**
 * How far to advance before reading the rejection. It has to clear the default
 * budget as well as the configured one: a build that ignores `connectTimeoutMs`
 * settles at 15000ms, and if the clock stopped short of that the promise would
 * simply never settle — the case would hang instead of reporting the wrong
 * budget.
 */
const SETTLE_MS = 20_000;

/** Long enough after a timeout that a still-live ticker cannot be missed. */
const AFTER_TIMEOUT_MS = 1_000;

/**
 * node-sdk's `internalCache` is a module singleton, so channels built in the
 * same file would share one dedup namespace and silently swallow each other's
 * events.
 */
function isolatedCache() {
  const store = new Map<string, string>();
  const key = (k: unknown, opts?: { namespace?: string }) => `${opts?.namespace ?? ''}|${k}`;
  return {
    get: async (k: unknown, opts?: { namespace?: string }) => store.get(key(k, opts)),
    set: async (k: unknown, v: string, _expiredTime?: number, opts?: { namespace?: string }) => {
      store.set(key(k, opts), v);
      return true;
    },
  };
}

function createChannel(extra: Record<string, unknown> = {}) {
  const ch = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'secret',
    loggerLevel: LoggerLevel.error,
    cache: isolatedCache(),
    ...extra,
  } as never);
  // `connect()` resolves the bot identity over REST before it opens a socket;
  // stubbing it keeps every case parked on the WebSocket handshake.
  (ch.rawClient as any).request = vi.fn().mockResolvedValue({
    bot: { open_id: 'ou_bot_self', app_name: 'Test Bot' },
  });
  return ch;
}

function connectWebSocket(ch: unknown, timeoutMs: number): Promise<void> {
  return (ch as { connectWebSocket: (ms: number) => Promise<void> }).connectWebSocket(timeoutMs);
}

function forceReconnect(ch: unknown): Promise<void> {
  return (ch as { forceReconnect: () => Promise<void> }).forceReconnect();
}

function resolveConnectTimeoutMs(ch: unknown): number {
  return (ch as { resolveConnectTimeoutMs: () => number }).resolveConnectTimeoutMs();
}

/**
 * Subscribe to the rejection immediately, settle it later. Attaching the
 * handler before the clock moves keeps the pending rejection from surfacing as
 * an unhandled one.
 */
async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the handshake to time out, but the attempt resolved');
}

const TIMEOUT_MESSAGE = /handshake did not complete within (\d+)ms/;

/**
 * The budget the error reports, as a number.
 *
 * Reading it back as a number rather than substring-matching the message is
 * what makes these assertions discriminating: the default message carries
 * "15000", which contains both "50" and "500" — the very values several cases
 * use to tell a configured budget apart from the default.
 */
function timeoutBudgetOf(err: Error): number {
  const match = TIMEOUT_MESSAGE.exec(err.message);
  if (!match) throw new Error(`not a handshake-timeout rejection: ${err.message}`);
  return Number(match[1]);
}

/** Kick off an attempt, let it time out, and report the budget it used. */
async function budgetOf(start: () => Promise<unknown>): Promise<number> {
  const attempt = rejectionOf(start());
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  return timeoutBudgetOf(await attempt);
}

function onlyClient() {
  expect(wsFake.FakeWSClient.created).toHaveLength(1);
  return wsFake.FakeWSClient.created[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  wsFake.FakeWSClient.created.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('what a handshake timeout leaves behind', () => {
  test('the abandoned client stops dialing out once connect() has given up', async () => {
    const ch = createChannel({ connectTimeoutMs: 50 });
    const attempt = rejectionOf(ch.connect());

    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    const err = await attempt;

    expect(err).toBeInstanceOf(LarkChannelError);
    expect(err).toMatchObject({ code: 'not_connected' });

    const client = onlyClient();
    const attemptsWhenAbandoned = client.outboundAttempts;
    await vi.advanceTimersByTimeAsync(AFTER_TIMEOUT_MS);
    expect(client.outboundAttempts).toBe(attemptsWhenAbandoned);

    expect(timeoutBudgetOf(err)).toBe(50);
  });

  test('the abandoned client stops delivering events to the message handler', async () => {
    const ch = createChannel({
      connectTimeoutMs: 50,
      // Batching debounces for 600ms by default, which would let an event
      // pushed before the timeout reach the handler after it — and then
      // "nothing new arrived" could no longer be read off the call count.
      // Queue off: one push, one call.
      safety: { chatQueue: { enabled: false } },
    });
    const delivered: string[] = [];
    ch.on('message', (msg) => {
      delivered.push(msg.messageId);
    });

    const attempt = rejectionOf(ch.connect());

    // Positive control, taken while the budget is still running whether or not
    // `connectTimeoutMs` is honoured. Without it, "no events after the
    // timeout" would also pass on a pipeline that never delivered anything.
    await vi.advanceTimersByTimeAsync(40);
    expect(delivered.length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await attempt;
    await vi.advanceTimersByTimeAsync(0);

    const deliveredWhenAbandoned = delivered.length;
    await vi.advanceTimersByTimeAsync(AFTER_TIMEOUT_MS);
    expect(delivered).toHaveLength(deliveredWhenAbandoned);
  });

  test('a timeout tears down the attempt that timed out, not the one now in flight', async () => {
    const ch = createChannel();
    const abandoned = rejectionOf(connectWebSocket(ch, 1_000));
    await vi.advanceTimersByTimeAsync(200);
    const inFlight = rejectionOf(connectWebSocket(ch, 10_000));

    // Past the first attempt's budget, far short of the second's.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(timeoutBudgetOf(await abandoned)).toBe(1_000);

    const [first, second] = wsFake.FakeWSClient.created;
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);

    const abandonedAttempts = first.outboundAttempts;
    const inFlightAttempts = second.outboundAttempts;
    await vi.advanceTimersByTimeAsync(AFTER_TIMEOUT_MS);
    expect(first.outboundAttempts).toBe(abandonedAttempts);
    expect(second.outboundAttempts).toBeGreaterThan(inFlightAttempts);

    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await inFlight;
  });
});

describe('the outer handshake budget', () => {
  test('defaults to 15000ms on both the first connect and a forced reconnect', async () => {
    expect(await budgetOf(() => createChannel().connect())).toBe(DEFAULT_BUDGET_MS);
    expect(await budgetOf(() => forceReconnect(createChannel()))).toBe(DEFAULT_BUDGET_MS);
  });

  test('connectTimeoutMs governs the first connect', async () => {
    const ch = createChannel({ connectTimeoutMs: 500 });
    expect(await budgetOf(() => ch.connect())).toBe(500);
  });

  test('connectTimeoutMs governs a forced reconnect too', async () => {
    const ch = createChannel({ connectTimeoutMs: 500 });
    expect(await budgetOf(() => forceReconnect(ch))).toBe(500);
  });

  test('handshakeTimeoutMs bounds one handshake at the transport, never the budget', async () => {
    const ch = createChannel({ handshakeTimeoutMs: 3_000 });

    expect(await budgetOf(() => forceReconnect(ch))).toBe(DEFAULT_BUDGET_MS);
    expect(onlyClient().options.handshakeTimeoutMs).toBe(3_000);
  });

  test.each([
    ['NaN', Number.NaN],
    ['zero', 0],
    ['a negative value', -1],
    // Infinity falls back rather than clamping to the ceiling. Pinned because
    // a tidier-looking guard (!Number.isNaN(x) && x > 0, then Math.min) passes
    // every other case here while silently turning this into 2147483647.
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('falls back to the default when connectTimeoutMs is %s', async (_label, value) => {
    const ch = createChannel({ connectTimeoutMs: value });
    expect(await budgetOf(() => ch.connect())).toBe(DEFAULT_BUDGET_MS);
  });

  // A budget past setTimeout's 32-bit ceiling must come down to the ceiling,
  // not wrap to the 1ms delay that would invert the caller's intent.
  //
  // Asserted on the resolver rather than end-to-end like its neighbours:
  // driving the real path would mean advancing ~24.8 days of fake time through
  // the fake client's 10ms reconnect tick.
  test('clamps a budget beyond the timer ceiling instead of inverting it', () => {
    expect(resolveConnectTimeoutMs(createChannel({ connectTimeoutMs: 2 ** 31 }))).toBe(
      2_147_483_647,
    );
    expect(resolveConnectTimeoutMs(createChannel({ connectTimeoutMs: 60_000 }))).toBe(60_000);
  });
});

describe('the dependency floor the teardown relies on', () => {
  const FLOOR = '1.73.1';

  /**
   * Parses a strict `major.minor.patch`. Anything else — a prerelease such as
   * `1.73.0-rc.1` included — throws rather than being coerced: `Number('0-rc')`
   * is `NaN`, and a `NaN` comparison would have silently ranked a version
   * *below* the floor as above it, letting this gate pass on an unfixed SDK.
   */
  function parseVersion(version: string): [number, number, number] {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) throw new Error(`expected a plain major.minor.patch, got: ${version}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function compareVersions(a: string, b: string): number {
    const left = parseVersion(a);
    const right = parseVersion(b);
    for (let i = 0; i < 3; i++) {
      if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
    }
    return 0;
  }

  test('node-sdk is declared and resolved at 1.73.1 or later', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest.dependencies['@larksuiteoapi/node-sdk']).toBe(`^${FLOOR}`);

    const resolve = createRequire(import.meta.url).resolve;
    const installed = JSON.parse(
      readFileSync(resolve('@larksuiteoapi/node-sdk/package.json'), 'utf8'),
    ).version as string;
    // Below this, close() cannot reach a client that is still handshaking, and
    // the teardown the cases above assert is a no-op against the real SDK.
    expect(compareVersions(installed, FLOOR), `installed ${installed}`).toBeGreaterThanOrEqual(0);
  });
});
