/**
 * The UAT polling loop: pacing, and what "stop" has to mean.
 *
 * Two failure modes drive this suite.
 *
 * Retrying a rejected user token forever turns one leaked credential into
 * thousands of authentication attempts an hour, so a permission failure must
 * end the event source outright — and it must end BOTH loops, because
 * `bot.events` and `userActiveMeeting` ride the same token. Stopping only the
 * first leaves the second spinning on a dead credential with nothing left to
 * stop it.
 *
 * And "end the event source" is not "return out of the loop". Nothing else
 * collects a UAT session: idle timeout and liveness probing are TAT-only. A
 * session that stopped polling but stayed in the registry is a zombie, so the
 * teardown assertions below look at registry state rather than at request
 * counts going quiet.
 */

import type { LarkChannelError } from '../../types';
import {
  activeMeetingIds,
  axiosErrorWithToken,
  createTestChannel,
  MEETING_ID,
  pollEvents,
  stubMeetingApis,
  USER_TOKEN,
} from './fixtures';

const EMPTY_PAGE = { data: { has_more: false, page_token: 'pt_0', events: [] } };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('empty-poll backoff', () => {
  test('gaps grow 3s → 6s → 10s → 10s and reset once a round returns events', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);

    await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.events).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2999);
    expect(stubs.events).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stubs.events).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5999);
    expect(stubs.events).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(stubs.events).toHaveBeenCalledTimes(3);

    // 3000 * 2**3 would be 24s; the ceiling clamps it to 10s and keeps it there.
    await vi.advanceTimersByTimeAsync(9999);
    expect(stubs.events).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(stubs.events).toHaveBeenCalledTimes(4);

    stubs.events.mockResolvedValueOnce({ data: pollEvents() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stubs.events).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(2999);
    expect(stubs.events).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(stubs.events).toHaveBeenCalledTimes(6);
  });
});

describe('user token is fetched fresh', () => {
  test('a MeetingTokenSource function is called again before every poll round', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);

    // Record how many polls had already gone out at each token fetch, so
    // "fetched before round N" is checkable rather than just "fetched a lot".
    const fetchedAtRound: number[] = [];
    const token = vi.fn(() => {
      fetchedAtRound.push(stubs.events.mock.calls.length);
      return USER_TOKEN;
    });

    await ch.followMyMeeting({ userAccessToken: token });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(6000);

    expect(stubs.events).toHaveBeenCalledTimes(3);
    expect(fetchedAtRound).toContain(0);
    expect(fetchedAtRound).toContain(1);
    expect(fetchedAtRound).toContain(2);
  });
});

describe('permission failure stops both loops', () => {
  test('a 401 on bot.events also freezes userActiveMeeting and the token callback', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    const token = vi.fn().mockReturnValue(USER_TOKEN);

    // Only the event loop is rejected. A healthy userActiveMeeting is what
    // makes a one-loop-only shutdown visible: it would keep polling forever.
    stubs.events
      .mockResolvedValueOnce(EMPTY_PAGE)
      .mockRejectedValue(axiosErrorWithToken({ status: 401, feishuCode: 99991401 }));

    const session = await ch.followMyMeeting({ userAccessToken: token });
    session.on('error', () => {});

    await vi.advanceTimersByTimeAsync(120_000);
    const settled = {
      events: stubs.events.mock.calls.length,
      userActiveMeeting: stubs.userActiveMeeting.mock.calls.length,
      token: token.mock.calls.length,
    };

    await vi.advanceTimersByTimeAsync(600_000);

    expect(stubs.events.mock.calls.length).toBe(settled.events);
    expect(stubs.userActiveMeeting.mock.calls.length).toBe(settled.userActiveMeeting);
    expect(token.mock.calls.length).toBe(settled.token);
  });
});

describe('retryable failures use their own, slower schedule', () => {
  test('gaps climb past the empty-poll ceiling, cap at 60s, and recover on success', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);

    const callTimes: number[] = [];
    let failing = false;
    stubs.events.mockImplementation(async () => {
      callTimes.push(Date.now());
      if (failing) throw axiosErrorWithToken({ status: 500, feishuCode: 500, msg: 'server error' });
      return EMPTY_PAGE;
    });

    const session = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    session.on('error', () => {});
    await vi.advanceTimersByTimeAsync(0);

    failing = true;
    const firstFailureIndex = callTimes.length;
    await vi.advanceTimersByTimeAsync(300_000);

    const gaps: number[] = [];
    for (let i = firstFailureIndex; i < callTimes.length; i++) {
      gaps.push(callTimes[i] - callTimes[i - 1]);
    }

    expect(gaps.length).toBeGreaterThan(2);
    // Reusing the empty-poll counter would keep every gap at or under 10s.
    expect(Math.max(...gaps)).toBeGreaterThan(10_000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000);

    // A success has to put the loop back on the empty-poll cadence rather than
    // leaving it parked on a minute-long failure delay.
    failing = false;
    await vi.advanceTimersByTimeAsync(60_000);
    const afterRecovery = callTimes.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callTimes.length).toBeGreaterThan(afterRecovery);
  });

  test('unbroken retryable failures eventually end the session', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    stubs.events
      .mockResolvedValueOnce(EMPTY_PAGE)
      .mockRejectedValue(axiosErrorWithToken({ status: 500, feishuCode: 500 }));

    const session = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    session.on('error', () => {});
    const ended: string[] = [];
    session.on('end', (e: { reason: string }) => {
      ended.push(e.reason);
    });

    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(ended).toContain('error');
    expect(activeMeetingIds(ch)).toHaveLength(0);
  });
});

describe('the end-of-meeting check never kills a healthy session', () => {
  // These failures are correlated, not independent: one API, one 30s cadence, often
  // one user across several sessions — and a 429 can be self-inflicted. Ending the
  // session on exhaustion would drop every follow session in the same window while
  // captions were still streaming through a perfectly healthy activity loop.
  test('userActiveMeeting failing forever leaves the session running and polling', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    // The first call resolves the meeting for `followMyMeeting`; every later call
    // is the end-of-meeting check, and those all fail.
    stubs.userActiveMeeting
      .mockResolvedValueOnce({ data: { meetings: [{ meeting_id: MEETING_ID }] } })
      .mockRejectedValue(axiosErrorWithToken({ status: 503, feishuCode: 503 }));

    const session = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    const ended: string[] = [];
    session.on('error', () => {});
    session.on('end', (e: { reason: string }) => {
      ended.push(e.reason);
    });

    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(ended).toEqual([]);
    expect(activeMeetingIds(ch)).toContain(MEETING_ID);

    // It keeps checking, just slowly — losing end-detection beats ending the session.
    const before = stubs.userActiveMeeting.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stubs.userActiveMeeting.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('a backlog drains, but not forever', () => {
  test('has_more pulls the next page immediately, and stops spinning if it never ends', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    const token = vi.fn().mockReturnValue(USER_TOKEN);
    // A server that always says "more" — or a page_token that never advances — must
    // not turn into a flat-out request loop that also hammers the caller's auth.
    stubs.events.mockResolvedValue({
      data: { has_more: true, page_token: 'pt_stuck', events: [] },
    });

    const session = await ch.followMyMeeting({ userAccessToken: token });
    session.on('error', () => {});

    // Just under the paced interval, so everything here is unpaced drain.
    await vi.advanceTimersByTimeAsync(2_999);
    const drained = stubs.events.mock.calls.length;
    expect(drained).toBeGreaterThan(1);

    // Bounded: it gave up draining rather than spinning for the whole window.
    expect(drained).toBeLessThan(50);
    const tokenFetches = token.mock.calls.length;

    // And it is back on the paced schedule rather than stopped altogether.
    await vi.advanceTimersByTimeAsync(3_100);
    expect(stubs.events.mock.calls.length).toBeGreaterThan(drained);
    expect(token.mock.calls.length).toBeGreaterThan(tokenFetches);
  });
});

describe('termination is a full teardown, not just a stopped loop', () => {
  test('error → end(error) → session gone from the registry', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    stubs.events
      .mockResolvedValueOnce(EMPTY_PAGE)
      .mockRejectedValue(axiosErrorWithToken({ status: 403, feishuCode: 99991400 }));

    const session = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    expect(activeMeetingIds(ch)).toContain(MEETING_ID);

    const order: string[] = [];
    session.on('error', (e: LarkChannelError) => {
      order.push(`error:${e.code}`);
    });
    session.on('end', (e: { reason: string }) => {
      order.push(`end:${e.reason}`);
    });

    await vi.advanceTimersByTimeAsync(600_000);

    expect(order[0]).toBe('error:permission_denied');
    expect(order).toContain('end:error');
    expect(order.indexOf('end:error')).toBeGreaterThan(0);
    expect(activeMeetingIds(ch)).not.toContain(MEETING_ID);
    expect(activeMeetingIds(ch)).toHaveLength(0);
  });
});

describe('request parameters', () => {
  test('both loops always ask for open_id', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);

    await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(stubs.events.mock.calls.length).toBeGreaterThan(0);
    for (const [payload] of stubs.events.mock.calls) {
      expect(payload.params.user_id_type).toBe('open_id');
      expect(payload.params.meeting_id).toBe(MEETING_ID);
    }

    expect(stubs.userActiveMeeting.mock.calls.length).toBeGreaterThan(0);
    for (const [payload] of stubs.userActiveMeeting.mock.calls) {
      expect(payload.params.user_id_type).toBe('open_id');
    }
  });
});
