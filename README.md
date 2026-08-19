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
| `resolveSenderNames` | `boolean` | `false` | Populate `NormalizedMessage.senderName` from the chat roster (one cached `getChatMembers` per chat) |
| `resolveChatMembers` | `(chatId) => ChatMember[] \| undefined \| Promise<…>` | — | Override how `getChatMembers` sources the roster (return `undefined` to fall back to the API) |
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

`PolicyConfig`: `requireMention` · `dmMode` (`'open' \| 'allowlist' \| 'pair' \| 'disabled'`) · `dmAllowlist` · `groupAllowlist` · `respondToMentionAll` · `botLoopGuard` (see [Bot-at-bot](#bot-at-bot)). `dmAllowlist` takes **sender ids** (`ou_…` / user_id / union_id), `groupAllowlist` takes **chat ids** (`oc_…`) — an app id (`cli_…`) belongs in neither and is warned about.

`SafetyConfig`: `dedup` (`ttl`/`maxEntries`/`sweepIntervalMs`) · `processingLock` (`ttlMs`/`renewIntervalMs`) · `chatQueue` (`enabled`, `mergeWhileBusy`) · `batch.text` / `batch.media` · `staleMessageWindowMs`.

`processingLock` defaults to a 300,000 ms TTL and a 60,000 ms renewal interval. Both
values must be integer milliseconds from 1 through 2,147,483,647, and
`renewIntervalMs` must be less than `ttlMs`. If only `ttlMs` is overridden, the
renewal interval is derived as the smaller of 60,000 ms and one third of the TTL
(rounded down, with a 1 ms minimum). Lease ownership is token-bound: an active or
finalizing handler cannot be displaced merely because wall-clock time has passed
its TTL.

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
  senderName?: string;      // requires resolveSenderNames
  senderType?: string;      // 'user' | 'bot' | 'system' | 'anonymous' (from the raw event; undefined if absent)
  senderIsBot?: boolean;    // true when senderType === 'bot'; undefined when senderType is absent
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
type RejectReason = 'group_not_allowed' | 'sender_not_allowed' | 'no_mention' | 'dm_disabled' | 'mention_all_blocked' | 'bot_loop';
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
| `reply` | `reply(msg, input: SendInput, opts?: SendOptions): Promise<SendResult>` | Reply to a received message — defaults `replyTo` to it and stays in-thread when it was ([Bot-at-bot](#bot-at-bot)) |
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
| `getChatMembers` | `getChatMembers(chatId, opts?): Promise<ChatMember[]>` | Roster (**users only** — Feishu filters bots), paginated + cached ([Bot-at-bot](#bot-at-bot)) |
| `getChatBots` | `getChatBots(chatId, opts?): Promise<ChatMember[]>` | The chat's **bots** (`isBot: true`); cached; seeds the roster so bots are @-able by name ([Bot-at-bot](#bot-at-bot)) |
| `getBotIdentity` | `getBotIdentity(): BotIdentity` | This bot's own `{ openId, name }`; throws `not_connected` before `connect()` |
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

interface SendOptions { replyTo?: string; replyInThread?: boolean; mentions?: MentionInfo[]; resolveMentionsInText?: boolean; }
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

### Meetings — `channel.joinMeeting` / `channel.followMyMeeting`

The two entry points correspond to the two identities. Both return a
`MeetingSession` with the same events and methods.

| Method | Signature | Identity |
|---|---|---|
| `followMyMeeting` | `(opts: FollowMeetingOptions): Promise<MeetingSession>` | **User access token.** Follows the meeting its owner is in; nothing appears in the meeting |
| `joinMeeting` | `(meetingNo: string, opts?: JoinMeetingOptions): Promise<MeetingSession>` | App (tenant) credentials. The bot joins as a visible participant |
| `getMeetingEventHealth` | `(): MeetingEventHealth` | Diagnostics for the in-meeting event path |
| `getRetainedMeetings` | `(): MeetingMembership[]` | Meetings the bot is in with no session listening |

```ts
// User identity — no connect() needed, this path is REST polling only.
const m = await channel.followMyMeeting({
  userAccessToken: () => myAuth.freshToken(), // re-read before every poll
  stabilizeMs: 800,                           // deliver a sentence once it settles
});

// App identity — requires connect(), it is driven by event pushes.
channel.on('meetingInvited', async (invite) => {
  const m = await channel.joinMeeting(invite.meetingNo, { callId: invite.callId });

  m.on('chat', async ({ content, selfEcho }) => {
    if (selfEcho) return;                     // see "Answering yourself" below
    await m.sendMessage(`heard: ${content}`);
  });
});
```

| Session event | Payload | Notes |
|---|---|---|
| `transcript` | `{ actor, text, sentenceId, language, startMs, endMs, selfEcho }` | Captions. A later delivery of the same `sentenceId` supersedes the earlier text; requires captions / transcription to be on in the meeting |
| `chat` | `{ actor, content, messageId, messageType, sendTime, selfEcho }` | In-meeting chat. The bot's own messages come back here with `selfEcho: true` |
| `participant` | `{ actor, action: 'joined' \| 'left', joinTime, leaveTime, leaveReason }` | Participants arriving and leaving. `leaveReason` is the platform's raw value |
| `share` | `{ actor, action: 'started' \| 'ended', shareId, doc, time }` | Document sharing started / ended. A hand-off arrives as a pair in one delivery, and the order carries the meaning |
| `documentContext` | `{ contextType, commentFocus \| sectionLocation \| elementPreview, … }` | A context change inside a shared document (comment focus / section location / element preview). Identifiers only — no body text or assets |
| `end` | `{ meetingId, reason }` | The session ended. `reason` is a `MeetingEndReason`: `meeting_ended` / `no_longer_active` / `idle_timeout` / `error` / `left` / `disposed` |
| `error` | `LarkChannelError` | An error inside the session (poll failure, unpacking, a throwing handler). With no handler registered it degrades to a log rather than an unhandled rejection |

`session.on()` is **multicast** (unlike `channel.on()`, which is single-slot):
several handlers per event, and the returned function removes only its own.

| Method | Notes |
|---|---|
| `sendMessage(text)` | In-meeting message. Rejects with `not_supported` in follow mode — the bot is not in the meeting |
| `leave()` | Leave the meeting and free the slot, then end the session. Idempotent, reclaims even if the API call fails, and **still works after the session has ended** |
| `dispose()` | Stop timers and subscriptions **without leaving**. Idempotent |
| `getStats()` | Per-activity-type parse counters for this session |

#### Semantics

**`dispose()` and `leave()`** — `dispose()` stops the session's timers and event
subscriptions without calling any API; the bot stays in the meeting. `leave()` calls
`bots/leave` to remove the bot from the meeting, returns the concurrency slot, and then
ends the session; it remains callable after the session has already ended, including
after `dispose()` or `disconnect()`. `disconnect()` disposes every live session.

**After `disconnect()`, re-attach** — `disconnect()` disposes sessions but does not leave
their meetings, so the bot stays in them; a later `connect()` re-registers the event
handlers but does **not** rebuild the sessions, and pushes for those meetings are then
dropped. Sessions signal it by ending with `reason: 'disposed'`.
`getRetainedMeetings()` lists them as `{ meetingId, meetingNo }`; re-attach with
`joinMeeting(meetingNo)`, which does not consume a new concurrency slot for a meeting
already held, or call `leave()` on the new session to give the slot back. Ignoring an
entry leaves the bot in a meeting deaf, holding a slot, until the meeting ends.

**`meeting.idleTimeoutMs`** — Idle reclamation threshold in ms, default `0` (off). With
a positive value, a session that receives no in-meeting activity for that long ends,
calls `bots/leave`, and returns its slot. App identity only.

**`meeting.livenessProbeIntervalMs`** — Probe interval in ms, default `300000`.
Periodically confirms the bot is still in the meeting, covering the cases that produce
no `meeting_ended_v1` (removed by a host, meeting handed over). App identity only.

**`meeting.maxConcurrentSessions`** — Ceiling on concurrent sessions, default `32`. At
the ceiling `joinMeeting()` throws `too_many_sessions` and no `bots/join` request is
sent. The count tracks meetings joined and not yet left, so `disconnect()` does not
release it and `leave()` does.

**`meeting.sendRateLimitPerMinute`** — In-meeting messages per session per minute,
default `20`. Beyond it `sendMessage()` throws `rate_limited`.

**`selfEcho`** — Marks an item produced by this bot: messages it sends come back as
`chat`, and its speech is transcribed into `transcript`. Flagged items are delivered as
usual, leaving the decision to ignore them to the caller. It reports `true` while the
bot's own open_id is unresolved, and is always `false` in follow mode.

**Delivery order** — Items within one delivery are handed over serially in array order,
and an async handler's return value is awaited before the next item is delivered.

**`stabilizeMs`** — Caption settling window in ms, default `0`. With `0` every text
change is delivered; with a positive value a `sentenceId` is delivered once it has
received no new content for that long. Later deliveries of the same `sentenceId`
supersede earlier text, so callers should upsert on it.

Which send is later is decided by `endMs`, not by arrival order: a session ingests from
event pushes and from the liveness probe's REST read, so an earlier, shorter version of a
sentence can arrive last. While settling, a send whose `endMs` is older than the one held
is ignored. Equal values keep last-arrival-wins, since a transcription fix rewrites a
sentence without extending it. With `stabilizeMs: 0` there is no buffer to compare
against, so ordering is the caller's to handle.

**`getMeetingEventHealth()`** — Returns counters for each of the two inbound links,
`{ push, poll }`. Both carry `received` (activities received), `lastAt`, and per activity
type a `{ received, empty }` pair; `empty` counts activities of that type that unpacked
to zero items, which distinguishes "the platform never sent it" from "it arrived and
could not be read".

`push` additionally carries `registered` (whether the channel's internal `vc.bot.*`
handlers are registered, set by `connect()`) and `reason` when it is not. `registered`
describes registration, not connectivity: it stays `true` across a dropped and
reconnecting WebSocket. `poll` additionally carries `sessions`, the number of live follow
sessions, so `received: 0` with `sessions: 0` reads as "nothing to poll" rather than a
fault.

The links are counted separately because they fail independently — pushes can stop while
polling keeps working, and one total would let either link's traffic stand in for the
other's health. The split is by transport, not by session identity: an app-identity
session's liveness probe reads over REST, so what it recovers counts under `poll`.

**Follow-mode visibility** — Follow mode does not join the meeting: no bot appears in
the participant list, while everything every participant says is readable. Informing
participants and obtaining their agreement is the integrator's responsibility; the SDK
surfaces nothing on their behalf.

Examples: [`examples/10-meeting-follow.ts`](examples/10-meeting-follow.ts),
[`examples/11-meeting-join.ts`](examples/11-meeting-join.ts).

### Unwrapped events — `channel.onRawEvent`

```ts
const off = channel.onRawEvent('vc.bot.meeting_started_v1', (payload) => { … });
off(); // removes this one handler
```

**What it does** — registers a callback under a Feishu event type name and hands it
the decrypted event payload as the platform sent it. Several handlers can share one
event type without replacing each other; the return value removes the one you just
registered.

**The problem it solves** — the channel wraps a fixed set of event types: IM
messages, card actions, reactions, bot-added, Drive comments, and the three meeting
pushes the meeting channel runs on (`vc.bot.meeting_invited_v1`, `_activity_v1`,
`_ended_v1`). Everything else — approvals, calendar, contact changes, and
`vc.bot.meeting_started_v1` in the snippet above — has no entry point of its own.
The two workarounds are both bad: writing into the dispatcher's private handler map
breaks on a version bump,
and opening a second connection for the same app makes Feishu split delivery
between the two connections, so the channel's own IM messages start arriving
intermittently. `onRawEvent` puts these event types on the connection the channel
already holds.

**Side effects** — the callback receives the event *unprocessed*, so the channel's
inbound protections do not apply to it. Signature verification and decryption still
happen (they are a layer earlier), but every step after normalization is skipped:
`PolicyGate` (`dmMode`, `dmAllowlist`, `groupAllowlist`, `requireMention`), dedup,
the per-chat serialization lock, the loop guard, stale-event dropping. In practice:

- Registering a raw handler for a type the channel **already wraps** opens a second,
  unguarded entry point for it. `im.message.receive_v1` is the one to watch: a
  message your allowlist rejects on the built-in path still reaches the raw handler.
- The payload is not redacted and `includeRawEvent: false` does not affect it — it
  carries `tenant_key`, full user ids and message bodies. Logging it or forwarding
  it to a third party is on you.
- A raw handler is a pure observer: its return value is always discarded (the
  signature is `=> void | Promise<void>`), so it cannot change what goes back to
  Feishu — only delay when that is sent. One event is processed in this order: the
  built-in handler finishes, then your raw handlers finish one by one, and only then
  is the response returned to Feishu. The response can only come from a built-in
  handler; an unwrapped event type has none, so Feishu always gets "no response" —
  `onRawEvent` cannot be used to reply to Feishu. For most event types that is
  irrelevant, since Feishu only wants an acknowledgement. But a `card.action.trigger` response *is* what the user sees
  after clicking (a toast, an updated card), and Feishu puts a timeout on it: a
  raw handler that spends a few seconds on a request will make the click look failed
  even though the built-in handler produced the right result immediately. Raw
  handlers on that event type must return at once and leave real work to a queue.

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
| `not_supported` | Unavailable in this mode (e.g. `sendMessage` on a followed meeting) |
| `meeting_not_found` | No active meeting to follow, or the target is no longer active |
| `too_many_sessions` | `meeting.maxConcurrentSessions` reached |

On a permission failure the meeting path may attach `context.consoleUrl` — the
signed one-click authorization link Feishu returns. **Treat it as a credential**:
it is passed through byte for byte (re-encoding invalidates the signature) and is
dropped entirely unless it is an `https:` URL. The SDK does not write it to a log of
its own, but it does not scrub logs either — log hygiene, including anything
node-sdk writes about a failed request, is the integrator's responsibility. Hand it
to an operator; do not echo it into a chat, a UI, or a support ticket.

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

## Bot-at-bot

Multiple bots collaborating in one chat (@-ing each other to hand off work) need
a few extra signals and guards. Everything here is **opt-in / additive** — off
by default, existing behavior unchanged.

**Know who sent it.** Every `message` carries `senderType` (`'user'` / `'bot'` /
…) and the convenience `senderIsBot`, so an agent can tell a human, itself, and
another bot apart. Get the bot's own identity for its system prompt with
`getBotIdentity()`. Enable `resolveSenderNames` to fill `senderName` from the
chat roster.

**Receiving events from other bots.** Feishu does **not** deliver "another bot
@-ed me" events unless your app has the `im:message.group_at_msg` /
`include_bot` permission enabled — and the failure is silent. There is no API to
self-check this; if bot-to-bot @ mentions never arrive, verify that permission
first. **An @-only ping still wakes the bot.** When someone @-mentions the bot
but types nothing else, the message is still delivered (not dropped as empty):
`mentionedBot` is `true` while `content` is empty. Detect this "just poke the
bot" case with `mentionedBot && !content.trim()`.

**Replying to the right place.** Use `channel.reply(msg, input)` instead of
computing the reply target by hand. It replies to `msg` and **follows the
triggering message's shape**: `replyTo` defaults to `msg.messageId`, and
`replyInThread` defaults to `Boolean(msg.threadId)` — so a reply stays in a
thread when the message was in one, and stays flat when it wasn't.

| Triggering message | Default `replyInThread` | Result |
|---|---|---|
| Topic group (every message is threaded) | `true` | reply lands back in the same topic |
| Ordinary group, flat message (no thread) | `false` | plain quote-reply — does **not** start a thread |
| Ordinary group, message already in a thread | `true` | reply stays in that existing thread |

`reply()` only *follows* the trigger — it never promotes a flat message into a
thread on its own. Override either default via `opts`:

```ts
channel.reply(msg, input, { replyInThread: true });   // start a thread from a flat message
channel.reply(msg, input, { replyInThread: false });  // plain reply even inside a thread
```

**@-mentioning by name.** To @ someone back, either pass structured
`mentions` (a name-only `{ name }` is resolved to an open_id via the chat
roster) or set `resolveMentionsInText: true` to rewrite `@name` tokens in a
text/markdown body. Names resolve from the chat roster, which is seeded from
`getChatMembers` (users), `getChatBots` (bots), and bots observed in earlier
inbound mentions. So to @ another bot by name, either call `getChatBots(chatId)`
once to preload it, or rely on it having already appeared in the chat; otherwise
pass its open_id explicitly. A name that is unknown **or shared by more than one
member** is left as plain text and never mentioned — so for security-sensitive
handoffs, pass an explicit open_id.

**Restrict who can trigger the bot — by chat, not by listing each sender.**
Sender open_ids are hard to get up front, so enumerating them in `dmAllowlist`
is impractical. Instead, allow only specific chats with
`groupAllowlist: ['oc_…']` and require an @ with `requireMention: true` — this
scopes the bot to those chats without caring who sent the message.

**Breaking ping-pong loops.** Two bots can @ each other endlessly. The opt-in
`policy.botLoopGuard` counts only "another bot @-ed me" messages in a sliding
window (a human message resets it) and trips past a threshold:

```ts
policy: {
  botLoopGuard: {
    enabled: true,
    windowMs: 60_000,      // sliding window W
    maxBotMentions: 5,     // trip at N bot @-mentions in W
    scope: 'chat',         // or 'chat+sender'
    onTrip: 'reject',      // 'drop' (default) silently mutes; 'reject' emits a reject event
  },
}
```

Tune `windowMs` / `maxBotMentions` to your collaboration tempo — set them too
low and legitimate high-tempo handoffs trip it. The default `onTrip: 'drop'`
**silently** stops replying (it logs one warning on the first trip); prefer
`'reject'` (emits a `reject` event with `reason: 'bot_loop'`) when the app needs
to know it was muted. This is a heuristic backstop, not a protocol-level
guarantee.

## License

MIT
