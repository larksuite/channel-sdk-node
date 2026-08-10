/**
 * The two meeting entry points, seen from the caller's side.
 *
 * They differ on whether a connection is required, and that asymmetry is
 * deliberate rather than an oversight: joining needs the push stream, so
 * without a connection it would join a meeting and then hear nothing —
 * failing loudly is better. Following needs only REST polling, so demanding a
 * WebSocket would be pure overhead for an app that never uses the IM side.
 *
 * `console_url` is the odd field here. What comes back on a permission failure
 * is a signed one-click authorization link — a credential in URL form. It is
 * passed through byte for byte because any re-encoding invalidates the
 * signature, but it is checked first: `domain` is configurable, so this string
 * is not from a trusted source, and a downstream that renders it as a link
 * turns a `javascript:` or `data:` value into script execution.
 *
 * Meeting content — captions, chat, participant names and the meeting title —
 * is written by whoever is in the meeting, guests included. It may travel as a
 * structured log field and never as part of a message string, or a participant
 * can inject newlines and ANSI escapes and forge log lines.
 */

import {
  BOT_OPEN_ID,
  CONSOLE_URL,
  createTestChannel,
  dispatchEvent,
  loggerArgsText,
  loggerMessageText,
  MEETING_ID,
  MEETING_NO,
  markConnected,
  permissionDeniedError,
  stubMeetingApis,
  USER_TOKEN,
} from '../meeting/__tests__/fixtures';

const OTHER_MEETING_ID = '7180000000000000002';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connection prerequisites are asymmetric on purpose', () => {
  test('joinMeeting without connect() fails fast', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);

    await expect(ch.joinMeeting(MEETING_NO)).rejects.toMatchObject({ code: 'not_connected' });
    expect(stubs.join).not.toHaveBeenCalled();
  });

  test('followMyMeeting works without connect() and opens no socket', async () => {
    const { ch } = createTestChannel();
    stubMeetingApis(ch);

    const session = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });

    expect(session.meetingId).toBe(MEETING_ID);
    expect(session.mode).toBe('uat');
    expect(ch.rawWsClient).toBeUndefined();
  });
});

describe('joinMeeting', () => {
  test('joins by meeting number and takes the meeting id from the response', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    const session = await ch.joinMeeting(MEETING_NO);

    expect(stubs.join).toHaveBeenCalledTimes(1);
    const [payload] = stubs.join.mock.calls[0];
    expect(payload.data.join_type).toBe(1);
    expect(payload.data.join_identify).toEqual({ meeting_no: MEETING_NO });
    expect(session.meetingId).toBe(MEETING_ID);
    expect(session.meetingNo).toBe(MEETING_NO);
    expect(session.mode).toBe('tat');
  });

  test('password and callId are passed through when given', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    await ch.joinMeeting(MEETING_NO, { password: 'pw', callId: 'call_1' });

    const [payload] = stubs.join.mock.calls[0];
    expect(payload.data.password).toBe('pw');
    expect(payload.data.call_id).toBe('call_1');
  });
});

describe('followMyMeeting meeting selection', () => {
  test('no active meeting is an error, not an empty session', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    stubs.userActiveMeeting.mockResolvedValue({ data: { meetings: [] } });

    await expect(ch.followMyMeeting({ userAccessToken: USER_TOKEN })).rejects.toMatchObject({
      code: 'meeting_not_found',
    });
  });

  test('several active meetings: the first is taken and the rest are warned about', async () => {
    const { ch, logger } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    stubs.userActiveMeeting.mockResolvedValue({
      data: {
        meetings: [
          { meeting_id: MEETING_ID, meeting_no: MEETING_NO, meeting_title: 'First' },
          { meeting_id: OTHER_MEETING_ID, meeting_no: '987654321', meeting_title: 'Second' },
        ],
      },
    });

    const session = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });

    expect(session.meetingId).toBe(MEETING_ID);
    expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
  });

  test('an explicit meetingNo picks that meeting', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    stubs.userActiveMeeting.mockResolvedValue({
      data: {
        meetings: [
          { meeting_id: MEETING_ID, meeting_no: MEETING_NO, meeting_title: 'First' },
          { meeting_id: OTHER_MEETING_ID, meeting_no: '987654321', meeting_title: 'Second' },
        ],
      },
    });

    const session = await ch.followMyMeeting({
      userAccessToken: USER_TOKEN,
      meetingNo: '987654321',
    });

    expect(session.meetingId).toBe(OTHER_MEETING_ID);
  });
});

describe('follow mode never claims an item as its own', () => {
  test('selfEcho stays false even for an item whose speaker is the bot open_id', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    stubs.events.mockResolvedValue({
      data: {
        has_more: false,
        page_token: 'pt_1',
        events: [
          {
            event_id: 'evt_uat_self',
            event_type: 'vc.bot.meeting_activity_v1',
            payload: {
              meeting: { id: MEETING_ID },
              activity_event_type: 'transcript_received',
              transcript_received_items: [
                { speaker: { id: BOT_OPEN_ID, user_name: 'TestBot' }, text: 'echo?' },
              ],
            },
          },
        ],
      },
    });

    const session = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    const flags: boolean[] = [];
    session.on('transcript', (e: { selfEcho: boolean }) => {
      flags.push(e.selfEcho);
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f === false)).toBe(true);
  });
});

describe('disconnect', () => {
  test('active sessions are disposed, not left — the bot stays in the meeting', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    const session = await ch.joinMeeting(MEETING_NO);
    const ended: string[] = [];
    session.on('end', (e: { reason: string }) => {
      ended.push(e.reason);
    });

    await ch.disconnect();

    expect(stubs.leave).not.toHaveBeenCalled();
    expect(ended).toEqual(['disposed']);

    const callsAtDisconnect = stubs.events.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(stubs.events.mock.calls.length).toBe(callsAtDisconnect);
  });
});

describe('consoleUrl', () => {
  test('an https link is surfaced byte for byte', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    stubs.join.mockRejectedValue(permissionDeniedError());

    let thrown: any;
    try {
      await ch.joinMeeting(MEETING_NO);
    } catch (e) {
      thrown = e;
    }

    expect(thrown.code).toBe('permission_denied');
    // Verbatim: the signature covers the whole string, so re-encoding even one
    // character turns a working authorization link into a broken one.
    expect(thrown.context.consoleUrl).toBe(CONSOLE_URL);
  });

  test('the link is a credential and never reaches the log', async () => {
    const { ch, logger } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    stubs.join.mockRejectedValue(permissionDeniedError());

    await expect(ch.joinMeeting(MEETING_NO)).rejects.toBeDefined();

    expect(loggerArgsText(logger)).not.toContain(CONSOLE_URL);
  });

  test('a non-https link is dropped and its value is not echoed anywhere', async () => {
    for (const hostile of [
      'javascript:alert(document.domain)',
      'data:text/html,<script>x</script>',
    ]) {
      const { ch, logger } = createTestChannel();
      markConnected(ch);
      const stubs = stubMeetingApis(ch);
      stubs.join.mockRejectedValue(permissionDeniedError(hostile));

      let thrown: any;
      try {
        await ch.joinMeeting(MEETING_NO);
      } catch (e) {
        thrown = e;
      }

      // Asserting the code as well keeps this from passing for the wrong
      // reason: an absent field on an unrelated error proves nothing.
      expect(thrown.code).toBe('permission_denied');
      expect(thrown.context?.consoleUrl).toBeUndefined();
      expect(loggerArgsText(logger)).not.toContain(hostile);
    }
  });
});

describe('meeting content never lands in a log message body', () => {
  const HOSTILE_TOPIC = 'Sync\n2026-01-01 ERROR fabricated line \u001b[31mred\u001b[0m';
  const HOSTILE_TEXT = 'hello\n2026-01-01 FATAL forged \u001b[31mred\u001b[0m';

  test('a meeting title full of newlines and escapes stays a structured field', async () => {
    const { ch, logger } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    stubs.userActiveMeeting.mockResolvedValue({
      data: {
        meetings: [
          { meeting_id: MEETING_ID, meeting_no: MEETING_NO, meeting_title: HOSTILE_TOPIC },
          { meeting_id: OTHER_MEETING_ID, meeting_no: '987654321', meeting_title: HOSTILE_TOPIC },
        ],
      },
    });

    await ch.followMyMeeting({ userAccessToken: USER_TOKEN });

    expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
    expect(loggerMessageText(logger)).not.toContain(HOSTILE_TOPIC);
    expect(loggerMessageText(logger)).not.toContain('fabricated line');
  });

  test('caption text is not interpolated into the log when a handler throws', async () => {
    const { ch, logger } = createTestChannel();
    markConnected(ch);
    stubMeetingApis(ch);
    const session = await ch.joinMeeting(MEETING_NO);

    session.on('transcript', () => {
      throw new Error('handler blew up');
    });

    await dispatchEvent(ch, 'vc.bot.meeting_activity_v1', {
      event_id: 'evt_hostile',
      event_type: 'vc.bot.meeting_activity_v1',
      meeting_activity_items: [
        {
          meeting: { id: MEETING_ID },
          activity_event_type: 'transcript_received',
          transcript_received_items: [
            { speaker: { id: 'ou_alice', user_name: 'Alice' }, text: HOSTILE_TEXT },
          ],
        },
      ],
    });

    expect(loggerMessageText(logger)).not.toContain(HOSTILE_TEXT);
    expect(loggerMessageText(logger)).not.toContain('forged');
  });
});
