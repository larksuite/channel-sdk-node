/**
 * A sliding one-minute window over outbound in-meeting messages.
 *
 * The bot's own messages come back as `chat_received`, so a handler that replies without
 * checking `selfEcho` answers itself at network speed. This bounds the damage.
 */

const WINDOW_MS = 60_000;

export class SendRateLimiter {
  private readonly sentAt: number[] = [];

  constructor(private readonly maxPerMinute: number) {}

  /** Consume one slot, or report that the window is full. */
  tryAcquire(): boolean {
    const cutoff = Date.now() - WINDOW_MS;
    while (this.sentAt.length > 0 && this.sentAt[0] <= cutoff) this.sentAt.shift();

    if (this.sentAt.length >= this.maxPerMinute) return false;
    this.sentAt.push(Date.now());
    return true;
  }
}
