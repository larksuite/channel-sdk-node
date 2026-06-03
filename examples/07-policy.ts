/**
 * Runtime policy (offline, no network): getPolicy / updatePolicy
 * (partial merge, takes effect immediately)
 * Run: pnpm exec tsx examples/07-policy.ts
 */
import { createLarkChannel } from '../src/index';
import { ok } from './env';

async function main() {
  // Construct only, never connect — no network; placeholder credentials are fine.
  const channel = createLarkChannel({
    appId: 'cli_dummy',
    appSecret: 'dummy',
    policy: { requireMention: true, dmMode: 'open', groupAllowlist: ['oc_a'] },
  });

  ok('getPolicy(initial) →', channel.getPolicy());

  // Partial merge: only requireMention changes, the rest is kept.
  channel.updatePolicy({ requireMention: false });
  ok('updatePolicy({ requireMention:false }) →', channel.getPolicy());

  // Append to the allowlist (note: you must include the existing entries).
  const cur = channel.getPolicy();
  channel.updatePolicy({ groupAllowlist: [...(cur.groupAllowlist ?? []), 'oc_b'] });
  ok('append allowlist →', channel.getPolicy());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
