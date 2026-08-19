import {
  createTestChannel,
  dispatchEvent,
  flushMicrotasks,
  markConnected,
} from '../meeting/__tests__/fixtures';

function directMessage(messageId: string): unknown {
  return {
    sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: 'oc_dm',
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"hello"}',
      create_time: String(Date.now()),
    },
  };
}

describe.each([
  ['queue disabled', false],
  ['queue enabled', true],
])('message handler errors with %s', (_label, queueEnabled) => {
  test("surface through channel.on('error') exactly once", async () => {
    const { ch } = createTestChannel({
      safety: {
        chatQueue: { enabled: queueEnabled },
        batch: { text: { delayMs: 0 } },
      },
    });
    const errors: unknown[] = [];
    markConnected(ch);
    ch.on('error', (error: unknown) => errors.push(error));
    ch.on('message', async () => {
      throw new Error('message handler exploded');
    });

    await dispatchEvent(ch, 'im.message.receive_v1', directMessage(`om_error_${queueEnabled}`));
    await flushMicrotasks();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain('message handler exploded');
  });
});

test('a throwing error observer cannot break handler cleanup', async () => {
  const { ch, logger } = createTestChannel({ safety: { chatQueue: { enabled: false } } });
  let handlerCalls = 0;
  markConnected(ch);
  ch.on('error', () => {
    throw new Error('observer exploded');
  });
  ch.on('message', async () => {
    handlerCalls++;
    throw new Error('message handler exploded');
  });

  const raw = directMessage('om_observer_throw');
  await dispatchEvent(ch, 'im.message.receive_v1', raw);
  await flushMicrotasks();
  await dispatchEvent(ch, 'im.message.receive_v1', raw);
  await flushMicrotasks();

  expect(handlerCalls).toBe(1);
  expect(
    logger.error.mock.calls.some(
      ([entry]) =>
        Array.isArray(entry) &&
        entry[0] === 'safety: error observer threw' &&
        entry[1]?.message === 'observer exploded',
    ),
  ).toBe(true);
});
