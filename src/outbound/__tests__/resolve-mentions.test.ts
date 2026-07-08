/**
 * @name -> open_id resolution + syntax fallback.
 *
 * Two pure resolvers back the outbound path:
 *   - resolveNameMentions: fill openId on name-only structured mentions via a
 *     roster lookup; drop the ones that don't resolve; keep entries that
 *     already carry an openId.
 *   - resolveMentionsInText: rewrite plaintext `@<name>` tokens into real
 *     `<at>` tags when the name resolves; leave unknown / ambiguous `@xxx`
 *     untouched (syntax fallback). Matching is Map-lookup based and any regex
 *     built from a roster name is escaped, so it stays linear on pathological
 *     input (no ReDoS).
 *
 * lookup(name) returns an openId, or undefined for unknown / ambiguous.
 */

import { resolveMentionsInText, resolveNameMentions } from '../markdown/resolve-mentions';

describe('resolveNameMentions', () => {
  test('fills openId on a name-only mention from the lookup', () => {
    const out = resolveNameMentions([{ key: '@_a', name: 'Alice' }], (n) =>
      n === 'Alice' ? 'ou_a' : undefined,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Alice', openId: 'ou_a' });
  });

  test('drops a name-only mention that does not resolve', () => {
    const out = resolveNameMentions([{ key: '@_b', name: 'Bob' }], () => undefined);
    expect(out).toEqual([]);
  });

  test('keeps a mention that already carries an openId', () => {
    const out = resolveNameMentions([{ key: '@_z', openId: 'ou_z', name: 'Zed' }], () => undefined);
    expect(out).toHaveLength(1);
    expect(out[0].openId).toBe('ou_z');
  });
});

describe('resolveMentionsInText', () => {
  const lookup = (n: string) => (n === 'Alice' ? 'ou_a' : undefined);

  test('rewrites a resolved @name into an <at> tag, keeps surrounding text', () => {
    const out = resolveMentionsInText('hi @Alice 上', lookup);
    expect(out).toContain('<at');
    expect(out).toContain('ou_a');
    expect(out).toContain('上');
    expect(out).not.toContain('@Alice'); // the plaintext token was consumed
  });

  test('leaves an unknown @name as plaintext', () => {
    const out = resolveMentionsInText('hi @Alice and @Ghost', lookup);
    expect(out).toContain('ou_a');
    expect(out).toContain('@Ghost');
  });

  test('an ambiguous name (lookup undefined) is left untouched', () => {
    const out = resolveMentionsInText('hi @Alice 上', () => undefined);
    expect(out).toBe('hi @Alice 上');
    expect(out).not.toContain('<at');
  });

  test('regex metacharacters in a name are matched literally, not as a pattern', () => {
    const name = 'a.*+?(){}[]|\\b';
    const out = resolveMentionsInText(`hi @${name} end`, (n) =>
      n === name ? 'ou_meta' : undefined,
    );
    expect(out).toContain('ou_meta');
    expect(out).not.toContain(`@${name}`);
  });

  test('pathological long input returns in bounded time (ReDoS guard, C3)', () => {
    const huge = `@${'a'.repeat(50_000)}`;
    const start = Date.now();
    const out = resolveMentionsInText(huge, () => undefined);
    expect(Date.now() - start).toBeLessThan(2000);
    // Unmatched: preserved verbatim, never rewritten, never hung.
    expect(out).toContain('a'.repeat(50_000));
  });
});
