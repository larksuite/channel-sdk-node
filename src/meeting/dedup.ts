/**
 * Duplicate suppression for in-meeting activity.
 *
 * Two keys per activity, because neither alone is enough. A delivery key catches the
 * same delivery arriving twice. A content key catches the overlap between the push
 * stream and the liveness probe's gap-recovery read — their delivery ids can never be
 * equal, since one is a platform id and the other is synthesised from the push
 * envelope plus a position.
 *
 * `sentence_id` is NOT a suppression key: a sentence is re-sent as the speaker keeps
 * talking, so keying on it freezes a caption at its first word, silently.
 */

import { createHash } from 'node:crypto';
import type { Cache } from '@larksuiteoapi/node-sdk';
import { SeenCache } from '../safety/dedup-cache';
import type { RawActivity } from './normalize';
import { readActor } from './normalize';

/** Its own namespace: sharing the IM path's would let either side suppress the other. */
const NAMESPACE = 'channel:meeting:seen';

/** Two keys per activity, so the window holds half as many activities. */
const MAX_ENTRIES = 10_000;

const DIGEST_LENGTH = 24;

export class MeetingDedup {
  private readonly seen: SeenCache;

  constructor(cache: Cache) {
    this.seen = new SeenCache(cache, { namespace: NAMESPACE, maxMemEntries: MAX_ENTRIES });
  }

  /**
   * True when this activity has already been delivered to `scope`.
   *
   * `scope` isolates sessions: one meeting can carry both an app-identity bot and a
   * user-identity follower, reading the same endpoint.
   */
  async isDuplicate(activity: RawActivity, scope: string): Promise<boolean> {
    const keys = [
      activity.eventId ? `${scope}|d|${activity.eventId}` : undefined,
      `${scope}|c|${contentKey(activity)}`,
    ].filter((k): k is string => k !== undefined);

    const hits = await Promise.all(keys.map((k) => this.seen.has(k)));
    if (hits.some(Boolean)) return true;

    await Promise.all(keys.map((k) => this.seen.add(k)));
    return false;
  }

  dispose(): void {
    this.seen.dispose();
  }
}

/** Digest over an explicit tuple, so a value containing the separator cannot fake one. */
function contentKey(activity: RawActivity): string {
  const parts = activity.items.map((item) => [
    item.sentence_id ?? item.message_id ?? item.share_id ?? null,
    item.text ?? item.content ?? null,
    item.start_time_ms ?? item.send_time ?? item.time ?? item.join_time ?? item.leave_time ?? null,
    readActor(item).id || null,
  ]);
  return createHash('sha256')
    .update(JSON.stringify([activity.activityType, parts]))
    .digest('base64url')
    .slice(0, DIGEST_LENGTH);
}
