/**
 * One-click QR-code app registration: registerApp
 * No credentials needed — this is how you bootstrap appId/appSecret.
 * Run: pnpm exec tsx examples/09-register.ts
 *
 * Prints a QR URL; open it (or render it as a QR) and scan in Feishu to create
 * / authorize the app. Resolves with { client_id, client_secret }, which you
 * feed into createLarkChannel.
 */
import { registerApp } from '../src/index';
import { log, ok } from './env';

async function main() {
  log('starting QR registration…');
  const result = await registerApp({
    onQRCodeReady: ({ url, expireIn }) => {
      ok(`scan to register (expires in ${expireIn}s):`);
      console.log(`\n  ${url}\n`);
    },
    onStatusChange: (s) => log('status:', s.status),
  });
  ok('registered →', { client_id: result.client_id, hasSecret: Boolean(result.client_secret) });
  // const channel = createLarkChannel({ appId: result.client_id, appSecret: result.client_secret });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
