import type { Cache, Domain, HttpInstance, LoggerLevel } from '@larksuiteoapi/node-sdk';
import type { Logger, WSConfigOverrides } from './internal';

// ─────────────────────────────────────────────────────────────
// Normalized inbound message — the core output of the channel
// ─────────────────────────────────────────────────────────────

export type ChatType = 'p2p' | 'group';

export interface NormalizedMessage {
  messageId: string;
  chatId: string;
  chatType: ChatType;
  /**
   * Finer-grained chat mode than {@link chatType}: distinguishes a topic
   * group ('topic') from an ordinary group ('group'). Only populated when
   * the channel is created with `resolveChatMode: true` — Feishu omits chat
   * mode from message events, so resolving it costs one cached `chat.get`
   * per chat. `undefined` when resolution is disabled or failed.
   */
  chatMode?: 'p2p' | 'group' | 'topic';
  senderId: string;
  senderName?: string;
  content: string;
  rawContentType: string;
  resources: ResourceDescriptor[];
  mentions: MentionInfo[];
  mentionAll: boolean;
  mentionedBot: boolean;
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
  createTime: number;
  raw?: unknown;
}

export interface ResourceDescriptor {
  type: 'image' | 'file' | 'audio' | 'video' | 'sticker';
  fileKey: string;
  fileName?: string;
  durationMs?: number;
  coverImageKey?: string;
}

export interface MentionInfo {
  key: string;
  openId?: string;
  userId?: string;
  name?: string;
  isBot?: boolean;
}

export interface BotIdentity {
  openId: string;
  userId?: string;
  name: string;
}

// ─────────────────────────────────────────────────────────────
// Outbound send / stream
// ─────────────────────────────────────────────────────────────

export type SendInput =
  | { markdown: string }
  | { text: string }
  | { post: object }
  | { image: { source: string | Buffer } }
  | { file: { source: string | Buffer; fileName: string } }
  | { audio: { source: string | Buffer; duration?: number } }
  | { video: { source: string | Buffer; duration?: number; coverImageKey?: string } }
  | { card: object }
  | { cardId: string }
  | { shareChat: { chatId: string } }
  | { shareUser: { userId: string } }
  | { sticker: { fileKey: string } };

export interface MediaSource {
  source: string | Buffer;
}

export interface SendOptions {
  replyTo?: string;
  replyInThread?: boolean;
  mentions?: MentionInfo[];
}

export interface SendResult {
  messageId: string;
  chunkIds?: string[];
}

export type StreamInput =
  | { markdown: MarkdownStreamProducer }
  | { card: { initial: object; producer: CardStreamProducer } };

export type MarkdownStreamProducer = (controller: MarkdownStreamController) => Promise<void>;
export type CardStreamProducer = (controller: CardStreamController) => Promise<void>;

export interface MarkdownStreamController {
  append(chunk: string): Promise<void>;
  setContent(full: string): Promise<void>;
  readonly messageId: string;
}

export interface CardStreamController {
  update(next: object | ((current: object) => object)): Promise<void>;
  readonly messageId: string;
  readonly current: object;
}

// ─────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────

export interface EventMap {
  message: (msg: NormalizedMessage) => void | Promise<void>;
  reject: (evt: RejectEvent) => void;
  cardAction: (evt: CardActionEvent) => void | Promise<void>;
  reaction: (evt: ReactionEvent) => void;
  botAdded: (evt: BotAddedEvent) => void;
  comment: (evt: CommentEvent) => void | Promise<void>;
  error: (err: LarkChannelError) => void;
  reconnecting: () => void;
  reconnected: () => void;
}

export type EventName = keyof EventMap;

/**
 * Reason for a {@link RejectEvent}. These are the set of policy-level
 * decisions that deliberately reject a message and inform the caller.
 *
 * Internal defenses (duplicate dedup, stale/expired timestamps, in-flight
 * processing lock) silently drop their targets — they are not reject
 * reasons, because the caller cannot act on them meaningfully.
 */
export type RejectReason =
  | 'group_not_allowed'
  | 'sender_not_allowed'
  | 'no_mention'
  | 'dm_disabled'
  | 'mention_all_blocked';

export interface RejectEvent {
  messageId: string;
  chatId: string;
  senderId: string;
  reason: RejectReason;
}

export interface CardActionEvent {
  messageId: string;
  chatId: string;
  operator: { openId: string; userId?: string; name?: string };
  action: {
    value: unknown;
    tag: string;
    name?: string;
    option?: string;
    /**
     * CardKit 2.0 form submission values, keyed by element name. Present
     * only on form-submit actions; `undefined` for plain button clicks.
     * Sunk from bridge, which previously had to enable `includeRawEvent`
     * just to read `action.form_value`.
     */
    formValue?: Record<string, unknown>;
  };
  raw?: unknown;
}

export interface ReactionEvent {
  messageId: string;
  operator: { openId: string; userId?: string };
  emojiType: string;
  action: 'added' | 'removed';
  actionTime?: number;
  raw?: unknown;
}

export interface BotAddedEvent {
  chatId: string;
  operator: { openId: string; userId?: string };
  /**
   * The bot's own name as carried in the `name` field of the Feishu event.
   * Not the chat's name — that requires a separate `getChatInfo(chatId)`
   * call, which callers can do on demand.
   */
  botName?: string;
  external?: boolean;
  raw?: unknown;
}

export interface CommentEvent {
  fileToken: string;
  fileType: string;
  commentId: string;
  replyId?: string;
  operator: { openId: string; userId?: string; unionId?: string };
  mentionedBot: boolean;
  timestamp: number;
  raw?: unknown;
}

export type LarkChannelErrorCode =
  | 'format_error'
  | 'target_revoked'
  | 'rate_limited'
  | 'permission_denied'
  | 'upload_failed'
  | 'ssrf_blocked'
  | 'send_timeout'
  | 'not_connected'
  | 'unknown';

export class LarkChannelError extends Error {
  code: LarkChannelErrorCode;

  cause?: unknown;

  context?: { to?: string; messageId?: string; attempt?: number };

  constructor(
    code: LarkChannelErrorCode,
    message: string,
    opts?: { cause?: unknown; context?: LarkChannelError['context'] },
  ) {
    super(message);
    this.name = 'LarkChannelError';
    this.code = code;
    this.cause = opts?.cause;
    this.context = opts?.context;
  }
}

// ─────────────────────────────────────────────────────────────
// Channel configuration
// ─────────────────────────────────────────────────────────────

export interface LarkChannelOptions {
  appId: string;
  appSecret: string;

  transport?: 'websocket' | 'webhook';
  webhook?: WebhookOptions;

  safety?: SafetyConfig;
  policy?: PolicyConfig;
  outbound?: OutboundConfig;

  logger?: Logger;
  loggerLevel?: LoggerLevel;
  cache?: Cache;
  domain?: Domain | string;
  httpInstance?: HttpInstance;

  /** Caller tag appended to User-Agent as `source/<name>`. */
  source?: string;

  /**
   * Client-only WebSocket settings (currently `pingTimeout`). Forwarded
   * to the underlying WSClient. Server-pushed values like ping cadence,
   * reconnect interval / count are not exposed here — they stay
   * server-authoritative.
   */
  wsConfig?: WSConfigOverrides;

  /**
   * Maximum time (ms) to wait for the WebSocket handshake (`open` /
   * `error`) before aborting the attempt and letting the retry loop try
   * again. When unset, no timeout is enforced — the handshake can hang
   * indefinitely on stuck DNS / proxy / NAT paths.
   */
  handshakeTimeoutMs?: number;

  /**
   * Optional Node http(s) agent forwarded to the underlying WSClient for
   * the WebSocket transport. Useful for routing the WS through an HTTP(S)
   * proxy or for customizing TLS / keepalive.
   */
  agent?: any;

  /**
   * Attach the raw Feishu event body on every normalized event
   * (`message`, `cardAction`, `reaction`, `botAdded`, `comment`) as
   * `evt.raw`. Useful when a handler needs fields that the normalizer
   * dropped (e.g. `tenant_key`, `host`, `event_id`, vendor-specific
   * extensions). Off by default — payloads are smaller and stricter.
   */
  includeRawEvent?: boolean;

  /** @deprecated Use `includeRawEvent` instead. Retained for backward compatibility. */
  includeRawInMessage?: boolean;

  /**
   * Populate {@link NormalizedMessage.chatMode} on every inbound message by
   * resolving the chat's mode (p2p / group / topic) — which Feishu omits
   * from message events. Costs one cached `chat.get` per chat (best-effort;
   * falls back to 'group' on failure). Off by default to avoid the extra
   * API call for callers that don't need topic-group awareness.
   */
  resolveChatMode?: boolean;

  /**
   * App-level keepalive watchdog (defense-in-depth above the SDK's internal
   * ping). When enabled, an independent timer probes the connection and
   * force-reconnects the WebSocket if it looks stuck while the network is
   * reachable. `onUnrecoverable` fires when even a forced reconnect fails,
   * so the app can decide what to do (e.g. restart the process). WebSocket
   * transport only. Off by default.
   */
  keepalive?: {
    enabled?: boolean;
    onUnrecoverable?: (err: unknown) => void;
    /** Heartbeat interval in ms (default 15000). */
    intervalMs?: number;
  };

  /**
   * Per-request timeout (ms) for outbound REST calls. Without it a hung
   * Feishu API can block the bot indefinitely. Applied to node-sdk's shared
   * `defaultHttpInstance` (a process-wide singleton, so it also affects other
   * Clients using the default). Ignored when you supply your own
   * {@link httpInstance} — configure that instance yourself. Unset = no
   * client-side REST timeout.
   */
  httpTimeoutMs?: number;

  /**
   * Read `HTTPS_PROXY` / `HTTP_PROXY` from the environment and route traffic
   * through it: the WebSocket transport (via the WS `agent`, unless an
   * explicit {@link agent} is given) and outbound REST calls (via the shared
   * `defaultHttpInstance`, unless a custom {@link httpInstance} is supplied).
   * Off by default.
   */
  respectProxyEnv?: boolean;
}

export interface WebhookOptions {
  verificationToken?: string;
  encryptKey?: string;
  adapter?: 'express' | 'koa' | 'koa-router';
}

export interface SafetyConfig {
  dedup?: {
    ttl?: number;
    maxEntries?: number;
    sweepIntervalMs?: number;
  };
  chatQueue?: {
    enabled?: boolean;
    /**
     * While a chat's handler is in-flight, accumulate every newly-arrived
     * message and deliver them as a single merged batch the moment the
     * in-flight handler drains — instead of letting the debounce window
     * queue up multiple sequential batches. The `message` callback still
     * receives one merged {@link NormalizedMessage} (delivery shape
     * unchanged). Sunk from bridge's `pending-queue.ts`. Off by default.
     */
    mergeWhileBusy?: boolean;
  };
  batch?: {
    text?: {
      delayMs?: number;
      longThresholdChars?: number;
      longDelayMs?: number;
      maxMessages?: number;
      maxChars?: number;
    };
    media?: {
      delayMs?: number;
      maxItems?: number;
    };
  };
  staleMessageWindowMs?: number;
}

export interface PolicyConfig {
  groupAllowlist?: string[];
  dmMode?: 'open' | 'allowlist' | 'pair' | 'disabled';
  dmAllowlist?: string[];
  requireMention?: boolean;
  respondToMentionAll?: boolean;
}

export interface OutboundConfig {
  textChunkLimit?: number;
  markdownConverter?: 'builtin' | ((md: string) => object);
  streamThrottleMs?: number;
  streamThrottleChars?: number;
  streamInitialText?: string;
  /**
   * Maximum character count of a single streaming card's markdown element
   * before the controller rolls over to a new card. Feishu enforces a
   * per-element size limit on `cardkit.cardElement.content` updates; once
   * cumulative AI output approaches that limit, further updates are
   * rejected with `code: 230099 / ErrCode: 11310 "element exceeds the
   * limit"`. The controller pre-emptively splits and creates a follow-up
   * card so generation can continue without interruption.
   *
   * Default: 30000.
   */
  streamMaxElementChars?: number;
  ssrfGuard?: boolean | { allowlist?: string[] };
  /**
   * Allowlist of directories that a **local file** media `source` may be read
   * from. **Required for local file sources: when unset (or empty), local file
   * paths are rejected outright** — only `Buffer` and `http(s)` URL sources
   * work without it. This default-deny avoids reading arbitrary files
   * (`~/.ssh/id_rsa`, `.env`, …) when `source` is attacker-influenced. When
   * set, every path must resolve inside one of these directories, a POSIX
   * blocklist (`/etc/`, `/proc/`, `/sys/`, `/dev/`) still applies, and symlink
   * targets are re-checked after `realpath`.
   */
  allowedFileDirs?: string[];
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
  };
}

// ─────────────────────────────────────────────────────────────
// Low-level return types
// ─────────────────────────────────────────────────────────────

export interface ChatInfo {
  chatId: string;
  name?: string;
  description?: string;
  chatType: 'p2p' | 'group';
  ownerId?: string;
  memberCount?: number;
}

export type IdType = 'open_id' | 'user_id' | 'union_id';

export interface CreateChatOptions {
  name: string;
  description?: string;
  /** Users to seed the new chat with. Interpreted per {@link userIdType}. */
  inviteUserIds?: string[];
  /** ID convention for {@link inviteUserIds}. Defaults to `'open_id'`. */
  userIdType?: IdType;
  /** Defaults to `'group'`. */
  chatMode?: 'group';
  /** Visibility — `'private'` (default) or `'public'`. */
  chatType?: 'private' | 'public';
}

/** One entry from {@link LarkChannel.listChats}. */
export interface ChatSummary {
  id: string;
  name: string;
}

/** Subset of `application.v6.application.get` the channel surfaces. */
export interface AppInfo {
  /** open_id (or the requested id type) of the app's owner/admin. */
  ownerId?: string;
  appName?: string;
}

export type ResourceType = 'image' | 'file';
