/**
 * senderType / senderIsBot on NormalizedMessage.
 *
 * The raw event carries `sender.sender_type` ('user' | 'bot' | 'system' |
 * 'anonymous'), which the normalizer currently drops. These tests pin the
 * pass-through and the derived `senderIsBot` boolean, plus the "empty @"
 * wake semantics (only a bot mention, no body).
 *
 */

import type { RawMessageEvent } from '../context';
import { normalize } from '../index';

const botIdentity = { openId: 'ou_bot', name: 'TestBot' };

function buildEvent(
  opts: { senderType?: string; message?: Partial<RawMessageEvent['message']> } = {},
): RawMessageEvent {
  const sender: RawMessageEvent['sender'] = {
    sender_id: { open_id: 'ou_alice', user_id: 'u_alice' },
  };
  if (opts.senderType !== undefined) sender.sender_type = opts.senderType;
  return {
    sender,
    message: {
      message_id: 'om_x',
      chat_id: 'oc_test',
      chat_type: 'group',
      message_type: 'text',
      content: '{"text":"hello"}',
      create_time: String(Date.now()),
      ...opts.message,
    },
  };
}

describe('senderType / senderIsBot pass-through', () => {
  test('bot sender → senderType "bot", senderIsBot true', async () => {
    const msg = await normalize(buildEvent({ senderType: 'bot' }), { botIdentity });
    expect(msg.senderType).toBe('bot');
    expect(msg.senderIsBot).toBe(true);
  });

  test('user sender → senderType "user", senderIsBot false', async () => {
    const msg = await normalize(buildEvent({ senderType: 'user' }), { botIdentity });
    expect(msg.senderType).toBe('user');
    expect(msg.senderIsBot).toBe(false);
  });

  test('missing sender_type → both fields undefined (cannot be inferred)', async () => {
    const msg = await normalize(buildEvent(), { botIdentity });
    expect(msg.senderType).toBeUndefined();
    expect(msg.senderIsBot).toBeUndefined();
  });
});

describe('empty @ wake', () => {
  test('a mention-only message strips to empty content but keeps mentionedBot', async () => {
    const msg = await normalize(
      buildEvent({
        senderType: 'bot',
        message: {
          content: '{"text":"@_bot"}',
          mentions: [{ key: '@_bot', id: { open_id: 'ou_bot' }, name: 'TestBot' }],
        },
      }),
      { botIdentity },
    );
    expect(msg.mentionedBot).toBe(true);
    expect(msg.content).toBe('');
  });
});
