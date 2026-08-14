/**
 * One meeting, as the caller sees it.
 *
 * Three invariants shape this file.
 *
 * Teardown never depends on an API call succeeding: `bots/leave` is most likely to fail
 * exactly when a meeting has just ended, which is the ordinary end of every meeting.
 *
 * Ending the session and giving up the bot's seat are separate steps. `dispose()` ends
 * without leaving, so a reconnect does not evict the bot; `leave()` gives up the seat and
 * stays callable after the session has ended.
 *
 * Delivery is strictly ordered and handlers are awaited, because array position carries
 * meaning — a share hand-off arrives as an `ended` followed by a `started` in one
 * delivery. A slow handler therefore holds up the stream.
 */

import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { Logger } from '../internal';
import { LarkChannelError } from '../types';
import { type Cursor, createCursor } from './cursor';
import type { MeetingDedup } from './dedup';
import { meetingError } from './errors';
import { MeetingHealth, type MeetingLink } from './health';
import { LivenessProbe } from './liveness';
import { normalizeActivity, type RawActivity } from './normalize';
import { SendRateLimiter } from './rate-limit';
import { SerialQueue } from './serial-queue';
import { PollSource } from './sources/poll-source';
import { TranscriptStabilizer } from './stabilizer';
import type { UserTokenProvider } from './token';
import type {
  MeetingActivityStats,
  MeetingEndReason,
  MeetingEventMap,
  MeetingEventName,
  MeetingSession,
  MeetingTranscriptEvent,
  Unsubscribe,
} from './types';

export interface ResolvedMeetingConfig {
  maxConcurrentSessions: number;
  idleTimeoutMs: number;
  livenessProbeIntervalMs: number;
  sendRateLimitPerMinute: number;
}

/** Same shape as {@link MeetingHealth.record}, plus the link the activity arrived over. */
export type RecordActivity = (
  link: MeetingLink,
  activityType: string,
  itemCount: number,
  opts?: { forwardCompatible?: boolean },
) => void;

export interface MeetingSessionDeps {
  client: Client;
  logger: Logger;
  meetingId: string;
  meetingNo: string;
  topic?: string;
  mode: 'uat' | 'tat';
  config: ResolvedMeetingConfig;
  dedup: MeetingDedup;
  includeRaw: boolean;
  /** Resolved late: the bot's own id is not known until the channel connects. */
  botOpenId: () => string | undefined;
  stabilizeMs: number;
  /** Follow mode only, and always a provider so no token becomes a property. */
  token?: UserTokenProvider;
  /** Channel-wide counters, alongside this session's own. */
  recordHealth: RecordActivity;
  /** Drop this session from the registry. */
  onEnded: (session: LiveMeetingSession) => void;
  /** Give back the concurrency slot. Only when the bot is really out. */
  onMembershipReleased: () => void;
}

export class LiveMeetingSession implements MeetingSession {
  readonly meetingId: string;
  readonly meetingNo: string;
  readonly topic?: string;
  readonly mode: 'uat' | 'tat';

  /**
   * Replaceable on purpose: the wire signal for "not in this meeting" has not
   * been observed yet, so this is the one seam where that classification lives.
   */
  liveness?: LivenessProbe;

  private readonly handlers = new Map<MeetingEventName, Set<(payload: never) => unknown>>();
  private readonly health = new MeetingHealth();
  private readonly rateLimiter: SendRateLimiter;
  private readonly stabilizer: TranscriptStabilizer;
  /** Shared by the poll loop and the liveness probe — see {@link Cursor}. */
  private readonly cursor: Cursor = createCursor();
  private source?: PollSource;
  private idleTimer?: NodeJS.Timeout;
  private probeTimer?: NodeJS.Timeout;
  private ended = false;
  /** The bot is a participant of this meeting and the slot is still taken. */
  private membershipHeld: boolean;
  /**
   * Serializes everything the caller observes: two producers feed a session, so this is
   * what keeps ordering true across both and the duplicate check atomic.
   */
  private readonly queue = new SerialQueue();

  constructor(private readonly deps: MeetingSessionDeps) {
    this.meetingId = deps.meetingId;
    this.meetingNo = deps.meetingNo;
    this.topic = deps.topic;
    this.mode = deps.mode;
    this.membershipHeld = deps.mode === 'tat';
    this.rateLimiter = new SendRateLimiter(deps.config.sendRateLimitPerMinute);
    this.stabilizer = new TranscriptStabilizer({
      stabilizeMs: deps.stabilizeMs,
      onFlush: (event) => {
        void this.queue.run(() => this.emit('transcript', event));
      },
    });
  }

  /** Begin whatever this mode needs: a poll loop, or timers around the push feed. */
  start(): void {
    if (this.mode === 'uat') {
      this.startPolling();
      return;
    }

    if (this.deps.config.livenessProbeIntervalMs > 0) {
      this.liveness = new LivenessProbe({
        client: this.deps.client,
        meetingId: this.meetingId,
        logger: this.deps.logger,
        cursor: this.cursor,
        // The probe's read is also the push path's gap recovery: whatever it
        // pulled is delivered rather than discarded.
        onActivities: async (activities) => {
          // Recovered over REST, so it counts as poll even on an app-identity session.
          for (const activity of activities) await this.deliver(activity, 'poll');
        },
      });
      this.scheduleProbe();
    }
    this.resetIdleTimer();
  }

  private startPolling(): void {
    const token = this.deps.token;
    if (!token) throw new LarkChannelError('format_error', 'follow mode requires a token provider');

    this.source = new PollSource({
      client: this.deps.client,
      logger: this.deps.logger,
      meetingId: this.meetingId,
      token,
      cursor: this.cursor,
      callbacks: {
        onActivity: (activity) => this.deliver(activity, 'poll'),
        onError: (err) => this.emitError(err),
        onTerminate: () => {
          this.endOnce('error');
        },
        onNoLongerActive: () => {
          this.endOnce('no_longer_active');
        },
      },
    });
    this.source.start();
  }

  // ─── subscription ───────────────────────────────────────

  on<K extends MeetingEventName>(name: K, handler: MeetingEventMap[K]): Unsubscribe {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    const fn = handler as (payload: never) => unknown;
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  // ─── inbound ────────────────────────────────────────────

  /**
   * Unpack one activity and hand its items to the caller in order. Health is counted
   * before dedup, since a suppressed duplicate did arrive.
   */
  async deliver(activity: RawActivity, link: MeetingLink): Promise<void> {
    return this.queue.run(() => this.deliverNow(activity, link));
  }

  private async deliverNow(activity: RawActivity, link: MeetingLink): Promise<void> {
    if (this.ended) return;

    const { events, forwardCompatible } = normalizeActivity(activity, {
      meetingId: this.meetingId,
      mode: this.mode,
      botOpenId: this.deps.botOpenId(),
      includeRaw: this.deps.includeRaw,
    });

    this.health.record(activity.activityType, events.length, { forwardCompatible });
    this.deps.recordHealth(link, activity.activityType, events.length, { forwardCompatible });
    this.resetIdleTimer();

    // Scoped per session, not per meeting: a follower and an in-meeting bot can
    // both be watching this meeting through the same endpoint.
    if (await this.deps.dedup.isDuplicate(activity, `${this.mode}:${this.meetingId}`)) return;

    for (const { name, event } of events) {
      if (this.ended) return;
      if (name === 'transcript' && this.deps.stabilizeMs > 0) {
        // Settling is out-of-band by definition, so the caller already accepted
        // relaxed ordering across sentences by setting a window.
        this.stabilizer.push(event as MeetingTranscriptEvent);
        continue;
      }
      await this.emit(name, event);
    }
  }

  getStats(): Record<string, MeetingActivityStats> {
    return this.health.stats();
  }

  // ─── logging representation ─────────────────────────────

  /**
   * A small representation for logging: without it both `JSON.stringify` and
   * `util.inspect` walk into the SDK `Client`, which is circular.
   */
  toJSON(): object {
    return this.describe();
  }

  [inspect.custom](): object {
    return this.describe();
  }

  private describe(): object {
    return {
      meetingId: this.meetingId,
      meetingNo: this.meetingNo,
      topic: this.topic,
      mode: this.mode,
      ended: this.ended,
    };
  }

  // ─── outbound ───────────────────────────────────────────

  /**
   * Post a text message into the meeting chat.
   *
   * `content` goes out as plain text, unlike IM: `im.v1.message.create` wants a JSON
   * string (`'{"text":"hi"}'`), while `vc.v1.bot.message` displays whatever it is given
   * verbatim, so the IM encoding would show up as a JSON literal in the meeting. Any
   * future `msg_type` here must have its own encoding confirmed against a live meeting —
   * the generated types say only `content?: string`.
   */
  async sendMessage(text: string): Promise<void> {
    if (this.mode !== 'tat') {
      throw new LarkChannelError(
        'not_supported',
        'sendMessage requires the bot to be in the meeting; follow mode cannot post',
      );
    }
    if (this.ended) {
      throw new LarkChannelError('not_supported', 'this meeting session has already ended');
    }
    if (!this.rateLimiter.tryAcquire()) {
      throw new LarkChannelError(
        'rate_limited',
        'in-meeting message rate limit exceeded for this session',
      );
    }

    try {
      await this.deps.client.vc.v1.bot.message({
        data: {
          meeting_id: this.meetingId,
          msg_type: 'text',
          content: text,
          uuid: randomUUID(),
        },
      });
    } catch (err) {
      throw meetingError(err, { meetingId: this.meetingId });
    }
  }

  // ─── teardown ───────────────────────────────────────────

  /**
   * End the session without leaving the meeting. Idempotent.
   *
   * The bot stays a participant, which is what makes a reconnect safe — and why a
   * process must still `leave()` before exiting.
   */
  dispose(): void {
    this.endOnce('disposed');
  }

  /**
   * Leave the meeting and give up the slot, then end the session. Idempotent, and
   * still effective after the session has already ended by another route.
   */
  async leave(): Promise<void> {
    this.endOnce('left');
    await this.giveUpSeat();
  }

  /** Reaction to `vc.bot.meeting_ended_v1`: end, then leave the meeting once. */
  async endedByPlatform(): Promise<void> {
    this.endOnce('meeting_ended');
    await this.giveUpSeat();
  }

  /**
   * Call `bots/leave` once and release the slot regardless of the outcome — released on
   * attempt, or a permanently failing leave would burn a slot for the life of the process.
   */
  private async giveUpSeat(): Promise<void> {
    if (!this.membershipHeld) return;
    this.membershipHeld = false;

    try {
      await this.deps.client.vc.v1.bot.leave({ data: { meeting_id: this.meetingId } });
    } catch (err) {
      this.emitError(meetingError(err, { meetingId: this.meetingId }));
    } finally {
      this.deps.onMembershipReleased();
    }
  }

  /** The bot is already out (the server said so), so release without calling. */
  private releaseSeatWithoutLeaving(): void {
    if (!this.membershipHeld) return;
    this.membershipHeld = false;
    this.deps.onMembershipReleased();
  }

  /**
   * Stop everything and announce the end, exactly once. Returns false when the session
   * had already ended, without preventing `leave()` from still giving up the seat.
   */
  private endOnce(reason: MeetingEndReason): boolean {
    if (this.ended) return false;
    this.ended = true;

    this.source?.stop();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.idleTimer = undefined;
    this.probeTimer = undefined;
    // Flushes pending captions rather than dropping them with the timers. Queued
    // onto the same chain as `end`, so a settled caption cannot arrive after it.
    this.stabilizer.dispose();

    this.deps.onEnded(this);
    void this.queue.run(() => this.emit('end', { meetingId: this.meetingId, reason }));
    return true;
  }

  // ─── timers ─────────────────────────────────────────────

  /** App-identity only: a follow session has its own end signal and a healthy poll loop. */
  private resetIdleTimer(): void {
    const { idleTimeoutMs } = this.deps.config;
    if (this.ended || this.mode !== 'tat' || idleTimeoutMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.reclaimIdle(), idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  /** Silent for too long: end, and hand the seat back rather than burning it. */
  private reclaimIdle(): void {
    if (!this.endOnce('idle_timeout')) return;
    void this.giveUpSeat();
  }

  private scheduleProbe(): void {
    if (this.ended) return;
    this.probeTimer = setTimeout(() => {
      void this.probe();
    }, this.deps.config.livenessProbeIntervalMs);
    this.probeTimer.unref?.();
  }

  /** Only a confirmed departure ends the session; see {@link LivenessProbe}. */
  private async probe(): Promise<void> {
    if (this.ended || !this.liveness) return;
    const verdict = await this.liveness.check();
    if (this.ended) return;

    if (verdict === 'gone') {
      if (this.endOnce('no_longer_active')) {
        // The server already confirmed the bot is out, so calling `bots/leave`
        // would be pointless — but the slot must still come back.
        this.releaseSeatWithoutLeaving();
      }
      return;
    }
    this.scheduleProbe();
  }

  // ─── emit ───────────────────────────────────────────────

  private async emit(name: MeetingEventName, payload: unknown): Promise<void> {
    const handlers = this.handlers.get(name);
    if (!handlers || handlers.size === 0) return;

    // Snapshot: a handler may unsubscribe during its own delivery.
    for (const handler of [...handlers]) {
      try {
        await (handler as (p: unknown) => unknown)(payload);
      } catch (err) {
        this.emitError(meetingError(err, { meetingId: this.meetingId }));
      }
    }
  }

  private emitError(err: LarkChannelError): void {
    const handlers = this.handlers.get('error');
    if (handlers && handlers.size > 0) {
      for (const handler of [...handlers]) {
        try {
          (handler as (p: unknown) => unknown)(err);
        } catch {
          // An error handler that throws has nowhere left to report to.
        }
      }
      return;
    }
    // Message body stays a constant: meeting content is participant-authored, and
    // interpolating it would let anyone in the meeting forge log lines.
    this.deps.logger.error?.('meeting: unhandled session error', {
      meetingId: this.meetingId,
      code: err.code,
      message: err.message,
      cause: err.cause,
    });
  }
}
