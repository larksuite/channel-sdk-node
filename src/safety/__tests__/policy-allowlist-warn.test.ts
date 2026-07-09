/**
 * allowFrom mis-configuration warning.
 *
 * `dmAllowlist` / `groupAllowlist` accept sender open_id / chat_id, never an
 * app id (`cli_`). When a `cli_` entry appears, PolicyGate must emit exactly
 * one `warn` naming the field and the single offending value — WITHOUT dumping
 * the whole allowlist (no PII / full-table logging). The warning must not
 * change matching behavior.
 *
 * PolicyGate is expected to accept an injected logger: `new PolicyGate(cfg,
 * bot?, logger)`.
 */

import type { NormalizedMessage } from '../../types';
import { PolicyGate } from '../policy-gate';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

// Flatten every warn call's args into one string so we can assert what the
// message does and does NOT contain, regardless of how the args are split.
function warnText(logger: ReturnType<typeof makeLogger>): string {
  return logger.warn.mock.calls.flat().map(String).join(' ');
}

describe('cli_ mis-configuration warning', () => {
  test('dmAllowlist with a cli_ entry warns once, names the field + bad value only', () => {
    const logger = makeLogger();
    new PolicyGate({ dmAllowlist: ['cli_abc', 'ou_valid'] }, undefined, logger as any);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const text = warnText(logger);
    expect(text).toContain('dmAllowlist');
    expect(text).toContain('cli_abc');
    // The valid entry must not be echoed — no full-table dump.
    expect(text).not.toContain('ou_valid');
  });

  test('groupAllowlist with a cli_ entry warns once, names the field + bad value only', () => {
    const logger = makeLogger();
    new PolicyGate({ groupAllowlist: ['cli_x', 'oc_valid'] }, undefined, logger as any);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const text = warnText(logger);
    expect(text).toContain('groupAllowlist');
    expect(text).toContain('cli_x');
    expect(text).not.toContain('oc_valid');
  });

  test('well-formed allowlists (ou_ / oc_) do not warn', () => {
    const logger = makeLogger();
    new PolicyGate({ dmAllowlist: ['ou_a'], groupAllowlist: ['oc_a'] }, undefined, logger as any);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('the warning does not change matching — a real sender still fails an all-cli_ allowlist', () => {
    const logger = makeLogger();
    const gate = new PolicyGate(
      { dmMode: 'allowlist', dmAllowlist: ['cli_x'] },
      undefined,
      logger as any,
    );
    // A real DM sender is always an open_id / user_id, never cli_, so a
    // cli_-only allowlist grants access to no one.
    const decision = gate.evaluate({
      messageId: 'om_1',
      chatId: 'oc_dm',
      chatType: 'p2p',
      senderId: 'ou_alice',
      content: 'hi',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: Date.now(),
    } as NormalizedMessage);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('sender_not_allowed');
  });
});
