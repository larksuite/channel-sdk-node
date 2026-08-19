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

async function flushEventLoop(): Promise<void> {
  await flushMicrotasks();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await flushMicrotasks();
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
        entry[0] === 'channel: error handler threw' &&
        entry[1]?.message === 'observer exploded',
    ),
  ).toBe(true);
});

test('an async rejecting error observer is consumed without unhandledRejection', async () => {
  const { ch, logger } = createTestChannel({ safety: { chatQueue: { enabled: false } } });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  let handlerCalls = 0;
  let observerCalls = 0;
  process.on('unhandledRejection', onUnhandled);

  try {
    markConnected(ch);
    ch.on('error', async () => {
      observerCalls++;
      throw new Error('async observer exploded');
    });
    ch.on('message', async () => {
      handlerCalls++;
      if (handlerCalls === 1) throw new Error('first message exploded');
    });

    await dispatchEvent(ch, 'im.message.receive_v1', directMessage('om_async_observer_1'));
    await flushEventLoop();
    await dispatchEvent(ch, 'im.message.receive_v1', directMessage('om_async_observer_2'));
    await flushEventLoop();

    expect(observerCalls).toBe(1);
    expect(handlerCalls).toBe(2);
    expect(unhandled).toEqual([]);
    expect(
      logger.error.mock.calls.some(
        ([entry]) =>
          Array.isArray(entry) &&
          entry[0] === 'channel: error handler threw' &&
          entry[1]?.message === 'async observer exploded',
      ),
    ).toBe(true);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a throwing thenable returned by the error observer is isolated', async () => {
  const { ch, logger } = createTestChannel({ safety: { chatQueue: { enabled: false } } });
  markConnected(ch);
  ch.on('error', (() =>
    Object.defineProperty({}, 'then', {
      get() {
        throw new Error('then getter exploded');
      },
    })) as never);
  ch.on('message', async () => {
    throw new Error('message handler exploded');
  });

  await dispatchEvent(ch, 'im.message.receive_v1', directMessage('om_thenable_observer'));
  await flushEventLoop();

  expect(
    logger.error.mock.calls.some(
      ([entry]) =>
        Array.isArray(entry) &&
        entry[0] === 'channel: error handler threw' &&
        entry[1]?.message === 'then getter exploded',
    ),
  ).toBe(true);
});
