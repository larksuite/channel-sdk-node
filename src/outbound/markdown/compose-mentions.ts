import type { MentionInfo } from '../../types';

const OPEN_ID = /^(ou_|on_)[A-Za-z0-9_-]+$/;

/** A well-formed Feishu open_id / union_id for use in an `<at user_id="…">`. */
export function isValidOpenId(id: string | undefined): id is string {
  return !!id && OPEN_ID.test(id);
}

/**
 * Neutralize a display name before it lands in an `<at>` tag body / `user_name`.
 * Display names are attacker-influenced (any group member sets their own), and
 * Feishu renders the `<at>` sink without escaping — a name containing `<`, `>`,
 * `"`, or a `</at>` / `<at` sequence could inject a second, forged mention (or
 * post markup) in the bot's own voice. We strip those characters rather than
 * HTML-encode, because the tag body is plain text to Feishu and encoded
 * entities would render literally.
 */
export function escapeAtName(name: string): string {
  return name.replace(/[<>"]/g, '');
}

/**
 * Build a text prefix that renders as real Feishu mentions when prepended
 * to a text-type outbound message (the <at …> tag form).
 *
 * For post-type messages, the mentions should be injected as `at` elements
 * at the beginning of the post body — use `composePostMentionElements`
 * instead.
 */
export function composeMentionsTextPrefix(mentions: MentionInfo[]): string {
  if (!mentions?.length) return '';
  const parts: string[] = [];
  for (const m of mentions) {
    if (!isValidOpenId(m.openId)) continue;
    parts.push(`<at user_id="${m.openId}">${escapeAtName(m.name ?? '')}</at>`);
  }
  return parts.length > 0 ? parts.join(' ') + ' ' : '';
}

export interface PostAtElement {
  tag: 'at';
  user_id: string;
  user_name?: string;
}

/**
 * Produce `at` elements to prepend to the first paragraph of a post body.
 */
export function composePostMentionElements(mentions: MentionInfo[]): PostAtElement[] {
  if (!mentions?.length) return [];
  const out: PostAtElement[] = [];
  for (const m of mentions) {
    if (!isValidOpenId(m.openId)) continue;
    out.push({
      tag: 'at',
      user_id: m.openId,
      user_name: m.name ? escapeAtName(m.name) : undefined,
    });
  }
  return out;
}
