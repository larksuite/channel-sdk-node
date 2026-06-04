/**
 * Shared config / helpers. Examples import the source directly (../src) and run
 * with tsx — no build needed.
 *
 * Environment variables:
 *   LARK_APP_ID, LARK_APP_SECRET        required (except 06-normalize / 07-policy)
 *   LARK_TEST_CHAT_ID                   target chat for send/receive examples (open_chat_id)
 *   LARK_TEST_DOC_TOKEN / _DOC_TYPE     cloud-doc token / type for the comment example (default docx)
 *   LARK_TEST_COMMENT_ID                comment id for the comment example
 *   LARK_DOMAIN                         optional, Feishu/Lark domain
 *   HTTPS_PROXY                         optional, used together with respectProxyEnv
 */
import { join } from 'node:path';
import { createLarkChannel, type LarkChannelOptions } from '../src/index';

// Auto-load examples/.env (built into Node >= 20.12). Running `tsx examples/xx.ts`
// from the terminal picks values up from here; under VS Code debugging the
// launch.json `envFile` already injected them, so re-loading the same values is
// a no-op. If the file is missing it's ignored and we fall back to shell env.
try {
  process.loadEnvFile?.(join(import.meta.dirname, '.env'));
} catch {
  /* no .env — rely on shell environment variables */
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    fail(`missing environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

export const env = {
  appId: () => req('LARK_APP_ID'),
  appSecret: () => req('LARK_APP_SECRET'),
  chatId: () => req('LARK_TEST_CHAT_ID'),
  docToken: () => process.env.LARK_TEST_DOC_TOKEN,
  docType: () => process.env.LARK_TEST_DOC_TYPE ?? 'docx',
  commentId: () => process.env.LARK_TEST_COMMENT_ID,
  domain: () => process.env.LARK_DOMAIN,
};

export function makeChannel(extra?: Partial<LarkChannelOptions>) {
  return createLarkChannel({
    appId: env.appId(),
    appSecret: env.appSecret(),
    domain: env.domain(),
    respectProxyEnv: true,
    ...extra,
  });
}

export const log = (...a: unknown[]) => console.log('·', ...a);
export const ok = (...a: unknown[]) => console.log('\x1b[32m✓\x1b[0m', ...a);
export const fail = (...a: unknown[]) => console.error('\x1b[31m✗\x1b[0m', ...a);

// Run one step: print ✓ on success, ✗ + LarkChannelError.code on failure,
// without aborting the remaining steps.
export async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    ok(name, r === undefined ? '' : compact(r));
  } catch (e) {
    const err = e as { code?: string; message?: string };
    fail(name, '→', err?.code ?? '', err?.message ?? String(e));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function compact(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// A minimal interactive card (for the send card / updateCard examples).
export function simpleCard(text: string): object {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: text } },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '点我' }, type: 'primary', value: { act: 'click' } },
        ],
      },
    ],
  };
}
