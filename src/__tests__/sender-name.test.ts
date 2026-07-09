/**
 * resolveSenderNames wiring + mention collection into the roster.
 *
 * Opt-in `resolveSenderNames` warms the chat roster and feeds a synchronous
 * `resolveSenderName` into `normalize`, so delivered messages carry
 * `senderName`. Off by default (zero extra API). Separately, every inbound
 * message's `mentions[]` (incl. bots) is collected into the roster so a bot
 * that has "shown its face" can later be @'d by name.
 *
 * Delivery is observed via the `message` event; the queue is disabled so
 * dispatch is not debounced, and `requireMention` is off so a plain user
 * message is delivered.
 *
 */

import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '../index';

function createChannel(extra: Record<string, unknown> = {}) {
  const ch = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'secret',
    loggerLevel: LoggerLevel.error,
    safety: { chatQueue: { enabled: false } },
    policy: { requireMention: false },
    ...extra,
  } as any);
  (ch as any).botIdentity = { openId: 'ou_bot', name: 'TestBot' };
  (ch as any).registerDispatcherHandlers();
  return ch;
}

function buildEvent(
  opts: { messageId?: string; content?: string; mentions?: unknown[] } = {},
): unknown {
  return {
    sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
    message: {
      message_id: opts.messageId ?? 'om_x',
      chat_id: 'oc_test',
      chat_type: 'group',
      message_type: 'text',
      content: opts.content ?? '{"text":"hi"}',
      create_time: String(Date.now()),
      ...(opts.mentions ? { mentions: opts.mentions } : {}),
    },
  };
}

async function dispatch(ch: any, raw: unknown): Promise<void> {
  await ch.dispatcher.handles.get('im.message.receive_v1')(raw);
}

function onNextMessage(ch: any): Promise<any> {
  return new Promise((resolve) => ch.on('message', (m: any) => resolve(m)));
}

describe('senderName resolution', () => {
  test('resolveSenderNames:true fills senderName from the warmed roster', async () => {
    const ch = createChannel({ resolveSenderNames: true });
    (ch.rawClient.im.v1.chatMembers as any).get = vi.fn().mockResolvedValue({
      data: {
        items: [{ member_id: 'ou_alice', member_id_type: 'open_id', name: 'Alice' }],
        has_more: false,
      },
    });

    const delivered = onNextMessage(ch);
    await dispatch(ch, buildEvent({ messageId: 'om_sn1' }));
    const msg = await delivered;
    expect(msg.senderName).toBe('Alice');
  });

  test('default (option off): senderName undefined and no roster API call', async () => {
    const ch = createChannel();
    const get = vi.fn();
    (ch.rawClient.im.v1.chatMembers as any).get = get;

    const delivered = onNextMessage(ch);
    await dispatch(ch, buildEvent({ messageId: 'om_sn2' }));
    const msg = await delivered;
    expect(msg.senderName).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  test('roster miss degrades to undefined (no throw)', async () => {
    const ch = createChannel({ resolveSenderNames: true });
    (ch.rawClient.im.v1.chatMembers as any).get = vi.fn().mockResolvedValue({
      data: {
        items: [{ member_id: 'ou_other', member_id_type: 'open_id', name: 'Other' }],
        has_more: false,
      },
    });

    const delivered = onNextMessage(ch);
    await dispatch(ch, buildEvent({ messageId: 'om_sn3' }));
    const msg = await delivered;
    expect(msg.senderName).toBeUndefined();
  });
});

describe('mention collection', () => {
  test('a bot seen in an inbound mention becomes resolvable by name', async () => {
    const ch = createChannel();
    await dispatch(
      ch,
      buildEvent({
        messageId: 'om_sn4',
        content: '{"text":"@_1 hi"}',
        mentions: [{ key: '@_1', id: { open_id: 'ou_search' }, name: 'SearchBot' }],
      }),
    );
    // The channel's roster cache should now resolve the observed bot by name.
    expect((ch as any).chatMemberCache.resolveOpenId('oc_test', 'SearchBot')).toBe('ou_search');
  });
});
