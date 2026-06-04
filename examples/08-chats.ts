/**
 * List the groups the bot is in (to grab a chat_id): im.v1.chat.list
 * Requires: LARK_APP_ID, LARK_APP_SECRET
 * Run: pnpm exec tsx examples/08-chats.ts
 */
import { makeChannel, ok, log, fail } from './env';

async function main() {
  const channel = makeChannel();
  const r = (await channel.rawClient.im.v1.chat.list({
    params: { page_size: 100 },
  })) as { data?: { items?: Array<{ chat_id?: string; name?: string; chat_mode?: string }> } };

  const items = r.data?.items ?? [];
  if (!items.length) {
    log('the bot is not in any group. Add it to a group first, or use 04-receive and DM it to get a chat_id.');
    return;
  }
  log(`bot is in ${items.length} group(s):`);
  for (const it of items) {
    ok(it.chat_id, '|', it.name ?? '(no name)', '|', it.chat_mode);
  }
}

main().catch((e) => {
  fail(e);
  process.exit(1);
});
