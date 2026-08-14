/**
 * Parse-health counters.
 *
 * Failures on this path are silent by construction: a missing subscription, a
 * missing permission, or a renamed field all look identical from the outside —
 * nothing arrives. Splitting "activities received" from "activities that
 * unpacked to nothing" is what separates "the platform never sent it" from
 * "it arrived and we could not read it", which are opposite investigations.
 *
 * Two counting rules follow from that. An unrecognized `activity_event_type`
 * counts as empty: it means the SDK has fallen behind the platform, which is
 * exactly what should be visible. An unrecognized `context_type` inside a
 * document-context item does not: dropping a sub-variant is planned
 * forward-compatibility, and counting it as a failure would train people to
 * ignore the counter.
 *
 * Counters are per link, and the link is the transport rather than the session's
 * identity. One total would let a healthy poll loop stand in for a dead push
 * stream; and because an app-identity session's liveness probe reads over REST,
 * counting by identity would let that probe's recovery stand in for the pushes
 * it exists to compensate for.
 *
 * The key space is server-driven and the counters live as long as the process,
 * so it is bounded — an unbounded map keyed by strings someone else chooses is
 * a slow leak.
 */

import { MeetingHealth } from '../health';
import {
  createTestChannel,
  dispatchEvent,
  flushMicrotasks,
  MEETING_NO,
  markConnected,
  pollEvents,
  pushActivity,
  stubMeetingApis,
  USER_TOKEN,
} from './fixtures';

const MAX_DISTINCT_KEYS = 5000;
const PROBE_INTERVAL = 60_000;

describe('channel-level health', () => {
  test('before anything arrives, nothing is counted and registration is reported honestly', () => {
    const { ch } = createTestChannel();

    const health = ch.getMeetingEventHealth();
    expect(health.push.received).toBe(0);
    expect(health.push.stats).toEqual({});
    expect(health.push.registered).toBe(false);
    expect(typeof health.push.reason).toBe('string');
    expect(health.push.reason.length).toBeGreaterThan(0);
    expect(health.poll).toEqual({ sessions: 0, received: 0, stats: {} });
  });

  test('registration flips once the dispatcher handlers are in place', () => {
    const { ch } = createTestChannel();
    markConnected(ch);

    const health = ch.getMeetingEventHealth();
    expect(health.push.registered).toBe(true);
    expect(health.push.reason).toBeUndefined();
    expect(health.push.received).toBe(0);
  });

  test('a pushed activity advances the push counters and leaves poll untouched', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    stubMeetingApis(ch);
    await ch.joinMeeting(MEETING_NO);

    await dispatchEvent(ch, 'vc.bot.meeting_activity_v1', pushActivity());
    await flushMicrotasks();

    const health = ch.getMeetingEventHealth();
    expect(health.push.received).toBe(3);
    expect(health.push.lastAt).toBeGreaterThan(0);
    expect(health.push.stats.transcript_received).toEqual({ received: 1, empty: 0 });
    expect(health.push.stats.chat_received).toEqual({ received: 1, empty: 0 });
    expect(health.push.stats.participant_joined).toEqual({ received: 1, empty: 0 });
    expect(health.poll.received).toBe(0);
    expect(health.poll.stats).toEqual({});
  });
});

describe('the two links cannot stand in for each other', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The reported failure mode: pushes stop, a follow session keeps polling, and a
  // single total keeps climbing — so the snapshot reads healthy while the link the
  // app identity depends on is dead.
  test('a busy follow session never advances the push counters', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    stubs.events.mockResolvedValue({ data: pollEvents() });

    await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    await vi.advanceTimersByTimeAsync(10_000);

    const health = ch.getMeetingEventHealth();
    expect(health.poll.received).toBeGreaterThan(0);
    expect(health.poll.sessions).toBe(1);
    expect(health.push.received).toBe(0);
    expect(health.push.lastAt).toBeUndefined();
    expect(health.push.stats).toEqual({});
  });

  // The subtle half, and the reason the axis is transport and not identity: this is an
  // app-identity session, but its probe reads `bot.events`. Counting that as push would
  // let gap recovery vouch for the very stream it is recovering from.
  test('what an app-identity probe recovers over REST counts as poll', async () => {
    const { ch } = createTestChannel({
      meeting: { livenessProbeIntervalMs: PROBE_INTERVAL, idleTimeoutMs: 0 },
    });
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    const session = await ch.joinMeeting(MEETING_NO);
    session.on('error', () => {});
    stubs.events.mockResolvedValue({ data: pollEvents() });

    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL * 2);

    const health = ch.getMeetingEventHealth();
    expect(health.poll.received).toBeGreaterThan(0);
    // No follow session exists, so the poll counters here come from the probe alone.
    expect(health.poll.sessions).toBe(0);
    expect(health.push.received).toBe(0);
    // The session's own counters stay whole: per-session stats answer "what did this
    // session see", where the transport does not change the answer.
    expect(session.getStats().transcript_received?.received).toBeGreaterThan(0);
  });

  test('sessions counts live follow sessions, so an idle one is not mistaken for a fault', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    stubMeetingApis(ch);

    const session = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    expect(ch.getMeetingEventHealth().poll.sessions).toBe(1);

    session.dispose();
    await flushMicrotasks();
    expect(ch.getMeetingEventHealth().poll.sessions).toBe(0);
  });
});

describe('MeetingHealth counters', () => {
  test('an activity that unpacked to nothing counts as empty', () => {
    const health = new MeetingHealth();

    health.record('transcript_received', 2);
    health.record('transcript_received', 0);

    expect(health.stats().transcript_received).toEqual({ received: 2, empty: 1 });
    expect(health.counters().received).toBe(2);
  });

  test('an unknown activity type counts as empty — the SDK has fallen behind', () => {
    const health = new MeetingHealth();

    health.record('something_invented_next_quarter', 0);

    expect(health.stats().something_invented_next_quarter).toEqual({ received: 1, empty: 1 });
  });

  test('a forward-compatible drop does not count as empty', () => {
    const health = new MeetingHealth();

    health.record('document_context_changed', 0, { forwardCompatible: true });

    expect(health.stats().document_context_changed).toEqual({ received: 1, empty: 0 });
  });

  test('counters start empty and omit lastAt until something arrives', () => {
    const health = new MeetingHealth();

    expect(health.counters()).toEqual({ received: 0, stats: {} });

    health.record('chat_received', 1);
    expect(health.counters().lastAt).toBeGreaterThan(0);
  });

  test('past the key ceiling new types fold into a single bucket', () => {
    const health = new MeetingHealth();

    for (let i = 0; i < MAX_DISTINCT_KEYS; i++) health.record(`type_${i}`, 1);

    // 100 further distinct types must add at most the one overflow bucket.
    for (let i = 0; i < 100; i++) health.record(`overflow_${i}`, i === 0 ? 0 : 1);

    const stats = health.stats();
    expect(Object.keys(stats).length).toBeLessThanOrEqual(MAX_DISTINCT_KEYS + 1);
    expect(stats.overflow_0).toBeUndefined();
    expect(stats.overflow_99).toBeUndefined();
    expect(stats.__other__).toEqual({ received: 100, empty: 1 });
    // Nothing is lost from the totals — only the per-key breakdown is bounded.
    expect(health.counters().received).toBe(MAX_DISTINCT_KEYS + 100);
  });
});
