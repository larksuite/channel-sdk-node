/**
 * channel.getBotIdentity().
 *
 * After connect resolves the bot identity, `getBotIdentity()` returns it so
 * callers can safely inline it into a system prompt. Before connect it must
 * THROW `LarkChannelError('not_connected')` rather than return undefined.
 *
 */

import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '../index';
import { LarkChannelError } from '../types';

function createChannel(opts: { withIdentity?: boolean } = {}) {
  const ch = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'secret',
    loggerLevel: LoggerLevel.error,
  });
  if (opts.withIdentity) {
    (ch as any).botIdentity = { openId: 'ou_bot', name: 'B' };
  }
  return ch;
}

describe('getBotIdentity()', () => {
  test('returns the resolved identity once connected', () => {
    const ch = createChannel({ withIdentity: true });
    expect(ch.getBotIdentity()).toEqual({ openId: 'ou_bot', name: 'B' });
  });

  test('throws LarkChannelError(not_connected) before identity is resolved', () => {
    const ch = createChannel(); // botIdentity still undefined
    // Assert both the error class and the code so callers can branch on it.
    let thrown: unknown;
    try {
      ch.getBotIdentity();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LarkChannelError);
    expect((thrown as LarkChannelError).code).toBe('not_connected');
  });
});
