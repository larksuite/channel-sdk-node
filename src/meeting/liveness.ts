/**
 * Confirms a TAT session's bot is still in its meeting, and catches up on anything the
 * push stream dropped while doing it.
 *
 * `vc.bot.meeting_ended_v1` does not cover a host removing the bot or a meeting
 * changing hands, so this is the backstop for those.
 *
 * It reuses `bot.events` under the app identity, which needs no scope beyond the one
 * `bots/join` already requires. The same call is the push path's gap-recovery read:
 * whatever it returns is delivered and the shared cursor advances.
 *
 * Every verdict fails open. Probes across sessions share a cadence, so a probe failure
 * is correlated — one network blip, or one missing scope, hits every session in the
 * same tick. Reading "I could not tell" as "the bot has left" would end all of them at
 * once, while the opposite mistake is bounded by idle reclamation.
 */

import type { Client } from '@larksuiteoapi/node-sdk';
import type { Logger } from '../internal';
import type { Cursor } from './cursor';
import { classifyMeetingError } from './errors';
import type { RawActivity } from './normalize';
import { readPollActivities } from './normalize';

export type LivenessVerdict =
  /** The service answered and the bot is still in the meeting. */
  | 'active'
  /** The service answered and confirmed the bot is not in the meeting. */
  | 'gone'
  /** No usable answer. Never ends a session. */
  | 'unknown';

/**
 * Feishu codes that positively mean "this bot is not in that meeting".
 *
 * `120004` (HTTP 403, `msg: "bot is not in the meeting"`) was observed live — a
 * membership statement rather than an auth or quota one, which is what makes it safe to
 * act on. Not to be confused with `120003 user is not in the meeting`, the user
 * identity's equivalent, which the follow path sees. Anything unlisted reads as
 * inconclusive.
 */
export const NOT_IN_MEETING_CODES: ReadonlySet<number> = new Set([120004]);

export interface LivenessProbeOptions {
  client: Client;
  meetingId: string;
  logger: Logger;
  cursor?: Cursor;
  /** Deliver what the probe read, so the call doubles as gap recovery. */
  onActivities?: (activities: RawActivity[]) => Promise<void>;
}

export class LivenessProbe {
  constructor(private readonly opts: LivenessProbeOptions) {}

  /** Never throws: the caller has no failure branch to take. */
  async check(): Promise<LivenessVerdict> {
    const { client, meetingId, cursor, onActivities } = this.opts;
    try {
      const cursorValue = cursor?.get();
      const res = await client.vc.v1.bot.events({
        params: {
          meeting_id: meetingId,
          // Must be >= 20: smaller pages are rejected at field validation
          // (`99992402`), before membership is ever considered.
          page_size: 100,
          user_id_type: 'open_id',
          ...(cursorValue ? { page_token: cursorValue } : {}),
        },
      });

      cursor?.set(res?.data?.page_token ?? cursorValue);
      const activities = readPollActivities(res?.data);
      // Overlap with the push stream is expected; the session serializes delivery, so
      // the duplicate check suppresses it.
      if (activities.length > 0) await onActivities?.(activities);

      // A quiet meeting returns an empty list too, so it proves nothing either way.
      return activities.length > 0 ? 'active' : 'unknown';
    } catch (err) {
      return this.classifyFailure(err);
    }
  }

  private classifyFailure(err: unknown): LivenessVerdict {
    const feishuCode = (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    if (typeof feishuCode === 'number' && NOT_IN_MEETING_CODES.has(feishuCode)) return 'gone';

    // Probe failures are expected background noise.
    this.opts.logger.debug?.('meeting: liveness probe inconclusive', {
      meetingId: this.opts.meetingId,
      code: classifyMeetingError(err),
    });
    return 'unknown';
  }
}
