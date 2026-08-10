/**
 * Shared fixtures for the meeting-channel suites.
 *
 * The push and poll builders describe the SAME semantic batch in the two wire
 * shapes Feishu uses, which nest differently:
 *   - push (`vc.bot.meeting_activity_v1`): `meeting_activity_items[]`, each item
 *     carrying `activity_event_type` and its `*_items[]` arrays FLAT on itself.
 *   - poll (`vc.v1.bot.events`): `events[]`, each carrying `event_id` plus the
 *     same `activity_event_type` and `*_items[]` nested under `payload`.
 * Shapes were read off `@larksuiteoapi/node-sdk@1.73.0` `types/index.d.ts`, not
 * off prose docs — the nesting difference is not documented anywhere else.
 *
 * Both builders derive from one `ACTIVITY_BATCH` on purpose: normalizing either
 * shape has to produce the same events, and that equivalence can only be
 * asserted if the two inputs cannot drift apart.
 */

import { inspect } from 'node:util';
import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '../../index';

export const BOT_OPEN_ID = 'ou_bot_self';
export const MEETING_ID = '7180000000000000001';
export const MEETING_NO = '123456789';
export const MEETING_TOPIC = 'Weekly sync';

/**
 * The user access token every credential-hygiene assertion greps for. Kept
 * distinctive so a `not.toContain` can never pass by accident, and distinct
 * from the app secret so the two leak paths cannot be confused.
 */
export const USER_TOKEN = 'u-secret';

/** A signed one-click authorization link: itself a credential, never a plain URL. */
export const CONSOLE_URL =
  'https://open.feishu.cn/app/cli_test/auth?q=vc%3Ameeting%3Abot&state=Zm9vYmFy&sig=abcdef123456';

const ALICE = { id: 'ou_alice', user_type: 1, user_role: 2, user_name: 'Alice' };
const BOB = { id: 'ou_bob', user_type: 1, user_role: 1, user_name: 'Bob' };

const MEETING = {
  id: MEETING_ID,
  topic: MEETING_TOPIC,
  meeting_no: MEETING_NO,
  start_time: '1700000000',
  host_user: BOB,
};

/**
 * One entry == one `activity_event_type` plus its item arrays. Three activities
 * carrying five items in total, so "delivers every item, not just the first of
 * the first" is observable in both unpack layers at once.
 */
const ACTIVITY_BATCH: Array<Record<string, unknown>> = [
  {
    activity_event_type: 'transcript_received',
    transcript_received_items: [
      {
        speaker: ALICE,
        text: 'good morning',
        language: 'en_us',
        start_time_ms: '1000',
        end_time_ms: '1500',
        sentence_id: 's_1',
      },
      {
        speaker: BOB,
        text: 'morning all',
        language: 'en_us',
        start_time_ms: '1600',
        end_time_ms: '2100',
        sentence_id: 's_2',
      },
    ],
  },
  {
    activity_event_type: 'chat_received',
    chat_received_items: [
      {
        operator: ALICE,
        message_id: 'omc_1',
        message_type: 1,
        content: 'agenda?',
        send_time: '1700',
      },
      {
        operator: BOB,
        message_id: 'omc_2',
        message_type: 1,
        content: 'sent it',
        send_time: '1800',
      },
    ],
  },
  {
    activity_event_type: 'participant_joined',
    participant_joined_items: [{ participant: BOB, join_time: '900' }],
  },
];

function pushEnvelope(
  eventId: string,
  activities: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return structuredClone({
    event_id: eventId,
    event_type: 'vc.bot.meeting_activity_v1',
    tenant_key: 'tk_test',
    create_time: '1700000005000',
    meeting_activity_items: activities.map((a) => ({ meeting: MEETING, ...a })),
  });
}

/** A `vc.bot.meeting_activity_v1` push: 3 activities carrying 5 items. */
export function pushActivity(): Record<string, unknown> {
  return pushEnvelope('evt_push_batch', ACTIVITY_BATCH);
}

/**
 * The `data` object of a `vc.v1.bot.events` response carrying the same five
 * items as {@link pushActivity}, in the poll shape.
 */
export function pollEvents(): Record<string, unknown> {
  return structuredClone({
    has_more: false,
    page_token: 'pt_next',
    events: ACTIVITY_BATCH.map((a, i) => ({
      event_id: `evt_poll_${i + 1}`,
      event_type: 'vc.bot.meeting_activity_v1',
      event_time: '1700000005000',
      payload: { meeting: MEETING, ...a },
    })),
  });
}

/**
 * A share hand-off inside one push: the old share ends and a new one starts.
 * Array order is the only thing that says which share is current, so it has to
 * survive delivery intact.
 */
export function pairedShare(): Record<string, unknown> {
  return pushEnvelope('evt_paired_share', [
    {
      activity_event_type: 'magic_share_ended',
      magic_share_ended_items: [{ operator: ALICE, share_id: 'sh_old', time: '3000' }],
    },
    {
      activity_event_type: 'magic_share_started',
      magic_share_started_items: [
        {
          operator: BOB,
          share_id: 'sh_new',
          share_doc: { url: 'https://example.com/docx/abc', title: 'Design doc' },
          time: '3001',
        },
      ],
    },
  ]);
}

/** A push carrying exactly one transcript item. */
export function transcriptPush(opts: {
  eventId?: string;
  text: string;
  sentenceId?: string;
  speaker?: Record<string, unknown>;
  startMs?: string;
  endMs?: string;
}): Record<string, unknown> {
  return pushEnvelope(opts.eventId ?? 'evt_transcript', [
    {
      activity_event_type: 'transcript_received',
      transcript_received_items: [
        {
          speaker: opts.speaker ?? ALICE,
          text: opts.text,
          language: 'en_us',
          start_time_ms: opts.startMs ?? '5000',
          end_time_ms: opts.endMs ?? '5400',
          sentence_id: opts.sentenceId ?? 's_single',
        },
      ],
    },
  ]);
}

/**
 * The same sentence pushed three times as the speaker keeps talking: one
 * `sentence_id`, growing text. Every one of the three is a real update the
 * caller has to see — treating `sentence_id` as a dedup key would leave only
 * the first, and subtitles would freeze at "he".
 */
export function growingTranscript(): Array<Record<string, unknown>> {
  return ['he', 'he said', 'he said hello'].map((text, i) =>
    transcriptPush({
      eventId: `evt_grow_${i + 1}`,
      text,
      sentenceId: 's_grow',
      startMs: '5000',
      endMs: String(5200 + i * 200),
    }),
  );
}

/**
 * An AxiosError shaped the way `withUserAccessToken` failures really arrive.
 *
 * The bearer token sits in TWO places — `config.headers` and
 * `response.config.headers` — and only the first is reachable through
 * `toJSON()`. An implementation that enumerates known paths instead of
 * matching key names recursively tends to scrub one copy and miss the other,
 * so `carry` lets a case put the token in only the copy it wants to probe.
 */
export function axiosErrorWithToken(
  opts: {
    status?: number;
    feishuCode?: number;
    msg?: string;
    carry?: 'both' | 'config' | 'response';
  } = {},
): Error {
  const status = opts.status ?? 401;
  const feishuCode = opts.feishuCode ?? 99991401;
  const carry = opts.carry ?? 'both';
  const url = 'https://open.feishu.cn/open-apis/vc/v1/bots/events';
  const authHeader = { Authorization: `Bearer ${USER_TOKEN}`, 'User-Agent': 'channel-test' };
  const cleanHeader = { 'User-Agent': 'channel-test' };

  const err = new Error(`Request failed with status code ${status}`) as Error & {
    [k: string]: unknown;
  };
  err.name = 'AxiosError';
  err.isAxiosError = true;
  err.code = status === 401 || status === 403 ? 'ERR_BAD_REQUEST' : 'ERR_BAD_RESPONSE';
  err.config = {
    url,
    method: 'get',
    params: { meeting_id: MEETING_ID, user_id_type: 'open_id' },
    headers: carry === 'response' ? { ...cleanHeader } : { ...authHeader },
  };
  err.response = {
    status,
    statusText: status === 401 ? 'Unauthorized' : 'Error',
    data: { code: feishuCode, msg: opts.msg ?? 'invalid access token' },
    headers: { 'x-tt-logid': 'logid_test_1' },
    config: {
      url,
      method: 'get',
      headers: carry === 'config' ? { ...cleanHeader } : { ...authHeader },
    },
  };
  // axios defines this, and it is what JSON-serializing loggers actually emit.
  err.toJSON = function toJSON(this: Record<string, unknown>) {
    return { message: this.message, name: this.name, code: this.code, config: this.config };
  };
  return err;
}

/**
 * A permission-denied response carrying the signed console link Feishu hands
 * back when a scope is missing.
 */
export function permissionDeniedError(consoleUrl: string = CONSOLE_URL): Error {
  const err = new Error('Request failed with status code 403') as Error & {
    [k: string]: unknown;
  };
  err.name = 'AxiosError';
  err.isAxiosError = true;
  err.response = {
    status: 403,
    data: {
      code: 99991672,
      msg: 'no permission',
      error: {
        console_url: consoleUrl,
        permission_violations: [{ type: 'scope', subject: 'vc:meeting.bot.join:write' }],
      },
    },
    headers: {},
    config: {
      url: 'https://open.feishu.cn/open-apis/vc/v1/bots/join',
      method: 'post',
      headers: {},
    },
  };
  return err;
}

// ─────────────────────────────────────────────────────────────
// Test rig
// ─────────────────────────────────────────────────────────────

export interface CapturedLogger {
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
}

export function makeLogger(): CapturedLogger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

function allCalls(logger: CapturedLogger): unknown[][] {
  return [logger.error, logger.warn, logger.info, logger.debug, logger.trace].flatMap(
    (fn) => fn.mock.calls as unknown[][],
  );
}

/**
 * Everything the logger was handed, deep-inspected. `util.inspect` rather than
 * `JSON.stringify` because it walks non-enumerable `message`/`stack` and nested
 * axios `config` objects — the places a secret actually survives.
 */
export function loggerArgsText(logger: CapturedLogger): string {
  return allCalls(logger)
    .flat()
    .map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 10 })))
    .join('\n');
}

/**
 * Only the first argument of each call — the message body. Untrusted meeting
 * content may travel as a structured field but must never be interpolated
 * here, or a participant can forge log lines with newlines and ANSI escapes.
 */
export function loggerMessageText(logger: CapturedLogger): string {
  return allCalls(logger)
    .map((args) => String(args[0]))
    .join('\n');
}

/**
 * A cache scoped to one channel.
 *
 * node-sdk's `internalCache` is a module singleton, so channels built in the same
 * test file would otherwise share one dedup namespace: a second test delivering the
 * same fixture payload gets silently suppressed, and its assertions fail somewhere
 * unrelated to the cause.
 */
function makeIsolatedCache() {
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

export function createTestChannel(extra: Record<string, unknown> = {}): {
  ch: any;
  logger: CapturedLogger;
} {
  const logger = makeLogger();
  const ch = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'app-secret',
    // Nothing is filtered by level, so leak assertions see every line the SDK
    // would ever write — not just the ones above a default threshold.
    loggerLevel: LoggerLevel.trace,
    logger: logger as never,
    cache: makeIsolatedCache(),
    ...extra,
  } as never);
  return { ch, logger };
}

/**
 * Put the channel in the state a finished `connect()` leaves behind, without a
 * real WebSocket or identity fetch: bot identity resolved, dispatcher handlers
 * registered, connected flag set.
 *
 * Pass `null` to model the window where the connection is up but the bot's own
 * open_id has not resolved yet. It has to be `null` rather than `undefined`,
 * because `undefined` would select the default identity instead.
 */
export function markConnected(
  ch: any,
  bot: { openId: string; name: string } | null = { openId: BOT_OPEN_ID, name: 'TestBot' },
): void {
  ch.botIdentity = bot ?? undefined;
  if (bot) ch.safety.setBotIdentity(bot);
  ch.registerDispatcherHandlers();
  ch.connected = true;
}

export interface MeetingApiStubs {
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  message: ReturnType<typeof vi.fn>;
  events: ReturnType<typeof vi.fn>;
  userActiveMeeting: ReturnType<typeof vi.fn>;
}

/** Replace every `vc.v1.bot` call with a stub that succeeds and reports nothing. */
export function stubMeetingApis(ch: any): MeetingApiStubs {
  const stubs: MeetingApiStubs = {
    join: vi.fn().mockResolvedValue({
      data: { meeting: { id: MEETING_ID, meeting_no: MEETING_NO, topic: MEETING_TOPIC } },
    }),
    leave: vi.fn().mockResolvedValue({ data: {} }),
    message: vi.fn().mockResolvedValue({ data: { uuid: 'uuid_stub' } }),
    events: vi
      .fn()
      .mockResolvedValue({ data: { has_more: false, page_token: 'pt_0', events: [] } }),
    userActiveMeeting: vi.fn().mockResolvedValue({
      data: {
        meetings: [
          { meeting_id: MEETING_ID, meeting_no: MEETING_NO, meeting_title: MEETING_TOPIC },
        ],
      },
    }),
  };
  Object.assign(ch.rawClient.vc.v1.bot, stubs);
  return stubs;
}

/** Hand a raw event to the dispatcher exactly as the transport would. */
export async function dispatchEvent(ch: any, type: string, raw: unknown): Promise<unknown> {
  const handler = ch.dispatcher.handles.get(type);
  if (!handler) throw new Error(`no dispatcher handler registered for "${type}"`);
  return handler(raw);
}

/**
 * The channel's live-session registry.
 *
 * Teardown has to remove the session here, not merely stop its loops: a
 * session that stopped polling but stayed in the registry is a zombie nothing
 * else will ever collect, and it is invisible to any assertion that only
 * watches request counts.
 */
export function activeMeetingIds(ch: any): string[] {
  return ch.meetings.list().map((s: { meetingId: string }) => s.meetingId);
}

/**
 * Let queued microtasks (fire-and-forget dispatch paths) settle.
 *
 * Generous by default: delivery crosses a serial queue and two dedup lookups, so a
 * tight count turns an implementation detail into a flaky assertion. It cannot
 * over-flush — anything genuinely blocked (a gated handler, a pending timer) stays
 * blocked no matter how many turns pass.
 */
export async function flushMicrotasks(times = 24): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
