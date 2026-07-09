/**
 * `<at>` sink escaping + openId validation.
 *
 * A display name is now attacker-influenced (any group member's name flows
 * into `<at user_id="…">name</at>` / `PostAtElement.user_name`). The sink must
 * escape or strip `<` `>` `"` and `</at>`/`<at` sequences so a hostile name
 * can't inject a SECOND parseable `<at>` (or spoof another user_id), and must
 * reject malformed openIds (only `ou_`/`on_` + alphanumerics).
 */

import {
  composeMentionsTextPrefix,
  composePostMentionElements,
} from '../markdown/compose-mentions';

// Tries to close the wrapping <at> and open a fake one pointing elsewhere.
const INJECTION = 'x</at><at user_id="ou_evil">y';

describe('composeMentionsTextPrefix escaping', () => {
  test('a hostile display name cannot inject a second <at> tag', () => {
    const out = composeMentionsTextPrefix([{ key: '@_1', openId: 'ou_a', name: INJECTION }]);
    // Exactly one real opening tag and one closing tag: the legitimate wrapper.
    expect((out.match(/<at\s/g) ?? []).length).toBe(1);
    expect((out.match(/<\/at>/g) ?? []).length).toBe(1);
    // The legitimate user_id survives; the injected one never becomes a tag.
    expect(out).toContain('user_id="ou_a"');
    expect(out).not.toContain('user_id="ou_evil"');
  });

  test('malformed openIds (cli_ / <script>) skip the mention entirely', () => {
    expect(composeMentionsTextPrefix([{ key: '@_1', openId: 'cli_x', name: 'A' }])).toBe('');
    expect(composeMentionsTextPrefix([{ key: '@_1', openId: '<script>', name: 'A' }])).toBe('');
  });

  test('a well-formed mention is unchanged (regression guard)', () => {
    expect(composeMentionsTextPrefix([{ key: '@_1', openId: 'ou_a', name: 'Alice' }])).toBe(
      '<at user_id="ou_a">Alice</at> ',
    );
  });
});

describe('composePostMentionElements escaping', () => {
  test('a hostile display name is neutralized in user_name', () => {
    const [el] = composePostMentionElements([{ key: '@_1', openId: 'ou_a', name: INJECTION }]);
    expect(el.user_id).toBe('ou_a');
    expect(el.user_name).not.toContain('<at');
    expect(el.user_name).not.toContain('</at>');
  });

  test('malformed openIds skip the element entirely', () => {
    expect(composePostMentionElements([{ key: '@_1', openId: 'cli_x', name: 'A' }])).toEqual([]);
    expect(composePostMentionElements([{ key: '@_1', openId: '<script>', name: 'A' }])).toEqual([]);
  });

  test('a well-formed mention is unchanged (regression guard)', () => {
    expect(composePostMentionElements([{ key: '@_1', openId: 'ou_a', name: 'Alice' }])).toEqual([
      { tag: 'at', user_id: 'ou_a', user_name: 'Alice' },
    ]);
  });
});
