import { createTestChannel, dispatchEvent, markConnected } from '../meeting/__tests__/fixtures';

const channels: Array<{ disconnect(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(channels.splice(0).map((ch) => ch.disconnect()));
});

function cardClick(delivery: Record<string, unknown>) {
  return {
    context: { open_message_id: 'om_retry', open_chat_id: 'oc_retry' },
    operator: { open_id: 'ou_alice' },
    action: { tag: 'button', value: { choice: 'a' } },
    ...delivery,
  };
}

test('首次拒绝后原按钮的新点击进入 handler，同一投递重放被过滤', async () => {
  const { ch } = createTestChannel();
  markConnected(ch);
  channels.push(ch);
  let calls = 0;
  ch.on('cardAction', () => {
    calls++;
    return { toast: { type: 'info', content: calls === 1 ? '请稍后重试' : '已收到' } };
  });
  const click = (token: string) => dispatchEvent(ch, 'card.action.trigger', cardClick({ token }));
  expect(await click('first')).toEqual({ toast: { type: 'info', content: '请稍后重试' } });
  expect(await click('first')).toBeUndefined();
  expect(await click('second')).toEqual({ toast: { type: 'info', content: '已收到' } });
  expect(calls).toBe(2);
});

test.each(['header', 'event_id', 'missing'])('%s 投递标识区分重放与真实点击', async (shape) => {
  const { ch } = createTestChannel();
  markConnected(ch);
  channels.push(ch);
  let calls = 0;
  ch.on('cardAction', () => {
    calls++;
  });
  const click = (id: string) =>
    dispatchEvent(
      ch,
      'card.action.trigger',
      cardClick(
        shape === 'header'
          ? { header: { event_id: id } }
          : shape === 'event_id'
            ? { event_id: id }
            : {},
      ),
    );
  await click('first');
  await click('first');
  expect(calls).toBe(shape === 'missing' ? 2 : 1);
  await click('second');
  expect(calls).toBe(shape === 'missing' ? 3 : 2);
});
