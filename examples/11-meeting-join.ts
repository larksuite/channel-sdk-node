/**
 * Meeting path two (app identity): the bot joins as a real participant, reads
 * in-meeting chat, and answers back into the meeting.
 *
 * Requires: LARK_APP_ID, LARK_APP_SECRET, and the `vc:meeting.bot.join:write`
 * scope (allow-listed rollout).
 * Run: pnpm exec tsx examples/11-meeting-join.ts
 *
 * Once running, invite the bot into a meeting that has "allow agents to join"
 * turned on, then type `@assistant <something>` in the meeting chat.
 * Ctrl-C leaves every meeting and exits.
 */
import { fail, log, makeChannel, ok } from './env';
import type { MeetingSession } from '../src/index';

const TRIGGER = '@assistant';

async function main() {
  const channel = makeChannel();
  const joined = new Set<MeetingSession>();

  // Single-slot, like every other channel event: one invite, one decision.
  channel.on('meetingInvited', async (invite) => {
    ok('invited', { meetingNo: invite.meetingNo, by: invite.inviter?.name });

    const meeting = await channel.joinMeeting(invite.meetingNo, {
      // Present when the invite came in as a call.
      callId: invite.callId,
    });
    joined.add(meeting);
    ok('joined', { meetingId: meeting.meetingId });

    meeting.on('chat', async ({ actor, content, selfEcho }) => {
      // Without this the bot answers its own messages: what it sends comes back
      // on this same stream as chat, at network speed.
      if (selfEcho) return;
      if (!content.startsWith(TRIGGER)) return;

      log('question', { from: actor.name, content });
      await meeting.sendMessage(`heard you: ${content.slice(TRIGGER.length).trim()}`);
    });

    meeting.on('transcript', ({ actor, text, sentenceId, selfEcho }) => {
      if (selfEcho) return;
      log('transcript', { speaker: actor.name, sentenceId, text });
    });

    meeting.on('end', ({ reason }) => {
      ok('meeting over', { meetingId: meeting.meetingId, reason });
      joined.delete(meeting);
    });

    meeting.on('error', (err) => {
      fail('session error', err.code, err.message);
    });
  });

  channel.on('error', (err) => {
    // A missing scope arrives here with a one-click authorization link attached.
    // Treat it as a credential: hand it to an operator, never echo it into a chat.
    fail('channel error', err.code, err.message, err.context?.consoleUrl ? '(consoleUrl present)' : '');
  });

  await channel.connect();
  ok('connected — invite the bot into a meeting now');

  // Diagnosing silence: this path runs on `push`, so `push.received` stuck at 0
  // means the platform never sent anything (check the event subscription and the
  // meeting setting), while `empty` climbing means it arrived and could not be
  // unpacked. `poll` moves only from the liveness probe's gap-recovery read, so it
  // cannot vouch for the push stream.
  setInterval(() => log('health', channel.getMeetingEventHealth()), 60_000).unref();

  process.on('SIGINT', async () => {
    // Leave explicitly: dispose alone keeps the bot sitting in the meeting.
    await Promise.all([...joined].map((m) => m.leave()));
    process.exit(0);
  });
}

main().catch((e) => {
  fail(String(e));
  process.exit(1);
});
