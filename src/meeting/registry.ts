/**
 * Admission, routing and reclamation for meeting sessions.
 *
 * Sessions are started from outside this process — anyone who can pull the bot into a
 * meeting starts one — so admission is refused *before* `bots/join` goes out, and never
 * after, which would park the bot in a meeting with nothing listening.
 *
 * The cap counts server-side membership rather than live objects: `disconnect()`
 * disposes sessions without leaving their meetings, so a counter watching local objects
 * would read zero while the bot is still a participant everywhere.
 */

import type { Logger } from '../internal';
import { LarkChannelError } from '../types';
import { readPushActivities } from './normalize';
import type { LiveMeetingSession } from './session';
import type { MeetingMembership } from './types';

/**
 * Keyed by mode as well as meeting id: one meeting can carry both an app-identity bot
 * and a user-identity follower, and a meeting-id-only key would silently replace one
 * with the other.
 */
function sessionKey(mode: 'uat' | 'tat', meetingId: string): string {
  return `${mode}:${meetingId}`;
}

export class MeetingRegistry {
  private readonly sessions = new Map<string, LiveMeetingSession>();
  /**
   * Meetings this process has joined and not left, session or no session, mapped to the
   * number `joinMeeting` takes — the id alone cannot be rejoined.
   */
  private readonly membership = new Map<string, string>();

  constructor(
    private readonly logger: Logger,
    private readonly maxConcurrentSessions: number,
  ) {}

  list(): LiveMeetingSession[] {
    return [...this.sessions.values()];
  }

  /** Push events and `meeting_ended_v1` are app-identity, so they route to tat. */
  get(meetingId: string): LiveMeetingSession | undefined {
    return this.sessions.get(sessionKey('tat', meetingId));
  }

  /**
   * Throws before any API call when the cap is reached.
   *
   * A meeting the bot is already in is exempt: after `disconnect()` the membership
   * outlives the session, and re-attaching to it takes no new slot. Without the
   * exemption a process at the cap could never recover the sessions it just disposed.
   */
  assertCanJoin(meetingNo?: string): void {
    if (meetingNo !== undefined && [...this.membership.values()].includes(meetingNo)) return;
    if (this.membership.size >= this.maxConcurrentSessions) {
      throw new LarkChannelError(
        'too_many_sessions',
        `already in ${this.membership.size} meetings (maxConcurrentSessions)`,
      );
    }
  }

  /** Record that the bot is now a participant, whether or not a session lives. */
  addMembership(meetingId: string, meetingNo: string): void {
    this.membership.set(meetingId, meetingNo);
  }

  /**
   * Meetings the bot is still in that have no live session — what `disconnect()` leaves
   * behind. Nothing routes their pushes and nothing can leave them until a caller
   * re-attaches, so this is the only way to find them again after losing the session
   * references.
   */
  retained(): MeetingMembership[] {
    return [...this.membership]
      .filter(([meetingId]) => !this.sessions.has(sessionKey('tat', meetingId)))
      .map(([meetingId, meetingNo]) => ({ meetingId, meetingNo }));
  }

  releaseMembership(meetingId: string): void {
    this.membership.delete(meetingId);
  }

  /**
   * Register a session, tearing down any predecessor under the same key.
   *
   * A replaced session would be unreachable but still running: not routed to, unable to
   * remove itself (its `onEnded` identity check no longer matches), invisible to
   * `disconnect()`, and for a follow session still polling with the caller's token.
   */
  add(session: LiveMeetingSession): void {
    const key = sessionKey(session.mode, session.meetingId);
    const previous = this.sessions.get(key);
    this.sessions.set(key, session);

    if (previous && previous !== session) {
      this.logger.warn?.('meeting: replacing an existing session for this meeting', {
        meetingId: session.meetingId,
        mode: session.mode,
      });
      previous.dispose();
    }
  }

  remove(session: LiveMeetingSession): void {
    const key = sessionKey(session.mode, session.meetingId);
    // Identity check: a replacement session must not be removed by its predecessor.
    if (this.sessions.get(key) === session) this.sessions.delete(key);
  }

  /**
   * Find a live session by meeting number — the only id `joinMeeting` is given.
   * Mode-scoped, because handing a follow session to a `joinMeeting` caller would give
   * them one whose `sendMessage` rejects.
   */
  findByMeetingNo(meetingNo: string, mode: 'uat' | 'tat'): LiveMeetingSession | undefined {
    return this.list().find((s) => s.meetingNo === meetingNo && s.mode === mode);
  }

  /**
   * Fan one `vc.bot.meeting_activity_v1` push out to the sessions it belongs to. The
   * push is app-level, so each activity is routed by its own `meeting.id`; activities
   * for meetings this process does not own are dropped at debug level.
   */
  async route(payload: unknown): Promise<void> {
    for (const activity of readPushActivities(payload)) {
      const session = activity.meetingId ? this.get(activity.meetingId) : undefined;
      if (!session) {
        this.logger.debug?.('meeting: activity for an unmanaged meeting', {
          meetingId: activity.meetingId,
          activityType: activity.activityType,
        });
        continue;
      }
      await session.deliver(activity, 'push');
    }
  }

  /**
   * Dispose every session without leaving any meeting. Membership is untouched: the
   * slots stay taken because the participants remain.
   */
  disposeAll(): void {
    for (const session of this.list()) session.dispose();
  }
}
