# @larksuite/channel

**English** | [简体中文](./README.zh.md)

Channel SDK — let agents and external services integrate with the Feishu/Lark
messaging system without touching the WebSocket lifecycle, the dozen-plus
`msg_type` branches, or @-mention placeholder wiring.

It sits on top of [`@larksuiteoapi/node-sdk`](https://github.com/larksuite/node-sdk)
and gives you one entry point that reliably receives & normalizes events,
applies policy/safety, and sends streaming replies, media, and cards.

## Install

```bash
npm install @larksuite/channel
# or: pnpm add @larksuite/channel
```

## Quick start

```typescript
import { createLarkChannel } from '@larksuite/channel';

const channel = createLarkChannel({
  appId: process.env.LARK_APP_ID!,
  appSecret: process.env.LARK_APP_SECRET!,
});

channel.on('message', async (msg) => {
  await channel.send(
    msg.chatId,
    { markdown: `received: ${msg.content}` },
    { replyTo: msg.messageId },
  );
});

await channel.connect();
```

No WebSocket reconnect logic, no `text` / `post` / `merge_forward` parsing —
the channel hands you a `NormalizedMessage` and takes a `SendInput`.

## Capabilities

- **Transport** — WebSocket connection management, auto-reconnect, keepalive,
  handshake timeout, webhook mode.
- **Normalization** — a dozen-plus `msg_type` values folded into a single
  `NormalizedMessage`; @-mention handling, `merge_forward` expansion, card /
  reaction / comment / botAdded event normalization.
- **Policy & safety** — `requireMention`, allowlists, dedup, stale-drop,
  per-chat serialization.
- **Outbound** — `send` (text / markdown / post / card / image / file / audio /
  video / share / sticker), streaming typewriter cards, `updateCard`,
  reactions, media upload with SSRF guard, automatic fallbacks.

## API

### Entry

| API | Description |
|---|---|
| `createLarkChannel(opts: LarkChannelOptions): LarkChannel` | Factory (recommended) |
| `new LarkChannel(opts)` | Class form, equivalent |

Read-only instance members: `channel.comments` (comment surface),
`channel.rawClient` (underlying `Client`, escape hatch), `channel.rawWsClient`
(underlying `WSClient`), `channel.botIdentity` (available after `connect()`).

### One-click QR registration — `registerApp`

Bootstrap an app's `appId` / `appSecret` via a QR-code device flow (no
pre-existing credentials needed). You get a QR URL through `onQRCodeReady`;
after the user scans it and creates / authorizes the app, it resolves with the
credentials — feed them straight into `createLarkChannel`.

```ts
import { registerApp, createLarkChannel } from '@larksuite/channel';

const { client_id, client_secret } = await registerApp({
  onQRCodeReady: ({ url, expireIn }) => console.log('scan to register:', url),
  onStatusChange: (s) => console.log('status:', s.status),
});
const channel = createLarkChannel({ appId: client_id, appSecret: client_secret });
```

`RegisterAppOptions`: `onQRCodeReady` (required) · `onStatusChange?` ·
`appPreset?` (pre-fill app name/desc/avatar) · `domain?` / `larkDomain?` ·
`signal?` (AbortSignal) · `source?` — an optional attribution tag appended to
the QR URL as `source/<name>` (passed through as-is, not defaulted).

### Options — `LarkChannelOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `appId` / `appSecret` | `string` | — | Required |
| `transport` | `'websocket' \| 'webhook'` | `'websocket'` | Transport mode |
| `webhook` | `WebhookOptions` | — | Webhook-mode config (verification token / encrypt key / adapter) |
| `policy` | `PolicyConfig` | — | Who may trigger the bot (inbound gate) |
| `safety` | `SafetyConfig` | — | Dedup / stale / per-chat queue / batching |
| `outbound` | `OutboundConfig` | — | Outbound behavior (chunking, streaming, SSRF, retry) |
| `resolveChatMode` | `boolean` | `false` | Populate `NormalizedMessage.chatMode` (one cached `chat.get` per chat) |
| `keepalive` | `{ enabled; onUnrecoverable?; intervalMs? }` | — | Connection watchdog (WS only) |
| `respectProxyEnv` | `boolean` | `false` | Route WS + REST through `HTTPS_PROXY` / `HTTP_PROXY` |
| `httpTimeoutMs` | `number` | — | Per-request REST timeout |
| `agent` | `http(s).Agent` | — | Custom WS agent (wins over `respectProxyEnv`) |
| `handshakeTimeoutMs` | `number` | — | WS handshake timeout |
| `wsConfig` | `WSConfigOverrides` | — | Client-only WS settings (`pingTimeout`) |
| `domain` | `Domain \| string` | `Feishu` | Feishu / Lark domain |
| `cache` | `Cache` | built-in | Cache instance (dedup / credentials) |
| `logger` / `loggerLevel` | `Logger` / `LoggerLevel` | `info` | Logging |
| `httpInstance` | `HttpInstance` | shared default | Custom HTTP instance (then configure timeout/proxy yourself) |
| `source` | `string` | — | User-Agent tag |
| `includeRawEvent` | `boolean` | `false` | Attach the raw event payload as `evt.raw` |

`PolicyConfig`: `requireMention` · `dmMode` (`'open' \| 'allowlist' \| 'pair' \| 'disabled'`) · `dmAllowlist` · `groupAllowlist` · `respondToMentionAll`.

`SafetyConfig`: `dedup` (`ttl`/`maxEntries`/`sweepIntervalMs`) · `chatQueue` (`enabled`, `mergeWhileBusy`) · `batch.text` / `batch.media` · `staleMessageWindowMs`.

### Lifecycle

| Method | Signature | Description |
|---|---|---|
| `connect` | `connect(): Promise<void>` | Connect; resolves after the first WS handshake |
| `disconnect` | `disconnect(): Promise<void>` | Disconnect and clean up |
| `getConnectionStatus` | `(): WSConnectionStatus \| undefined` | Connection snapshot (`undefined` in webhook mode / before connect) |

### Events — `channel.on(name, handler)`

`on('message', fn)` for a single event, or `on({ message, cardAction })` for
several; returns an unsubscribe function.

| Event | Payload | When |
|---|---|---|
| `message` | `NormalizedMessage` | Inbound message (after policy / safety / batching) |
| `cardAction` | `CardActionEvent` | Card button / form submit (handler may **return** a `CardActionResponse` — see below) |
| `reaction` | `ReactionEvent` | Message reaction add/remove |
| `botAdded` | `BotAddedEvent` | Bot added to a chat |
| `comment` | `CommentEvent` | Cloud-doc comment @-mentioning the bot |
| `reject` | `RejectEvent` | Message rejected by policy (`reason`) |
| `error` | `LarkChannelError` | Internal error |
| `reconnecting` / `reconnected` | `()` | WS reconnect lifecycle |

```ts
interface NormalizedMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  chatMode?: 'p2p' | 'group' | 'topic'; // requires resolveChatMode
  senderId: string;
  senderName?: string;
  content: string;          // normalized, readable content
  rawContentType: string;   // original msg_type
  resources: ResourceDescriptor[];
  mentions: MentionInfo[];
  mentionAll: boolean;
  mentionedBot: boolean;
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
  createTime: number;
  raw?: unknown;            // present when includeRawEvent is set
}

interface CardActionEvent {
  messageId: string; chatId: string;
  operator: { openId: string; userId?: string; name?: string };
  action: { value: unknown; tag: string; name?: string; option?: string; formValue?: Record<string, unknown> };
}
interface ReactionEvent { messageId: string; operator: { openId: string; userId?: string }; emojiType: string; action: 'added' | 'removed'; actionTime?: number; }
interface BotAddedEvent { chatId: string; operator: { openId: string; userId?: string }; botName?: string; external?: boolean; }
interface CommentEvent { fileToken: string; fileType: string; commentId: string; replyId?: string; operator: { openId: string; userId?: string; unionId?: string }; mentionedBot: boolean; timestamp: number; }
interface RejectEvent { messageId: string; chatId: string; senderId: string; reason: RejectReason; }
type RejectReason = 'group_not_allowed' | 'sender_not_allowed' | 'no_mention' | 'dm_disabled' | 'mention_all_blocked';
```

#### Card action callback responses

A `cardAction` handler may **return** a `CardActionResponse` to give the
clicking user native, immediate feedback — most commonly a toast — without
having to update the whole card:

```ts
channel.on('cardAction', async (evt) => {
  await handleAction(evt);
  return { toast: { type: 'success', content: 'Submitted' } };
  // or update the card in place: { card: { type: 'raw', data: { ... } } }
});
```

The returned object is passed back to Feishu/Lark verbatim as the callback
response for that click. Returning nothing (`undefined`) means "no immediate
response" — the original behavior, so existing handlers keep working unchanged.

Notes:
- The response is sent **synchronously**, and card actions run serially per
  chat (after any in-flight work for that chat). A slow handler can therefore
  delay the response past Feishu's callback timeout — for heavy work, prefer
  detaching it and reflecting progress via a card update.
- The object is sent to Feishu as-is: do **not** include internal secrets /
  PII, and make sure it is JSON-serializable.

### Outbound methods

| Method | Signature | Notes |
|---|---|---|
| `send` | `send(to: string, input: SendInput, opts?: SendOptions): Promise<SendResult>` | `to` accepts open_id / chat_id / user_id (auto-detected) |
| `stream` | `stream(to, input: StreamInput, opts?): Promise<SendResult>` | Streaming reply |
| `updateCard` | `updateCard(messageId, card): Promise<void>` | Replace a card |
| `editMessage` | `editMessage(messageId, text): Promise<void>` | Edit text/post |
| `recallMessage` | `recallMessage(messageId): Promise<void>` | Recall |
| `addReaction` | `addReaction(messageId, emojiType): Promise<string>` | Returns `reaction_id` |
| `removeReaction` | `removeReaction(messageId, reactionId): Promise<void>` | Remove by id |
| `removeReactionByEmoji` | `removeReactionByEmoji(messageId, emojiType): Promise<boolean>` | Remove the bot's own |
| `downloadResource` | `downloadResource(messageId, fileKey, type): Promise<Buffer>` | Download media from a received message; `type`: `'image'` / `'file'`. Resources forwarded in a `merge_forward` use the same top-level `msg.messageId` |
| `getChatInfo` | `getChatInfo(chatId): Promise<ChatInfo>` | Chat info |
| `getChatMode` | `getChatMode(chatId): Promise<'p2p' \| 'group' \| 'topic'>` | Chat mode |
| `fetchMessage` | `fetchMessage(messageId): Promise<NormalizedMessage \| undefined>` | Fetch + normalize a message |

```ts
type SendInput =
  | { markdown: string } | { text: string } | { post: object }
  | { image: { source: string | Buffer } }
  | { file:  { source: string | Buffer; fileName: string } }
  | { audio: { source: string | Buffer; duration?: number } }
  | { video: { source: string | Buffer; duration?: number; coverImageKey?: string } }
  | { card: object }
  | { shareChat: { chatId: string } } | { shareUser: { userId: string } }
  | { sticker: { fileKey: string } };

interface SendOptions { replyTo?: string; replyInThread?: boolean; mentions?: MentionInfo[]; }
interface SendResult { messageId: string; chunkIds?: string[]; }

type StreamInput =
  | { markdown: (c: MarkdownStreamController) => Promise<void> }    // c.append(chunk) / c.setContent(full)
  | { card: { initial: object; producer: (c: CardStreamController) => Promise<void> } }; // c.update(next)
```

Media `source` accepts a URL / local path / Buffer, with a built-in SSRF guard.

### Runtime policy

| Method | Signature | Description |
|---|---|---|
| `updatePolicy` | `updatePolicy(partial: Partial<PolicyConfig>): void` | Hot-update policy (partial merge, effective immediately) |
| `getPolicy` | `getPolicy(): Readonly<PolicyConfig>` | Read the current policy |

### Cloud-doc comments — `channel.comments`

| Method | Signature | Notes |
|---|---|---|
| `resolveTarget` | `resolveTarget(fileToken, fileType): Promise<CommentTarget \| null>` | Resolves a wiki node to its obj_token; `null` for unsupported types |
| `fetch` | `fetch(target, commentId): Promise<FetchedComment \| null>` | Falls back from `.get` to `.list` pagination |
| `reply` | `reply(target, commentId, text): Promise<void>` | Falls back to a fresh top-level comment for whole-doc comments |
| `addReaction` / `removeReaction` | `(target, replyId, emojiType = 'Typing')` | Comment reactions |

### normalize helpers (advanced)

`normalize` / `normalizeCardAction` / `normalizeReaction` / `normalizeBotAdded`
/ `normalizeComment` turn a raw Feishu event payload into a normalized object —
for custom transports or tests. `normalize` always resolves; the other four
return `null` when the payload is missing the required identity fields.

### Errors — `LarkChannelError`

Outbound / connection failures reject with a `LarkChannelError` carrying a
stable `code`:

| code | Meaning |
|---|---|
| `format_error` | Bad content format (a plain-text downgrade was attempted) |
| `target_revoked` | Reply target gone (a resend without `replyTo` was attempted) |
| `rate_limited` | Rate limited |
| `permission_denied` | Auth / permission failure |
| `upload_failed` / `ssrf_blocked` | Media upload failed / URL blocked by the SSRF guard |
| `send_timeout` / `not_connected` / `unknown` | Timeout / not connected / other |

```ts
try {
  await channel.send(chatId, { markdown });
} catch (e) {
  const err = e as LarkChannelError;
  console.log(err.code, err.message, err.context); // err.cause holds the raw error
}
```

> Errors thrown inside inbound handlers don't reject your `await` — they surface
> on the `error` event instead.

## License

MIT

