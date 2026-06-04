/**
 * Streaming reply: stream (markdown typewriter card)
 * Requires: LARK_APP_ID, LARK_APP_SECRET, LARK_TEST_CHAT_ID
 * Run: pnpm exec tsx examples/03-stream.ts
 */
import { env, makeChannel, ok, sleep, fail } from './env';

async function main() {
  const channel = makeChannel();
  const to = env.chatId();

  const r = await channel.stream(to, {
    markdown: async (c) => {
      await c.append('正在思考');
      for (let i = 0; i < 3; i++) {
        await sleep(400);
        await c.append('·');
      }
      await c.append('\n\n');
      for (const line of ['这是 **流式** 输出示例：\n', '- 第一段\n', '- 第二段\n', '- 完成 ✅\n']) {
        await c.append(line);
        await sleep(300);
      }
    },
  });
  ok('stream done →', r.messageId);
}

main().catch((e) => {
  fail(e);
  process.exit(1);
});
