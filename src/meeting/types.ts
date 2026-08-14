import type { LarkChannelError } from '../types';

export type Unsubscribe = () => void;

// ─────────────────────────────────────────────────────────────
// Entry-point options
// ─────────────────────────────────────────────────────────────

/**
 * How the follow path obtains a user access token.
 *
 * A plain string is the simple case. A function is re-invoked before every poll round,
 * which lets a meeting outlast a shorter-lived token — this SDK never touches
 * `refresh_token` and never persists a credential.
 *
 * The name is kept under 20 characters because the repo's secret scanner reads a longer
 * type in a `userAccessToken:` annotation as a leaked credential.
 */
export type MeetingTokenSource = string | (() => string | Promise<string>);

export interface MeetingOptions {
  /**
   * Debounce window for caption settling, in ms. Default `0`.
   *
   * `0` forwards every update, so callers see a sentence grow word by word — the
   * right shape for streaming a caption or feeding a model continuously. A
   * positive value delivers a sentence only once it has stopped changing for
   * that long, at the cost of one window of latency (and of never settling while
   * someone talks without pause).
   */
  stabilizeMs?: number;
}

export interface FollowMeetingOptions extends MeetingOptions {
  /** Required: path one authenticates as the user, never as the app. */
  userAccessToken: MeetingTokenSource;
  /** Which meeting to follow when the user is in several at once. */
  meetingNo?: string;
}

export interface JoinMeetingOptions extends MeetingOptions {
  /** Password-protected meetings. Passed through to `bots/join`. */
  password?: string;
  /** From {@link MeetingInvitedEvent.callId}, when joining off an invite. */
  callId?: string;
}

export interface MeetingChannelConfig {
  /**
   * Ceiling on concurrent sessions. Default `32`. Sessions are started by whoever calls
   * the bot into a meeting, so their number is not under the application's control.
   *
   * Admission is refused before `bots/join` goes out, so a refusal never parks the bot
   * in a meeting with no session behind it. A soft limit: overlapping joins for
   * *different* meetings can each pass the check and briefly exceed it by the number in
   * flight.
   */
  maxConcurrentSessions?: number;

  /**
   * Reclaim a TAT session that has seen no activity for this long, in ms.
   * **Default `0` — off.** Follow-mode sessions are unaffected.
   *
   * `0`: no reclamation. A session then ends only on `meeting_ended_v1`, on a probe
   * confirming the bot has left, or on an explicit {@link MeetingSession.leave} /
   * {@link MeetingSession.dispose}.
   *
   * A positive value: no activity for that long → end the session, call `bots/leave`,
   * return the concurrency slot. The leave is not optional, because a reclaimed session
   * leaves no handle to leave with. Any delivered activity resets the timer, including
   * what the probe pulls in while catching up.
   *
   * Enable it where the probe cannot be relied on (a missing scope, `bot.events`
   * unreachable for long stretches), or where handlers may block for a long time — a
   * blocked handler stops the timer being reset and also blocks the queue the probe
   * uses, leaving nothing to reclaim the session.
   */
  idleTimeoutMs?: number;

  /**
   * How often to confirm the bot is still in the meeting, in ms.
   * Default `300000` (5 min); `0` disables.
   *
   * Backstop for the cases that produce no `meeting_ended_v1` at all — the bot
   * being removed by a host, or the meeting changing hands.
   */
  livenessProbeIntervalMs?: number;

  /**
   * Cap on in-meeting messages per session per minute. Default `20`.
   *
   * A bot's own messages come back as `chat_received`, so a handler that
   * answers without checking `selfEcho` self-triggers at network speed. This
   * bounds the damage.
   */
  sendRateLimitPerMinute?: number;
}

// ─────────────────────────────────────────────────────────────
// Session events
// ─────────────────────────────────────────────────────────────

export interface MeetingActor {
  /**
   * The actor's `open_id`. The meeting APIs are always asked for `open_id`, so this
   * shares a namespace with the bot's own id and {@link MeetingEventBase.selfEcho} can
   * compare them.
   */
  id: string;
  /** Untrusted: a display name chosen by a participant, guests included. */
  name?: string;
  userType?: number;
  userRole?: number;
}

export interface MeetingEventBase {
  meetingId: string;
  actor: MeetingActor;
  /**
   * The item was produced by this bot — a message echoed back, or its own speech
   * transcribed into the caption stream. Flagged but still delivered, so dropping it is
   * the caller's decision.
   *
   * Fails safe: reports `true` while the bot's own `open_id` is unresolved, since
   * `false` means "not me" and would let a self-sustaining loop through. Always `false`
   * in follow mode.
   */
  selfEcho: boolean;
  /** Raw platform payload; present only when `includeRawEvent` is set. */
  raw?: unknown;
}

export interface MeetingTranscriptEvent extends MeetingEventBase {
  /** Untrusted: spoken content, transcribed verbatim. */
  text: string;
  /**
   * Stable id for one sentence. Deliveries of the same id supersede earlier ones —
   * nothing on the wire marks which send is final, so callers upsert on this rather than
   * append. "Later" is decided by {@link endMs} where both sends carry one, not by
   * arrival: a session ingests from two transports and they can interleave.
   */
  sentenceId?: string;
  language?: string;
  startMs?: number;
  endMs?: number;
}

export interface MeetingChatEvent extends MeetingEventBase {
  /** Untrusted: written by a participant. */
  content: string;
  messageId?: string;
  messageType?: number;
  sendTime?: number;
}

export interface MeetingParticipantEvent extends MeetingEventBase {
  action: 'joined' | 'left';
  joinTime?: number;
  leaveTime?: number;
  leaveReason?: number;
}

export interface MeetingSharedDoc {
  /** Untrusted: a URL chosen by whoever shared the document. */
  url?: string;
  /** Untrusted: a document title. */
  title?: string;
}

export interface MeetingShareEvent extends MeetingEventBase {
  action: 'started' | 'ended';
  shareId?: string;
  doc?: MeetingSharedDoc;
  time?: number;
}

/**
 * A context change inside a shared document. Identifiers only, never content: a comment
 * arrives as a `commentId`, an image or board as an `elementToken`. Fetching the text or
 * asset is left to the caller.
 */
export interface MeetingDocumentContextEvent extends MeetingEventBase {
  /**
   * Derived from which sub-object is present: the `context_type` the prose docs describe
   * does not exist in the generated API surface. A platform-sent `context_type` wins
   * when it does show up.
   */
  contextType: 'commentFocus' | 'sectionLocation' | 'elementPreview';
  shareId?: string;
  doc?: MeetingSharedDoc;
  time?: number;
  commentFocus?: { commentId?: string; focused?: boolean };
  sectionLocation?: { title?: string; level?: number; parentTitles?: string[] };
  elementPreview?: {
    action?: string;
    elementType?: string;
    /** Untrusted: an opaque token identifying a document element. */
    elementToken?: string;
    blockId?: string;
  };
}

export interface MeetingEndEvent {
  meetingId: string;
  reason: MeetingEndReason;
}

export type MeetingEndReason =
  /** TAT: `vc.bot.meeting_ended_v1` arrived. */
  | 'meeting_ended'
  /** UAT: the meeting left the active list. TAT: the probe confirmed departure. */
  | 'no_longer_active'
  /** TAT: no activity for `idleTimeoutMs`. */
  | 'idle_timeout'
  /** The event source stopped unrecoverably — a rejected token, or repeated failures. */
  | 'error'
  /** {@link MeetingSession.leave} was called. */
  | 'left'
  /** {@link MeetingSession.dispose} was called, directly or via `disconnect()`. */
  | 'disposed';

export interface MeetingEventMap {
  transcript: (e: MeetingTranscriptEvent) => void | Promise<void>;
  chat: (e: MeetingChatEvent) => void | Promise<void>;
  participant: (e: MeetingParticipantEvent) => void | Promise<void>;
  share: (e: MeetingShareEvent) => void | Promise<void>;
  documentContext: (e: MeetingDocumentContextEvent) => void | Promise<void>;
  end: (e: MeetingEndEvent) => void | Promise<void>;
  error: (err: LarkChannelError) => void;
}

export type MeetingEventName = keyof MeetingEventMap;

// ─────────────────────────────────────────────────────────────
// Channel-level event
// ─────────────────────────────────────────────────────────────

/**
 * The bot was invited into a meeting. Channel-level rather than session-level: no
 * session exists yet when it arrives.
 */
export interface MeetingInvitedEvent {
  /** The 9-digit number `joinMeeting` takes. */
  meetingNo: string;
  meetingId?: string;
  /** Untrusted: the meeting title, free text from its creator. */
  topic?: string;
  inviter?: MeetingActor;
  bot?: MeetingActor;
  /** Pass to `joinMeeting` when joining off a call-style invite. */
  callId?: string;
  inviteTime?: number;
  raw?: unknown;
}

// ─────────────────────────────────────────────────────────────
// Observability
// ─────────────────────────────────────────────────────────────

export interface MeetingActivityStats {
  /** Activities of this type received. */
  received: number;
  /** How many of them unpacked to no items at all. */
  empty: number;
}

/** A meeting the bot is a participant of, and the number needed to re-attach to it. */
export interface MeetingMembership {
  meetingId: string;
  /** The 9-digit number {@link MeetingSession} was joined with — what `joinMeeting` takes. */
  meetingNo: string;
}

/** Activity counters for one inbound link. */
export interface MeetingLinkHealth {
  received: number;
  lastAt?: number;
  stats: Record<string, MeetingActivityStats>;
}

/** Event pushes, which arrive over the channel's own connection. */
export interface MeetingPushHealth extends MeetingLinkHealth {
  /**
   * Whether the channel's internal `vc.bot.*` handlers are registered — set by
   * `connect()`. It describes registration, not connectivity: it stays `true` across a
   * dropped and reconnecting WebSocket.
   */
  registered: boolean;
  /** Why registration has not taken effect, when it has not. */
  reason?: string;
}

/** REST reads: every follow session's poll loop, and the probe's gap-recovery read. */
export interface MeetingPollHealth extends MeetingLinkHealth {
  /** Live follow sessions, so `received: 0` with no sessions is not a fault. */
  sessions: number;
}

/**
 * Diagnostics for the in-meeting event path, whose failures are silent: a missing
 * subscription, a missing scope and a renamed field all look the same from outside.
 *
 * Counted per link rather than in one total. The two are independent — pushes can stop
 * while polling keeps working — and a single total would let either one's traffic stand
 * in for the other's health. The split is by transport, not by session identity: an
 * app-identity session's liveness probe reads over REST, so what it recovers counts
 * under `poll`.
 *
 * Within a link, `received` and `empty` separate "the platform never sent it" from "it
 * arrived and could not be read" — opposite investigations.
 */
export interface MeetingEventHealth {
  push: MeetingPushHealth;
  poll: MeetingPollHealth;
}

// ─────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────

export interface MeetingSession {
  /** Long meeting id, the one every API but `bots/join` takes. */
  readonly meetingId: string;
  /** 9-digit meeting number. */
  readonly meetingNo: string;
  /** Untrusted: free text from the meeting's creator. */
  readonly topic?: string;
  readonly mode: 'uat' | 'tat';

  /**
   * Subscribe. Multicast, unlike the channel's own single-slot `on()`: the returned
   * function removes only the handler it was returned for.
   *
   * Handlers are awaited before the next item is delivered, because order carries
   * meaning — a share hand-off arrives as an `ended` followed by a `started` in one
   * delivery. A slow handler therefore holds up the stream.
   */
  on<K extends MeetingEventName>(name: K, handler: MeetingEventMap[K]): Unsubscribe;

  /**
   * Send an in-meeting message. TAT only; in follow mode the bot is not in the
   * meeting, so this rejects with `not_supported`.
   */
  sendMessage(text: string): Promise<void>;

  /** Per-activity-type parse counters for this session. */
  getStats(): Record<string, MeetingActivityStats>;

  /**
   * Stop timers and subscriptions without calling any API. Idempotent.
   *
   * The bot stays in the meeting, so a reconnect does not evict it — which also means a
   * process must `leave()` before exiting.
   */
  dispose(): void;

  /**
   * Leave the meeting, give up the concurrency slot, then end the session. Idempotent,
   * and **still effective after the session has already ended** — including after
   * `dispose()` or `disconnect()`.
   *
   * Teardown does not depend on the API call succeeding: `bots/leave` is most likely to
   * fail exactly when a meeting has just ended. The failure surfaces through `error`.
   */
  leave(): Promise<void>;
}
