import type { Logger, WSConnectionStatus } from './internal';

/**
 * App-level keepalive loop — defense-in-depth against silent WS / network
 * issues the SDK's internal ping watchdog might miss. Sunk from bridge's
 * `bot/keepalive.ts`.
 *
 *  1. Independent timer (default 15s), untied from the server-pushed ping
 *     cadence, to catch issues earlier and from a different angle.
 *  2. Wake-up detection — if the timer was skipped for > SLEEP_DETECT_MS the
 *     machine likely slept; reset counters and bail for this tick.
 *  3. Timer-storm guard — on wake, multiple intervals can fire back-to-back.
 *  4. HTTP probe — before force-reconnecting, check the Feishu domain is
 *     reachable; if not it's a network outage, not a WS problem.
 *  5. Counter-based debounce — only force-reconnect after DEAD_THRESHOLD
 *     consecutive ticks confirm WS is not connected.
 *
 * The "what to do when reconnect can't recover" policy stays with the app via
 * `onUnrecoverable` (e.g. restart the process).
 */

const DEFAULT_INTERVAL_MS = 15_000;
const SLEEP_DETECT_MS = 30_000;
const TIMER_STORM_GUARD_MS = 5_000;
const HTTP_PROBE_TIMEOUT_MS = 5_000;
const DEAD_THRESHOLD = 3;
const NETWORK_DOWN_LOG_EVERY = 20; // ~ every 5 min while network is down

export interface KeepaliveDeps {
  getConnectionStatus: () => WSConnectionStatus | undefined;
  /** HTTP probe target (the Feishu/Lark domain base URL). */
  domain: string;
  /** Tear down and re-establish the WebSocket. */
  forceReconnect: () => Promise<void>;
  /** Called when `forceReconnect` itself throws — i.e. reconnection failed
   *  and the app must decide (e.g. restart the process). */
  onUnrecoverable?: (err: unknown) => void;
  logger: Logger;
  intervalMs?: number;
}

export interface KeepaliveHandle {
  stop(): void;
}

export function startKeepalive(deps: KeepaliveDeps): KeepaliveHandle {
  const { getConnectionStatus, domain, forceReconnect, onUnrecoverable, logger } = deps;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  let lastTick = 0;
  let consecutiveDown = 0;
  let networkDownTicks = 0;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const now = Date.now();
    const sinceLast = lastTick > 0 ? now - lastTick : 0;

    // (3) Timer storm — multiple intervals firing at once on wake-up.
    if (sinceLast > 0 && sinceLast < TIMER_STORM_GUARD_MS) return;
    // (2) Sleep detection — machine likely just woke from sleep.
    if (sinceLast > SLEEP_DETECT_MS) {
      logger.info?.('channel: keepalive wake-up', { sleptMs: sinceLast });
      consecutiveDown = 0;
      networkDownTicks = 0;
      lastTick = now;
      return;
    }
    lastTick = now;

    const status = getConnectionStatus();
    if (!status) return; // not initialized yet
    if (status.state === 'connected') {
      if (consecutiveDown > 0) {
        logger.info?.('channel: keepalive recovered', { afterTicks: consecutiveDown });
      }
      consecutiveDown = 0;
      networkDownTicks = 0;
      return;
    }

    // (4) Is the network even reachable? If not, force-reconnect won't help.
    const reachable = await httpProbe(domain);
    if (!reachable) {
      networkDownTicks++;
      if (networkDownTicks === 1 || networkDownTicks % NETWORK_DOWN_LOG_EVERY === 0) {
        logger.warn?.('channel: network unreachable', { domain, networkDownTicks });
      }
      consecutiveDown = 0;
      return;
    }
    if (networkDownTicks > 0) {
      logger.info?.('channel: network reachable again', { afterTicks: networkDownTicks });
      networkDownTicks = 0;
    }

    // Network reachable but WS not connected → WS is stuck.
    consecutiveDown++;
    logger.warn?.('channel: keepalive ws-stuck', {
      state: status.state,
      reconnectAttempts: status.reconnectAttempts,
      consecutiveDown,
    });

    // (5) Debounce — wait for DEAD_THRESHOLD ticks before force-reconnecting.
    if (consecutiveDown >= DEAD_THRESHOLD) {
      logger.warn?.('channel: keepalive force-reconnect', { state: status.state });
      consecutiveDown = 0;
      try {
        await forceReconnect();
      } catch (err) {
        logger.error?.('channel: keepalive force-reconnect failed', err);
        onUnrecoverable?.(err);
      }
    }
  };

  const timer = setInterval(() => {
    void tick().catch((err) => logger.error?.('channel: keepalive tick failed', err));
  }, intervalMs);
  // Don't keep the event loop alive solely for the heartbeat.
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function httpProbe(domain: string): Promise<boolean> {
  const target = /^https?:\/\//i.test(domain) ? domain : 'https://open.feishu.cn';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(target, { method: 'HEAD', signal: ctrl.signal });
      // Any HTTP response (even 4xx/5xx) means the host answered → reachable.
      return res.status > 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
