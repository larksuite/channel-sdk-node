/**
 * Unpacking meeting activity into session events.
 *
 * Two nesting layers have to be walked, not one: a delivery carries several
 * activities and each activity carries several items. Taking only the first of
 * either silently drops most of a busy meeting while still looking like it
 * works.
 *
 * Push and poll disagree about where the payload sits — push puts
 * `activity_event_type` and the `*_items[]` arrays directly on the activity,
 * poll nests both under `payload` — and both have to produce identical events,
 * because the whole point of the session abstraction is that moving between
 * the two entry points changes one line of caller code and nothing else.
 *
 * Array order is semantic. A share hand-off arrives as an `ended` followed by
 * a `started` in the same delivery; reordering them tells the caller the
 * screen went blank when in fact it changed hands.
 */

import { normalizeMeetingPoll, normalizeMeetingPush } from '../normalize';
import { BOT_OPEN_ID, MEETING_ID, pairedShare, pollEvents, pushActivity } from './fixtures';

const CTX = { meetingId: MEETING_ID, mode: 'tat' as const, botOpenId: BOT_OPEN_ID };

function pushWith(activities: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    event_id: 'evt_local',
    event_type: 'vc.bot.meeting_activity_v1',
    meeting_activity_items: activities.map((a) => ({ meeting: { id: MEETING_ID }, ...a })),
  };
}

describe('two-layer unpacking', () => {
  test('every item of every activity is emitted, in array order', () => {
    const out = normalizeMeetingPush(pushActivity(), CTX);

    expect(out.map((o) => o.name)).toEqual([
      'transcript',
      'transcript',
      'chat',
      'chat',
      'participant',
    ]);
    expect(out.map((o) => o.activityType)).toEqual([
      'transcript_received',
      'transcript_received',
      'chat_received',
      'chat_received',
      'participant_joined',
    ]);
  });

  test('a transcript item is fully normalized, with wire strings turned into numbers', () => {
    const out = normalizeMeetingPush(pushActivity(), CTX);

    expect(out[0].event).toEqual({
      meetingId: MEETING_ID,
      actor: { id: 'ou_alice', name: 'Alice', userType: 1, userRole: 2 },
      selfEcho: false,
      text: 'good morning',
      sentenceId: 's_1',
      language: 'en_us',
      startMs: 1000,
      endMs: 1500,
    });
  });

  test('a chat item and a participant item carry their own fields', () => {
    const out = normalizeMeetingPush(pushActivity(), CTX);

    expect(out[2].event).toMatchObject({
      meetingId: MEETING_ID,
      actor: { id: 'ou_alice', name: 'Alice' },
      content: 'agenda?',
      messageId: 'omc_1',
      messageType: 1,
      sendTime: 1700,
    });
    expect(out[4].event).toMatchObject({
      actor: { id: 'ou_bob', name: 'Bob' },
      action: 'joined',
      joinTime: 900,
    });
  });
});

describe('push and poll shapes converge', () => {
  test('the nested poll shape produces exactly the same events as the flat push shape', () => {
    expect(normalizeMeetingPoll(pollEvents(), CTX)).toEqual(
      normalizeMeetingPush(pushActivity(), CTX),
    );
  });
});

describe('ordering', () => {
  test('a share hand-off keeps ended before started', () => {
    const out = normalizeMeetingPush(pairedShare(), CTX);

    expect(out.map((o) => o.name)).toEqual(['share', 'share']);
    expect(out.map((o) => (o.event as { action: string }).action)).toEqual(['ended', 'started']);
    expect(out[0].event).toMatchObject({ shareId: 'sh_old', time: 3000 });
    expect(out[1].event).toMatchObject({
      shareId: 'sh_new',
      time: 3001,
      doc: { url: 'https://example.com/docx/abc', title: 'Design doc' },
    });
  });
});

describe('actor normalization', () => {
  test('speaker / operator / participant all become `actor`', () => {
    const out = normalizeMeetingPush(
      pushWith([
        {
          activity_event_type: 'transcript_received',
          transcript_received_items: [{ speaker: { id: 'ou_speaker', user_name: 'S' }, text: 't' }],
        },
        {
          activity_event_type: 'chat_received',
          chat_received_items: [{ operator: { id: 'ou_operator', user_name: 'O' }, content: 'c' }],
        },
        {
          activity_event_type: 'participant_joined',
          participant_joined_items: [{ participant: { id: 'ou_participant', user_name: 'P' } }],
        },
      ]),
      CTX,
    );

    expect(out.map((o) => (o.event as { actor: { id: string } }).actor.id)).toEqual([
      'ou_speaker',
      'ou_operator',
      'ou_participant',
    ]);
    expect(out.map((o) => (o.event as { actor: { name?: string } }).actor.name)).toEqual([
      'S',
      'O',
      'P',
    ]);
  });

  test('the id falls back id → open_id → user_id', () => {
    const out = normalizeMeetingPush(
      pushWith([
        {
          activity_event_type: 'transcript_received',
          transcript_received_items: [
            { speaker: { id: 'from_id', open_id: 'from_open', user_id: 'from_user' }, text: 'a' },
            { speaker: { open_id: 'from_open', user_id: 'from_user' }, text: 'b' },
            { speaker: { user_id: 'from_user' }, text: 'c' },
          ],
        },
      ]),
      CTX,
    );

    expect(out.map((o) => (o.event as { actor: { id: string } }).actor.id)).toEqual([
      'from_id',
      'from_open',
      'from_user',
    ]);
  });
});

describe('forward compatibility', () => {
  test('an unrecognized activity_event_type yields nothing and does not throw', () => {
    expect(() =>
      normalizeMeetingPush(
        pushWith([
          { activity_event_type: 'something_invented_next_quarter', whatever_items: [{ a: 1 }] },
        ]),
        CTX,
      ),
    ).not.toThrow();

    expect(
      normalizeMeetingPush(
        pushWith([
          { activity_event_type: 'something_invented_next_quarter', whatever_items: [{ a: 1 }] },
        ]),
        CTX,
      ),
    ).toEqual([]);
  });

  test('a delivery with no activities at all yields nothing', () => {
    expect(normalizeMeetingPush({ event_id: 'evt_empty' }, CTX)).toEqual([]);
    expect(normalizeMeetingPoll({ has_more: false, events: [] }, CTX)).toEqual([]);
  });
});

describe('document_context_changed', () => {
  const OPERATOR = { id: 'ou_alice', user_name: 'Alice' };

  function docContext(items: Array<Record<string, unknown>>): Record<string, unknown> {
    return pushWith([
      { activity_event_type: 'document_context_changed', document_context_changed_items: items },
    ]);
  }

  test('each context type maps to its own field', () => {
    const out = normalizeMeetingPush(
      docContext([
        {
          operator: OPERATOR,
          share_id: 'sh_1',
          share_doc: { url: 'https://example.com/docx/a', title: 'A' },
          time: '4000',
          context_type: 'comment_focus',
          comment_focus: { comment_id: 'cmt_1', focused: true },
        },
        {
          operator: OPERATOR,
          share_id: 'sh_1',
          time: '4001',
          context_type: 'section_location',
          section_location: { title: 'Risks', level: 2, parent_titles: ['Design'] },
        },
        {
          operator: OPERATOR,
          share_id: 'sh_1',
          time: '4002',
          context_type: 'element_preview',
          element_preview: {
            action: 'open',
            element_type: 'image',
            element_token: 'tok_1',
            block_id: 'blk_1',
          },
        },
      ]),
      CTX,
    );

    expect(out.map((o) => o.name)).toEqual([
      'documentContext',
      'documentContext',
      'documentContext',
    ]);
    expect(out[0].event).toMatchObject({
      contextType: 'commentFocus',
      shareId: 'sh_1',
      time: 4000,
      doc: { url: 'https://example.com/docx/a', title: 'A' },
      commentFocus: { commentId: 'cmt_1', focused: true },
    });
    expect(out[1].event).toMatchObject({
      contextType: 'sectionLocation',
      sectionLocation: { title: 'Risks', level: 2, parentTitles: ['Design'] },
    });
    expect(out[2].event).toMatchObject({
      contextType: 'elementPreview',
      elementPreview: {
        action: 'open',
        elementType: 'image',
        elementToken: 'tok_1',
        blockId: 'blk_1',
      },
    });
  });

  test('an unknown context type drops that item and keeps the rest', () => {
    const out = normalizeMeetingPush(
      docContext([
        { operator: OPERATOR, context_type: 'holographic_focus', holographic_focus: { x: 1 } },
        {
          operator: OPERATOR,
          context_type: 'comment_focus',
          comment_focus: { comment_id: 'cmt_2' },
        },
      ]),
      CTX,
    );

    expect(out).toHaveLength(1);
    expect(out[0].event).toMatchObject({ contextType: 'commentFocus' });
  });
});

describe('the actor id arrives in two shapes', () => {
  /**
   * The generated types declare `id?: string`, and every fixture built from them
   * used that form — which is why a live push, where `id` is a nested object,
   * produced empty actor ids and silently disabled `selfEcho` for a whole release
   * cycle. Both shapes are real: a poll passes `user_id_type` so the service picks
   * one convention, a push has no such parameter so it sends all three.
   */
  test('a nested id object resolves to open_id, and selfEcho still matches', () => {
    const out = normalizeMeetingPush(
      pushWith([
        {
          activity_event_type: 'chat_received',
          chat_received_items: [
            {
              operator: {
                id: { open_id: BOT_OPEN_ID, union_id: 'on_x', user_id: 'uid_x' },
                user_name: 'TestBot',
                user_type: 1,
              },
              content: 'from the bot itself',
            },
          ],
        },
      ]),
      CTX,
    );

    expect(out).toHaveLength(1);
    expect(out[0].event).toMatchObject({
      actor: { id: BOT_OPEN_ID, name: 'TestBot' },
      // The whole point: an empty id would compare against '' and never match, so
      // the bot would answer its own messages.
      selfEcho: true,
    });
  });

  test('a nested id without open_id falls back through user_id, then union_id', () => {
    const out = normalizeMeetingPush(
      pushWith([
        {
          activity_event_type: 'transcript_received',
          transcript_received_items: [
            { speaker: { id: { user_id: 'uid_only' } }, text: 'a' },
            { speaker: { id: { union_id: 'on_x', user_id: 'uid_second' } }, text: 'b' },
          ],
        },
      ]),
      CTX,
    );

    // open_id → user_id → union_id, the same order the string form already used.
    expect(out.map((o) => (o.event as { actor: { id: string } }).actor.id)).toEqual([
      'uid_only',
      'uid_second',
    ]);
  });
});
