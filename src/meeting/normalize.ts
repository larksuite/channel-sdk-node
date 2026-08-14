/**
 * Turning in-meeting activity into session events.
 *
 * Two nesting layers, not one: a delivery carries several activities and each
 * activity carries several items. Reading only the first of either drops most of
 * a busy meeting while still looking like it works, because the shape is valid
 * either way.
 *
 * Push and poll disagree about where the payload sits — a push puts
 * `activity_event_type` and the `*_items[]` arrays directly on the activity, a
 * poll response nests both under `payload` — so both are flattened to a single
 * {@link RawActivity} before anything else looks at them. The difference is not
 * described in any prose doc; it comes from the generated types.
 *
 * Order is preserved throughout. A share hand-off arrives as an `ended`
 * followed by a `started` in one delivery, and array position is the only thing
 * that says which document is current.
 */

import {
  asArray,
  asBoolean,
  asDict,
  asMs,
  asNumber,
  asString,
  asStringArray,
  type Dict,
} from './coerce';
import type {
  MeetingActor,
  MeetingChatEvent,
  MeetingDocumentContextEvent,
  MeetingEventName,
  MeetingParticipantEvent,
  MeetingSharedDoc,
  MeetingShareEvent,
  MeetingTranscriptEvent,
} from './types';

export interface MeetingNormalizeContext {
  meetingId: string;
  mode: 'uat' | 'tat';
  /** Undefined while the bot's identity is still resolving — see `selfEcho`. */
  botOpenId?: string;
  includeRaw?: boolean;
}

export interface NormalizedMeetingEvent {
  name: MeetingEventName;
  /** The platform's `activity_event_type`, kept for health counters. */
  activityType: string;
  event: unknown;
}

/** One activity, with the push/poll nesting difference already flattened away. */
export interface RawActivity {
  meetingId?: string;
  activityType: string;
  items: Dict[];
  /**
   * Redelivery key. A polled event carries its own `event_id`; a push carries one
   * on the envelope, which is combined with the activity's position — see
   * {@link readPushActivities}.
   */
  eventId?: string;
}

/**
 * `activity_event_type` → the array field holding its items.
 *
 * An activity type absent from this table is one the platform added after this
 * release: it yields no events and is counted as a parse miss, which is the
 * signal that the SDK has fallen behind.
 */
/**
 * A `Map` rather than an object literal: the key is a string the server chooses,
 * and a plain object would happily resolve `'constructor'` or `'toString'` to an
 * inherited member.
 */
const ITEMS_FIELD = new Map<string, string>([
  ['transcript_received', 'transcript_received_items'],
  ['chat_received', 'chat_received_items'],
  ['participant_joined', 'participant_joined_items'],
  ['participant_left', 'participant_left_items'],
  ['magic_share_started', 'magic_share_started_items'],
  ['magic_share_ended', 'magic_share_ended_items'],
  ['document_context_changed', 'document_context_changed_items'],
]);

const EVENT_NAME = new Map<string, MeetingEventName>([
  ['transcript_received', 'transcript'],
  ['chat_received', 'chat'],
  ['participant_joined', 'participant'],
  ['participant_left', 'participant'],
  ['magic_share_started', 'share'],
  ['magic_share_ended', 'share'],
  ['document_context_changed', 'documentContext'],
]);

const CONTEXT_TYPE_BY_NAME = new Map<string, MeetingDocumentContextEvent['contextType']>([
  ['comment_focus', 'commentFocus'],
  ['section_location', 'sectionLocation'],
  ['element_preview', 'elementPreview'],
]);

// ─────────────────────────────────────────────────────────────
// Reading the two wire shapes
// ─────────────────────────────────────────────────────────────

/**
 * Activities out of a `vc.bot.meeting_activity_v1` push.
 *
 * The id that identifies a re-delivery lives on the envelope, not on the
 * activities inside it, so it is combined with the activity's position: the
 * whole push is suppressed on redelivery, while the several activities within one
 * push stay distinct from each other.
 */
export function readPushActivities(payload: unknown): RawActivity[] {
  const envelope = payload as Dict | undefined;
  const envelopeId = asString(envelope?.event_id);
  return asArray(envelope?.meeting_activity_items).map((activity, index) => {
    const parsed = toRawActivity(activity);
    return {
      ...parsed,
      eventId: parsed.eventId ?? (envelopeId ? `${envelopeId}#${index}` : undefined),
    };
  });
}

/** Activities out of a `vc.v1.bot.events` response body — one activity per event. */
export function readPollActivities(data: unknown): RawActivity[] {
  const events = asArray((data as Dict | undefined)?.events);
  return events.map((event) => {
    const payload = asDict(event.payload) ?? {};
    return {
      ...toRawActivity(payload),
      eventId: asString(event.event_id),
    };
  });
}

function toRawActivity(carrier: Dict): RawActivity {
  const activityType = asString(carrier.activity_event_type) ?? '';
  const field = ITEMS_FIELD.get(activityType);
  const meeting = asDict(carrier.meeting);
  return {
    meetingId: asString(meeting?.id),
    activityType,
    // Both nestings are accepted on both paths: the flat form is what a push
    // sends, the `payload` form is what a poll returns, and neither is
    // guaranteed to stay put.
    items: field ? asArray(carrier[field] ?? asDict(carrier.payload)?.[field]) : [],
    eventId: asString(carrier.event_id),
  };
}

// ─────────────────────────────────────────────────────────────
// Normalizing
// ─────────────────────────────────────────────────────────────

export interface ActivityResult {
  events: NormalizedMeetingEvent[];
  /**
   * The activity was understood but every item inside it was a variant this
   * release does not know. That is planned forward-compatibility, not a parse
   * failure, and counting it as one would train people to ignore the counter.
   */
  forwardCompatible: boolean;
}

export function normalizeActivity(
  activity: RawActivity,
  ctx: MeetingNormalizeContext,
): ActivityResult {
  const name = EVENT_NAME.get(activity.activityType);
  if (!name) return { events: [], forwardCompatible: false };

  const events: NormalizedMeetingEvent[] = [];
  let dropped = 0;

  for (const item of activity.items) {
    const event = buildEvent(name, activity.activityType, item, ctx);
    if (!event) {
      dropped++;
      continue;
    }
    events.push({ name, activityType: activity.activityType, event });
  }

  return {
    events,
    forwardCompatible:
      activity.activityType === 'document_context_changed' && dropped > 0 && events.length === 0,
  };
}

/** Convenience wrapper over a whole push, scoped to one meeting. */
export function normalizeMeetingPush(
  payload: unknown,
  ctx: MeetingNormalizeContext,
): NormalizedMeetingEvent[] {
  return normalizeAll(readPushActivities(payload), ctx);
}

/** Convenience wrapper over a whole poll response body, scoped to one meeting. */
export function normalizeMeetingPoll(
  data: unknown,
  ctx: MeetingNormalizeContext,
): NormalizedMeetingEvent[] {
  return normalizeAll(readPollActivities(data), ctx);
}

function normalizeAll(
  activities: RawActivity[],
  ctx: MeetingNormalizeContext,
): NormalizedMeetingEvent[] {
  return activities
    .filter((a) => !a.meetingId || a.meetingId === ctx.meetingId)
    .flatMap((a) => normalizeActivity(a, ctx).events);
}

// ─────────────────────────────────────────────────────────────
// Per-type item mapping
// ─────────────────────────────────────────────────────────────

function buildEvent(
  name: MeetingEventName,
  activityType: string,
  item: Dict,
  ctx: MeetingNormalizeContext,
): unknown {
  const actor = readActor(item);
  const base = {
    meetingId: ctx.meetingId,
    actor,
    selfEcho: isSelfEcho(actor, ctx),
    ...(ctx.includeRaw ? { raw: item } : {}),
  };

  switch (name) {
    case 'transcript':
      return {
        ...base,
        text: asString(item.text) ?? '',
        sentenceId: asString(item.sentence_id),
        language: asString(item.language),
        startMs: asMs(item.start_time_ms),
        endMs: asMs(item.end_time_ms),
      } satisfies MeetingTranscriptEvent;

    case 'chat':
      return {
        ...base,
        content: asString(item.content) ?? '',
        messageId: asString(item.message_id),
        messageType: asNumber(item.message_type),
        sendTime: asMs(item.send_time),
      } satisfies MeetingChatEvent;

    case 'participant':
      return {
        ...base,
        action: activityType === 'participant_left' ? 'left' : 'joined',
        joinTime: asMs(item.join_time),
        leaveTime: asMs(item.leave_time),
        leaveReason: asNumber(item.leave_reason),
      } satisfies MeetingParticipantEvent;

    case 'share':
      return {
        ...base,
        action: activityType === 'magic_share_ended' ? 'ended' : 'started',
        shareId: asString(item.share_id),
        doc: readDoc(item.share_doc),
        time: asMs(item.time),
      } satisfies MeetingShareEvent;

    case 'documentContext':
      return buildDocumentContext(base, item);

    default:
      return undefined;
  }
}

/**
 * `contextType` is derived from which sub-object is present.
 *
 * The `context_type` discriminator the prose docs describe does not exist in the
 * generated API surface at all, so presence is the only reliable signal — but a
 * platform-sent `context_type` wins when it is there, since the generated types
 * can lag the wire. An item carrying none of the three known variants is a new
 * context kind and is dropped.
 */
function buildDocumentContext(base: object, item: Dict): MeetingDocumentContextEvent | undefined {
  const declared = asString(item.context_type);
  const commentFocus = asDict(item.comment_focus);
  const sectionLocation = asDict(item.section_location);
  const elementPreview = asDict(item.element_preview);

  const contextType = pickContextType(declared, {
    commentFocus,
    sectionLocation,
    elementPreview,
  });
  if (!contextType) return undefined;

  const shared = {
    ...base,
    contextType,
    shareId: asString(item.share_id),
    doc: readDoc(item.share_doc),
    time: asMs(item.time),
  } as MeetingDocumentContextEvent;

  if (contextType === 'commentFocus') {
    shared.commentFocus = {
      commentId: asString(commentFocus?.comment_id),
      focused: asBoolean(commentFocus?.focused),
    };
  } else if (contextType === 'sectionLocation') {
    shared.sectionLocation = {
      title: asString(sectionLocation?.title),
      level: asNumber(sectionLocation?.level),
      parentTitles: asStringArray(sectionLocation?.parent_titles),
    };
  } else {
    shared.elementPreview = {
      action: asString(elementPreview?.action),
      elementType: asString(elementPreview?.element_type),
      elementToken: asString(elementPreview?.element_token),
      blockId: asString(elementPreview?.block_id),
    };
  }
  return shared;
}

function pickContextType(
  declared: string | undefined,
  present: { commentFocus?: Dict; sectionLocation?: Dict; elementPreview?: Dict },
): MeetingDocumentContextEvent['contextType'] | undefined {
  const named = declared ? CONTEXT_TYPE_BY_NAME.get(declared) : undefined;

  // A declared name this release does not know is a new context kind: dropped,
  // and deliberately not second-guessed from whatever sub-objects came with it.
  if (declared && !named) return undefined;
  // A known name still has to come with a sub-object — the name alone is no data.
  if (named && present[named]) return named;

  if (present.commentFocus) return 'commentFocus';
  if (present.sectionLocation) return 'sectionLocation';
  if (present.elementPreview) return 'elementPreview';
  return undefined;
}

/**
 * Each activity type names its actor differently — `speaker`, `operator`,
 * `participant` — and the id field is not consistent either, so both are
 * normalized here rather than at every call site.
 */
export function readActor(item: Dict): MeetingActor {
  const raw = asDict(item.speaker) ?? asDict(item.operator) ?? asDict(item.participant) ?? {};
  return {
    id: readActorId(raw),
    name: asString(raw.user_name) ?? asString(raw.name),
    userType: asNumber(raw.user_type),
    userRole: asNumber(raw.user_role),
  };
}

/**
 * The actor id, whichever shape it arrives in.
 *
 * Both shapes are real, and which one arrives follows from the request. A poll passes
 * `user_id_type: 'open_id'`, so the service picks a convention and `id` is that
 * string. A push has no such parameter, so it sends the whole set nested —
 * `{ open_id, union_id, user_id }` — confirmed against the live service, and contrary
 * to the generated types, which declare `id?: string` for both.
 *
 * Reading only the string form is the worst possible failure here: it does not throw,
 * it leaves the id empty, and `selfEcho` then compares against `''` and never matches
 * — so the bot answers its own messages, with nothing in the logs to say why.
 * `open_id` first, because that is the namespace the bot's own id lives in.
 */
function readActorId(raw: Dict): string {
  const nested = asDict(raw.id);
  if (nested) {
    return asString(nested.open_id) ?? asString(nested.user_id) ?? asString(nested.union_id) ?? '';
  }
  return (
    asString(raw.id) ??
    asString(raw.open_id) ??
    asString(raw.user_id) ??
    asString(raw.union_id) ??
    ''
  );
}

function isSelfEcho(actor: MeetingActor, ctx: MeetingNormalizeContext): boolean {
  // Follow mode never puts the bot in the meeting, so nothing can be its echo.
  if (ctx.mode === 'uat') return false;
  // Not knowing has to read as "possibly me": `false` is the value that lets a
  // caller respond, which is exactly how a bot ends up answering itself.
  if (!ctx.botOpenId) return true;
  return actor.id === ctx.botOpenId;
}

function readDoc(value: unknown): MeetingSharedDoc | undefined {
  const doc = asDict(value);
  if (!doc) return undefined;
  return { url: asString(doc.url), title: asString(doc.title) };
}
