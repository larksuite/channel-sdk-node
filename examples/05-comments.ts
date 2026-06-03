/**
 * Cloud-doc comments: channel.comments.resolveTarget / fetch / reply /
 * addReaction / removeReaction
 * Requires: LARK_APP_ID, LARK_APP_SECRET, LARK_TEST_DOC_TOKEN, LARK_TEST_COMMENT_ID
 *           (optional LARK_TEST_DOC_TYPE, default docx)
 * Run: pnpm exec tsx examples/05-comments.ts
 */
import { env, makeChannel, ok, log, step, fail } from './env';

async function main() {
  const token = env.docToken();
  const commentId = env.commentId();
  if (!token || !commentId) {
    fail('need LARK_TEST_DOC_TOKEN and LARK_TEST_COMMENT_ID (create a comment in a doc, then take its token / comment_id)');
    process.exit(1);
  }

  const channel = makeChannel();

  const target = await channel.comments.resolveTarget(token, env.docType());
  ok('resolveTarget', target);
  if (!target) return;

  const c = await channel.comments.fetch(target, commentId);
  ok('fetch', { isWhole: c?.isWhole, quote: c?.quote, replies: c?.replies?.length });

  const replyId = c?.replies?.at(-1)?.reply_id;
  if (replyId) {
    await step('addReaction', () => channel.comments.addReaction(target, replyId));
    await step('removeReaction', () => channel.comments.removeReaction(target, replyId));
  } else {
    log('no reply on this comment, skipping reaction');
  }

  await step('reply', () => channel.comments.reply(target, commentId, 'examples · auto reply'));
}

main().catch((e) => {
  fail(e);
  process.exit(1);
});
