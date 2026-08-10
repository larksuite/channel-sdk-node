/**
 * Liveness probing must fail open.
 *
 * Every live session probes on the same cadence, so probe failures are
 * correlated, not independent: one network blip or one scope that was never
 * granted hits every session in the same tick. A probe that treats "I could
 * not tell" as "the bot has left" therefore does not lose one session, it
 * loses all of them at once. Idle timeout still bounds the cost of keeping a
 * dead session around, so the asymmetry is heavily in favour of staying alive.
 *
 * The 200-with-an-empty-list case is the trap. It reads like a definitive "no
 * events, bot is not in the meeting", and an implementation that ends the
 * session there looks entirely reasonable — but a quiet meeting returns the
 * exact same thing, so that implementation kills live sessions whenever nobody
 * happens to be talking. Until the real not-in-meeting signal has been
 * observed against the live service, only an explicitly confirmed verdict may
 * end a session.
 */

import { LivenessProbe } from '../liveness';
import {
  activeMeetingIds,
  axiosErrorWithToken,
  createTestChannel,
  dispatchEvent,
  flushMicrotasks,
  MEETING_ID,
  MEETING_NO,
  makeLogger,
  markConnected,
  stubMeetingApis,
} from './fixtures';

const PROBE_INTERVAL = 60_000;

/** A TAT session with probing on and idle reclamation off, so the only thing
 *  that can end it is the probe verdict under test. */
async function joinProbedMeeting() {
  const { ch, logger } = createTestChannel({
    meeting: { livenessProbeIntervalMs: PROBE_INTERVAL, idleTimeoutMs: 0 },
  });
  markConnected(ch);
  const stubs = stubMeetingApis(ch);
  const session = await ch.joinMeeting(MEETING_NO);
  const ended: string[] = [];
  session.on('end', (e: { reason: string }) => {
    ended.push(e.reason);
  });
  session.on('error', () => {});
  return { ch, logger, stubs, session, ended };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a probe that cannot answer keeps the session', () => {
  test('a network error does not end the session', async () => {
    const { ch, stubs, ended } = await joinProbedMeeting();
    stubs.events.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL * 5);

    expect(ended).toEqual([]);
    expect(activeMeetingIds(ch)).toContain(MEETING_ID);
  });

  test('401 / 403 does not end the session', async () => {
    for (const status of [401, 403]) {
      const { ch, stubs, ended } = await joinProbedMeeting();
      stubs.events.mockRejectedValue(axiosErrorWithToken({ status, feishuCode: 99991400 }));

      await vi.advanceTimersByTimeAsync(PROBE_INTERVAL * 5);

      expect(ended).toEqual([]);
      expect(activeMeetingIds(ch)).toContain(MEETING_ID);
    }
  });

  test('200 with an empty event list does not end the session', async () => {
    const { ch, stubs, ended } = await joinProbedMeeting();
    stubs.events.mockResolvedValue({ data: { has_more: false, page_token: 'pt', events: [] } });

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL * 10);

    expect(ended).toEqual([]);
    expect(activeMeetingIds(ch)).toContain(MEETING_ID);
  });

  test('repeated failures keep the session and keep probing', async () => {
    const { ch, stubs, ended } = await joinProbedMeeting();
    stubs.events.mockRejectedValue(axiosErrorWithToken({ status: 500, feishuCode: 500 }));

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL * 3);
    const afterThree = stubs.events.mock.calls.length;
    expect(afterThree).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL * 20);

    expect(stubs.events.mock.calls.length).toBeGreaterThan(afterThree);
    expect(ended).toEqual([]);
    expect(activeMeetingIds(ch)).toContain(MEETING_ID);
  });
});

describe('a confirmed "no longer in the meeting" verdict ends the session', () => {
  test('end(no_longer_active) fires and the session is removed', async () => {
    const { ch, session, ended } = await joinProbedMeeting();

    // The probe is a pluggable seam precisely because the real wire signal is
    // still unknown; swapping it lets the session's reaction be pinned now and
    // the classification be filled in once it has been observed for real.
    (session as any).liveness = { check: vi.fn().mockResolvedValue('gone') };

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL * 2);

    expect(ended).toEqual(['no_longer_active']);
    expect(activeMeetingIds(ch)).not.toContain(MEETING_ID);
  });
});

describe('the probe doubles as gap recovery', () => {
  // The push stream can drop events across a reconnect. The probe already reads
  // `bot.events`, so discarding that response would waste the request — and, if
  // `page_token` turns out to acknowledge, silently consume events instead.

  test('what the probe reads is delivered to the session', async () => {
    const { stubs, session } = await joinProbedMeeting();
    const seen: string[] = [];
    session.on('transcript', (e: { text: string }) => {
      seen.push(e.text);
    });

    stubs.events.mockResolvedValue({
      data: {
        has_more: false,
        page_token: 'pt_after_probe',
        events: [
          {
            event_id: 'evt_recovered',
            event_type: 'vc.bot.meeting_activity_v1',
            payload: {
              meeting: { id: MEETING_ID },
              activity_event_type: 'transcript_received',
              transcript_received_items: [
                { speaker: { id: 'ou_alice', user_name: 'Alice' }, text: 'missed while offline' },
              ],
            },
          },
        ],
      },
    });

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL + 1_000);

    expect(seen).toEqual(['missed while offline']);
  });

  test('the cursor advances, so the next probe does not re-read the same page', async () => {
    const { stubs } = await joinProbedMeeting();
    stubs.events.mockResolvedValue({
      data: { has_more: false, page_token: 'pt_advanced', events: [] },
    });

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL + 1_000);
    const calls1 = stubs.events.mock.calls;
    const firstCall = calls1[calls1.length - 1][0];
    expect(firstCall.params.page_token).toBeUndefined();

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL + 1_000);
    const calls2 = stubs.events.mock.calls;
    const secondCall = calls2[calls2.length - 1][0];
    expect(secondCall.params.page_token).toBe('pt_advanced');
  });

  test('an event already delivered by the push stream is not delivered twice', async () => {
    const { ch, stubs, session } = await joinProbedMeeting();
    const seen: string[] = [];
    session.on('transcript', (e: { text: string }) => {
      seen.push(e.text);
    });

    const push = {
      event_id: 'evt_overlap',
      event_type: 'vc.bot.meeting_activity_v1',
      meeting_activity_items: [
        {
          meeting: { id: MEETING_ID },
          activity_event_type: 'transcript_received',
          transcript_received_items: [
            { speaker: { id: 'ou_alice', user_name: 'Alice' }, text: 'said once' },
          ],
        },
      ],
    };
    // The same activity from both producers, with the delivery ids the platform
    // really sends: a push carries one on the envelope, a polled event carries its
    // own, and the SDK's push key is `<envelopeId>#<index>` — so the two delivery
    // keys can never be equal. Only the transport-independent content key can
    // suppress this, which is exactly what makes it the assertion worth having.
    stubs.events.mockResolvedValue({
      data: {
        has_more: false,
        page_token: 'pt_overlap',
        events: [
          {
            event_id: '7180000000000000777',
            event_type: 'vc.bot.meeting_activity_v1',
            payload: push.meeting_activity_items[0],
          },
        ],
      },
    });

    const pushDelivery = dispatchEvent(ch, 'vc.bot.meeting_activity_v1', push);
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL + 1_000);
    await pushDelivery;
    await flushMicrotasks();

    expect(seen).toEqual(['said once']);
  });
});

describe('LivenessProbe verdicts', () => {
  function makeProbe(ch: any) {
    return new LivenessProbe({
      client: ch.rawClient,
      meetingId: MEETING_ID,
      logger: makeLogger() as never,
    });
  }

  test('a rejected request is "unknown", never "gone"', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    stubs.events.mockRejectedValue(new Error('boom'));

    await expect(makeProbe(ch).check()).resolves.toBe('unknown');
  });

  test('a permission error is "unknown" — a missing scope is not a departure', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    stubs.events.mockRejectedValue(axiosErrorWithToken({ status: 403, feishuCode: 99991400 }));

    await expect(makeProbe(ch).check()).resolves.toBe('unknown');
  });

  test('200 with an empty list is "unknown" — indistinguishable from a quiet meeting', async () => {
    const { ch } = createTestChannel();
    const stubs = stubMeetingApis(ch);
    stubs.events.mockResolvedValue({ data: { has_more: false, page_token: 'pt', events: [] } });

    await expect(makeProbe(ch).check()).resolves.toBe('unknown');
  });

  test('never throws — the caller has no failure branch to take', async () => {
    const { ch } = createTestChannel();
    (ch.rawClient.vc.v1.bot as any).events = vi.fn(() => {
      throw new Error('synchronous explosion');
    });

    await expect(makeProbe(ch).check()).resolves.toMatch(/active|gone|unknown/);
  });
});
