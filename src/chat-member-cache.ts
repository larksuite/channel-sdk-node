import type { ChatMember } from './types';

/**
 * Per-chat roster cache backing these consumers: `getChatMembers` (source
 * 'api', authoritative users), `getChatBots` (source 'api', authoritative
 * bots), inbound mention collection (source 'mention', can carry bots),
 * `senderName` resolution and "@name → open_id" normalization.
 *
 * Two safety invariants:
 *   - A display name that maps to more than one openId is AMBIGUOUS and
 *     resolves to `undefined` — never last-writer-wins — so a name collision
 *     (e.g. an attacker renaming to a real bot's name) can't misroute an @.
 *     An 'api' name→openId is never silently replaced by a 'mention' one.
 *   - Entries expire after a TTL and the number of cached chats is capped, so
 *     stale or poisoned mappings don't linger.
 *
 * Clock, TTL and capacity are injectable so time and eviction are deterministic
 * in tests.
 */
const AMBIGUOUS = Symbol('ambiguous');
type NameTarget = string | typeof AMBIGUOUS;

interface Roster {
  /** openId → display name. 'api' names win over 'mention' names for the same openId. */
  byOpenId: Map<string, string>;
  /** display name → single openId, or AMBIGUOUS when the name is shared. */
  byName: Map<string, NameTarget>;
  /** openId → which source last set its name, so 'api' isn't overwritten by 'mention'. */
  nameSource: Map<string, MemberSource>;
  /** last user list from `getChatMembers` — served back on a cache hit. */
  apiMembers?: ChatMember[];
  /** when {@link apiMembers} was fetched — its own TTL, so `mention` writes don't extend the API cache. */
  apiFetchedAt?: number;
  /** last bot list from `getChatBots` — cached separately so it can't clobber {@link apiMembers}. */
  apiBots?: ChatMember[];
  /** when {@link apiBots} was fetched — its own TTL. */
  apiBotsFetchedAt?: number;
  updatedAt: number;
}

export type MemberSource = 'api' | 'mention';

export interface ChatMemberCacheOptions {
  now?: () => number;
  ttlMs?: number;
  maxChats?: number;
  maxEntriesPerChat?: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_CHATS = 500;
const DEFAULT_MAX_ENTRIES_PER_CHAT = 1000;

export class ChatMemberCache {
  private readonly chats = new Map<string, Roster>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxChats: number;
  private readonly maxEntriesPerChat: number;

  constructor(opts: ChatMemberCacheOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxChats = opts.maxChats ?? DEFAULT_MAX_CHATS;
    this.maxEntriesPerChat = opts.maxEntriesPerChat ?? DEFAULT_MAX_ENTRIES_PER_CHAT;
  }

  setMembers(chatId: string, members: ChatMember[], source: MemberSource): void {
    const roster = this.rosterForWrite(chatId);
    this.indexAll(roster, members, source);
    if (source === 'api') {
      roster.apiMembers = members;
      roster.apiFetchedAt = this.now();
    }
    roster.updatedAt = this.now();
    this.store(chatId, roster);
  }

  /** Cache an authoritative bot list (from `getChatBots`) — separate from the
   *  user list so neither clobbers the other. Indexed as an 'api' source. */
  setBots(chatId: string, bots: ChatMember[]): void {
    const roster = this.rosterForWrite(chatId);
    this.indexAll(roster, bots, 'api');
    roster.apiBots = bots;
    roster.apiBotsFetchedAt = this.now();
    roster.updatedAt = this.now();
    this.store(chatId, roster);
  }

  /**
   * The last API user list, or `undefined` when absent or expired. Uses its
   * own `apiFetchedAt` clock so ongoing 'mention' writes to an active chat
   * don't keep the API cache alive past the TTL (spec §5).
   */
  getMembers(chatId: string): ChatMember[] | undefined {
    return this.liveList(chatId, 'members');
  }

  /** The last API bot list, or `undefined` when absent or expired. */
  getBots(chatId: string): ChatMember[] | undefined {
    return this.liveList(chatId, 'bots');
  }

  private liveList(chatId: string, kind: 'members' | 'bots'): ChatMember[] | undefined {
    const roster = this.liveRoster(chatId);
    const list = kind === 'members' ? roster?.apiMembers : roster?.apiBots;
    const fetchedAt = kind === 'members' ? roster?.apiFetchedAt : roster?.apiBotsFetchedAt;
    if (!list || fetchedAt === undefined) return undefined;
    if (this.now() - fetchedAt > this.ttlMs) return undefined;
    return list;
  }

  private indexAll(roster: Roster, members: ChatMember[], source: MemberSource): void {
    for (const m of members) {
      if (!m.id || !m.name) continue;
      this.indexMember(roster, m.id, m.name, source);
    }
  }

  resolveName(chatId: string, openId: string): string | undefined {
    return this.liveRoster(chatId)?.byOpenId.get(openId);
  }

  resolveOpenId(chatId: string, name: string): string | undefined {
    const target = this.liveRoster(chatId)?.byName.get(name);
    return typeof target === 'string' ? target : undefined;
  }

  private indexMember(roster: Roster, openId: string, name: string, source: MemberSource): void {
    // openId → name: an 'api' name is authoritative; don't let a later
    // 'mention' name overwrite it, but a fresh 'api' name always wins.
    const prevSource = roster.nameSource.get(openId);
    const prevName = roster.byOpenId.get(openId);
    if (source === 'api' || prevSource !== 'api') {
      roster.byOpenId.set(openId, name);
      roster.nameSource.set(openId, source);
      // On a rename, drop the member's previous name→openId entry so the
      // reverse index doesn't accumulate every historical display name of a
      // member that renames repeatedly — but only when it still uniquely
      // pointed here (an ambiguous/shared name is left alone).
      if (prevName !== undefined && prevName !== name && roster.byName.get(prevName) === openId) {
        roster.byName.delete(prevName);
      }
    }

    // name → openId: a second distinct openId for the same name makes it
    // ambiguous (unresolvable) regardless of source.
    const existing = roster.byName.get(name);
    if (existing === undefined) {
      roster.byName.set(name, openId);
    } else if (existing !== openId) {
      roster.byName.set(name, AMBIGUOUS);
    }

    this.capEntries(roster);
  }

  /** Per-chat hard backstop: evict oldest-inserted entries past the cap. */
  private capEntries(roster: Roster): void {
    evictOldest(roster.byName, this.maxEntriesPerChat);
    evictOldest(roster.byOpenId, this.maxEntriesPerChat);
    evictOldest(roster.nameSource, this.maxEntriesPerChat);
  }

  private rosterForWrite(chatId: string): Roster {
    return (
      this.liveRoster(chatId) ?? {
        byOpenId: new Map(),
        byName: new Map(),
        nameSource: new Map(),
        updatedAt: this.now(),
      }
    );
  }

  private liveRoster(chatId: string): Roster | undefined {
    const roster = this.chats.get(chatId);
    if (!roster) return undefined;
    if (this.now() - roster.updatedAt > this.ttlMs) {
      this.chats.delete(chatId);
      return undefined;
    }
    return roster;
  }

  /** Re-insert (LRU touch) and evict the oldest chats past the cap. */
  private store(chatId: string, roster: Roster): void {
    this.chats.delete(chatId);
    this.chats.set(chatId, roster);
    evictOldest(this.chats, this.maxChats);
  }
}

/** Drop oldest-inserted keys until the map is within `max`. */
function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
