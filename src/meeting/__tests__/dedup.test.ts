/**
 * Duplicate suppression on the meeting path.
 *
 * The subtle one is `sentence_id`. It looks like a natural dedup key and it is
 * not one: a sentence is re-sent as the speaker keeps talking, with the text
 * growing each time. Keying on it collapses a whole sentence into its first
 * fragment, so captions freeze at "he" and never recover — and nothing errors,
 * so it surfaces only as "the transcript feels wrong". It is an overwrite
 * marker for the caller, carried on every event, never a suppression key.
 *
 * The dedup set also has to live in its own namespace. Sharing the one the IM
 * path uses means an id seen on either side suppresses the other, which is a
 * silent, cross-feature drop.
 */

import { DEFAULT_DEDUP } from '../../safety/types';
import {
  createTestChannel,
  dispatchEvent,
  flushMicrotasks,
  growingTranscript,
  MEETING_ID,
  MEETING_NO,
  markConnected,
  stubMeetingApis,
  transcriptPush,
  USER_TOKEN,
} from './fixtures';

function withoutEventId(push: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...push };
  delete copy.event_id;
  return copy;
}

async function joinedWithTranscripts(extra: Record<string, unknown> = {}) {
  const { ch } = createTestChannel(extra);
  markConnected(ch);
  stubMeetingApis(ch);
  const session = await ch.joinMeeting(MEETING_NO);
  const seen: Array<{ text: string; sentenceId?: string }> = [];
  session.on('transcript', (e: { text: string; sentenceId?: string }) => {
    seen.push({ text: e.text, sentenceId: e.sentenceId });
  });
  const deliver = async (push: unknown) => {
    await dispatchEvent(ch, 'vc.bot.meeting_activity_v1', push);
    await flushMicrotasks();
  };
  return { ch, session, seen, deliver };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('event_id', () => {
  test('a re-delivered event_id is dropped even when its body differs', async () => {
    const { seen, deliver } = await joinedWithTranscripts();

    await deliver(transcriptPush({ eventId: 'evt_same', text: 'first' }));
    // Different body, same id: only an event_id-keyed check can catch this, so
    // it isolates that level from the content-hash level below.
    await deliver(transcriptPush({ eventId: 'evt_same', text: 'a completely different line' }));

    expect(seen.map((s) => s.text)).toEqual(['first']);
  });
});

describe('content key when event_id is absent', () => {
  test('two byte-identical deliveries collapse into one', async () => {
    const { seen, deliver } = await joinedWithTranscripts();
    const push = withoutEventId(
      transcriptPush({ text: 'identical line', sentenceId: 's_ident', startMs: '9000' }),
    );

    await deliver(structuredClone(push));
    await deliver(structuredClone(push));

    expect(seen.map((s) => s.text)).toEqual(['identical line']);
  });
});

describe('a growing sentence is not a duplicate', () => {
  test('all three updates of one sentence_id are delivered, each carrying it', async () => {
    const { seen, deliver } = await joinedWithTranscripts();

    for (const push of growingTranscript()) await deliver(push);

    expect(seen).toEqual([
      { text: 'he', sentenceId: 's_grow' },
      { text: 'he said', sentenceId: 's_grow' },
      { text: 'he said hello', sentenceId: 's_grow' },
    ]);
  });
});

describe('scope isolation between identities', () => {
  test('a follower and an in-meeting bot each receive the same activity once', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);
    const stubs = stubMeetingApis(ch);
    // Both read the same `bot.events` for the same meeting, so a shared key space
    // would let whichever consumed an activity first silently swallow the other's
    // copy — one of the two streams would just develop holes.
    stubs.events.mockResolvedValue({
      data: {
        has_more: false,
        page_token: 'pt_scope',
        events: [
          {
            event_id: '7180000000000000888',
            event_type: 'vc.bot.meeting_activity_v1',
            payload: {
              meeting: { id: MEETING_ID },
              activity_event_type: 'transcript_received',
              transcript_received_items: [
                { speaker: { id: 'ou_alice', user_name: 'Alice' }, text: 'heard by both' },
              ],
            },
          },
        ],
      },
    });

    const followed = await ch.followMyMeeting({ userAccessToken: USER_TOKEN });
    const joined = await ch.joinMeeting(MEETING_NO);
    const followedSeen: string[] = [];
    const joinedSeen: string[] = [];
    followed.on('transcript', (e: { text: string }) => {
      followedSeen.push(e.text);
    });
    joined.on('transcript', (e: { text: string }) => {
      joinedSeen.push(e.text);
    });

    // The follower reads it via its poll loop; the joined session via a push.
    await vi.advanceTimersByTimeAsync(5_000);
    await dispatchEvent(ch, 'vc.bot.meeting_activity_v1', {
      event_id: 'evt_scope_push',
      event_type: 'vc.bot.meeting_activity_v1',
      meeting_activity_items: [
        {
          meeting: { id: MEETING_ID },
          activity_event_type: 'transcript_received',
          transcript_received_items: [
            { speaker: { id: 'ou_alice', user_name: 'Alice' }, text: 'heard by both' },
          ],
        },
      ],
    });
    await flushMicrotasks();

    expect(followedSeen).toEqual(['heard by both']);
    expect(joinedSeen).toEqual(['heard by both']);
  });
});

describe('dedup namespace', () => {
  test('an id already seen by the IM path does not suppress a meeting event', async () => {
    const namespacesWritten: string[] = [];
    const cache = {
      // Report a hit for every lookup in the IM namespace. A meeting path that
      // shares that namespace would treat its own first event as a duplicate
      // and deliver nothing.
      get: async (_key: unknown, opts?: { namespace?: string }) =>
        opts?.namespace === DEFAULT_DEDUP.namespace ? '1' : undefined,
      set: async (
        _key: unknown,
        _value: string,
        _expiredTime?: number,
        opts?: { namespace?: string },
      ) => {
        if (opts?.namespace) namespacesWritten.push(opts.namespace);
        return true;
      },
    };

    const { seen, deliver } = await joinedWithTranscripts({ cache });
    await deliver(transcriptPush({ eventId: 'evt_ns', text: 'namespaced' }));

    expect(seen.map((s) => s.text)).toEqual(['namespaced']);
    expect(namespacesWritten.length).toBeGreaterThan(0);
    expect(namespacesWritten).not.toContain(DEFAULT_DEDUP.namespace);
  });
});
