import type { MentionInfo } from '../../types';
import { escapeAtName, isValidOpenId } from './compose-mentions';

/**
 * Resolve a display name to an openId, or `undefined` when the name is unknown
 * or ambiguous. Backed by the chat's roster at the call site.
 */
export type MentionLookup = (name: string) => string | undefined;

/**
 * Fill `openId` on name-only structured mentions from the roster. Entries that
 * already carry an openId pass through untouched; name-only entries that don't
 * resolve (unknown / ambiguous) are dropped rather than sent with a wrong or
 * missing id.
 */
export function resolveNameMentions(mentions: MentionInfo[], lookup: MentionLookup): MentionInfo[] {
  const out: MentionInfo[] = [];
  for (const m of mentions) {
    if (m.openId) {
      out.push(m);
      continue;
    }
    if (!m.name) continue;
    const openId = lookup(m.name);
    if (openId) out.push({ ...m, openId });
  }
  return out;
}

// Longest candidate name to try after an `@`: bounded words and characters so
// the scan stays linear on hostile input — a 50k-char token yields one
// bounded window, not a quadratic prefix walk.
const MAX_NAME_WORDS = 5;
const MAX_NAME_CHARS = 64;
const TRAILING_PUNCTUATION = /[.,!?;:)\]}]+$/;

interface NameMatch {
  name: string;
  openId: string;
  /** Length of the consumed name text (excluding the leading `@`). */
  length: number;
}

/**
 * Rewrite plaintext `@<name>` tokens into real `<at>` tags when the name
 * resolves against the roster. Unknown or ambiguous names are left verbatim
 * (syntax fallback) — an `@xxx` that doesn't resolve is never turned into a
 * mention. Resolution is longest-match-first (so a multi-word `@John Smith`
 * resolves ahead of `@John`), using per-candidate Map lookups rather than a
 * roster-name-derived regex, so it stays linear even on pathological input.
 */
export function resolveMentionsInText(text: string, lookup: MentionLookup): string {
  if (!text.includes('@')) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, at);
    // An `@` mid-word (e.g. inside an email `a@b`) is not a mention.
    const startsToken = at === 0 || /\s/.test(text[at - 1]);
    const match = startsToken ? matchNameAt(text, at + 1, lookup) : undefined;
    if (match) {
      out += `<at user_id="${match.openId}">${escapeAtName(match.name)}</at>`;
      i = at + 1 + match.length;
    } else {
      out += '@';
      i = at + 1;
    }
  }
  return out;
}

/** Longest resolvable name starting at `start`, or `undefined`. */
function matchNameAt(text: string, start: number, lookup: MentionLookup): NameMatch | undefined {
  const window = text.slice(start, start + MAX_NAME_CHARS);
  for (const candidate of candidatePrefixes(window)) {
    const direct = lookup(candidate);
    if (isValidOpenId(direct)) return { name: candidate, openId: direct, length: candidate.length };
    const trimmed = candidate.replace(TRAILING_PUNCTUATION, '');
    if (trimmed !== candidate) {
      const t = lookup(trimmed);
      if (isValidOpenId(t)) return { name: trimmed, openId: t, length: trimmed.length };
    }
  }
  return undefined;
}

/** Word-boundary prefixes of `window`, longest first (up to MAX_NAME_WORDS). */
function candidatePrefixes(window: string): string[] {
  if (!window || /^\s/.test(window)) return [];
  const wordEnds: number[] = [];
  let inWord = false;
  for (let k = 0; k < window.length; k++) {
    const isSpace = /\s/.test(window[k]);
    if (!isSpace) {
      inWord = true;
    } else if (inWord) {
      wordEnds.push(k);
      inWord = false;
      if (wordEnds.length >= MAX_NAME_WORDS) break;
    }
  }
  if (inWord && wordEnds.length < MAX_NAME_WORDS) wordEnds.push(window.length);
  return wordEnds.map((end) => window.slice(0, end)).reverse();
}
