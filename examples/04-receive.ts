/**
 * Full inbound suite (long-running): on(message/cardAction/reaction/botAdded/
 * comment/reject/error/reconnecting/reconnected) + echo send + fetchMessage
 * (quote expansion) + downloadResource
 * Requires: LARK_APP_ID, LARK_APP_SECRET
 * Run: pnpm exec tsx examples/04-receive.ts
 *
 * Once running, trigger events against the bot in Feishu: send a message /
 * reply-quote one / send an image / add a reaction / add the bot to a group /
 * @-mention it in a doc comment, and watch the output. Ctrl-C to exit.
 */
import { makeChannel, ok, log, fail } from './env';

async function main() {
  const channel = makeChannel({
    resolveChatMode: true,
    policy: { requireMention: false, dmMode: 'open' }, // example: respond to everything, easy to observe
  });

  channel.on({
    message: async (msg) => {
      ok('message', {
        from: msg.senderId,
        chat: msg.chatId,
        mode: msg.chatMode,
        type: msg.rawContentType,
        content: msg.content.slice(0, 120),
        mentionedBot: msg.mentionedBot,
      });

      // Reply-quote: expand the quoted message
      if (msg.replyToMessageId) {
        const quoted = await channel.fetchMessage(msg.replyToMessageId);
        log('  ↳ quoted:', quoted?.content?.slice(0, 120));
      }

      // Has an image/file: download the first resource
      const res = msg.resources[0];
      if (res) {
        const buf = await channel.downloadResource(
          msg.messageId,
          res.fileKey,
          res.type === 'image' ? 'image' : 'file',
        );
        log(`  ↳ downloaded ${res.type}: ${buf.length} bytes`);
      }

      // Echo. Use text rather than markdown: a media message's content is
      // markdown like `![image](key)`; sending it back as markdown would make
      // the converter try to send the *received* image_key outbound, which
      // triggers 230001.
      await channel.send(
        msg.chatId,
        { text: `收到(${msg.rawContentType})：${msg.content}` },
        { replyTo: msg.messageId },
      );
    },
    cardAction: (e) => ok('cardAction', { tag: e.action.tag, value: e.action.value, formValue: e.action.formValue }),
    reaction: (e) => ok('reaction', e.action, e.emojiType, 'on', e.messageId),
    botAdded: (e) => ok('botAdded', 'chat', e.chatId, 'by', e.operator.openId),
    comment: (e) => ok('comment', { doc: e.fileToken, type: e.fileType, commentId: e.commentId, mentionedBot: e.mentionedBot }),
    reject: (e) => log('reject', e.reason, e.messageId),
    error: (e) => fail('error', e.code, e.message),
    reconnecting: () => log('reconnecting…'),
    reconnected: () => ok('reconnected'),
  });

  await channel.connect();
  ok('listening… 在飞书里触发各类事件；Ctrl-C 退出');

  const bye = async () => {
    log('disconnecting…');
    await channel.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch((e) => {
  fail(e);
  process.exit(1);
});
