/**
 * normalize utility functions (offline, no credentials / network needed):
 * normalize / normalizeCardAction / normalizeReaction / normalizeBotAdded /
 * normalizeComment, plus the missing-field → null demo.
 * Run: pnpm exec tsx examples/06-normalize.ts
 */
import {
  normalize,
  normalizeBotAdded,
  normalizeCardAction,
  normalizeComment,
  normalizeReaction,
  type RawMessageEvent,
} from '../src/index';
import { ok } from './env';

async function main() {
  const msgEvent = {
    sender: { sender_id: { open_id: 'ou_alice' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello world' }),
      create_time: '1700000000000',
    },
  } as unknown as RawMessageEvent;
  const msg = await normalize(msgEvent, { botIdentity: { openId: 'ou_bot', name: 'Bot' } });
  ok('normalize(text) →', { content: msg.content, type: msg.rawContentType, senderId: msg.senderId });

  ok(
    'normalizeCardAction →',
    normalizeCardAction({
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
      operator: { open_id: 'ou_alice' },
      action: { tag: 'button', value: 'go', form_value: { name: 'Alice' } },
    } as never),
  );

  ok(
    'normalizeReaction(added) →',
    normalizeReaction({ message_id: 'om_1', reaction_type: { emoji_type: 'OK' }, user_id: { open_id: 'ou_alice' } } as never, 'added'),
  );

  ok('normalizeBotAdded →', normalizeBotAdded({ chat_id: 'oc_1', operator_id: { open_id: 'ou_alice' } } as never));

  ok(
    'normalizeComment →',
    normalizeComment({ file_token: 'doccn1', file_type: 'docx', comment_id: 'c1', user_id: { open_id: 'ou_alice' } } as never),
  );

  // Missing a required field (no operator open_id) → returns null
  ok(
    'normalizeReaction(missing open_id) →',
    normalizeReaction({ message_id: 'om_1', reaction_type: { emoji_type: 'OK' } } as never, 'added'),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
