/**
 * MeetingSession lifecycle, delivery and outbound rules.
 *
 * The load-bearing case here is the first one. `bots/leave` is at its most
 * likely to fail exactly when a meeting has just ended — the bot may already
 * be out — and that is the ordinary end of every meeting, not an edge case. If
 * a failed leave aborts reclamation, every normally-ended meeting leaks a
 * session, its timers and its buffers. So the API call and the reclamation are
 * decoupled: the call's failure is reported through `error`, and reclamation
 * happens regardless.
 *
 * `selfEcho` is the other one worth stating outright. `false` means "this was
 * not me", which is what lets a caller act on an item; when the bot's own
 * open_id is not yet known, answering `false` waves the bot's own words
 * straight back into the loop it is supposed to prevent. Not knowing has to
 * resolve to `true`.
 */

import {
  activeMeetingIds,
  BOT_OPEN_ID,
  createTestChannel,
  dispatchEvent,
  flushMicrotasks,
  MEETING_ID,
  MEETING_NO,
  markConnected,
  pushActivity,
  stubMeetingApis,
  transcriptPush,
  USER_TOKEN,
} from './fixtures';

async function joinedSession(extra: Record<string, unknown> = {}) {
  const { ch, logger } = createTestChannel(extra);
  markConnected(ch);
  const stubs = stubMeetingApis(ch);
  const session = await ch.joinMeeting(MEETING_NO);
  return { ch, logger, stubs, session };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a failing bots/leave must not abort reclamation', () => {
  test('leave() resolves, reports the failure, and still tears the session down', async () => {
    const { ch, stubs, session } = await joinedSession();
    stubs.leave.mockRejectedValue(
      Object.assign(new Error('meeting not found'), { response: { status: 404 } }),
    );

    const errors: Array<{ code: string }> = [];
    session.on('error', (e: { code: string }) => {
      errors.push(e);
    });

    await expect(session.leave()).resolves.toBeUndefined();

    expect(stubs.leave).toHaveBeenCalledTimes(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(activeMeetingIds(ch)).not.toContain(MEETING_ID);

    // Nothing of the session may still be running afterwards.
    const probesSoFar = stubs.events.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(stubs.events.mock.calls.length).toBe(probesSoFar);
  });
});

describe('leave / dispose', () => {
  test('leave() is idempotent and calls bots/leave once', async () => {
    const { stubs, session } = await joinedSession();

    await session.leave();
    await session.leave();
    await session.leave();

    expect(stubs.leave).toHaveBeenCalledTimes(1);
  });

  test('dispose() is idempotent and never calls bots/leave', async () => {
    const { stubs, session } = await joinedSession();

    session.dispose();
    session.dispose();

    expect(stubs.leave).not.toHaveBeenCalled();
  });

  test('dispose() after leave() does not call bots/leave a second time', async () => {
    const { stubs, session } = await joinedSession();

    await session.leave();
    session.dispose();

    expect(stubs.leave).toHaveBeenCalledTimes(1);
  });
});

describe('meeting_ended_v1', () => {
  test('emits end(meeting_ended) and leaves exactly once', async () => {
    const { ch, stubs, session } = await joinedSession();
    const ended: string[] = [];
    session.on('end', (e: { reason: string }) => {
      ended.push(e.reason);
    });

    await dispatchEvent(ch, 'vc.bot.meeting_ended_v1', {
      event_id: 'evt_ended',
      meeting: { id: MEETING_ID, meeting_no: MEETING_NO },
    });
    await flushMicrotasks();

    expect(ended).toEqual(['meeting_ended']);
    expect(stubs.leave).toHaveBeenCalledTimes(1);
    expect(activeMeetingIds(ch)).not.toContain(MEETING_ID);
  });
});

describe('sendMessage', () => {
  test('sends a text message with an idempotency uuid', async () => {
    const { stubs, session } = await joinedSession();

    await session.sendMessage('x');

    expect(stubs.message).toHaveBeenCalledTimes(1);
    const [payload] = stubs.message.mock.calls[0];
    expect(payload.data.meeting_id).toBe(MEETING_ID);
    expect(payload.data.msg_type).toBe('text');
    expect(payload.data.content).toBe('x');
    expect(typeof payload.data.uuid).toBe('string');
    expect(payload.data.uuid.length).toBeGreaterThan(0);
  });

  // `vc.v1.bot.message` shows `content` verbatim, unlike `im.v1.message.create`, which
  // wants a JSON string. Sending the IM encoding put a JSON literal on screen. Text
  // carrying quotes and a newline is the strongest witness: any re-encoding — JSON
  // wrapping, escaping, trimming — changes the string, so equality alone catches it.
  test('content is the text verbatim, not JSON-encoded', async () => {
    const { stubs, session } = await joinedSession();
    const text = 'he said "hi"\nand left';

    await session.sendMessage(text);

    expect(stubs.message.mock.calls[0][0].data.content).toBe(text);
  });

  test('is rejected in follow mode, where the bot is not in the meeting', async () => {
    const { ch } = createTestChannel();
    stubMeetingApis(ch);
    const session = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });

    await expect(session.sendMessage('hi')).rejects.toMatchObject({ code: 'not_supported' });
  });

  test('over the per-minute limit it throws and sends nothing', async () => {
    const { stubs, session } = await joinedSession({ meeting: { sendRateLimitPerMinute: 2 } });

    await session.sendMessage('one');
    await session.sendMessage('two');
    await expect(session.sendMessage('three')).rejects.toMatchObject({ code: 'rate_limited' });

    expect(stubs.message).toHaveBeenCalledTimes(2);
  });
});

describe('selfEcho', () => {
  test('items from the bot itself are flagged and still delivered', async () => {
    const { ch, session } = await joinedSession();
    const seen: Array<{ text: string; selfEcho: boolean }> = [];
    session.on('transcript', (e: { text: string; selfEcho: boolean }) => {
      seen.push({ text: e.text, selfEcho: e.selfEcho });
    });

    await dispatchEvent(
      ch,
      'vc.bot.meeting_activity_v1',
      transcriptPush({
        eventId: 'evt_self',
        text: 'this is the bot talking',
        speaker: { id: BOT_OPEN_ID, user_name: 'TestBot' },
      }),
    );
    await flushMicrotasks();

    expect(seen).toEqual([{ text: 'this is the bot talking', selfEcho: true }]);
  });

  test('an unknown bot open_id resolves to true, not false', async () => {
    const { ch } = createTestChannel();
    // Connection is up but the bot's own identity has not resolved yet.
    markConnected(ch, null);
    stubMeetingApis(ch);
    const session = await ch.joinMeeting(MEETING_NO);

    const flags: boolean[] = [];
    session.on('transcript', (e: { selfEcho: boolean }) => {
      flags.push(e.selfEcho);
    });

    await dispatchEvent(
      ch,
      'vc.bot.meeting_activity_v1',
      transcriptPush({ eventId: 'evt_unknown_bot', text: 'who said this?' }),
    );
    await flushMicrotasks();

    expect(flags).toEqual([true]);
  });
});

describe('on() is multicast', () => {
  test('every handler fires and unsubscribing removes only its own', async () => {
    const { ch, session } = await joinedSession();
    const first: string[] = [];
    const second: string[] = [];

    const offFirst = session.on('transcript', (e: { text: string }) => {
      first.push(e.text);
    });
    session.on('transcript', (e: { text: string }) => {
      second.push(e.text);
    });

    await dispatchEvent(
      ch,
      'vc.bot.meeting_activity_v1',
      transcriptPush({ eventId: 'evt_mc_1', text: 'first round', sentenceId: 's_mc_1' }),
    );
    await flushMicrotasks();

    expect(first).toEqual(['first round']);
    expect(second).toEqual(['first round']);

    offFirst();
    await dispatchEvent(
      ch,
      'vc.bot.meeting_activity_v1',
      transcriptPush({ eventId: 'evt_mc_2', text: 'second round', sentenceId: 's_mc_2' }),
    );
    await flushMicrotasks();

    expect(first).toEqual(['first round']);
    expect(second).toEqual(['first round', 'second round']);
  });
});

describe('a handler that ends the session cannot jump the queue', () => {
  test('end arrives after every handler for the item being delivered', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    stubMeetingApis(ch);
    // A settled caption is the discriminating path: the stabilizer's timer hands the
    // event to the queue, and the task's *synchronous prefix* invokes user code. A
    // barrier published after that prefix lets the `end` this handler queues run
    // alongside the delivery it came from. Push delivery cannot show the difference
    // — it hits an `await` in the duplicate check before touching a handler.
    const session = await ch.joinMeeting(MEETING_NO, { stabilizeMs: 800 });
    const trace: string[] = [];

    session.on('transcript', () => {
      trace.push('first');
      void session.leave();
    });
    session.on('transcript', () => {
      trace.push('second');
    });
    session.on('end', () => {
      trace.push('end');
    });

    await dispatchEvent(
      ch,
      'vc.bot.meeting_activity_v1',
      transcriptPush({ eventId: 'evt_barrier', text: 'ending mid-delivery' }),
    );
    await vi.advanceTimersByTimeAsync(900);
    await flushMicrotasks();

    expect(trace).toEqual(['first', 'second', 'end']);
  });
});

describe('ordering survives async handlers', () => {
  test('the next item waits for the previous handler to settle', async () => {
    const { ch, session } = await joinedSession();
    const trace: string[] = [];
    const gates: Array<() => void> = [];

    session.on('transcript', async (e: { text: string }) => {
      trace.push(`enter:${e.text}`);
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      trace.push(`exit:${e.text}`);
    });

    const delivered = dispatchEvent(ch, 'vc.bot.meeting_activity_v1', pushActivity());
    await flushMicrotasks();

    // Only the first transcript may be in flight — the second item of the same
    // batch must not have been handed over yet.
    expect(trace).toEqual(['enter:good morning']);

    gates[0]();
    await flushMicrotasks();
    expect(trace).toEqual(['enter:good morning', 'exit:good morning', 'enter:morning all']);

    gates[1]();
    await flushMicrotasks();
    await delivered;
    expect(trace).toEqual([
      'enter:good morning',
      'exit:good morning',
      'enter:morning all',
      'exit:morning all',
    ]);
  });
});
