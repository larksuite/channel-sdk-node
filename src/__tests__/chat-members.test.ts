/**
 * channel.getChatMembers + roster cache + resolveChatMembers hook.
 *
 * Walks `im.v1.chatMembers.get` with pagination (pageSize clamped to <=100,
 * maxPages cap), caches per chat (second call is a hit; `force` bypasses),
 * honors a `resolveChatMembers` override hook, throws LarkChannelError on API
 * failure, and returns users only (`isBot` never true — Feishu filters bots).
 *
 */

import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '../index';
import { LarkChannelError } from '../types';

function createChannel(extra: Record<string, unknown> = {}) {
  const ch = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'secret',
    loggerLevel: LoggerLevel.error,
    ...extra,
  } as any);
  (ch as any).botIdentity = { openId: 'ou_bot', name: 'TestBot' };
  return ch;
}

function stubGet(ch: ReturnType<typeof createChannel>, impl: ReturnType<typeof vi.fn>) {
  (ch.rawClient.im.v1.chatMembers as any).get = impl;
  return impl;
}

describe('pagination', () => {
  test('follows has_more/page_token and maps items to ChatMember{id,name}', async () => {
    const ch = createChannel();
    const get = stubGet(
      ch,
      vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            items: [{ member_id: 'ou_a', member_id_type: 'open_id', name: 'Alice' }],
            has_more: true,
            page_token: 'tok2',
          },
        })
        .mockResolvedValueOnce({
          data: {
            items: [{ member_id: 'ou_b', member_id_type: 'open_id', name: 'Bob' }],
            has_more: false,
          },
        }),
    );

    const members = await ch.getChatMembers('oc_1');
    expect(members).toHaveLength(2);
    expect(members[0]).toMatchObject({ id: 'ou_a', name: 'Alice' });
    expect(members[1]).toMatchObject({ id: 'ou_b', name: 'Bob' });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][0].params.page_token).toBe('tok2');
  });

  test('clamps pageSize to 100', async () => {
    const ch = createChannel();
    const get = stubGet(ch, vi.fn().mockResolvedValue({ data: { items: [], has_more: false } }));
    await ch.getChatMembers('oc_1', { pageSize: 500 });
    expect(get.mock.calls[0][0].params.page_size).toBe(100);
  });

  test('stops at maxPages even when has_more stays true', async () => {
    const ch = createChannel();
    const get = stubGet(
      ch,
      vi.fn().mockResolvedValue({
        data: { items: [{ member_id: 'ou_x', name: 'X' }], has_more: true, page_token: 't' },
      }),
    );
    await ch.getChatMembers('oc_1', { maxPages: 1 });
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('caching', () => {
  test('second call hits the cache; force bypasses it', async () => {
    const ch = createChannel();
    const get = stubGet(
      ch,
      vi.fn().mockResolvedValue({
        data: { items: [{ member_id: 'ou_a', name: 'Alice' }], has_more: false },
      }),
    );

    await ch.getChatMembers('oc_1');
    await ch.getChatMembers('oc_1');
    expect(get).toHaveBeenCalledTimes(1);

    await ch.getChatMembers('oc_1', { force: true });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('resolveChatMembers hook', () => {
  test('when it returns members, the API is not called', async () => {
    const ch = createChannel({ resolveChatMembers: () => [{ id: 'ou_h', name: 'Hooked' }] });
    const get = stubGet(ch, vi.fn());
    const members = await ch.getChatMembers('oc_1');
    expect(members).toEqual([{ id: 'ou_h', name: 'Hooked' }]);
    expect(get).not.toHaveBeenCalled();
  });

  test('when it returns undefined, it falls back to the API', async () => {
    const ch = createChannel({ resolveChatMembers: () => undefined });
    const get = stubGet(
      ch,
      vi.fn().mockResolvedValue({
        data: { items: [{ member_id: 'ou_a', name: 'Alice' }], has_more: false },
      }),
    );
    const members = await ch.getChatMembers('oc_1');
    expect(get).toHaveBeenCalledTimes(1);
    expect(members[0]).toMatchObject({ id: 'ou_a', name: 'Alice' });
  });
});

describe('errors and shape', () => {
  test('API failure throws LarkChannelError', async () => {
    const ch = createChannel();
    stubGet(ch, vi.fn().mockRejectedValue(new Error('permission_denied')));
    await expect(ch.getChatMembers('oc_1')).rejects.toBeInstanceOf(LarkChannelError);
  });

  test('returned members are users — isBot is never true', async () => {
    const ch = createChannel();
    stubGet(
      ch,
      vi.fn().mockResolvedValue({
        data: { items: [{ member_id: 'ou_a', name: 'Alice' }], has_more: false },
      }),
    );
    const members = await ch.getChatMembers('oc_1');
    expect(members[0].isBot).not.toBe(true);
  });
});
