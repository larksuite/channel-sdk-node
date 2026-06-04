/**
 * L2 sink batch (sunk from bridge):
 *   - normalizeCardAction surfaces CardKit 2.0 `action.form_value` as
 *     `action.formValue` (removes the need to enable includeRawEvent)
 *   - ChatModeCache caches chat.get results and falls back to 'group'
 *   - channel.fetchMessage normalizes a fetched message (quote resolution)
 */
import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { ChatModeCache } from '../chat-mode-cache';
import { createLarkChannel } from '../index';
import { normalizeCardAction } from '../normalize';

describe('normalizeCardAction form_value', () => {
  test('surfaces form_value as action.formValue', () => {
    const evt = normalizeCardAction({
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
      operator: { open_id: 'ou_user' },
      action: {
        tag: 'form',
        value: { kind: 'submit' },
        form_value: { name_input: 'Alice', agree: true },
      },
    });
    expect(evt?.action.formValue).toEqual({ name_input: 'Alice', agree: true });
  });

  test('plain button click leaves formValue undefined', () => {
    const evt = normalizeCardAction({
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
      operator: { open_id: 'ou_user' },
      action: { tag: 'button', value: 'ok' },
    });
    expect(evt?.action.formValue).toBeUndefined();
  });
});

describe('ChatModeCache', () => {
  test('caches the resolved mode (single fetch per chatId)', async () => {
    const cache = new ChatModeCache();
    const fetch = vi.fn().mockResolvedValue('topic' as const);
    expect(await cache.resolve('oc_1', fetch)).toBe('topic');
    expect(await cache.resolve('oc_1', fetch)).toBe('topic');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('falls back to group on failure without poisoning the cache', async () => {
    const cache = new ChatModeCache();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('perm'))
      .mockResolvedValueOnce('p2p' as const);
    expect(await cache.resolve('oc_2', fetch)).toBe('group');
    // not cached → next call retries and succeeds
    expect(await cache.resolve('oc_2', fetch)).toBe('p2p');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('channel.fetchMessage', () => {
  function makeChannel() {
    const ch = createLarkChannel({
      appId: 'cli_test',
      appSecret: 'secret',
      loggerLevel: LoggerLevel.error,
    });
    (ch as any).botIdentity = { openId: 'ou_bot', name: 'Bot' };
    return ch;
  }

  test('normalizes a fetched text message', async () => {
    const ch = makeChannel();
    (ch.rawClient.im.v1.message as any).get = vi.fn().mockResolvedValue({
      data: {
        items: [
          {
            message_id: 'om_quoted',
            msg_type: 'text',
            sender: { id: 'ou_alice' },
            body: { content: JSON.stringify({ text: 'hello there' }) },
            create_time: '1700000000000',
          },
        ],
      },
    });
    const msg = await ch.fetchMessage('om_quoted');
    expect(msg?.messageId).toBe('om_quoted');
    expect(msg?.content).toContain('hello there');
    expect(msg?.rawContentType).toBe('text');
  });

  test('returns undefined when the fetch fails', async () => {
    const ch = makeChannel();
    (ch.rawClient.im.v1.message as any).get = vi.fn().mockRejectedValue(new Error('nope'));
    expect(await ch.fetchMessage('om_x')).toBeUndefined();
  });

  test('returns undefined when there is no parent item', async () => {
    const ch = makeChannel();
    (ch.rawClient.im.v1.message as any).get = vi.fn().mockResolvedValue({ data: { items: [] } });
    expect(await ch.fetchMessage('om_x')).toBeUndefined();
  });
});
