import type { Logger } from '../internal';
import type { BotIdentity, NormalizedMessage, PolicyConfig, RejectReason } from '../types';

export interface PolicyDecision {
  allowed: boolean;
  reason?: RejectReason;
}

export class PolicyGate {
  private cfg: PolicyConfig;

  private bot?: BotIdentity;

  private readonly logger?: Logger;

  constructor(cfg: PolicyConfig | undefined, bot?: BotIdentity, logger?: Logger) {
    this.cfg = { ...(cfg ?? {}) };
    this.bot = bot;
    this.logger = logger;
    this.warnOnMisconfiguredAllowlists();
  }

  evaluate(msg: NormalizedMessage): PolicyDecision {
    if (msg.chatType === 'group') return this.evaluateGroup(msg);
    return this.evaluateDm(msg);
  }

  private evaluateGroup(msg: NormalizedMessage): PolicyDecision {
    const allow = this.cfg.groupAllowlist;
    if (allow && allow.length > 0 && !allow.includes(msg.chatId)) {
      return { allowed: false, reason: 'group_not_allowed' };
    }
    const requireMention = this.cfg.requireMention ?? true;
    if (requireMention && !msg.mentionedBot) {
      return { allowed: false, reason: 'no_mention' };
    }
    if (msg.mentionAll && !(this.cfg.respondToMentionAll ?? false)) {
      return { allowed: false, reason: 'mention_all_blocked' };
    }
    return { allowed: true };
  }

  private evaluateDm(msg: NormalizedMessage): PolicyDecision {
    const mode = this.cfg.dmMode ?? 'open';
    if (mode === 'disabled') {
      return { allowed: false, reason: 'dm_disabled' };
    }
    if (mode === 'allowlist') {
      const allow = this.cfg.dmAllowlist ?? [];
      if (!allow.includes(msg.senderId)) {
        return { allowed: false, reason: 'sender_not_allowed' };
      }
    }
    // 'pair' mode is reserved for a future iteration; treat as open for now.
    return { allowed: true };
  }

  updateConfig(partial: Partial<PolicyConfig>): void {
    this.cfg = { ...this.cfg, ...partial };
    this.warnOnMisconfiguredAllowlists();
  }

  /**
   * Flag the most common allowlist misconfiguration: an app id (`cli_…`) in a
   * list that expects sender ids / chat ids, which silently matches nothing.
   * Logs only the field name and the single offending value — never the whole
   * list (no PII / full-table dumps).
   */
  private warnOnMisconfiguredAllowlists(): void {
    this.warnOnCliEntry('dmAllowlist', 'sender ids (ou_/user_id/union_id)', this.cfg.dmAllowlist);
    this.warnOnCliEntry('groupAllowlist', 'chat ids (oc_)', this.cfg.groupAllowlist);
  }

  private warnOnCliEntry(field: string, accepts: string, list?: string[]): void {
    if (!this.logger) return;
    const offending = list?.find((entry) => entry.startsWith('cli_'));
    if (!offending) return;
    this.logger.warn?.(
      `channel: PolicyConfig.${field} contains an app id ("${offending}") — it accepts ${accepts}, not cli_; this entry matches nothing`,
    );
  }

  getConfig(): Readonly<PolicyConfig> {
    return this.cfg;
  }

  setBotIdentity(bot: BotIdentity): void {
    this.bot = bot;
  }

  getBotIdentity(): BotIdentity | undefined {
    return this.bot;
  }
}
