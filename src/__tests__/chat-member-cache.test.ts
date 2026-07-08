/**
 * ChatMemberCache — roster name<->openId resolution.
 *
 * Backs `getChatMembers` (source 'api', authoritative users) and inbound
 * mention collection (source 'mention', incl. bots). It must:
 *   - resolve openId->name and name->openId,
 *   - treat a name that maps to >1 openId as AMBIGUOUS (unresolvable), never
 *     last-writer-wins, and never let a 'mention' entry silently replace
 *     an 'api' one,
 *   - expire per-chat entries after a TTL and cap the number of chats.
 *
 * For determinism the cache is expected to accept injectable options —
 * `now()` (clock), `ttlMs`, and `maxChats` — so time and capacity can be
 * driven from the test instead of wall-clock / internal constants.
 *
 */

import { ChatMemberCache } from '../chat-member-cache';

describe('resolveName / resolveOpenId', () => {
  test('resolves a known openId to its name and a known name to its openId', () => {
    const cache = new ChatMemberCache();
    cache.setMembers('c', [{ id: 'ou_a', name: 'Alice' }], 'api');
    expect(cache.resolveName('c', 'ou_a')).toBe('Alice');
    expect(cache.resolveOpenId('c', 'Alice')).toBe('ou_a');
  });

  test('unknown openId / name resolve to undefined', () => {
    const cache = new ChatMemberCache();
    cache.setMembers('c', [{ id: 'ou_a', name: 'Alice' }], 'api');
    expect(cache.resolveName('c', 'ou_missing')).toBeUndefined();
    expect(cache.resolveOpenId('c', 'Nobody')).toBeUndefined();
  });
});

describe('name collision', () => {
  test('one name mapping to two openIds becomes unresolvable, but openId->name still works', () => {
    const cache = new ChatMemberCache();
    cache.setMembers('c', [{ id: 'ou_a', name: 'Alice' }], 'api');
    cache.setMembers('c', [{ id: 'ou_x', name: 'Alice' }], 'mention');
    expect(cache.resolveOpenId('c', 'Alice')).toBeUndefined(); // AMBIGUOUS
    expect(cache.resolveName('c', 'ou_a')).toBe('Alice'); // byOpenId unaffected
  });
});

describe('source trust order', () => {
  test('a same-openId re-observation is not a conflict', () => {
    const cache = new ChatMemberCache();
    cache.setMembers('c', [{ id: 'ou_a', name: 'Alice' }], 'api');
    cache.setMembers('c', [{ id: 'ou_a', name: 'Alice' }], 'mention');
    expect(cache.resolveOpenId('c', 'Alice')).toBe('ou_a');
  });

  test('a mention with a different openId turns the name ambiguous, api entry not silently replaced', () => {
    const cache = new ChatMemberCache();
    cache.setMembers('c', [{ id: 'ou_a', name: 'Alice' }], 'api');
    cache.setMembers('c', [{ id: 'ou_x', name: 'Alice' }], 'mention');
    expect(cache.resolveOpenId('c', 'Alice')).toBeUndefined();
    expect(cache.resolveName('c', 'ou_a')).toBe('Alice');
  });
});

describe('TTL', () => {
  test('entries expire once the injected clock passes the TTL', () => {
    let clock = 0;
    const ttlMs = 5 * 60_000;
    const cache = new ChatMemberCache({ now: () => clock, ttlMs });
    cache.setMembers('c', [{ id: 'ou_a', name: 'Alice' }], 'api');
    expect(cache.resolveName('c', 'ou_a')).toBe('Alice');

    clock = ttlMs + 1; // advance past the TTL deterministically
    expect(cache.resolveName('c', 'ou_a')).toBeUndefined();
    expect(cache.resolveOpenId('c', 'Alice')).toBeUndefined();
  });
});

describe('capacity', () => {
  test('the oldest chat is evicted once the chat cap is exceeded', () => {
    const cache = new ChatMemberCache({ maxChats: 2 });
    cache.setMembers('c1', [{ id: 'ou_1', name: 'A' }], 'api');
    cache.setMembers('c2', [{ id: 'ou_2', name: 'B' }], 'api');
    cache.setMembers('c3', [{ id: 'ou_3', name: 'C' }], 'api'); // evicts c1

    expect(cache.resolveName('c1', 'ou_1')).toBeUndefined();
    expect(cache.resolveName('c3', 'ou_3')).toBe('C');
  });
});
