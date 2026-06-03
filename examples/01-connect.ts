/**
 * Connection lifecycle: connect / botIdentity / getConnectionStatus / disconnect
 * Run: pnpm exec tsx examples/01-connect.ts
 */
import { makeChannel, ok, log, fail } from './env';

async function main() {
  const channel = makeChannel();

  log('connecting…');
  await channel.connect();
  ok('connected');
  ok('botIdentity =', channel.botIdentity);
  ok('connectionStatus =', channel.getConnectionStatus());

  await channel.disconnect();
  ok('disconnected');
  ok('connectionStatus(after) =', channel.getConnectionStatus());
}

main().catch((e) => {
  fail(e);
  process.exit(1);
});
