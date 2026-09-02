import { createWriteStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  Client,
  Domain,
  defaultHttpInstance,
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ChatMemberCache } from './chat-member-cache';
import { ChatModeCache } from './chat-mode-cache';
import { CommentSurface } from './comments';
import {
  defaultLogger,
  internalCache,
  type Logger,
  LoggerProxy,
  type WSConnectionStatus,
} from './internal';
import { type KeepaliveHandle, startKeepalive } from './keepalive';
import { MeetingChannel } from './meeting';
import type {
  FollowMeetingOptions,
  JoinMeetingOptions,
  MeetingEventHealth,
  MeetingMembership,
  MeetingSession,
} from './meeting/types';
import type { ApiMessageItem, RawMessageEvent } from './normalize';
import {
  normalize,
  normalizeBotAdded,
  normalizeCardAction,
  normalizeComment,
  normalizeReaction,
} from './normalize';
import { OutboundSender, retry } from './outbound';
import { classifyError } from './outbound/errors';
import { resolveMentionsInText, resolveNameMentions } from './outbound/markdown/resolve-mentions';
import { SafetyPipeline } from './safety';
import {
  type AppInfo,
  type BotIdentity,
  type ChatInfo,
  type ChatMember,
  type ChatSummary,
  type CreateChatOptions,
  type EventMap,
  type EventName,
  type IdType,
  LarkChannelError,
  type LarkChannelOptions,
  type MentionInfo,
  type NormalizedMessage,
  type PolicyConfig,
  type ResourceType,
  type SendInput,
  type SendOptions,
  type SendResult,
  type StreamInput,
} from './types';

type Unsubscribe = () => void;

/** Fallback budget for {@link LarkChannelOptions.connectTimeoutMs}. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * `setTimeout`'s 32-bit ceiling. Anything above it wraps to a 1ms delay, so a
 * deliberately generous budget would otherwise become an instant timeout.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Options for {@link LarkChannel.getChatMembers}. */
interface GetChatMembersOptions {
  pageSize?: number;
  maxPages?: number;
  idType?: IdType;
  /** Skip the roster cache and refetch. */
  force?: boolean;
}

/** One page of the raw `im.v1.chatMembers.get` response we consume. */
interface RawChatMembersPage {
  items?: Array<{
    member_id?: string;
    member_id_type?: string;
    name?: string;
    tenant_key?: string;
  }>;
  has_more?: boolean;
  page_token?: string;
}

/** One item of the raw `.../members/bots` response. */
interface RawBotItem {
  bot_id?: string;
  bot_name?: string;
}

export class LarkChannel {
  readonly rawClient: Client;

  rawWsClient?: WSClient;

  botIdentity?: BotIdentity;

  /** Cloud-doc comment surface: fetch / reply / reactions with quirk fallbacks. */
  readonly comments: CommentSurface;

  /**
   * Meeting channel internals. Private so its wiring methods do not become de
   * facto public API of a pre-1.0 package — the supported surface is
   * {@link joinMeeting}, {@link followMyMeeting} and {@link getMeetingEventHealth}.
   */
  private readonly meetings: MeetingChannel;

  private readonly opts: LarkChannelOptions;

  private readonly logger: Logger;

  private readonly dispatcher: EventDispatcher;

  private readonly handlers: Partial<EventMap> = {};

  private connectPromise?: Promise<void>;

  private connected = false;

  private readonly sender: OutboundSender;

  private readonly safety: SafetyPipeline;

  private readonly chatModeCache = new ChatModeCache();

  private readonly chatMemberCache = new ChatMemberCache();

  private keepaliveHandle?: KeepaliveHandle;

  private proxyAgent?: HttpsProxyAgent<string>;

  /**
   * The channel's own dispatcher handlers, keyed by event type. Read at dispatch
   * time rather than captured, so `onRawEvent` can compose with them whether it
   * is called before or after `connect()`.
   */
  private builtinHandlers: Record<string, (raw: unknown) => unknown> = {};

  private readonly rawHandlers = new Map<string, Set<(payload: unknown) => unknown>>();

  /**
   * Event types already wired into the dispatcher. `EventDispatcher.register`
   * logs an error when a key is re-registered, so each type gets exactly one
   * composed entry and the composition reads mutable state instead.
   */
  private readonly dispatchedTypes = new Set<string>();

  constructor(opts: LarkChannelOptions) {
    this.opts = opts;
    this.logger = new LoggerProxy(
      opts.loggerLevel ?? LoggerLevel.info,
      opts.logger ?? defaultLogger,
    );

    this.rawClient = new Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: opts.domain ?? Domain.Feishu,
      cache: opts.cache,
      httpInstance: opts.httpInstance,
      logger: opts.logger,
      loggerLevel: opts.loggerLevel,
      source: opts.source,
      extraUaTags: ['channel'],
    });

    this.dispatcher = new EventDispatcher({
      verificationToken: opts.webhook?.verificationToken,
      encryptKey: opts.webhook?.encryptKey,
      cache: opts.cache,
      logger: opts.logger,
      loggerLevel: opts.loggerLevel,
    });

    this.sender = new OutboundSender(this.rawClient, opts.outbound ?? {}, this.logger);

    this.comments = new CommentSurface(this.rawClient, this.logger);

    this.meetings = new MeetingChannel({
      client: this.rawClient,
      logger: this.logger,
      cache: opts.cache ?? internalCache,
      config: opts.meeting,
      includeRaw: opts.includeRawEvent ?? opts.includeRawInMessage ?? false,
      // Late-bound: the bot's own open_id is only known once connected, and
      // selfEcho compares against it.
      botOpenId: () => this.botIdentity?.openId,
      isConnected: () => this.connected,
      invitedHandler: () => this.handlers.meetingInvited,
      onError: (e) => this.emitError(e),
    });

    this.configureHttp();

    this.safety = new SafetyPipeline({
      config: opts.safety,
      policy: opts.policy,
      cache: opts.cache ?? internalCache,
      logger: this.logger,
      onReject: (evt) => {
        this.handlers.reject?.(evt);
      },
      onMessage: async (merged) => {
        const handler = this.handlers.message;
        if (handler) await handler(merged);
      },
      onError: (error) => this.emitError(error),
    });
  }

  // ─── lifecycle ──────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().catch((err) => {
      this.connectPromise = undefined;
      throw err;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    this.botIdentity = await this.fetchBotIdentity();
    this.safety.setBotIdentity(this.botIdentity);
    this.registerDispatcherHandlers();

    const transport = this.opts.transport ?? 'websocket';
    if (transport === 'websocket') {
      await this.connectWebSocket(this.resolveConnectTimeoutMs());
      this.startKeepaliveIfEnabled();
    }
    // webhook transport wiring is external: user plugs this.dispatcher into
    // their HTTP handler via the existing adaptor modules.
    this.connected = true;
  }

  private startKeepaliveIfEnabled(): void {
    if (!this.opts.keepalive?.enabled || this.keepaliveHandle) return;
    this.keepaliveHandle = startKeepalive({
      getConnectionStatus: () => this.getConnectionStatus(),
      domain: String(this.opts.domain ?? Domain.Feishu),
      forceReconnect: () => this.forceReconnect(),
      onUnrecoverable: this.opts.keepalive.onUnrecoverable,
      logger: this.logger,
      intervalMs: this.opts.keepalive.intervalMs,
    });
  }

  /**
   * Tear down the current WebSocket and re-establish it. Used by the
   * keepalive watchdog when the connection looks stuck. Throws if the fresh
   * handshake fails, so keepalive can surface it via `onUnrecoverable`.
   */
  private async forceReconnect(): Promise<void> {
    try {
      this.rawWsClient?.close({ force: true });
    } catch {
      /* best effort */
    }
    this.rawWsClient = undefined;
    await this.connectWebSocket(this.resolveConnectTimeoutMs());
  }

  /**
   * Shared by `connect()` and `forceReconnect()` so the two can't drift apart.
   * Value domain and the reason for the fallback: see
   * {@link LarkChannelOptions.connectTimeoutMs}.
   */
  private resolveConnectTimeoutMs(): number {
    const configured = this.opts.connectTimeoutMs;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.min(configured, MAX_TIMER_DELAY_MS);
    }
    return DEFAULT_CONNECT_TIMEOUT_MS;
  }

  /**
   * Apply a per-request timeout and/or proxy to node-sdk's shared
   * `defaultHttpInstance` (a typed `AxiosInstance` — `defaults` is visible,
   * no cast needed). Only runs when the caller opted in, and only when no
   * custom `httpInstance` was supplied: a caller who brings their own HTTP
   * instance owns its configuration, and we don't mutate a process-wide
   * singleton behind their back.
   */
  private configureHttp(): void {
    if (this.opts.httpInstance) return;
    const timeout = this.opts.httpTimeoutMs;
    const proxyAgent = this.opts.respectProxyEnv ? this.proxyAgentFromEnv() : undefined;
    if (timeout == null && !proxyAgent) return;
    if (timeout != null) defaultHttpInstance.defaults.timeout = timeout;
    if (proxyAgent) {
      defaultHttpInstance.defaults.httpsAgent = proxyAgent;
      defaultHttpInstance.defaults.httpAgent = proxyAgent;
    }
  }

  /**
   * Resolve the Node http(s) agent for the WebSocket transport: an explicit
   * `agent` option wins; otherwise, when `respectProxyEnv` is set, build one
   * from `HTTPS_PROXY` / `HTTP_PROXY`.
   */
  private resolveWsAgent(): unknown {
    if (this.opts.agent) return this.opts.agent;
    if (!this.opts.respectProxyEnv) return undefined;
    return this.proxyAgentFromEnv();
  }

  /** Lazily build (and cache) a proxy agent from the proxy env vars. Shared
   *  by the WebSocket transport and the REST HTTP instance. */
  private proxyAgentFromEnv(): HttpsProxyAgent<string> | undefined {
    if (this.proxyAgent) return this.proxyAgent;
    const proxyUrl =
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy;
    if (!proxyUrl) return undefined;
    this.proxyAgent = new HttpsProxyAgent(proxyUrl);
    this.logger.info?.('channel: proxy detected', { proxy: redactProxyUrl(proxyUrl) });
    return this.proxyAgent;
  }

  /**
   * Construct the underlying WSClient and wait for its `onReady` callback —
   * so `connect()` only resolves after the first WebSocket handshake
   * actually succeeds. Rejects on `onError` or if the handshake doesn't
   * complete within `timeoutMs`.
   *
   * Also wires `onReconnecting` / `onReconnected` callbacks to emit the
   * corresponding public events.
   */
  private connectWebSocket(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // Held per attempt rather than read off `this.rawWsClient`: a concurrent
      // reconnect may already have repointed that field at a newer client, and
      // tearing that one down would kill a live session.
      let attemptClient: WSClient | undefined;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // The caller has given up on this attempt and may start another right
        // away. Left alone, this client keeps reconnecting on its own —
        // leaking a socket and timers, and still delivering events into the
        // caller's handlers — with nothing left holding a reference to it.
        // See https://github.com/larksuite/node-sdk/issues/197
        try {
          attemptClient?.close({ force: true });
        } catch {
          /* best effort */
        }
        reject(
          new LarkChannelError(
            'not_connected',
            `WebSocket handshake did not complete within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      attemptClient = new WSClient({
        appId: this.opts.appId,
        appSecret: this.opts.appSecret,
        domain: this.opts.domain ?? Domain.Feishu,
        logger: this.opts.logger,
        loggerLevel: this.opts.loggerLevel,
        httpInstance: this.opts.httpInstance,
        autoReconnect: true,
        source: this.opts.source,
        extraUaTags: ['channel'],
        agent: this.resolveWsAgent(),
        wsConfig: this.opts.wsConfig,
        handshakeTimeoutMs: this.opts.handshakeTimeoutMs,
        onReady: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        onError: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(
            new LarkChannelError('not_connected', `WebSocket connect failed: ${err.message}`, {
              cause: err,
            }),
          );
        },
        onReconnecting: () => this.handlers.reconnecting?.(),
        onReconnected: () => this.handlers.reconnected?.(),
      });
      this.rawWsClient = attemptClient;
      attemptClient.start({ eventDispatcher: this.dispatcher });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.keepaliveHandle?.stop();
    this.keepaliveHandle = undefined;
    // Dispose, never leave: a reconnect must not make the bot disappear from
    // every meeting it is in. Two consequences the caller has to handle, both
    // documented on `getRetainedMeetings`: sessions end with `disposed` and are
    // NOT rebuilt by a later `connect()`, and the bot lingers as a participant
    // until someone leaves it.
    this.meetings.disposeAll();
    try {
      this.rawWsClient?.close({});
    } catch {
      /* best effort */
    }
    try {
      await this.safety.dispose();
    } catch {
      /* best effort */
    }
    this.connected = false;
    this.connectPromise = undefined;
  }

  /**
   * Snapshot of the WebSocket lifecycle (state, last/next connect times,
   * current reconnect attempts). Returns `undefined` when the channel
   * hasn't initialized a WSClient yet (e.g., before `connect()` is called
   * or under the webhook transport).
   */
  getConnectionStatus(): WSConnectionStatus | undefined {
    return this.rawWsClient?.getConnectionStatus();
  }

  /**
   * This bot's own identity ({@link BotIdentity}) — useful to inline into an
   * agent's system prompt ("you are @… / your open_id is …") so it can tell
   * itself apart from other bots and decide whom to reply to. Resolved during
   * {@link connect}; throws `LarkChannelError('not_connected')` if called
   * before then, rather than returning `undefined`, so callers don't silently
   * build a prompt with a missing identity.
   */
  getBotIdentity(): BotIdentity {
    if (!this.botIdentity) {
      throw new LarkChannelError(
        'not_connected',
        'bot identity not resolved yet — call connect() first',
      );
    }
    return this.botIdentity;
  }

  // ─── event subscription ────────────────────────────────

  on<K extends EventName>(name: K, handler: EventMap[K]): Unsubscribe;

  on(handlers: Partial<EventMap>): Unsubscribe;

  on(nameOrMap: EventName | Partial<EventMap>, handler?: EventMap[EventName]): Unsubscribe {
    if (typeof nameOrMap === 'string') {
      return this.attachSingle(nameOrMap, handler as EventMap[EventName]);
    }
    const unsubs: Unsubscribe[] = [];
    (Object.keys(nameOrMap) as EventName[]).forEach((k) => {
      const fn = nameOrMap[k];
      if (fn) unsubs.push(this.attachSingle(k, fn as EventMap[EventName]));
    });
    return () => {
      unsubs.forEach((u) => {
        u();
      });
    };
  }

  private attachSingle<K extends EventName>(name: K, handler: EventMap[K]): Unsubscribe {
    if (this.handlers[name]) {
      this.logger.warn(`channel: handler for "${name}" is being overwritten`);
    }
    this.handlers[name] = handler;
    return () => {
      if (this.handlers[name] === handler) delete this.handlers[name];
    };
  }

  // ─── outbound ──────────────────────────────────────────

  async send(to: string, input: SendInput, opts?: SendOptions): Promise<SendResult> {
    const resolved = this.resolveOutboundMentions(to, input, opts);
    return this.sender.send(to, resolved.input, resolved.opts);
  }

  async stream(to: string, input: StreamInput, opts?: SendOptions): Promise<SendResult> {
    return this.sender.stream(to, input, opts);
  }

  /**
   * Reply to a received message: defaults `replyTo` to `msg.messageId` and,
   * when the trigger is inside a topic thread (`msg.threadId` present), keeps
   * the reply in that thread — fixing the common "replied to the wrong place /
   * fell out of the topic" mistake of computing the reply target by hand.
   * `opts` overrides either default. Semantically a {@link send}; streaming
   * replies still use `stream(to, input, { replyTo })`.
   */
  async reply(
    msg: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'>,
    input: SendInput,
    opts?: SendOptions,
  ): Promise<SendResult> {
    return this.send(msg.chatId, input, {
      ...opts,
      replyTo: opts?.replyTo ?? msg.messageId,
      replyInThread: opts?.replyInThread ?? Boolean(msg.threadId),
    });
  }

  /**
   * Resolve "@name" into real mentions against the target chat's roster before
   * sending: fill `openId` on name-only structured mentions, and — when
   * `resolveMentionsInText` is set — rewrite `@name` tokens in a text/markdown
   * body. Both no-ops when there is nothing to resolve, so the default send
   * path is untouched.
   */
  private resolveOutboundMentions(
    to: string,
    input: SendInput,
    opts?: SendOptions,
  ): { input: SendInput; opts?: SendOptions } {
    if (!opts) return { input };
    const lookup = (name: string) => this.chatMemberCache.resolveOpenId(to, name);

    let nextOpts = opts;
    if (opts.mentions?.length) {
      nextOpts = { ...opts, mentions: resolveNameMentions(opts.mentions, lookup) };
    }

    let nextInput = input;
    if (opts.resolveMentionsInText) {
      if ('text' in input)
        nextInput = { ...input, text: resolveMentionsInText(input.text, lookup) };
      else if ('markdown' in input)
        nextInput = { ...input, markdown: resolveMentionsInText(input.markdown, lookup) };
    }

    return { input: nextInput, opts: nextOpts };
  }

  // ─── low-level ─────────────────────────────────────────

  async updateCard(messageId: string, card: object): Promise<void> {
    await this.sender.patchCard(messageId, card);
  }

  /**
   * Create a standalone CardKit 2.0 card entity (`cardkit.v1.card.create`) and
   * return its `card_id`. The card isn't attached to any message yet — send a
   * message that references it via `channel.send(to, { cardId })`, then drive
   * it with {@link updateCardById}. This is the managed-card lifecycle: one
   * entity, many in-place updates, decoupled from the message that displays it.
   */
  async createCard(cardJson: object): Promise<{ cardId: string }> {
    const cardId = await this.sender.createCardInstance(cardJson);
    return { cardId };
  }

  /**
   * Full-content update of a card entity by `card_id` (`cardkit.v1.card.update`).
   * `sequence` must strictly increase across calls for the same card — Feishu
   * rejects stale/out-of-order sequences so a slow update can't overwrite a
   * newer one. Unlike {@link updateCard} (which targets a message_id), this
   * updates the shared entity, so every message referencing the card_id
   * re-renders.
   */
  async updateCardById(cardId: string, cardJson: object, sequence: number): Promise<void> {
    await this.sender.updateCardFull(cardId, cardJson, sequence);
  }

  /**
   * Edit an already-sent message's text/post content. Uses `im.v1.message.update`
   * which (per Feishu docs) only supports editing text and rich-text (post)
   * messages. For cards, use {@link updateCard} instead — a wrong attempt to
   * use this on a card would hit the same API and fail with a clearer
   * Feishu-side error.
   */
  async editMessage(messageId: string, text: string): Promise<void> {
    await this.rawClient.im.v1.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      } as never,
    });
  }

  async recallMessage(messageId: string): Promise<void> {
    await this.rawClient.im.v1.message.delete({
      path: { message_id: messageId },
    });
  }

  /**
   * Add an emoji reaction to a message. Returns the `reaction_id` Feishu
   * assigned — stash it if you want to {@link removeReaction} later,
   * since the raw `im.message.reaction.*_v1` events don't carry the id.
   * Only the bot's own reactions can be removed.
   */
  async addReaction(messageId: string, emojiType: string): Promise<string> {
    const r = await this.rawClient.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } } as never,
    });
    const rid =
      (r as { data?: { reaction_id?: string } } | null)?.data?.reaction_id ??
      (r as { reaction_id?: string } | null)?.reaction_id;
    if (!rid) {
      throw new LarkChannelError('unknown', 'messageReaction.create returned no reaction_id');
    }
    return rid;
  }

  /**
   * Remove a reaction by its `reaction_id` (the value returned from
   * {@link addReaction}). Only the bot's own reactions can be removed —
   * removing a user-added reaction will fail with a Feishu permission
   * error.
   */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await this.rawClient.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  }

  /**
   * Convenience: remove the bot's reaction on `messageId` matching
   * `emojiType`, without needing the `reaction_id`. Lists the message's
   * reactions filtered by emoji, picks the one added by this bot
   * (operator_type === 'app'), and deletes it. Returns `true` if a
   * matching reaction was found and deleted, `false` otherwise (including
   * the case where the bot never added that emoji).
   */
  async removeReactionByEmoji(messageId: string, emojiType: string): Promise<boolean> {
    const r = await this.rawClient.im.v1.messageReaction.list({
      path: { message_id: messageId },
      params: { reaction_type: emojiType, page_size: 50 } as never,
    });
    const items =
      (
        r as {
          data?: {
            items?: Array<{
              reaction_id?: string;
              operator?: { operator_type?: 'app' | 'user' };
            }>;
          };
        } | null
      )?.data?.items ?? [];
    const mine = items.find((it) => it.operator?.operator_type === 'app');
    if (!mine?.reaction_id) return false;
    await this.removeReaction(messageId, mine.reaction_id);
    return true;
  }

  /**
   * Download a resource (image / file / audio / video / sticker) carried by a
   * **received** message. Feishu serves message resources via
   * `im.v1.messageResource.get`, which needs both the owning `messageId` and
   * the resource's `fileKey` — the `im/v1/images|files/:key` endpoints only
   * work for media the app itself uploaded and return 400 for received media.
   *
   * `type` is `'image'` for image resources, `'file'` for everything else
   * (file / audio / video / sticker) — matching `ResourceDescriptor.type`.
   */
  async downloadResource(messageId: string, fileKey: string, type: ResourceType): Promise<Buffer> {
    const { buffer } = await this.downloadResourceWithMeta(messageId, fileKey, type);
    return buffer;
  }

  /**
   * Like {@link downloadResource}, but also returns the server's response
   * `content-type` (when present). Feishu's `im.v1.messageResource.get`
   * carries the resource's real MIME in the response headers — needed to pick
   * an accurate file extension. `contentType` is the media type with any
   * parameters (e.g. `; charset=...`) stripped, or `undefined` when the header
   * is absent (e.g. a defensive raw-`Buffer` response). Callers should fall
   * back to a per-kind default in that case.
   */
  async downloadResourceWithMeta(
    messageId: string,
    fileKey: string,
    type: ResourceType,
  ): Promise<{ buffer: Buffer; contentType?: string }> {
    const r = await this.rawClient.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const buffer = await bufferFromStream(r as unknown);
    return { buffer, contentType: extractContentType(r as unknown) };
  }

  /**
   * Stream a message resource straight to `destPath` without ever holding the
   * whole payload in memory — the HTTP response is `pipe`d to the file, so a
   * 100 MB attachment costs only stream-buffer overhead, not 100 MB of JS
   * heap. Prefer this over {@link downloadResource} /
   * {@link downloadResourceWithMeta} whenever the bytes are headed for disk
   * (e.g. a size-limited attachment cache): those materialize a full `Buffer`
   * via `Buffer.concat`, which can OOM the process when several large
   * downloads run concurrently.
   *
   * Returns the server `content-type` (params stripped; `undefined` when
   * absent) for MIME/extension detection, and the number of bytes written.
   * The parent directory of `destPath` must already exist.
   */
  async downloadResourceToFile(
    messageId: string,
    fileKey: string,
    type: ResourceType,
    destPath: string,
  ): Promise<{ contentType?: string; bytesWritten: number }> {
    const r = await this.rawClient.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const contentType = extractContentType(r as unknown);
    const bytesWritten = await streamToFile(r as unknown, destPath);
    return { contentType, bytesWritten };
  }

  /**
   * Create a group chat (`im.v1.chat.create`) and return its `chat_id`.
   * `inviteUserIds` seeds the membership; the ids are interpreted per
   * `userIdType` (default `'open_id'`). Requires the `im:chat` scope.
   */
  async createChat(opts: CreateChatOptions): Promise<{ chatId: string }> {
    const r = await this.rawClient.im.v1.chat.create({
      params: { user_id_type: opts.userIdType ?? 'open_id' },
      data: {
        name: opts.name,
        description: opts.description,
        chat_mode: opts.chatMode ?? 'group',
        chat_type: opts.chatType ?? 'private',
        user_id_list: opts.inviteUserIds,
      } as never,
    });
    const chatId = (r as { data?: { chat_id?: string } }).data?.chat_id;
    if (!chatId) {
      throw new LarkChannelError('unknown', 'im.v1.chat.create returned no chat_id');
    }
    return { chatId };
  }

  /**
   * List the chats this bot is a member of (`im.v1.chat.list`), following
   * pagination automatically. `pageSize` is clamped to Feishu's max of 100;
   * `maxPages` caps how many pages are fetched (default 10) so an account in
   * thousands of chats can't spin forever. Returns `{ id, name }` per chat.
   */
  async listChats(opts?: { pageSize?: number; maxPages?: number }): Promise<ChatSummary[]> {
    const pageSize = Math.min(Math.max(opts?.pageSize ?? 100, 1), 100);
    const maxPages = opts?.maxPages ?? 10;
    const out: ChatSummary[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const r = (await this.rawClient.im.v1.chat.list({
        params: { page_size: pageSize, page_token: pageToken },
      })) as {
        data?: {
          items?: Array<{ chat_id?: string; name?: string }>;
          has_more?: boolean;
          page_token?: string;
        };
      };
      const d = r?.data;
      for (const it of d?.items ?? []) {
        if (it.chat_id) out.push({ id: it.chat_id, name: it.name ?? '' });
      }
      if (!d?.has_more || !d.page_token) break;
      pageToken = d.page_token;
    }
    return out;
  }

  /**
   * Fetch this app's own metadata (`application.v6.application.get`) — the
   * `app_id` is the one the channel was constructed with, so callers don't
   * pass it. Primarily used to resolve the app owner/admin (`ownerId`) for
   * access control. Requires the application-info scope.
   */
  async getAppInfo(opts?: {
    lang?: 'zh_cn' | 'en_us' | 'ja_jp';
    userIdType?: 'open_id' | 'user_id' | 'union_id';
  }): Promise<AppInfo> {
    const r = await this.rawClient.application.v6.application.get({
      path: { app_id: this.opts.appId },
      params: {
        lang: opts?.lang ?? 'zh_cn',
        user_id_type: opts?.userIdType ?? 'open_id',
      },
    });
    const app = (r as { data?: { app?: { owner?: { owner_id?: string }; app_name?: string } } })
      .data?.app;
    return { ownerId: app?.owner?.owner_id, appName: app?.app_name };
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    const r = await this.rawClient.im.v1.chat.get({
      path: { chat_id: chatId },
    });
    const d = (r as { data?: Record<string, unknown> }).data ?? {};
    return {
      chatId,
      name: d.name as string | undefined,
      description: d.description as string | undefined,
      chatType: (d.chat_mode as 'p2p' | 'group') ?? 'group',
      ownerId: d.owner_id as string | undefined,
      memberCount: d.user_count as number | undefined,
    };
  }

  /**
   * Fetch the chat's mode via `im.v1.chat.get`. Returns one of:
   *   - 'p2p'   — direct (1:1) chat
   *   - 'group' — ordinary group
   *   - 'topic' — topic group
   *
   * Unknown / missing values fall back to 'group' for consistency with
   * {@link getChatInfo}. The underlying API call is not cached — chat
   * mode rarely changes within a chat's lifetime, so callers that read
   * this on every inbound message should keep their own cache keyed by
   * `chatId`.
   *
   * Throws on API failure (network, permission, invalid chatId) so the
   * caller can decide how to handle it; silently defaulting would hide
   * real problems.
   */
  async getChatMode(chatId: string): Promise<'p2p' | 'group' | 'topic'> {
    const r = await this.rawClient.im.v1.chat.get({
      path: { chat_id: chatId },
    });
    const mode = (r as { data?: { chat_mode?: string } }).data?.chat_mode;
    if (mode === 'p2p') return 'p2p';
    if (mode === 'topic') return 'topic';
    return 'group';
  }

  /**
   * List a chat's members (`im.v1.chatMembers.get`), following pagination.
   * Returns **users only** — Feishu's chat-members API filters bots out, so
   * `isBot` is never `true` here. Use {@link getChatBots} for the bots.
   * `pageSize` is clamped to Feishu's max of 100; `maxPages` (default 10) caps
   * paging. Results are cached per chat and reused by `senderName` resolution
   * and "@name → open_id"; a second call hits the cache and `force` bypasses
   * it. A `resolveChatMembers` option, if provided, overrides the API.
   * Throws {@link LarkChannelError} on API failure.
   */
  async getChatMembers(chatId: string, opts?: GetChatMembersOptions): Promise<ChatMember[]> {
    if (!opts?.force) {
      const cached = this.chatMemberCache.getMembers(chatId);
      if (cached) return cached;
    }
    const members = await this.fetchChatMembers(chatId, opts);
    this.chatMemberCache.setMembers(chatId, members, 'api');
    return members;
  }

  private async fetchChatMembers(
    chatId: string,
    opts?: GetChatMembersOptions,
  ): Promise<ChatMember[]> {
    const fromHook = await this.opts.resolveChatMembers?.(chatId);
    if (fromHook) return fromHook;

    const idType = opts?.idType ?? 'open_id';
    const pageSize = Math.min(Math.max(opts?.pageSize ?? 100, 1), 100);
    const maxPages = opts?.maxPages ?? 10;
    const out: ChatMember[] = [];
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < maxPages; page++) {
        const r = (await this.rawClient.im.v1.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: idType, page_size: pageSize, page_token: pageToken },
        } as never)) as { data?: RawChatMembersPage };
        const d = r?.data;
        for (const it of d?.items ?? []) {
          if (!it.member_id) continue;
          out.push({
            id: it.member_id,
            idType: (it.member_id_type as IdType) ?? idType,
            name: it.name,
            tenantKey: it.tenant_key,
            isBot: false,
          });
        }
        if (!d?.has_more || !d.page_token) break;
        pageToken = d.page_token;
      }
    } catch (e) {
      throw classifyError(e, { to: chatId });
    }
    return out;
  }

  /**
   * List the **bots** in a chat (`GET .../members/bots`) — the companion to
   * {@link getChatMembers}, which returns users only (Feishu filters bots from
   * that list). Returns {@link ChatMember}s with `isBot: true`, and seeds them
   * into the roster so another bot can be `@`-ed by name **without** having
   * appeared in an inbound mention first. Cached per chat like
   * {@link getChatMembers} (`force` bypasses). Throws {@link LarkChannelError}
   * on API failure.
   *
   * There is no typed node-sdk method for this endpoint, so it goes through the
   * raw request; the response is `{ data: { items: [{ bot_id, bot_name }] } }`.
   */
  async getChatBots(chatId: string, opts?: { force?: boolean }): Promise<ChatMember[]> {
    if (!opts?.force) {
      const cached = this.chatMemberCache.getBots(chatId);
      if (cached) return cached;
    }
    const bots = await this.fetchChatBots(chatId);
    this.chatMemberCache.setBots(chatId, bots);
    return bots;
  }

  private async fetchChatBots(chatId: string): Promise<ChatMember[]> {
    try {
      const r = await this.rawClient.request({
        url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/bots`,
        method: 'GET',
      });
      // client.request returns the parsed body; the envelope carries `data`,
      // but tolerate a top-level `items` shape defensively.
      const body = r as { data?: { items?: RawBotItem[] }; items?: RawBotItem[] };
      const items = body.data?.items ?? body.items ?? [];
      const out: ChatMember[] = [];
      for (const it of items) {
        if (!it.bot_id) continue;
        out.push({ id: it.bot_id, idType: 'open_id', name: it.bot_name, isBot: true });
      }
      return out;
    } catch (e) {
      throw classifyError(e, { to: chatId });
    }
  }

  /** Warm the roster for `senderName` resolution; failures degrade silently. */
  private async warmChatRoster(chatId: string): Promise<void> {
    try {
      await this.getChatMembers(chatId);
    } catch (e) {
      this.logger.debug?.('channel: roster warm failed', e);
    }
  }

  /**
   * Record identities seen in a message's mentions (incl. bots) into the
   * roster, so a bot that has "shown its face" can later be @'d by name.
   * Source is 'mention' so it never overwrites authoritative API user names.
   */
  private collectMentionsIntoRoster(chatId: string, mentions: MentionInfo[]): void {
    const seen: ChatMember[] = [];
    for (const m of mentions) {
      if (m.openId && m.name) seen.push({ id: m.openId, name: m.name, isBot: m.isBot });
    }
    if (seen.length) this.chatMemberCache.setMembers(chatId, seen, 'mention');
  }

  /**
   * Fetch a message by id and return it as a {@link NormalizedMessage} — the
   * same shape live `message` events produce. Useful for resolving a
   * reply-quoted message: `im.v1.message.get` returns a flat item list
   * (parent + descendants for merge_forward), which this method feeds back
   * through {@link normalize} so merge_forward gets the same
   * `<forwarded_messages>` expansion as live events.
   *
   * Sunk from bridge's `quote.ts`, which previously synthesized a fake raw
   * event and called the internal `normalize()` directly. Returns
   * `undefined` when the message can't be fetched or has no parent item.
   * `stripBotMentions` is off here so the raw quoted content is preserved.
   */
  /**
   * Fetch a message's raw `data.items[]` (`im.v1.message.get`) without running
   * them through {@link normalize} — for callers that need fidelity the
   * normalizer drops: original `body.content` JSON, `mentions`, `sender.id`,
   * `create_time`. For merge_forward the list is the parent followed by its
   * descendants (each carrying `upper_message_id`).
   *
   * `cardContentType` maps to the `card_msg_content_type` query param.
   * Defaults to `'user_card_content'` so interactive messages return the
   * original CardKit 2.0 card JSON (`user_dsl`) rather than the v1-canonical
   * downgrade. Pass `null` to omit the param entirely.
   */
  async fetchRawMessage(
    messageId: string,
    opts?: { cardContentType?: 'user_card_content' | string | null },
  ): Promise<ApiMessageItem[]> {
    const cardContentType =
      opts?.cardContentType === undefined ? 'user_card_content' : opts.cardContentType;
    const r = (await this.rawClient.im.v1.message.get({
      path: { message_id: messageId },
      params: (cardContentType ? { card_msg_content_type: cardContentType } : undefined) as never,
    })) as { data?: { items?: ApiMessageItem[] } };
    return r?.data?.items ?? [];
  }

  async fetchMessage(messageId: string): Promise<NormalizedMessage | undefined> {
    let items: ApiMessageItem[];
    try {
      const r = (await this.rawClient.im.v1.message.get({
        path: { message_id: messageId },
      })) as { data?: { items?: ApiMessageItem[] } };
      items = r?.data?.items ?? [];
    } catch (e) {
      this.logger.warn?.('channel: fetchMessage failed', e);
      return undefined;
    }
    const parent = items[0];
    if (!parent || !parent.message_id) return undefined;

    // Reuse the already-fetched items when normalize re-asks for sub-messages
    // of this same id (merge_forward); nested merge_forwards fall back to a
    // fresh API call.
    const fetchSubMessages = (mid: string): Promise<ApiMessageItem[]> =>
      mid === parent.message_id ? Promise.resolve(items) : this.fetchMessageItemsWithRetry(mid);

    const senderOpenId = parent.sender?.id;
    const fakeRaw: RawMessageEvent = {
      sender: { sender_id: { open_id: senderOpenId } },
      message: {
        message_id: parent.message_id,
        // chat_id / chat_type aren't used by normalize's converters but are
        // required by the type. Empty strings are safe.
        chat_id: '',
        chat_type: 'group',
        message_type: parent.msg_type ?? 'text',
        content: parent.body?.content ?? '',
        create_time: parent.create_time !== undefined ? String(parent.create_time) : undefined,
        mentions: parent.mentions,
      },
    };

    try {
      return await normalize(fakeRaw, {
        botIdentity: this.botIdentity ?? { openId: '', name: '' },
        fetchSubMessages,
        stripBotMentions: false,
      });
    } catch (e) {
      this.logger.warn?.('channel: fetchMessage normalize failed', e);
      return undefined;
    }
  }

  /**
   * Read a message's `data.items[]` (`im.v1.message.get`) with retry — used to
   * expand merge-forward sub-messages. Wraps the GET in the shared
   * exponential-backoff {@link retry}: transient upstream failures
   * (5xx → `unknown`, `rate_limited`) and — since this is an idempotent read —
   * timeouts are retried; non-transient errors (permission / not-found /
   * format) fail fast. On exhaustion it **throws** the classified
   * {@link LarkChannelError} instead of degrading to `[]`, so the converter can
   * tell "fetch failed" apart from "genuinely empty". The failure is warn-logged
   * here (once, after retries) before re-throwing.
   */
  private fetchMessageItemsWithRetry(messageId: string): Promise<ApiMessageItem[]> {
    return retry(
      async () => {
        const r = (await this.rawClient.im.v1.message.get({
          path: { message_id: messageId },
        })) as { data?: { items?: ApiMessageItem[] } };
        return r?.data?.items ?? [];
      },
      { ...(this.opts.outbound?.retry ?? {}), retryTimeouts: true },
    ).catch((e) => {
      this.logger.warn?.('channel: fetchSubMessages failed', e);
      throw e;
    });
  }

  // ─── runtime config ────────────────────────────────────

  updatePolicy(partial: Partial<PolicyConfig>): void {
    this.safety.updatePolicy(partial);
  }

  getPolicy(): Readonly<PolicyConfig> {
    return this.safety.getPolicy();
  }

  // ─── internals: bot identity & dispatch wiring ────────

  private async fetchBotIdentity(): Promise<BotIdentity> {
    // Standard Feishu API: GET /open-apis/bot/v3/info
    // Returns: { code, msg, bot: { open_id, app_name, avatar_url, ... } }
    let lastError: unknown;
    try {
      const r = await this.rawClient.request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      });
      const bot = (r as { bot?: { open_id?: string; app_name?: string } }).bot;
      if (bot?.open_id) {
        return { openId: bot.open_id, name: bot.app_name ?? 'bot' };
      }
      lastError = new Error(
        `bot/v3/info response missing open_id: ${JSON.stringify(r).slice(0, 200)}`,
      );
    } catch (e) {
      lastError = e;
    }

    // Let the shared error classifier decide: 401/403 / feishu auth codes
    // → permission_denied; rate_limited / send_timeout pass through;
    // everything else falls back to `not_connected` (the genuine
    // "couldn't reach the API" bucket). Without this, all connect
    // failures collapse to `not_connected`, making auth errors
    // indistinguishable from network errors.
    const classified = classifyError(lastError);
    const code = classified.code === 'unknown' ? 'not_connected' : classified.code;
    throw new LarkChannelError(
      code,
      'could not resolve bot identity via /open-apis/bot/v3/info — required for channel to function',
      { cause: lastError },
    );
  }

  private registerDispatcherHandlers(): void {
    // `im.v1.message.get(mid)` on a merge_forward message returns
    // `data.items[]` as a flat list: the parent message first (no
    // `upper_message_id`) followed by every descendant, each with
    // `upper_message_id` pointing at its direct parent. That is
    // exactly what `convertMergeForward` / `buildChildrenMap` consume,
    // so the converter tree-builds correctly without further work.
    // (Earlier attempts used `message.list` with
    // `container_id_type: 'message'`, which Feishu rejects — 'message'
    // isn't a valid container type.)
    const fetchSubMessages = (mid: string): Promise<ApiMessageItem[]> =>
      this.fetchMessageItemsWithRetry(mid);

    // Unified raw-event flag: prefer the new `includeRawEvent` option,
    // fall back to the legacy `includeRawInMessage` for back-compat.
    const includeRaw = this.opts.includeRawEvent ?? this.opts.includeRawInMessage ?? false;

    const normalizeOpts = {
      botIdentity: this.botIdentity!,
      stripBotMentions: true,
      includeRaw,
      fetchSubMessages,
    };

    this.builtinHandlers = {
      // IM message — full safety pipeline
      'im.message.receive_v1': async (raw: unknown) => {
        try {
          const event = raw as RawMessageEvent;
          const chatId = event.message.chat_id;

          // Opt-in: warm the chat roster and resolve the sender's display name
          // (Feishu omits it from message events). Best-effort; degrades to
          // undefined on failure. Off by default (zero extra API).
          let resolveSenderName: ((openId: string) => string | undefined) | undefined;
          if (this.opts.resolveSenderNames) {
            await this.warmChatRoster(chatId);
            resolveSenderName = (openId) => this.chatMemberCache.resolveName(chatId, openId);
          }

          const msg = await normalize(event, { ...normalizeOpts, resolveSenderName });

          // Collect observed mention identities (incl. bots, which the members
          // API filters out) so they can later be @'d by name.
          this.collectMentionsIntoRoster(chatId, msg.mentions);

          // Opt-in: resolve the finer-grained chat mode (p2p/group/topic),
          // which Feishu omits from the event. Cached per chatId; best-effort.
          if (this.opts.resolveChatMode) {
            msg.chatMode = await this.chatModeCache.resolve(msg.chatId, (id) =>
              this.getChatMode(id),
            );
          }
          await this.safety.pushMessage(msg);
        } catch (e) {
          this.emitError(e);
        }
      },

      // Card button click — dedup + lock + queue (by chatId).
      // The key includes the action's identity (tag + value) so that
      // different buttons on the same card by the same user are NOT
      // collapsed by the dedup cache. A genuine Feishu re-delivery
      // of the same click still hashes to the same key.
      'card.action.trigger': async (raw: unknown) => {
        const evt = normalizeCardAction(raw as never, { includeRaw });
        if (!evt) return undefined;
        const actionId = cardActionId(evt.action);
        // Return the handler's value so a card-action callback response
        // (e.g. a toast) flows back through the dispatcher to Feishu. A
        // missing handler or a deduped / in-flight drop yields `undefined`,
        // which the transport reads as "no response".
        return this.safety.pushAction(
          `card:${evt.messageId}:${evt.operator.openId}:${actionId}`,
          evt.chatId,
          async () => {
            const h = this.handlers.cardAction;
            return h ? h(evt) : undefined;
          },
        );
      },

      // Reactions — dedup only
      'im.message.reaction.created_v1': async (raw: unknown) => {
        const evt = normalizeReaction(raw as never, 'added', { includeRaw });
        if (!evt) return;
        const key = reactionKey(evt);
        await this.safety.pushLight(key, () => this.handlers.reaction?.(evt));
      },
      'im.message.reaction.deleted_v1': async (raw: unknown) => {
        const evt = normalizeReaction(raw as never, 'removed', { includeRaw });
        if (!evt) return;
        const key = reactionKey(evt);
        await this.safety.pushLight(key, () => this.handlers.reaction?.(evt));
      },

      // Bot added — direct fire, no safety
      'im.chat.member.bot.added_v1': (raw: unknown) => {
        const evt = normalizeBotAdded(raw as never, { includeRaw });
        if (!evt) return;
        try {
          this.handlers.botAdded?.(evt);
        } catch (e) {
          this.emitError(e);
        }
      },

      // Drive comments — dedup + lock + queue (by fileToken).
      // The dedup key folds in replyId so thread replies on the same
      // top-level comment don't collide with each other (or with the
      // top-level comment itself).
      'drive.notice.comment_add_v1': async (raw: unknown) => {
        const evt = normalizeComment(raw as never, { includeRaw });
        if (!evt) return;
        await this.safety.pushAction(
          `comment:${evt.fileToken}:${evt.commentId}:${evt.replyId ?? ''}`,
          evt.fileToken,
          async () => {
            const h = this.handlers.comment;
            if (h) await h(evt);
          },
        );
      },

      // Meeting channel — the three vc.bot.* events, registered internally so
      // callers never have to wire them up themselves.
      ...this.meetings.handlers(),
    };

    this.meetings.markRegistered();
    for (const type of Object.keys(this.builtinHandlers)) this.ensureDispatchEntry(type);
  }

  /**
   * Subscribe to a Feishu event type the channel does not wrap.
   *
   * Multicast; the returned function removes only this handler. Without this the
   * alternatives are reaching into the dispatcher's private map, which breaks on
   * a version bump, or opening a second long-lived connection — and a second
   * connection for the same app makes Feishu split delivery between them, so the
   * channel's own IM traffic starts disappearing.
   *
   * **Raw handlers run outside the safety pipeline.** They run after signature
   * verification and decryption, but `PolicyGate` (`dmMode`, `dmAllowlist`,
   * `groupAllowlist`, `requireMention`), dedup, the per-chat processing lock, the
   * loop guard and the stale-message filter are all downstream of normalization
   * and do not apply here. Registering a raw handler for an event type the channel
   * already handles therefore opens a path around those checks — deliberately,
   * but worth knowing before using it on `im.message.receive_v1`.
   *
   * The payload is the decrypted platform event, unredacted and unaffected by
   * `includeRawEvent: false`: it carries `tenant_key`, full user ids and message
   * bodies.
   *
   * Handlers are awaited before the dispatcher replies to Feishu, so that replies
   * stay ordered after them. On `card.action.trigger` that matters: a slow raw
   * handler delays the callback response past Feishu's timeout even though its
   * return value is discarded. Keep raw handlers on that event type cheap, or hand
   * the work to a queue.
   */
  onRawEvent(eventType: string, handler: (payload: unknown) => void | Promise<void>): Unsubscribe {
    let set = this.rawHandlers.get(eventType);
    if (!set) {
      set = new Set();
      this.rawHandlers.set(eventType, set);
    }
    set.add(handler);
    this.ensureDispatchEntry(eventType);
    return () => {
      set?.delete(handler);
    };
  }

  private ensureDispatchEntry(eventType: string): void {
    if (this.dispatchedTypes.has(eventType)) return;
    this.dispatchedTypes.add(eventType);
    this.dispatcher.register({
      [eventType]: (raw: unknown) => this.dispatchToHandlers(eventType, raw),
    } as never);
  }

  /**
   * Built-in first, raw handlers after, and the built-in's return value is the
   * one that goes back to Feishu — a card action's callback response must not be
   * rewritable by an observer that merely subscribed to the same event.
   */
  private async dispatchToHandlers(eventType: string, raw: unknown): Promise<unknown> {
    const builtin = this.builtinHandlers[eventType];
    const result = builtin ? await builtin(raw) : undefined;

    for (const handler of [...(this.rawHandlers.get(eventType) ?? [])]) {
      try {
        await handler(raw);
      } catch (e) {
        // Contained: a raw subscriber must not break the built-in path.
        this.emitError(e);
      }
    }
    return result;
  }

  // ─── meeting channel ───────────────────────────────────

  /**
   * Put the bot in a meeting as a visible participant (app identity).
   * Requires {@link connect} — this path is driven by event pushes.
   */
  async joinMeeting(meetingNo: string, opts?: JoinMeetingOptions): Promise<MeetingSession> {
    return this.meetings.joinMeeting(meetingNo, opts);
  }

  /**
   * Follow the meeting the given user access token's owner is currently in,
   * without joining it (user identity). Does **not** require {@link connect}:
   * this path is REST polling only.
   */
  async followMyMeeting(opts: FollowMeetingOptions): Promise<MeetingSession> {
    return this.meetings.followMyMeeting(opts);
  }

  /**
   * Diagnostics for the in-meeting event path, counted per link — `push` for event
   * pushes, `poll` for REST reads. See {@link MeetingEventHealth}.
   */
  getMeetingEventHealth(): MeetingEventHealth {
    return this.meetings.health();
  }

  /**
   * Meetings the bot is still a participant of with nothing listening — what
   * `disconnect()` leaves behind.
   *
   * `disconnect()` disposes sessions without leaving their meetings, so the bot stays in
   * them; a later `connect()` re-registers the event handlers but does not rebuild the
   * sessions, and their pushes are then dropped. Sessions signal this by ending with
   * `reason: 'disposed'`.
   *
   * Re-attach with `joinMeeting(meetingNo)` — which does not consume a new concurrency
   * slot for a meeting already held — or, once attached, `leave()` to give the slot back.
   * Ignoring an entry here means the bot sits in a meeting deaf, holding a slot, until
   * the meeting ends.
   */
  getRetainedMeetings(): MeetingMembership[] {
    return this.meetings.retainedMeetings();
  }

  private emitError(e: unknown): void {
    const err =
      e instanceof LarkChannelError
        ? e
        : new LarkChannelError('unknown', String((e as { message?: string })?.message ?? e), {
            cause: e,
          });
    const handler = this.handlers.error;
    if (!handler) {
      this.logger.error?.('channel: unhandled error', err);
      return;
    }
    try {
      void Promise.resolve(handler(err)).catch((observerError) => {
        this.logErrorObserverFailure(observerError);
      });
    } catch (observerError) {
      this.logErrorObserverFailure(observerError);
    }
  }

  private logErrorObserverFailure(observerError: unknown): void {
    try {
      this.logger.error?.('channel: error handler threw', observerError);
    } catch {
      /* an observer failure must never escape through its logger */
    }
  }
}

export function createLarkChannel(opts: LarkChannelOptions): LarkChannel {
  return new LarkChannel(opts);
}

/** Mask `user:pass@` credentials in a proxy URL before logging it. */
function redactProxyUrl(url: string): string {
  return url.replace(/\/\/[^:@/]+:[^@/]+@/, '//[redacted]@');
}

/**
 * Pull the `content-type` media type out of a download response's headers.
 * The code-gen download endpoints expose axios response headers on the
 * wrapper object; header names are case-insensitive, so check both casings.
 * Strips any `; charset=…` / `; boundary=…` parameters and returns the bare
 * media type (lowercased), or `undefined` when no usable header is present.
 */
function extractContentType(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const headers = (raw as { headers?: Record<string, unknown> }).headers;
  if (!headers) return undefined;
  const value = headers['content-type'] ?? headers['Content-Type'];
  if (typeof value !== 'string') return undefined;
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType || undefined;
}

/**
 * Stream a download response to disk without buffering it in heap. The
 * code-gen download endpoints expose the body via `getReadableStream()`,
 * which we `pipeline` straight into a write stream (back-pressure aware,
 * cleans up on error). Falls back to writing an already-materialized
 * `Buffer` / `Uint8Array` for the defensive non-stream response shapes —
 * those are already in memory, so there's nothing to stream. Returns the
 * number of bytes written.
 */
async function streamToFile(raw: unknown, destPath: string): Promise<number> {
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as {
      data?: unknown;
      getReadableStream?: () => NodeJS.ReadableStream;
    };
    if (typeof r.getReadableStream === 'function') {
      await pipeline(r.getReadableStream(), createWriteStream(destPath));
      const { size } = await stat(destPath);
      return size;
    }
    if (Buffer.isBuffer(r.data)) {
      await writeFile(destPath, r.data);
      return r.data.length;
    }
    if (r.data instanceof Uint8Array) {
      const buf = Buffer.from(r.data);
      await writeFile(destPath, buf);
      return buf.length;
    }
  }
  if (Buffer.isBuffer(raw)) {
    await writeFile(destPath, raw);
    return raw.length;
  }
  if (raw instanceof Uint8Array) {
    const buf = Buffer.from(raw);
    await writeFile(destPath, buf);
    return buf.length;
  }
  throw new LarkChannelError('unknown', 'unexpected download response type');
}

async function bufferFromStream(raw: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as {
      data?: unknown;
      getReadableStream?: () => NodeJS.ReadableStream;
    };
    // The code-gen download endpoints (im.v1.image.get / im.v1.file.get)
    // return a wrapper object `{ writeFile, getReadableStream, headers }`
    // where the body is exposed as a stream. Consume it into a Buffer.
    if (typeof r.getReadableStream === 'function') {
      return await readableToBuffer(r.getReadableStream());
    }
    if (Buffer.isBuffer(r.data)) return r.data;
    if (r.data instanceof Uint8Array) return Buffer.from(r.data);
  }
  throw new LarkChannelError('unknown', 'unexpected download response type');
}

function readableToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function reactionKey(evt: {
  messageId: string;
  operator: { openId: string };
  emojiType: string;
  action: 'added' | 'removed';
  actionTime?: number;
}): string {
  return `rx:${evt.messageId}:${evt.operator.openId}:${evt.emojiType}:${evt.action}:${evt.actionTime ?? 0}`;
}

/**
 * Build a stable identity for a card action event's button/element, so that
 * different clicks on the same card by the same user dedup independently.
 * `tag` plus serialized `value` is enough to tell buttons apart; `name` and
 * `option` are rolled in for form-style interactions where the same value
 * may repeat but the triggering element differs. The serialized payload is
 * length-clamped to keep cache keys small.
 */
function cardActionId(action: {
  value: unknown;
  tag: string;
  name?: string;
  option?: string;
}): string {
  const serialized =
    typeof action.value === 'string' ? action.value : JSON.stringify(action.value ?? '');
  const valuePart = serialized.length > 128 ? serialized.slice(0, 128) : serialized;
  return `${action.tag}|${action.name ?? ''}|${action.option ?? ''}|${valuePart}`;
}
