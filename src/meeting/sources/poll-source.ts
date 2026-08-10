/**
 * The follow-mode (user identity) event source.
 *
 * Two loops ride the same user access token: `bot.events` for activity, and
 * `userActiveMeeting` to notice the meeting has ended, since the follow path gets no end
 * event. A rejected credential must stop both — stopping one leaves the other retrying
 * forever with nothing to stop it.
 *
 * Empty rounds and failed rounds back off on separate counters, per loop. Sharing the
 * empty-poll counter would cap failures at its ceiling, and a rejected token retried
 * every ten seconds means thousands of authentication attempts an hour — against the
 * caller's own auth service, since the token provider is theirs.
 */

import { type Client, withUserAccessToken } from '@larksuiteoapi/node-sdk';
import type { Logger } from '../../internal';
import type { LarkChannelError } from '../../types';
import type { Cursor } from '../cursor';
import { isRetryableMeetingError, meetingError } from '../errors';
import { readPollActivities } from '../normalize';
import type { UserTokenProvider } from '../token';
import type { MeetingSourceCallbacks } from './types';

const EMPTY_BASE_MS = 3_000;
const EMPTY_MAX_MS = 10_000;
const FAILURE_MAX_MS = 60_000;

/** Consecutive failures to absorb before giving up — roughly eight minutes at the backoff above. */
const MAX_CONSECUTIVE_FAILURES = 12;

/** How often to re-check that the followed meeting is still active. */
const END_CHECK_INTERVAL_MS = 30_000;

const PAGE_SIZE = 100;

/**
 * Back-to-back drain rounds allowed before pacing resumes. `has_more` drives an unpaced
 * loop, so a server that keeps saying "more" would otherwise spin flat out.
 */
const MAX_DRAIN_ROUNDS = 20;

/** One loop's failure schedule; independent instances so the loops cannot exhaust each other. */
class FailureBackoff {
  private rounds = 0;

  reset(): void {
    this.rounds = 0;
  }

  /** The next delay, or `null` when this loop has failed too many times running. */
  next(): number | null {
    this.rounds++;
    if (this.rounds >= MAX_CONSECUTIVE_FAILURES) return null;
    return Math.min(EMPTY_BASE_MS * 2 ** (this.rounds - 1), FAILURE_MAX_MS);
  }
}

export interface PollSourceOptions {
  client: Client;
  logger: Logger;
  meetingId: string;
  /** Always a provider, never a raw string — see `meeting/token.ts`. */
  token: UserTokenProvider;
  cursor: Cursor;
  callbacks: MeetingSourceCallbacks;
}

export class PollSource {
  private emptyRounds = 0;
  private drainRounds = 0;
  private readonly pollFailures = new FailureBackoff();
  private readonly endCheckFailures = new FailureBackoff();
  private pollTimer?: NodeJS.Timeout;
  private endCheckTimer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly opts: PollSourceOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedulePoll(0);
    this.scheduleEndCheck(END_CHECK_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.endCheckTimer) clearTimeout(this.endCheckTimer);
    this.pollTimer = undefined;
    this.endCheckTimer = undefined;
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private scheduleEndCheck(delayMs: number): void {
    if (!this.running) return;
    this.endCheckTimer = setTimeout(() => {
      void this.checkStillActive();
    }, delayMs);
    this.endCheckTimer.unref?.();
  }

  // ─── activity loop ──────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const { activities, hasMore } = await this.fetchActivities();
      this.pollFailures.reset();

      for (const activity of activities) {
        if (!this.running) return;
        await this.opts.callbacks.onActivity(activity);
      }

      this.schedulePoll(this.nextPollDelay(activities.length > 0, hasMore));
    } catch (err) {
      this.handleFailure(
        meetingError(err, { meetingId: this.opts.meetingId }),
        this.pollFailures,
        (delay) => this.schedulePoll(delay),
      );
    }
  }

  private async fetchActivities() {
    const cursorValue = this.opts.cursor.get();
    const res = await this.opts.client.vc.v1.bot.events(
      {
        params: {
          meeting_id: this.opts.meetingId,
          page_size: PAGE_SIZE,
          // Always open_id: any other convention would put actor ids in a
          // different namespace from the bot's own, silently breaking selfEcho.
          user_id_type: 'open_id',
          ...(cursorValue ? { page_token: cursorValue } : {}),
        },
      },
      withUserAccessToken(await this.opts.token()),
    );
    this.opts.cursor.set(res?.data?.page_token ?? cursorValue);
    return { activities: readPollActivities(res?.data), hasMore: res?.data?.has_more === true };
  }

  /**
   * A backlog drains at full speed; an idle meeting backs off. Pacing a backlog would
   * make a busy meeting arrive minutes late, one page at a time.
   */
  private nextPollDelay(hadActivity: boolean, hasMore: boolean): number {
    if (hasMore && this.drainRounds < MAX_DRAIN_ROUNDS) {
      this.drainRounds++;
      return 0;
    }
    this.drainRounds = 0;
    if (hadActivity) {
      this.emptyRounds = 0;
      return EMPTY_BASE_MS;
    }
    const delay = Math.min(EMPTY_BASE_MS * 2 ** this.emptyRounds, EMPTY_MAX_MS);
    this.emptyRounds++;
    return delay;
  }

  // ─── end-of-meeting loop ────────────────────────────────

  /**
   * The follow path has no end event, so absence from the active list is the
   * signal. Fails open: only a successful response that omits this meeting ends
   * the session, because a failed request means "unknown", and probes across
   * sessions fail together.
   */
  private async checkStillActive(): Promise<void> {
    if (!this.running) return;

    try {
      const res = await this.opts.client.vc.v1.bot.userActiveMeeting(
        { params: { user_id_type: 'open_id' } },
        withUserAccessToken(await this.opts.token()),
      );
      this.endCheckFailures.reset();

      const meetings = res?.data?.meetings;
      if (Array.isArray(meetings) && !meetings.some((m) => m?.meeting_id === this.opts.meetingId)) {
        this.stop();
        this.opts.callbacks.onNoLongerActive();
        return;
      }
      this.scheduleEndCheck(END_CHECK_INTERVAL_MS);
    } catch (err) {
      this.handleFailure(
        meetingError(err, { meetingId: this.opts.meetingId }),
        this.endCheckFailures,
        (delay) => this.scheduleEndCheck(delay),
        // Exhausting this loop must not end the session: activity may be flowing
        // perfectly well, and these failures are correlated — one API, one 30s
        // cadence, often one user — so terminating here would end every follow
        // session in the same window, captions still streaming.
        { terminateOnExhaustion: false },
      );
    }
  }

  // ─── shared failure policy ──────────────────────────────

  /**
   * One policy for both loops. A rejected credential always terminates, since it is
   * shared; running out of retries only terminates for the loop carrying the session's
   * actual purpose.
   */
  private handleFailure(
    err: LarkChannelError,
    backoff: FailureBackoff,
    reschedule: (delayMs: number) => void,
    opts: { terminateOnExhaustion?: boolean } = {},
  ): void {
    if (!this.running) return;
    this.opts.callbacks.onError(err);

    // A rejected credential cannot be retried into working, and every retry is
    // another authentication attempt with a bad token.
    if (!isRetryableMeetingError(err)) {
      this.terminate(err);
      return;
    }

    const delay = backoff.next();
    if (delay !== null) {
      reschedule(delay);
      return;
    }

    if (opts.terminateOnExhaustion === false) {
      // Keep checking, just slowly: losing end-detection is better than ending a
      // session whose activity stream is healthy.
      reschedule(FAILURE_MAX_MS);
      return;
    }
    this.terminate(err);
  }

  private terminate(err: LarkChannelError): void {
    this.stop();
    this.opts.callbacks.onTerminate(err);
  }
}
