import {
  Client,
  Domain,
  defaultHttpInstance,
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
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
import type { ApiMessageItem, RawMessageEvent } from './normalize';
import {
  normalize,
  normalizeBotAdded,
  normalizeCardAction,
  normalizeComment,
  normalizeReaction,
} from './normalize';
import { OutboundSender } from './outbound';
import { classifyError } from './outbound/errors';
import { SafetyPipeline } from './safety';
import {
  type AppInfo,
  type BotIdentity,
  type ChatInfo,
  type ChatSummary,
  type CreateChatOptions,
  type EventMap,
  type EventName,
  LarkChannelError,
  type LarkChannelOptions,
  type NormalizedMessage,
  type PolicyConfig,
  type ResourceType,
  type SendInput,
  type SendOptions,
  type SendResult,
  type StreamInput,
} from './types';

type Unsubscribe = () => void;

export class LarkChannel {
  readonly rawClient: Client;

  rawWsClient?: WSClient;

  botIdentity?: BotIdentity;

  /** Cloud-doc comment surface: fetch / reply / reactions with quirk fallbacks. */
  readonly comments: CommentSurface;

  private readonly opts: LarkChannelOptions;

  private readonly logger: Logger;

  private readonly dispatcher: EventDispatcher;

  private readonly handlers: Partial<EventMap> = {};

  private connectPromise?: Promise<void>;

  private connected = false;

  private readonly sender: OutboundSender;

  private readonly safety: SafetyPipeline;

  private readonly chatModeCache = new ChatModeCache();

  private keepaliveHandle?: KeepaliveHandle;

  private proxyAgent?: HttpsProxyAgent<string>;

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
      await this.connectWebSocket(15000);
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
    await this.connectWebSocket(this.opts.handshakeTimeoutMs ?? 15000);
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
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new LarkChannelError(
            'not_connected',
            `WebSocket handshake did not complete within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.rawWsClient = new WSClient({
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
      this.rawWsClient.start({ eventDispatcher: this.dispatcher });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.keepaliveHandle?.stop();
    this.keepaliveHandle = undefined;
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
    return this.sender.send(to, input, opts);
  }

  async stream(to: string, input: StreamInput, opts?: SendOptions): Promise<SendResult> {
    return this.sender.stream(to, input, opts);
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
    const fetchSubMessages = async (mid: string): Promise<ApiMessageItem[]> => {
      if (mid === parent.message_id) return items;
      try {
        const r = (await this.rawClient.im.v1.message.get({
          path: { message_id: mid },
        })) as { data?: { items?: ApiMessageItem[] } };
        return r?.data?.items ?? [];
      } catch {
        return [];
      }
    };

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
    const fetchSubMessages = async (mid: string): Promise<ApiMessageItem[]> => {
      try {
        const r = await this.rawClient.im.v1.message.get({
          path: { message_id: mid },
        });
        const items = (r as { data?: { items?: ApiMessageItem[] } }).data?.items ?? [];
        return items;
      } catch (e) {
        this.logger.warn?.('channel: fetchSubMessages failed', e);
        return [];
      }
    };

    // Unified raw-event flag: prefer the new `includeRawEvent` option,
    // fall back to the legacy `includeRawInMessage` for back-compat.
    const includeRaw = this.opts.includeRawEvent ?? this.opts.includeRawInMessage ?? false;

    const normalizeOpts = {
      botIdentity: this.botIdentity!,
      stripBotMentions: true,
      includeRaw,
      fetchSubMessages,
    };

    this.dispatcher.register({
      // IM message — full safety pipeline
      'im.message.receive_v1': async (raw: unknown) => {
        try {
          const msg = await normalize(raw as RawMessageEvent, normalizeOpts);
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
        if (!evt) return;
        const actionId = cardActionId(evt.action);
        await this.safety.pushAction(
          `card:${evt.messageId}:${evt.operator.openId}:${actionId}`,
          evt.chatId,
          async () => {
            const h = this.handlers.cardAction;
            if (h) await h(evt);
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
    } as never);
  }

  private emitError(e: unknown): void {
    const err =
      e instanceof LarkChannelError
        ? e
        : new LarkChannelError('unknown', String((e as { message?: string })?.message ?? e), {
            cause: e,
          });
    const handler = this.handlers.error;
    if (handler) handler(err);
    else this.logger.error?.('channel: unhandled error', err);
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
