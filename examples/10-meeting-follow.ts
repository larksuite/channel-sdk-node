/**
 * Meeting path one (user identity): follow the meeting you are currently in,
 * without joining it. No bot appears in the participant list.
 *
 * Requires: LARK_APP_ID, LARK_APP_SECRET, LARK_USER_ACCESS_TOKEN
 * Run: pnpm exec tsx examples/10-meeting-follow.ts
 *
 * Start a Feishu meeting from the account that issued the token, turn on
 * "allow agents to join", then run this and talk. Ctrl-C to exit.
 *
 * Compliance: this reads what every participant says while nothing is visible in
 * the meeting. Telling participants, and getting their agreement, is on you —
 * the SDK does not surface anything on your behalf.
 */
import { fail, log, makeChannel, ok } from './env';

function userToken(): string {
  const v = process.env.LARK_USER_ACCESS_TOKEN;
  if (!v) {
    fail('missing environment variable LARK_USER_ACCESS_TOKEN');
    process.exit(1);
  }
  return v;
}

async function main() {
  // No connect() on this path: following is REST polling only, so a WebSocket
  // would be pure overhead.
  const channel = makeChannel();

  const meeting = await channel.followMyMeeting({
    // A function, not a string: it is re-read before every poll, which is how a
    // meeting outlives a token whose lifetime is shorter than the meeting.
    // Swap `userToken()` for your own refresh and long meetings keep working.
    userAccessToken: () => userToken(),
    // stabilizeMs: 800,  // deliver each sentence once it stops changing
  });

  ok('following', { meetingId: meeting.meetingId, mode: meeting.mode });

  meeting.on('transcript', ({ actor, text, sentenceId }) => {
    // Same sentenceId supersedes the previous text — upsert, do not append.
    log('transcript', { speaker: actor.name, sentenceId, text });
  });

  meeting.on('participant', ({ action, actor }) => {
    log('participant', { action, who: actor.name });
  });

  meeting.on('share', ({ action, doc }) => {
    log('share', { action, title: doc?.title });
  });

  meeting.on('end', ({ reason }) => {
    ok('meeting over', { reason });
    process.exit(0);
  });

  meeting.on('error', (err) => {
    fail('session error', err.code, err.message);
  });

  process.on('SIGINT', () => {
    void meeting.leave().then(() => process.exit(0));
  });
}

main().catch((e) => {
  fail(String(e));
  process.exit(1);
});
