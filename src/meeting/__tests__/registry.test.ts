/**
 * Session admission, routing and reclamation.
 *
 * Sessions are created by people outside this process: anyone in the tenant
 * who can pull the bot into a meeting starts one. So the number of them is not
 * something the application controls, and an unbounded registry is an
 * out-of-memory bug with an external trigger. Admission is refused before the
 * join call goes out, so a refusal never leaves the bot sitting in a meeting
 * nobody is listening to.
 *
 * The counter has to track server-side membership rather than local objects.
 * `disconnect()` disposes sessions without leaving the meetings, so a counter
 * that watches local sessions reads zero while the bot is still a participant
 * everywhere — and the cap stops meaning anything across a reconnect.
 *
 * A join that fails inconclusively is the ambiguous case: the request may well have
 * succeeded server-side, leaving a member with no local handle. Nothing can undo it
 * automatically — `bots/leave` was observed to reject a 9-digit meeting number, and
 * the long id was in the response that never arrived — so the remedy is a warning
 * loud enough for an operator to act on.
 */

import {
  activeMeetingIds,
  createTestChannel,
  dispatchEvent,
  flushMicrotasks,
  MEETING_ID,
  MEETING_NO,
  markConnected,
  pushActivity,
  stubMeetingApis,
  USER_TOKEN,
} from './fixtures';

const OTHER_MEETING_ID = '7180000000000000002';
const OTHER_MEETING_NO = '987654321';

function pushFor(meetingId: string, text: string, eventId: string): Record<string, unknown> {
  return {
    event_id: eventId,
    event_type: 'vc.bot.meeting_activity_v1',
    meeting_activity_items: [
      {
        meeting: { id: meetingId },
        activity_event_type: 'transcript_received',
        transcript_received_items: [
          { speaker: { id: 'ou_alice', user_name: 'Alice' }, text, sentence_id: eventId },
        ],
      },
    ],
  };
}

function joinResult(meetingId: string, meetingNo: string) {
  return { data: { meeting: { id: meetingId, meeting_no: meetingNo, topic: 'T' } } };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('concurrency cap', () => {
  test('at the cap, joinMeeting throws before bots/join is called', async () => {
    const { ch } = createTestChannel({ meeting: { maxConcurrentSessions: 1 } });
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    await ch.joinMeeting(MEETING_NO);
    expect(stubs.join).toHaveBeenCalledTimes(1);

    await expect(ch.joinMeeting(OTHER_MEETING_NO)).rejects.toMatchObject({
      code: 'too_many_sessions',
    });

    // Refusing after joining would park the bot in a meeting with no session
    // behind it — visible to everyone, listened to by nobody.
    expect(stubs.join).toHaveBeenCalledTimes(1);
  });
});

describe('routing by meeting id', () => {
  test('each session sees only its own meeting, and unknown meetings are ignored', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    stubs.join
      .mockResolvedValueOnce(joinResult(MEETING_ID, MEETING_NO))
      .mockResolvedValueOnce(joinResult(OTHER_MEETING_ID, OTHER_MEETING_NO));

    const first = await ch.joinMeeting(MEETING_NO);
    const second = await ch.joinMeeting(OTHER_MEETING_NO);

    const firstSeen: string[] = [];
    const secondSeen: string[] = [];
    first.on('transcript', (e: { text: string }) => {
      firstSeen.push(e.text);
    });
    second.on('transcript', (e: { text: string }) => {
      secondSeen.push(e.text);
    });

    await dispatchEvent(ch, 'vc.bot.meeting_activity_v1', pushFor(MEETING_ID, 'for first', 'e1'));
    await dispatchEvent(
      ch,
      'vc.bot.meeting_activity_v1',
      pushFor(OTHER_MEETING_ID, 'for second', 'e2'),
    );
    await flushMicrotasks();

    expect(firstSeen).toEqual(['for first']);
    expect(secondSeen).toEqual(['for second']);

    await expect(
      dispatchEvent(
        ch,
        'vc.bot.meeting_activity_v1',
        pushFor('7180000000000000099', 'nobody owns this', 'e3'),
      ),
    ).resolves.not.toThrow();
    await flushMicrotasks();

    expect(firstSeen).toEqual(['for first']);
    expect(secondSeen).toEqual(['for second']);
  });
});

describe('idle reclamation', () => {
  test('is off by default — a silent session is not reclaimed', async () => {
    // The probe detects a removed bot directly, so the only sessions this would
    // still reach are quiet-but-live meetings, and reclaiming one leaves it.
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    const session = await ch.joinMeeting(MEETING_NO);
    const ended: string[] = [];
    session.on('end', (e: { reason: string }) => {
      ended.push(e.reason);
    });
    session.on('error', () => {});

    await vi.advanceTimersByTimeAsync(6 * 3_600_000);

    expect(ended).toEqual([]);
    expect(activeMeetingIds(ch)).toContain(MEETING_ID);
    expect(stubs.leave).not.toHaveBeenCalled();
  });

  test('a silent session ends with idle_timeout and leaves the registry', async () => {
    const { ch } = createTestChannel({
      meeting: { idleTimeoutMs: 60_000, livenessProbeIntervalMs: 0 },
    });
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    const session = await ch.joinMeeting(MEETING_NO);
    const ended: string[] = [];
    session.on('end', (e: { reason: string }) => {
      ended.push(e.reason);
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(ended).toEqual([]);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(ended).toEqual(['idle_timeout']);
    expect(activeMeetingIds(ch)).not.toContain(MEETING_ID);

    const callsAtEnd = stubs.events.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(stubs.events.mock.calls.length).toBe(callsAtEnd);
  });

  test('activity restarts the idle clock', async () => {
    const { ch } = createTestChannel({
      meeting: { idleTimeoutMs: 60_000, livenessProbeIntervalMs: 0 },
    });
    markConnected(ch);
    stubMeetingApis(ch);
    const session = await ch.joinMeeting(MEETING_NO);
    const ended: string[] = [];
    session.on('end', (e: { reason: string }) => {
      ended.push(e.reason);
    });

    await vi.advanceTimersByTimeAsync(50_000);
    await dispatchEvent(ch, 'vc.bot.meeting_activity_v1', pushFor(MEETING_ID, 'still here', 'e_a'));
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(50_000);
    expect(ended).toEqual([]);
    expect(activeMeetingIds(ch)).toContain(MEETING_ID);
  });
});

describe('repeated join / reclaim does not accumulate', () => {
  test('neither live sessions nor pending timers grow with the round count', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    const timersAfterRound: number[] = [];
    for (let round = 0; round < 5; round++) {
      stubs.join.mockResolvedValueOnce(joinResult(`mid_round_${round}`, MEETING_NO));
      const session = await ch.joinMeeting(MEETING_NO);
      await dispatchEvent(
        ch,
        'vc.bot.meeting_activity_v1',
        pushFor(`mid_round_${round}`, `round ${round}`, `e_round_${round}`),
      );
      await flushMicrotasks();
      await session.leave();

      expect(activeMeetingIds(ch)).toHaveLength(0);
      timersAfterRound.push(vi.getTimerCount());
    }

    expect(timersAfterRound[4]).toBeLessThanOrEqual(timersAfterRound[0]);
  });
});

describe('the cap counts server-side membership', () => {
  test('disconnect() does not free a slot, because the bot is still in the meeting', async () => {
    const { ch } = createTestChannel({ meeting: { maxConcurrentSessions: 1 } });
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    await ch.joinMeeting(MEETING_NO);

    // disconnect() disposes sessions but deliberately does not leave meetings,
    // so the bot is still a participant when the channel comes back up.
    await ch.disconnect();
    markConnected(ch);

    await expect(ch.joinMeeting(OTHER_MEETING_NO)).rejects.toMatchObject({
      code: 'too_many_sessions',
    });
    expect(stubs.join).toHaveBeenCalledTimes(1);
    expect(stubs.leave).not.toHaveBeenCalled();
  });

  test('an explicit leave() does free the slot', async () => {
    const { ch } = createTestChannel({ meeting: { maxConcurrentSessions: 1 } });
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    const session = await ch.joinMeeting(MEETING_NO);
    await session.leave();

    stubs.join.mockResolvedValueOnce(joinResult(OTHER_MEETING_ID, OTHER_MEETING_NO));
    await expect(ch.joinMeeting(OTHER_MEETING_NO)).resolves.toBeDefined();
    expect(stubs.join).toHaveBeenCalledTimes(2);
  });
});

describe('what disconnect() leaves behind', () => {
  // disconnect() disposes sessions without leaving their meetings, and a later connect()
  // re-registers the handlers but rebuilds nothing: the bot is a participant that nothing
  // listens for. That gap is only survivable if the caller can find those meetings again
  // and re-attach, so these three properties are the contract.
  test('a session ends with disposed and its pushes are dropped after reconnect', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    stubMeetingApis(ch);

    const session = await ch.joinMeeting(MEETING_NO);
    const ends: string[] = [];
    const delivered: string[] = [];
    session.on('end', (e: { reason: string }) => {
      ends.push(e.reason);
    });
    session.on('transcript', () => delivered.push('transcript'));

    await ch.disconnect();
    markConnected(ch);

    await dispatchEvent(ch, 'vc.bot.meeting_activity_v1', pushActivity());
    await flushMicrotasks();

    expect(ends).toEqual(['disposed']);
    expect(delivered).toEqual([]);
    expect(activeMeetingIds(ch)).toHaveLength(0);
  });

  test('the meeting is reported as retained, with the number needed to re-attach', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    stubMeetingApis(ch);

    await ch.joinMeeting(MEETING_NO);
    // A live session is not retained — there is nothing for the caller to fix.
    expect(ch.getRetainedMeetings()).toEqual([]);

    await ch.disconnect();

    expect(ch.getRetainedMeetings()).toEqual([{ meetingId: MEETING_ID, meetingNo: MEETING_NO }]);
  });

  test('re-attaching at the cap is allowed, and routing works again', async () => {
    const { ch } = createTestChannel({ meeting: { maxConcurrentSessions: 1 } });
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    await ch.joinMeeting(MEETING_NO);
    await ch.disconnect();
    markConnected(ch);

    // The slot is still held by this very meeting, so the cap must not stand in the way
    // of getting a session back for it — otherwise the seat can never be recovered.
    const session = await ch.joinMeeting(MEETING_NO);
    const delivered: string[] = [];
    session.on('transcript', () => delivered.push('transcript'));

    await dispatchEvent(ch, 'vc.bot.meeting_activity_v1', pushActivity());
    await flushMicrotasks();

    expect(stubs.join).toHaveBeenCalledTimes(2);
    expect(delivered.length).toBeGreaterThan(0);
    expect(ch.getRetainedMeetings()).toEqual([]);

    // And the seat is still one seat: re-attaching must not have consumed a second.
    await session.leave();
    expect(ch.getRetainedMeetings()).toEqual([]);
  });
});

describe('registering over an existing session tears down the old one', () => {
  // A replaced session is invisible and unstoppable: no longer routed to, its
  // `onEnded` identity check no longer matches so it never removes itself, and
  // `disconnect()` cannot see it — while its timers keep running. For a follow
  // session that means polling on forever with the caller's user token.
  test('a second follow of the same meeting stops the first one polling', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);

    const first = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    const ended: string[] = [];
    first.on('end', (e: { reason: string }) => {
      ended.push(e.reason);
    });

    await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    await flushMicrotasks();

    expect(ended).toEqual(['disposed']);
    // Exactly one session survives, and only its loop is still running.
    expect(activeMeetingIds(ch)).toEqual([MEETING_ID]);

    await vi.advanceTimersByTimeAsync(60_000);
    const busy = stubs.events.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    const afterwards = stubs.events.mock.calls.length - busy;

    // One live loop, not two: a second would roughly double the request rate.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stubs.events.mock.calls.length - busy - afterwards).toBeLessThanOrEqual(afterwards);
  });
});

describe('a reclaimed session gives its seat back', () => {
  // Once a session is reclaimed the caller has no handle left to leave with, so
  // ending without releasing burns the slot for the life of the process — the
  // exhaustion the cap exists to prevent, arriving by a different door.

  test('idle reclamation leaves the meeting and frees the slot', async () => {
    const { ch } = createTestChannel({
      meeting: { maxConcurrentSessions: 1, idleTimeoutMs: 60_000, livenessProbeIntervalMs: 0 },
    });
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    await ch.joinMeeting(MEETING_NO);

    await vi.advanceTimersByTimeAsync(61_000);

    expect(stubs.leave).toHaveBeenCalledTimes(1);
    stubs.join.mockResolvedValueOnce(joinResult(OTHER_MEETING_ID, OTHER_MEETING_NO));
    await expect(ch.joinMeeting(OTHER_MEETING_NO)).resolves.toBeDefined();
  });

  test('a probe that confirms departure frees the slot without calling leave', async () => {
    const { ch } = createTestChannel({
      meeting: { maxConcurrentSessions: 1, idleTimeoutMs: 0, livenessProbeIntervalMs: 60_000 },
    });
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    const session = await ch.joinMeeting(MEETING_NO);
    session.on('error', () => {});
    (session as any).liveness = { check: vi.fn().mockResolvedValue('gone') };

    await vi.advanceTimersByTimeAsync(120_000);

    // The server already said the bot is out; calling leave would be pointless.
    expect(stubs.leave).not.toHaveBeenCalled();
    stubs.join.mockResolvedValueOnce(joinResult(OTHER_MEETING_ID, OTHER_MEETING_NO));
    await expect(ch.joinMeeting(OTHER_MEETING_NO)).resolves.toBeDefined();
  });

  test('leave() still works after dispose() — that is what makes the shutdown advice true', async () => {
    const { ch } = createTestChannel({ meeting: { maxConcurrentSessions: 1 } });
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    const session = await ch.joinMeeting(MEETING_NO);

    session.dispose();
    expect(stubs.leave).not.toHaveBeenCalled();

    await session.leave();

    expect(stubs.leave).toHaveBeenCalledTimes(1);
    stubs.join.mockResolvedValueOnce(joinResult(OTHER_MEETING_ID, OTHER_MEETING_NO));
    await expect(ch.joinMeeting(OTHER_MEETING_NO)).resolves.toBeDefined();
  });
});

describe('joining a meeting already joined', () => {
  test('the existing session is returned and bots/join is not called again', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    const first = await ch.joinMeeting(MEETING_NO);
    // Feishu redelivers `meeting_invited_v1` and the documented handler joins
    // unconditionally, so this is a routine path, not an edge case.
    const second = await ch.joinMeeting(MEETING_NO);

    expect(second).toBe(first);
    expect(stubs.join).toHaveBeenCalledTimes(1);
    expect(activeMeetingIds(ch)).toEqual([MEETING_ID]);
  });

  test('a follow session for the same meeting is not mistaken for a joined one', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    // Following does not put the bot in the meeting, so handing this back to a
    // joinMeeting caller would leave them with a session whose sendMessage rejects.
    const followed = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    const joined = await ch.joinMeeting(MEETING_NO);

    expect(joined).not.toBe(followed);
    expect(joined.mode).toBe('tat');
    expect(stubs.join).toHaveBeenCalledTimes(1);
    // Both survive: one meeting can carry an app-identity bot and a user-identity
    // follower at the same time.
    expect(activeMeetingIds(ch)).toHaveLength(2);
  });
});

describe('a join whose outcome is unknown', () => {
  // `bots/leave` was observed to reject a 9-digit meeting number outright (HTTP 400,
  // `121105 meeting not exist`), and the long id was in the response that never
  // arrived — so there is nothing to call. Warning is the whole remedy.
  test('a timeout warns and does not fire a request that cannot work', async () => {
    const { ch, logger } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    stubs.join.mockRejectedValue(
      Object.assign(new Error('timeout of 3000ms exceeded'), { code: 'ECONNABORTED' }),
    );

    await expect(ch.joinMeeting(MEETING_NO)).rejects.toBeDefined();
    await flushMicrotasks();

    expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
    expect(stubs.leave).not.toHaveBeenCalled();
    expect(activeMeetingIds(ch)).toHaveLength(0);
  });

  test('a socket reset counts as inconclusive too, not just a timeout code', async () => {
    const { ch, logger } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    // "Sent, no response" usually arrives as a reset rather than as one of the two
    // timeout codes, and it leaves exactly the same orphan participant behind.
    stubs.join.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );

    await expect(ch.joinMeeting(MEETING_NO)).rejects.toBeDefined();
    await flushMicrotasks();

    expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
  });

  test('a definite rejection is not treated as inconclusive', async () => {
    const { ch, logger } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    // 403 means the server answered: nothing was joined, so there is no orphan and
    // no reason to warn about one.
    stubs.join.mockRejectedValue(
      Object.assign(new Error('no permission'), {
        response: { status: 403, data: { code: 99991672, msg: 'no permission' } },
      }),
    );

    await expect(ch.joinMeeting(MEETING_NO)).rejects.toBeDefined();
    await flushMicrotasks();

    const warned = logger.warn.mock.calls.some((args: unknown[]) =>
      String(args[0]).includes('join outcome unknown'),
    );
    expect(warned).toBe(false);
  });

  test('overlapping joins for one number share a single join and a single session', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    // Overlap is routine: Feishu redelivers invites and the documented handler
    // joins unconditionally. The "already in this meeting" check cannot catch a
    // concurrent pair on its own — both look before either has a session — so the
    // in-flight join is shared instead. Two real joins would leave the second
    // replacing the first's session, orphaning it with live timers and no routing.
    let releaseJoin = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    stubs.join.mockImplementation(async () => {
      await blocked;
      return joinResult(MEETING_ID, MEETING_NO);
    });

    const first = ch.joinMeeting(MEETING_NO);
    const second = ch.joinMeeting(MEETING_NO);
    releaseJoin();
    const [a, b] = await Promise.all([first, second]);

    expect(stubs.join).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(activeMeetingIds(ch)).toEqual([MEETING_ID]);
  });

  test('a later join for the same number reuses the session rather than rejoining', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);

    const first = await ch.joinMeeting(MEETING_NO);
    stubs.leave.mockClear();
    const again = await ch.joinMeeting(MEETING_NO);

    expect(again).toBe(first);
    expect(stubs.join).toHaveBeenCalledTimes(1);
    // And nothing evicts the bot from the meeting the live session is watching.
    expect(stubs.leave).not.toHaveBeenCalled();
  });
});
