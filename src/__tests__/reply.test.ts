/**
 * channel.reply(msg, input, opts?).
 *
 * Convenience reply: defaults `replyTo` to the triggering message and, when
 * that message is inside a topic thread (`threadId` present), defaults
 * `reply_in_thread` to true so the reply lands back in the thread. `opts` can
 * override `replyInThread`.
 *
 */

import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '../index';

function createChannel() {
  const ch = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'secret',
    loggerLevel: LoggerLevel.error,
  });
  (ch as any).botIdentity = { openId: 'ou_bot', name: 'TestBot' };
  return ch;
}

function stubSender(ch: ReturnType<typeof createChannel>) {
  const reply = vi.fn().mockResolvedValue({ data: { message_id: 'om_reply' } });
  const create = vi.fn().mockResolvedValue({ data: { message_id: 'om_create' } });
  (ch.rawClient.im.v1.message as any).reply = reply;
  (ch.rawClient.im.v1.message as any).create = create;
  return { reply, create };
}

describe('channel.reply', () => {
  test('replying to a threaded message defaults reply_in_thread=true and targets it', async () => {
    const ch = createChannel();
    const { reply } = stubSender(ch);

    await ch.reply({ chatId: 'oc_1', messageId: 'om_1', threadId: 'th_1' } as any, { text: 'hi' });

    const call = reply.mock.calls[0][0];
    expect(call.path.message_id).toBe('om_1');
    expect(call.data.reply_in_thread).toBe(true);
  });

  test('replying to a non-threaded message does not force reply_in_thread', async () => {
    const ch = createChannel();
    const { reply } = stubSender(ch);

    await ch.reply({ chatId: 'oc_1', messageId: 'om_2' } as any, { text: 'hi' });

    const call = reply.mock.calls[0][0];
    expect(call.path.message_id).toBe('om_2');
    expect(call.data.reply_in_thread).not.toBe(true);
  });

  test('opts can override reply_in_thread to false even inside a thread', async () => {
    const ch = createChannel();
    const { reply } = stubSender(ch);

    await ch.reply(
      { chatId: 'oc_1', messageId: 'om_3', threadId: 'th' } as any,
      { text: 'x' },
      {
        replyInThread: false,
      },
    );

    expect(reply.mock.calls[0][0].data.reply_in_thread).toBe(false);
  });
});
