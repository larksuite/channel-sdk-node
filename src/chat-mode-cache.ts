export type ChatMode = 'p2p' | 'group' | 'topic';

/**
 * In-memory cache for chat mode lookups. Feishu omits chat mode from message
 * events, so the only way to know whether a chat is a p2p / ordinary group /
 * topic group is an extra `chat.get` — which is stable for a chat's lifetime,
 * hence cacheable by chatId.
 *
 * On lookup failure (network / permission / unknown chatId) the resolver
 * returns 'group' (the conservative default: treat as an ordinary chat) and
 * does NOT poison the cache, so a later message gets another try.
 */
export class ChatModeCache {
  private readonly cache = new Map<string, ChatMode>();

  async resolve(chatId: string, fetch: (chatId: string) => Promise<ChatMode>): Promise<ChatMode> {
    const hit = this.cache.get(chatId);
    if (hit) return hit;
    try {
      const mode = await fetch(chatId);
      this.cache.set(chatId, mode);
      return mode;
    } catch {
      return 'group';
    }
  }

  invalidate(chatId: string): void {
    this.cache.delete(chatId);
  }
}
