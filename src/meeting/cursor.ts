/**
 * The `bot.events` page cursor, owned by the session.
 *
 * Both links read that endpoint — the follow path polls it, and the app path's probe
 * reuses it for gap recovery — so they share one cursor rather than each re-reading
 * what the other consumed.
 */
export interface Cursor {
  get(): string | undefined;
  /** Ignores `undefined`, so a response without a token cannot rewind. */
  set(value: string | undefined): void;
}

export function createCursor(): Cursor {
  let value: string | undefined;
  return {
    get: () => value,
    set: (next) => {
      value = next ?? value;
    },
  };
}
