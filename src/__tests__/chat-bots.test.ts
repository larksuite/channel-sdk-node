/**
 * channel.getChatBots + roster seeding (members/bots API).
 *
 * The regular members list filters bots out, but `GET
 * /open-apis/im/v1/chats/:chat_id/members/bots` returns them
 * (`{ items: [{ bot_id, bot_name }] }`). `getChatBots` maps those to
 * `ChatMember{ id, name, isBot:true }`, caches per chat (second call is a hit;
 * `force` bypasses), throws LarkChannelError on failure, and — crucially —
 * seeds the roster so a bot is resolvable by name WITHOUT having appeared in an
 * inbound mention first. Its cache must not clobber getChatMembers' user list.
 *
 * The endpoint has no typed node-sdk method, so the channel calls it via the
 * raw-request escape hatch; tests stub `rawClient.request`.
 *
 */

import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '../index';
import { LarkChannelError } from '../types';

function createChannel() {
  const ch = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'secret',
    loggerLevel: LoggerLevel.error,
  });
  (ch as any).botIdentity = { openId: 'ou_bot', name: 'TestBot' };
  return ch;
}

function stubRequest(ch: ReturnType<typeof createChannel>, impl: ReturnType<typeof vi.fn>) {
  (ch.rawClient as any).request = impl;
  return impl;
}

const twoBots = {
  data: {
    items: [
      { bot_id: 'ou_search', bot_name: 'SearchBot' },
      { bot_id: 'ou_writer', bot_name: 'WriterBot' },
    ],
  },
};

describe('getChatBots', () => {
  test('lists bots and maps them to ChatMember{id,name,isBot:true}', async () => {
    const ch = createChannel();
    const req = stubRequest(ch, vi.fn().mockResolvedValue(twoBots));

    const bots = await ch.getChatBots('oc_1');

    expect(req).toHaveBeenCalledTimes(1);
    expect(req.mock.calls[0][0]).toMatchObject({ method: 'GET' });
    expect(req.mock.calls[0][0].url).toContain('/members/bots');
    expect(bots).toEqual([
      { id: 'ou_search', idType: 'open_id', name: 'SearchBot', isBot: true },
      { id: 'ou_writer', idType: 'open_id', name: 'WriterBot', isBot: true },
    ]);
  });

  test('second call hits the cache; force bypasses', async () => {
    const ch = createChannel();
    const req = stubRequest(ch, vi.fn().mockResolvedValue(twoBots));

    await ch.getChatBots('oc_1');
    await ch.getChatBots('oc_1');
    expect(req).toHaveBeenCalledTimes(1);

    await ch.getChatBots('oc_1', { force: true });
    expect(req).toHaveBeenCalledTimes(2);
  });

  test('seeds the roster so a bot is resolvable by name (no prior mention needed)', async () => {
    const ch = createChannel();
    stubRequest(ch, vi.fn().mockResolvedValue(twoBots));

    await ch.getChatBots('oc_1');
    expect((ch as any).chatMemberCache.resolveOpenId('oc_1', 'SearchBot')).toBe('ou_search');
    expect((ch as any).chatMemberCache.resolveName('oc_1', 'ou_writer')).toBe('WriterBot');
  });

  test('does not clobber the getChatMembers user-list cache', async () => {
    const ch = createChannel();
    const membersGet = vi.fn().mockResolvedValue({
      data: { items: [{ member_id: 'ou_u', name: 'User' }], has_more: false },
    });
    (ch.rawClient.im.v1.chatMembers as any).get = membersGet;
    stubRequest(ch, vi.fn().mockResolvedValue(twoBots));

    await ch.getChatMembers('oc_1'); // caches the user list
    await ch.getChatBots('oc_1'); // must not overwrite it
    const users = await ch.getChatMembers('oc_1'); // still a cache hit

    expect(membersGet).toHaveBeenCalledTimes(1);
    expect(users).toEqual([
      { id: 'ou_u', idType: 'open_id', name: 'User', tenantKey: undefined, isBot: false },
    ]);
  });

  test('API failure throws LarkChannelError', async () => {
    const ch = createChannel();
    stubRequest(ch, vi.fn().mockRejectedValue(new Error('permission_denied')));
    await expect(ch.getChatBots('oc_1')).rejects.toBeInstanceOf(LarkChannelError);
  });
});
