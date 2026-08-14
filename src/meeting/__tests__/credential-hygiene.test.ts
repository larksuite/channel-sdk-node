/**
 * Credential hygiene on the meeting path.
 *
 * A user access token reaches this SDK for the first time here, and it leaves
 * through TWO doors, not one:
 *
 *   1. the SDK's own logger, and
 *   2. the `error` event — the caller gets the very same LarkChannelError and
 *      typically forwards it to an error tracker, which walks `cause` deeply.
 *
 * The SDK does not scrub logs; what keeps the token out of both doors is that the
 * error object never carries it in the first place — `meetingError` reduces a
 * transport failure to `{ status, feishuCode, msg, logId }` instead of hanging the
 * original AxiosError off `cause`.
 *
 * Both `JSON.stringify` and `util.inspect` are asserted because they disagree:
 * axios only exposes `config` through `toJSON()`, so `JSON.stringify` silently
 * skips the second copy of the header living under `response.config`, while
 * `inspect` (and spreading, and most structured loggers) walks straight into it.
 */

import { inspect } from 'node:util';
import type { LarkChannelError } from '../../types';
import {
  axiosErrorWithToken,
  CONSOLE_URL,
  createTestChannel,
  loggerArgsText,
  MEETING_NO,
  markConnected,
  stubMeetingApis,
  USER_TOKEN,
} from './fixtures';

function serializedBothWays(value: unknown): string {
  return `${JSON.stringify(value)}\n${inspect(value, { depth: 10 })}`;
}

/**
 * Start a UAT session whose first poll succeeds and whose every later poll
 * fails with `err`. Letting the first round succeed is what makes the failure
 * land after the caller has had a chance to subscribe.
 */
async function followWithFailingPoll(err: Error) {
  const { ch, logger } = createTestChannel();
  const stubs = stubMeetingApis(ch);
  stubs.events
    .mockResolvedValueOnce({ data: { has_more: false, page_token: 'pt_0', events: [] } })
    .mockRejectedValue(err);
  const session = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
  return { ch, logger, session, stubs };
}

describe('token never escapes through the error event', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('the LarkChannelError handed to the caller carries no bearer token', async () => {
    const { session } = await followWithFailingPoll(axiosErrorWithToken());

    const errors: LarkChannelError[] = [];
    session.on('error', (e: LarkChannelError) => {
      errors.push(e);
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(errors.length).toBeGreaterThan(0);
    for (const err of errors) {
      expect(JSON.stringify(err)).not.toContain(USER_TOKEN);
      expect(inspect(err, { depth: 10 })).not.toContain(USER_TOKEN);
    }
  });

  test('a token living only under response.config is scrubbed too', async () => {
    const { session } = await followWithFailingPoll(axiosErrorWithToken({ carry: 'response' }));

    const errors: LarkChannelError[] = [];
    session.on('error', (e: LarkChannelError) => {
      errors.push(e);
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(errors.length).toBeGreaterThan(0);
    for (const err of errors) {
      expect(inspect(err, { depth: 10 })).not.toContain(USER_TOKEN);
    }
  });

  test('the failure is still diagnosable: status and Feishu code survive', async () => {
    const { session } = await followWithFailingPoll(
      axiosErrorWithToken({ status: 401, feishuCode: 99991401 }),
    );

    const errors: LarkChannelError[] = [];
    session.on('error', (e: LarkChannelError) => {
      errors.push(e);
    });

    await vi.advanceTimersByTimeAsync(30_000);

    const text = serializedBothWays(errors[0]);
    expect(errors[0].code).toBe('permission_denied');
    expect(text).toContain('99991401');
  });
});

describe('token never escapes through the logger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('with no error handler the fallback log carries no bearer token', async () => {
    const { logger } = await followWithFailingPoll(axiosErrorWithToken());

    await vi.advanceTimersByTimeAsync(30_000);

    const text = loggerArgsText(logger);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(USER_TOKEN);
  });

  test('the one-click authorization link does not reach the fallback log either', async () => {
    // No `error` handler is registered, so this takes the SDK's own logging branch
    // — the only place the link could escape, since the error object itself is
    // supposed to carry it to the caller.
    const denied = new Error('Request failed with status code 403') as Error & {
      [k: string]: unknown;
    };
    denied.name = 'AxiosError';
    denied.response = {
      status: 403,
      data: { code: 99991672, msg: 'no permission', error: { console_url: CONSOLE_URL } },
      config: { headers: {} },
    };
    const { logger } = await followWithFailingPoll(denied);

    await vi.advanceTimersByTimeAsync(30_000);

    const text = loggerArgsText(logger);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(CONSOLE_URL);
  });
});

describe('meeting passwords are credentials wherever they come from', () => {
  const OPT_PASSWORD = 'caller-secret-pw';
  const SERVER_PASSWORD = 'server-secret-pw';

  test('a failed join leaks neither the passed password nor the one in the response', async () => {
    const { ch, logger } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    const denied = new Error('Request failed with status code 400') as Error & {
      [k: string]: unknown;
    };
    denied.name = 'AxiosError';
    denied.response = {
      status: 400,
      data: { code: 3001, msg: 'wrong password', password: SERVER_PASSWORD },
      config: { headers: {}, data: JSON.stringify({ password: OPT_PASSWORD }) },
    };
    stubs.join.mockRejectedValue(denied);

    let thrown: unknown;
    try {
      await ch.joinMeeting(MEETING_NO, { password: OPT_PASSWORD });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    const errText = serializedBothWays(thrown);
    expect(errText).not.toContain(OPT_PASSWORD);
    expect(errText).not.toContain(SERVER_PASSWORD);

    const logText = loggerArgsText(logger);
    expect(logText).not.toContain(OPT_PASSWORD);
    expect(logText).not.toContain(SERVER_PASSWORD);
  });

  test('a successful join keeps the password off the session and out of the log', async () => {
    const { ch, logger } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    stubs.join.mockResolvedValue({
      data: { meeting: { id: 'mid_pw', meeting_no: MEETING_NO, password: SERVER_PASSWORD } },
    });

    const session = await ch.joinMeeting(MEETING_NO, { password: OPT_PASSWORD });

    const sessionText = serializedBothWays(session);
    expect(sessionText).not.toContain(OPT_PASSWORD);
    expect(sessionText).not.toContain(SERVER_PASSWORD);

    const logText = loggerArgsText(logger);
    expect(logText).not.toContain(OPT_PASSWORD);
    expect(logText).not.toContain(SERVER_PASSWORD);
  });
});

describe('the user token never becomes a property of anything', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A string handed to `followMyMeeting` is normalized into a provider closure at
   * the entry point, so it never becomes a property of the session or its poll
   * loop. This walks own properties rather than serializing, because that is the
   * access pattern a closure defeats and a stored string would not:
   * `{...session}`, `Object.entries`, and most log middleware take this route.
   *
   * The SDK `Client` is deliberately reachable here — `channel.rawClient` is a
   * documented public member — so this asserts the token specifically, not the
   * absence of a credential graph.
   */
  function ownPropertyText(root: unknown, depth = 6): string {
    const seen = new Set<unknown>();
    const parts: string[] = [];
    const walk = (value: unknown, level: number) => {
      if (level > depth || value === null || typeof value !== 'object') {
        if (typeof value === 'string') parts.push(value);
        return;
      }
      if (seen.has(value)) return;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        parts.push(key);
        walk(child, level + 1);
      }
    };
    walk(root, 0);
    return parts.join('\n');
  }

  test('a token passed as a plain string is not reachable from the session', async () => {
    const { ch } = createTestChannel();
    stubMeetingApis(ch);

    const session = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });

    // Positive control: a walker that silently returned nothing would make the
    // assertions below pass for the wrong reason.
    expect(ownPropertyText(session)).toContain('meetingId');

    expect(ownPropertyText(session)).not.toContain(USER_TOKEN);
    expect(ownPropertyText({ ...session })).not.toContain(USER_TOKEN);
  });
});
