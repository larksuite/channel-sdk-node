import type { LarkChannelError } from '../../types';
import type { RawActivity } from '../normalize';

/**
 * What a polling event source reports back to its session.
 *
 * Only the follow path needs one: the app identity receives pushes, which the registry
 * routes straight into the session.
 */
export interface MeetingSourceCallbacks {
  /** Deliver one activity. Awaited, so ordering holds end to end. */
  onActivity: (activity: RawActivity) => Promise<void>;
  onError: (err: LarkChannelError) => void;
  /**
   * The source cannot continue, and the session must be fully reclaimed — nothing
   * else collects a follow-mode session, since idle timeout and probing are
   * app-identity only.
   */
  onTerminate: (err: LarkChannelError) => void;
  /** The meeting left the active list. */
  onNoLongerActive: () => void;
}
