/**
 * onRawEvent — the escape hatch for Feishu events the channel has not wrapped.
 *
 * Without it the only way to subscribe to an unwrapped event is to reach into
 * the dispatcher's private map, which breaks on any version bump, or to open a
 * second long-lived connection — and a second connection for the same app
 * makes Feishu split delivery between them, so the channel's own IM traffic
 * starts disappearing. Neither is something a caller should have to do.
 *
 * The composition rules are where this gets sharp. `EventDispatcher.handles`
 * is one function per event type, so registering the same type twice replaces
 * rather than adds: composing built-in and raw handlers explicitly is the only
 * way both survive. Built-in runs first and its return value is the one that
 * goes back to Feishu — a card action's response payload must not be
 * rewritable by an observer.
 *
 * And the bypass is deliberate: raw handlers run after signature verification
 * and decryption, but outside the policy gate, dedup, processing lock and loop
 * guard. Registering one for an event type the channel already handles opens a
 * path around those checks. The last case pins that as designed behaviour so
 * it is not quietly "fixed" later by someone who reads it as a leak.
 */

import {
  createTestChannel,
  dispatchEvent,
  flushMicrotasks,
  markConnected,
} from '../meeting/__tests__/fixtures';

function reactionEvent(messageId: string): unknown {
  return {
    message_id: messageId,
    reaction_type: { emoji_type: 'OK' },
    operator_type: 'user',
    user_id: { open_id: 'ou_alice' },
    action_time: String(Date.now()),
  };
}

function cardAction(value: unknown, messageId: string): unknown {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger',
    context: { open_message_id: messageId, open_chat_id: 'oc_test' },
    operator: { open_id: 'ou_alice' },
    action: { tag: 'button', value },
  };
}

function directMessage(messageId: string): unknown {
  return {
    sender: { sender_id: { open_id: 'ou_stranger' }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: 'oc_dm',
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"let me in"}',
      create_time: String(Date.now()),
    },
  };
}

describe('subscribing to an unwrapped event type', () => {
  test('the handler fires, and unsubscribing removes only that handler', async () => {
    const { ch } = createTestChannel();
    const first: unknown[] = [];
    const second: unknown[] = [];

    // Registered before connect, which is when callers actually wire handlers:
    // the dispatcher registration that happens during connect must compose
    // with what is already there rather than wipe it.
    const offFirst = ch.onRawEvent('vc.bot.meeting_started_v1', (p: unknown) => {
      first.push(p);
    });
    ch.onRawEvent('vc.bot.meeting_started_v1', (p: unknown) => {
      second.push(p);
    });
    markConnected(ch);

    const started = { event_id: 'evt_started', meeting: { id: 'mid_1' } };
    await dispatchEvent(ch, 'vc.bot.meeting_started_v1', started);

    expect(first).toEqual([started]);
    expect(second).toEqual([started]);

    offFirst();
    await dispatchEvent(ch, 'vc.bot.meeting_started_v1', started);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });
});

describe('coexisting with a built-in handler', () => {
  test('the built-in handler still runs, and the raw handler runs after it', async () => {
    const { ch } = createTestChannel();
    const order: string[] = [];

    ch.onRawEvent('im.message.reaction.created_v1', () => {
      order.push('raw');
    });
    markConnected(ch);
    ch.on('reaction', () => {
      order.push('builtin');
    });

    await dispatchEvent(ch, 'im.message.reaction.created_v1', reactionEvent('om_order_1'));

    expect(order).toEqual(['builtin', 'raw']);
  });

  test('registering the raw handler after connect composes just the same', async () => {
    const { ch } = createTestChannel();
    const order: string[] = [];

    markConnected(ch);
    ch.on('reaction', () => {
      order.push('builtin');
    });
    ch.onRawEvent('im.message.reaction.created_v1', () => {
      order.push('raw');
    });

    await dispatchEvent(ch, 'im.message.reaction.created_v1', reactionEvent('om_order_2'));

    expect(order).toEqual(['builtin', 'raw']);
  });

  test('the card callback response comes from the built-in handler, not the raw one', async () => {
    const { ch } = createTestChannel();
    markConnected(ch);

    ch.on('cardAction', () => ({ toast: { type: 'success', content: 'from builtin' } }));
    ch.onRawEvent('card.action.trigger', () => ({
      toast: { type: 'error', content: 'from raw' },
    }));

    const response = await dispatchEvent(
      ch,
      'card.action.trigger',
      cardAction({ cmd: 'A' }, 'om_raw_ret'),
    );

    expect(response).toEqual({ toast: { type: 'success', content: 'from builtin' } });
  });

  test('a throwing raw handler is contained and surfaces through error', async () => {
    const { ch } = createTestChannel();
    const errors: Array<{ message: string }> = [];
    const builtin: string[] = [];

    markConnected(ch);
    ch.on('error', (e: { message: string }) => {
      errors.push(e);
    });
    ch.on('reaction', () => {
      builtin.push('fired');
    });
    ch.onRawEvent('im.message.reaction.created_v1', () => {
      throw new Error('raw handler exploded');
    });

    await expect(
      dispatchEvent(ch, 'im.message.reaction.created_v1', reactionEvent('om_raw_throw')),
    ).resolves.not.toThrow();
    await flushMicrotasks();

    expect(builtin).toEqual(['fired']);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => String(e.message).includes('raw handler exploded'))).toBe(true);
  });
});

describe('raw handlers sit outside the safety pipeline', () => {
  test('a DM the allowlist rejects never reaches `message`, but does reach the raw handler', async () => {
    const { ch } = createTestChannel({
      policy: { dmMode: 'allowlist', dmAllowlist: [] },
      safety: { chatQueue: { enabled: false } },
    });

    const delivered: unknown[] = [];
    const rawSeen: unknown[] = [];
    const rejected: Array<{ reason: string }> = [];

    markConnected(ch);
    ch.on('message', (m: unknown) => {
      delivered.push(m);
    });
    ch.on('reject', (e: { reason: string }) => {
      rejected.push(e);
    });
    ch.onRawEvent('im.message.receive_v1', (p: unknown) => {
      rawSeen.push(p);
    });

    const raw = directMessage('om_bypass_1');
    await dispatchEvent(ch, 'im.message.receive_v1', raw);
    await flushMicrotasks(8);

    expect(delivered).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(['sender_not_allowed']);
    expect(rawSeen).toEqual([raw]);
  });
});
