/**
 * Full outbound suite: send (multiple SendInput) / updateCard / editMessage /
 * recallMessage / addReaction / removeReaction / removeReactionByEmoji /
 * getChatInfo / getChatMode
 * Requires: LARK_APP_ID, LARK_APP_SECRET, LARK_TEST_CHAT_ID
 * Run: pnpm exec tsx examples/02-outbound.ts
 *
 * Note: send goes over REST (token auto-fetched), so connect() is not required.
 * Each step is wrapped in its own try/catch so one failure doesn't stop the
 * rest — making it easy to see at a glance which APIs pass.
 */
import { env, makeChannel, ok, step, simpleCard } from './env';

// 1x1 transparent PNG — demonstrates a Buffer as a media source (no external
// image dependency).
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC',
  'base64',
);

async function main() {
  const channel = makeChannel();
  const to = env.chatId();

  let textId = '';
  let cardId = '';

  await step('send text', async () => {
    const r = await channel.send(to, { text: 'examples · text 消息' });
    textId = r.messageId;
    return r;
  });

  await step('send markdown', () =>
    channel.send(to, { markdown: '**examples · markdown**\n- 列表项 `code`\n- [链接](https://feishu.cn)' }),
  );

  await step('send post', () =>
    channel.send(to, {
      post: { zh_cn: { title: 'examples · post', content: [[{ tag: 'text', text: '富文本一行' }]] } },
    }),
  );

  await step('send image (Buffer)', () => channel.send(to, { image: { source: tinyPng } }));

  await step('send card', async () => {
    const r = await channel.send(to, { card: simpleCard('examples · 卡片') });
    cardId = r.messageId;
    return r;
  });

  await step('updateCard', () => channel.updateCard(cardId, simpleCard('examples · 卡片（已更新）')));

  await step('addReaction', () => channel.addReaction(textId, 'OK'));
  await step('removeReactionByEmoji', () => channel.removeReactionByEmoji(textId, 'OK'));

  await step('editMessage', () => channel.editMessage(textId, 'examples · text（已编辑）'));

  await step('getChatInfo', () => channel.getChatInfo(to));
  await step('getChatMode', () => channel.getChatMode(to));

  await step('recallMessage', () => channel.recallMessage(textId));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
