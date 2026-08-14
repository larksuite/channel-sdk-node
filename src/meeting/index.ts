/**
 * The meeting channel: entry points, dispatcher handlers, and the registry that
 * ties them together.
 *
 * Kept out of `channel.ts` so the boundary is visible in the file tree — the IM
 * path and its error handling are deliberately untouched by this work.
 */

import type { Cache } from '@larksuiteoapi/node-sdk';
import { type Client, withUserAccessToken } from '@larksuiteoapi/node-sdk';
import type { Logger } from '../internal';
import { type EventMap, LarkChannelError } from '../types';
import { asDict, asMs, asString } from './coerce';
import { MeetingDedup } from './dedup';
import { isInconclusiveFailure, meetingError } from './errors';
import { MeetingHealth, type MeetingLink } from './health';
import { readActor } from './normalize';
import { MeetingRegistry } from './registry';
import { LiveMeetingSession, type ResolvedMeetingConfig } from './session';
import { toTokenProvider, type UserTokenProvider } from './token';
import type {
  FollowMeetingOptions,
  JoinMeetingOptions,
  MeetingChannelConfig,
  MeetingEventHealth,
  MeetingInvitedEvent,
  MeetingMembership,
  MeetingSession,
} from './types';

const DEFAULTS: ResolvedMeetingConfig = {
  maxConcurrentSessions: 32,
  // Off by default: the liveness probe detects a removed bot directly, so the only
  // sessions idle reclamation would still reach are quiet-but-live meetings — and
  // reclaiming one means leaving it. See MeetingChannelConfig.idleTimeoutMs.
  idleTimeoutMs: 0,
  livenessProbeIntervalMs: 5 * 60_000,
  sendRateLimitPerMinute: 20,
};

/** `join_type` is fixed by the protocol; the field exists but has one legal value. */
const JOIN_TYPE_BY_MEETING_NO = 1;

export interface MeetingChannelDeps {
  client: Client;
  logger: Logger;
  cache: Cache;
  config?: MeetingChannelConfig;
  includeRaw: boolean;
  botOpenId: () => string | undefined;
  isConnected: () => boolean;
  /** The channel's single-slot `meetingInvited` handler, read at dispatch time. */
  invitedHandler: () => EventMap['meetingInvited'] | undefined;
  /** Where anything a dispatcher handler throws goes, instead of the transport. */
  onError: (err: unknown) => void;
}

export class MeetingChannel {
  private readonly config: ResolvedMeetingConfig;
  private readonly registry: MeetingRegistry;
  private readonly dedup: MeetingDedup;
  /**
   * Joins currently in flight, by meeting number.
   *
   * The "already in this meeting" check cannot cover a concurrent pair on its own:
   * both callers look before either has a session, so both would call `bots/join`
   * and the second would replace the first's session. Feishu redelivers
   * `meeting_invited_v1` and the documented handler joins unconditionally, so the
   * pair is routine rather than hypothetical.
   */
  private readonly joining = new Map<string, Promise<MeetingSession>>();

  /**
   * One counter per link, owned here rather than by the registry: the registry keys
   * sessions and membership, and has no view of which transport an activity came in on
   * — nor of push registration, which is the channel's own act.
   */
  private readonly linkHealth: Record<MeetingLink, MeetingHealth> = {
    push: new MeetingHealth(),
    poll: new MeetingHealth(),
  };

  private pushRegistered = false;
  private pushUnregisteredReason: string | undefined = 'channel not connected';

  constructor(private readonly deps: MeetingChannelDeps) {
    this.config = { ...DEFAULTS, ...stripUndefined(deps.config) };
    this.registry = new MeetingRegistry(deps.logger, this.config.maxConcurrentSessions);
    this.dedup = new MeetingDedup(deps.cache);
  }

  /** Live sessions. Also the seam teardown assertions look at. */
  list(): LiveMeetingSession[] {
    return this.registry.list();
  }

  health(): MeetingEventHealth {
    return {
      push: {
        registered: this.pushRegistered,
        ...(this.pushUnregisteredReason ? { reason: this.pushUnregisteredReason } : {}),
        ...this.linkHealth.push.counters(),
      },
      poll: {
        sessions: this.registry.list().filter((s) => s.mode === 'uat').length,
        ...this.linkHealth.poll.counters(),
      },
    };
  }

  markRegistered(): void {
    this.pushRegistered = true;
    this.pushUnregisteredReason = undefined;
  }

  /** Meetings the bot is in with no session listening. See {@link MeetingRegistry.retained}. */
  retainedMeetings(): MeetingMembership[] {
    return this.registry.retained();
  }

  disposeAll(): void {
    this.registry.disposeAll();
  }

  // ─── entry points ───────────────────────────────────────

  /**
   * Put the bot in a meeting as a visible participant.
   *
   * Requires a live connection: this path depends on `meeting_activity_v1`
   * pushes, so without one the bot would join and then hear nothing at all —
   * failing loudly beats joining deaf.
   */
  async joinMeeting(meetingNo: string, opts: JoinMeetingOptions = {}): Promise<MeetingSession> {
    if (!this.deps.isConnected()) {
      throw new LarkChannelError(
        'not_connected',
        'joinMeeting needs the event connection for in-meeting activity — call connect() first',
      );
    }

    const existing = this.registry.findByMeetingNo(meetingNo, 'tat');
    if (existing) {
      this.deps.logger.debug?.('meeting: already in this meeting, reusing the session', {
        meetingId: existing.meetingId,
      });
      return existing;
    }

    // Overlapping calls share one join rather than racing to replace each other.
    const inFlight = this.joining.get(meetingNo);
    if (inFlight) return inFlight;

    this.registry.assertCanJoin(meetingNo);
    const attempt = this.performJoin(meetingNo, opts).finally(() => {
      this.joining.delete(meetingNo);
    });
    this.joining.set(meetingNo, attempt);
    return attempt;
  }

  private async performJoin(meetingNo: string, opts: JoinMeetingOptions): Promise<MeetingSession> {
    const meeting = await this.callJoin(meetingNo, opts);
    const meetingId = meeting?.id;
    if (!meetingId) {
      throw new LarkChannelError('meeting_not_found', 'bots/join returned no meeting id');
    }

    this.registry.addMembership(meetingId, meeting.meeting_no ?? meetingNo);
    return this.startSession({
      meetingId,
      meetingNo: meeting.meeting_no ?? meetingNo,
      topic: meeting.topic,
      mode: 'tat',
      stabilizeMs: opts.stabilizeMs ?? 0,
    });
  }

  /**
   * Follow the meeting the token's owner is currently in, without joining it.
   *
   * Deliberately does not require `connect()`: this path is REST polling only, so
   * demanding a WebSocket would be pure overhead for an app that never touches
   * the IM side.
   */
  async followMyMeeting(opts: FollowMeetingOptions): Promise<MeetingSession> {
    // Normalized to a provider immediately: a raw string handed further down would
    // become an enumerable property on the session and its poll loop.
    const token = toTokenProvider(opts.userAccessToken);

    const meetings = await this.listActiveMeetings(token);
    const chosen = opts.meetingNo
      ? meetings.find((m) => m.meeting_no === opts.meetingNo)
      : meetings[0];

    if (!chosen?.meeting_id) {
      throw new LarkChannelError(
        'meeting_not_found',
        opts.meetingNo
          ? 'the requested meeting is not among the active meetings'
          : 'no active meeting to follow',
      );
    }

    if (!opts.meetingNo && meetings.length > 1) {
      // No titles: they are free text from whoever created the meeting, and one
      // containing newlines can forge log lines. No meeting numbers for the
      // meetings we are *not* following either — for a meeting without a password
      // the number is itself the credential to join it, and the caller did not ask
      // about those. Only the followed one's number is echoed back.
      this.deps.logger.warn?.('meeting: several active meetings, following the first', {
        followedMeetingNo: chosen.meeting_no,
        otherActiveCount: meetings.length - 1,
      });
    }

    return this.startSession({
      meetingId: chosen.meeting_id,
      meetingNo: chosen.meeting_no ?? '',
      topic: chosen.meeting_title,
      mode: 'uat',
      stabilizeMs: opts.stabilizeMs ?? 0,
      token,
    });
  }

  // ─── dispatcher ─────────────────────────────────────────

  /**
   * The three `vc.bot.*` handlers the channel registers internally.
   *
   * Each is guarded, matching how the IM built-ins are written. The failure that
   * matters is the documented one: the `meetingInvited` handler is *supposed* to
   * call `joinMeeting()`, which rejects on `too_many_sessions` /
   * `permission_denied` / `not_connected` — unguarded, that becomes an unhandled
   * rejection at the transport instead of reaching `channel.on('error')`.
   */
  handlers(): Record<string, (raw: unknown) => Promise<unknown>> {
    return {
      'vc.bot.meeting_invited_v1': (raw) =>
        this.guard(async () => {
          const handler = this.deps.invitedHandler();
          if (handler) await handler(toInvitedEvent(raw, this.deps.includeRaw));
        }),

      'vc.bot.meeting_activity_v1': (raw) => this.guard(() => this.registry.route(raw)),

      'vc.bot.meeting_ended_v1': (raw) =>
        this.guard(async () => {
          const meetingId = asString(readMeeting(raw)?.id);
          await this.registry.get(meetingId ?? '')?.endedByPlatform();
        }),
    };
  }

  /** Route a handler failure to the channel's `error` event, never to the transport. */
  private async guard(run: () => Promise<void>): Promise<undefined> {
    try {
      await run();
    } catch (err) {
      this.deps.onError(meetingError(err));
    }
    return undefined;
  }

  // ─── internals ──────────────────────────────────────────

  private async callJoin(
    meetingNo: string,
    opts: JoinMeetingOptions,
  ): Promise<{ id?: string; meeting_no?: string; topic?: string } | undefined> {
    try {
      const res = await this.deps.client.vc.v1.bot.join({
        data: {
          join_type: JOIN_TYPE_BY_MEETING_NO,
          join_identify: { meeting_no: meetingNo },
          ...(opts.password ? { password: opts.password } : {}),
          ...(opts.callId ? { call_id: opts.callId } : {}),
        },
      });
      return res?.data?.meeting;
    } catch (err) {
      // "Sent, but no usable answer" is the shape that leaves orphan participants
      // behind — not just the two timeout error codes. See `isInconclusiveFailure`.
      if (isInconclusiveFailure(err)) this.warnAboutInconclusiveJoin(meetingNo);
      throw meetingError(err);
    }
  }

  /**
   * A join whose outcome is unknown may well have succeeded server-side, leaving a
   * participant with no local handle — a bot visible in a meeting that nothing is
   * listening to, until the meeting ends.
   *
   * Nothing can be done about it automatically, and this used to try. The long
   * meeting id was in the response that never arrived, so the only handle available
   * is the meeting number — and `bots/leave` was observed to reject one outright
   * (HTTP 400, `121105 meeting not exist`). Issuing that call was therefore a request
   * guaranteed to fail, on a path that had already failed. So this warns and stops:
   * reclaiming the orphan needs an operator, or the meeting ending on its own.
   */
  private warnAboutInconclusiveJoin(meetingNo: string): void {
    this.deps.logger.warn?.(
      'meeting: join outcome unknown — the bot may be a participant with no session, ' +
        'and cannot be removed automatically (bots/leave needs the long meeting id, ' +
        'which never arrived)',
      { meetingNo },
    );
  }

  private async listActiveMeetings(
    token: UserTokenProvider,
  ): Promise<Array<{ meeting_id?: string; meeting_no?: string; meeting_title?: string }>> {
    try {
      const res = await this.deps.client.vc.v1.bot.userActiveMeeting(
        { params: { user_id_type: 'open_id' } },
        withUserAccessToken(await token()),
      );
      return res?.data?.meetings ?? [];
    } catch (err) {
      throw meetingError(err);
    }
  }

  private startSession(spec: {
    meetingId: string;
    meetingNo: string;
    topic?: string;
    mode: 'uat' | 'tat';
    stabilizeMs: number;
    token?: UserTokenProvider;
  }): MeetingSession {
    const session = new LiveMeetingSession({
      client: this.deps.client,
      logger: this.deps.logger,
      meetingId: spec.meetingId,
      meetingNo: spec.meetingNo,
      topic: spec.topic,
      mode: spec.mode,
      config: this.config,
      dedup: this.dedup,
      includeRaw: this.deps.includeRaw,
      botOpenId: this.deps.botOpenId,
      stabilizeMs: spec.stabilizeMs,
      token: spec.token,
      recordHealth: (link, type, count, opts) => this.linkHealth[link].record(type, count, opts),
      onEnded: (s) => this.registry.remove(s),
      onMembershipReleased: () => this.registry.releaseMembership(spec.meetingId),
    });

    this.registry.add(session);
    session.start();
    return session;
  }
}

// ─────────────────────────────────────────────────────────────

function stripUndefined(config?: MeetingChannelConfig): Partial<ResolvedMeetingConfig> {
  if (!config) return {};
  return Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined),
  ) as Partial<ResolvedMeetingConfig>;
}

function readMeeting(raw: unknown): Record<string, unknown> | undefined {
  return asDict((raw as { meeting?: unknown } | undefined)?.meeting);
}

function toInvitedEvent(raw: unknown, includeRaw: boolean): MeetingInvitedEvent {
  const event = (asDict(raw) ?? {}) as Record<string, unknown>;
  const meeting = readMeeting(raw);
  return {
    meetingNo: asString(meeting?.meeting_no) ?? '',
    meetingId: asString(meeting?.id),
    topic: asString(meeting?.topic),
    inviter: readActor({ operator: event.inviter }),
    bot: readActor({ operator: event.bot }),
    callId: asString(event.call_id),
    inviteTime: asMs(event.invite_time),
    ...(includeRaw ? { raw } : {}),
  };
}

export type { LiveMeetingSession };
