/**
 * Coercions for platform payloads.
 *
 * Every field on the wire is optional, and timestamps and durations arrive as
 * decimal strings rather than numbers. Shared so the unpacking path and the
 * channel entry points cannot drift into two slightly different readings of the
 * same value.
 */

export type Dict = Record<string, unknown>;

export function asDict(v: unknown): Dict | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Dict) : undefined;
}

/** Only object entries survive: a stray scalar in an item array is not an item. */
export function asArray(v: unknown): Dict[] {
  return Array.isArray(v) ? (v.filter((x) => asDict(x) !== undefined) as Dict[]) : [];
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

export function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** Milliseconds, whether they arrive as a number or a decimal string. */
export function asMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || v.length === 0) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}
