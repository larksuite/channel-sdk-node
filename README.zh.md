# @larksuite/channel

[English](./README.md) | **简体中文**

Channel SDK —— 让 agent 或外部服务顺畅地集成飞书消息系统:一行 `import` 就能拿到
一个能可靠收发消息、归一化事件、流式回复、上传媒体、响应卡片按钮的集成实例,而不必
关心 WebSocket 状态、十几种 `msg_type` 分支、@-mention placeholder 怎么拼。

它构建在 [`@larksuiteoapi/node-sdk`](https://github.com/larksuite/node-sdk) 之上,
对外只暴露一个入口,使用者不再需要直接 import node-sdk。

## 安装

```bash
npm install @larksuite/channel
# 或:pnpm add @larksuite/channel
```

## 最小可运行示例

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

不需要管 WS 怎么连、不需要管事件怎么解析、不需要管引用消息怎么展开。

## 能力清单

- **L1 传输**:WS 长连接 / 自动重连 / 心跳保活 / 握手超时 / webhook 模式
- **L2 归一化**:NormalizedMessage / @-mention 处理 / merge_forward 展开 /
  card / reaction / comment / botAdded 归一化
- **L3 策略与安全**:requireMention / 白名单 / 去重 / 过期丢弃 / 按 chat 串行
- **L4 出站**:send(11 种 input)/ 流式打字机卡片 / updateCard / reaction /
  媒体上传(含 SSRF 防护)/ 自动回退

## API

### 入口

| API | 说明 |
|---|---|
| `createLarkChannel(opts: LarkChannelOptions): LarkChannel` | 工厂函数（推荐） |
| `new LarkChannel(opts)` | 类形式，等价 |

只读实例成员：`channel.comments`（评论 surface）、`channel.rawClient`（底层 `Client`，逃生通道）、`channel.rawWsClient`（底层 `WSClient`）、`channel.botIdentity`（`connect()` 后可用）。

### 一键扫码注册 — `registerApp`

通过二维码设备码流程引导出一个 app 的 `appId` / `appSecret`（无需预先有凭据）。`onQRCodeReady` 回调里拿到二维码 URL，用户扫码创建/授权 app 后，resolve 出凭据，直接喂给 `createLarkChannel`。

```ts
import { registerApp, createLarkChannel } from '@larksuite/channel';

const { client_id, client_secret } = await registerApp({
  onQRCodeReady: ({ url, expireIn }) => console.log('扫码注册：', url),
  onStatusChange: (s) => console.log('状态：', s.status),
});
const channel = createLarkChannel({ appId: client_id, appSecret: client_secret });
```

`RegisterAppOptions`：`onQRCodeReady`（必填）· `onStatusChange?` · `appPreset?`（预填 app 名称/描述/头像）· `domain?` / `larkDomain?` · `signal?`（AbortSignal）· `source?` —— 可选的来源标识，拼进二维码 URL 的 `source/<name>`（原样透传，不设默认）。

### 构造参数 `LarkChannelOptions`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appId` / `appSecret` | `string` | — | 必填 |
| `transport` | `'websocket' \| 'webhook'` | `'websocket'` | 传输方式 |
| `webhook` | `WebhookOptions` | — | webhook 模式配置 |
| `policy` | `PolicyConfig` | — | 谁能触发 bot（入站策略） |
| `safety` | `SafetyConfig` | — | 去重 / 过期 / 按 chat 串行 / 批合并 |
| `outbound` | `OutboundConfig` | — | 出站行为（分片、流式、SSRF、重试） |
| `resolveChatMode` | `boolean` | `false` | 填充 `NormalizedMessage.chatMode`（每 chat 一次 cached `chat.get`） |
| `resolveSenderNames` | `boolean` | `false` | 从群成员 roster 填充 `NormalizedMessage.senderName`（每 chat 一次 cached `getChatMembers`） |
| `resolveChatMembers` | `(chatId) => ChatMember[] \| undefined \| Promise<…>` | — | 覆写 `getChatMembers` 的 roster 来源（返回 `undefined` 回落 API） |
| `keepalive` | `{ enabled; onUnrecoverable?; intervalMs? }` | — | 连接保活看门狗（仅 WS） |
| `respectProxyEnv` | `boolean` | `false` | 读 `HTTPS_PROXY` / `HTTP_PROXY`，WS + REST 都走代理 |
| `httpTimeoutMs` | `number` | — | REST 调用超时 |
| `agent` | `http(s).Agent` | — | 自定义 WS agent（优先于 `respectProxyEnv`） |
| `handshakeTimeoutMs` | `number` | — | WS 握手超时 |
| `wsConfig` | `WSConfigOverrides` | — | WS 客户端设置（`pingTimeout`） |
| `domain` | `Domain \| string` | `Feishu` | 飞书 / Lark 域名 |
| `cache` | `Cache` | 内置 | 缓存实例（去重 / 凭据） |
| `logger` / `loggerLevel` | `Logger` / `LoggerLevel` | `info` | 日志 |
| `httpInstance` | `HttpInstance` | 共享默认 | 自定义 HTTP 实例（自带时 timeout/代理由你自行配置） |
| `source` | `string` | — | User-Agent 标记 |
| `includeRawEvent` | `boolean` | `false` | 每个事件附带原始载荷 `evt.raw` |

`PolicyConfig`：`requireMention` · `dmMode`（`'open' \| 'allowlist' \| 'pair' \| 'disabled'`）· `dmAllowlist` · `groupAllowlist` · `respondToMentionAll` · `botLoopGuard`（见 [Bot-at-bot](#bot-at-bot)）。`dmAllowlist` 填**发送方 id**（`ou_…` / user_id / union_id），`groupAllowlist` 填**群 id**（`oc_…`）——应用 id（`cli_…`）两者都不属于，填了会告警。

`SafetyConfig`：`dedup`（`ttl`/`maxEntries`/`sweepIntervalMs`）· `processingLock`（`ttlMs`/`renewIntervalMs`）· `chatQueue`（`enabled`、`mergeWhileBusy`）· `batch.text` / `batch.media` · `staleMessageWindowMs`。

### 生命周期

| 方法 | 签名 | 说明 |
|---|---|---|
| `connect` | `connect(): Promise<void>` | 建连；WS 首次握手成功后 resolve |
| `disconnect` | `disconnect(): Promise<void>` | 断连并清理 |
| `getConnectionStatus` | `(): WSConnectionStatus \| undefined` | 连接快照（webhook 模式 / 未连时为 `undefined`） |

### 事件 — `channel.on(name, handler)`

`on('message', fn)` 订阅单事件，或 `on({ message, cardAction })` 批量；返回取消订阅函数。

| 事件 | 回调参数 | 触发时机 |
|---|---|---|
| `message` | `NormalizedMessage` | 收到（已过策略/安全/批合并的）消息 |
| `cardAction` | `CardActionEvent` | 卡片按钮 / 表单提交（handler 可**返回** `CardActionResponse`，见下） |
| `reaction` | `ReactionEvent` | 消息表情增删 |
| `botAdded` | `BotAddedEvent` | bot 被加入群 |
| `comment` | `CommentEvent` | 云文档评论 @bot |
| `reject` | `RejectEvent` | 消息被策略拒绝（`reason`） |
| `error` | `LarkChannelError` | 内部错误 |
| `reconnecting` / `reconnected` | `()` | WS 重连生命周期 |

```ts
interface NormalizedMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  chatMode?: 'p2p' | 'group' | 'topic'; // 需 resolveChatMode
  senderId: string;
  senderName?: string;      // 需 resolveSenderNames
  senderType?: string;      // 'user' | 'bot' | 'system' | 'anonymous'（透传自原始事件；缺失则 undefined）
  senderIsBot?: boolean;    // senderType === 'bot' 时为 true；senderType 缺失时为 undefined
  content: string;          // 归一化后的可读内容
  rawContentType: string;   // 原始 msg_type
  resources: ResourceDescriptor[];
  mentions: MentionInfo[];
  mentionAll: boolean;
  mentionedBot: boolean;
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
  createTime: number;
  raw?: unknown;            // includeRawEvent 时附带
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

#### 卡片回调响应

`cardAction` handler 可**返回**一个 `CardActionResponse`，给点击用户原生的即时反馈
——最常见是 toast，无需更新整张卡片：

```ts
channel.on('cardAction', async (evt) => {
  await handleAction(evt);
  return { toast: { type: 'success', content: '已提交' } };
  // 或就地更新卡片：{ card: { type: 'raw', data: { ... } } }
});
```

返回的对象会原样回传给 Feishu/Lark 作为该次点击的回调响应。不返回（`undefined`）
即「无即时响应」——与旧行为一致，现有 handler 无需改动。

注意：
- 响应是**同步**回传，且卡片动作按 chat **串行**执行（排在该 chat 在途工作之后）。
  耗时 handler 会让响应延迟、甚至超过 Feishu 回调超时——重活仍建议 detach 到后台、
  用卡片更新反映进度。
- 对象会原样发给 Feishu：**勿**放内部 secret / PII，且须可被 JSON 序列化。

### 出站方法

| 方法 | 签名 | 说明 |
|---|---|---|
| `send` | `send(to: string, input: SendInput, opts?: SendOptions): Promise<SendResult>` | `to` 支持 open_id / chat_id / user_id（自动识别） |
| `reply` | `reply(msg, input: SendInput, opts?: SendOptions): Promise<SendResult>` | 回复收到的消息——默认 `replyTo` 指向它、原本在话题内则留话题内（[Bot-at-bot](#bot-at-bot)） |
| `stream` | `stream(to, input: StreamInput, opts?): Promise<SendResult>` | 流式回复 |
| `updateCard` | `updateCard(messageId, card): Promise<void>` | 整卡更新 |
| `editMessage` | `editMessage(messageId, text): Promise<void>` | 编辑 text/post |
| `recallMessage` | `recallMessage(messageId): Promise<void>` | 撤回 |
| `addReaction` | `addReaction(messageId, emojiType): Promise<string>` | 加表情，返回 `reaction_id` |
| `removeReaction` | `removeReaction(messageId, reactionId): Promise<void>` | 按 id 删 |
| `removeReactionByEmoji` | `removeReactionByEmoji(messageId, emojiType): Promise<boolean>` | 删 bot 自己的 |
| `downloadResource` | `downloadResource(messageId, fileKey, type): Promise<Buffer>` | 下载**收到的消息**里的媒体；`type`: `'image'` / `'file'` |
| `getChatInfo` | `getChatInfo(chatId): Promise<ChatInfo>` | 群信息 |
| `getChatMode` | `getChatMode(chatId): Promise<'p2p' \| 'group' \| 'topic'>` | 群模式 |
| `getChatMembers` | `getChatMembers(chatId, opts?): Promise<ChatMember[]>` | 群成员（**仅用户**——飞书过滤 bot），翻页 + 缓存（[Bot-at-bot](#bot-at-bot)） |
| `getChatBots` | `getChatBots(chatId, opts?): Promise<ChatMember[]>` | 群内**机器人**（`isBot: true`）；缓存；写入 roster，使 bot 可按名字 @（[Bot-at-bot](#bot-at-bot)） |
| `getBotIdentity` | `getBotIdentity(): BotIdentity` | 本 bot 自身 `{ openId, name }`；`connect()` 前调用抛 `not_connected` |
| `fetchMessage` | `fetchMessage(messageId): Promise<NormalizedMessage \| undefined>` | 取并归一化某条消息 |

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

媒体 `source` 支持 URL / 本地路径 / Buffer 三种，内置 SSRF 防护。

### 运行期策略

| 方法 | 签名 | 说明 |
|---|---|---|
| `updatePolicy` | `updatePolicy(partial: Partial<PolicyConfig>): void` | 热改策略（部分合并，立即生效） |
| `getPolicy` | `getPolicy(): Readonly<PolicyConfig>` | 读取当前策略 |

### 云文档评论 — `channel.comments`

| 方法 | 签名 | 说明 |
|---|---|---|
| `resolveTarget` | `resolveTarget(fileToken, fileType): Promise<CommentTarget \| null>` | wiki 节点 → obj_token；不支持的类型返回 `null` |
| `fetch` | `fetch(target, commentId): Promise<FetchedComment \| null>` | `.get` 失败自动回退 `.list` 翻页 |
| `reply` | `reply(target, commentId, text): Promise<void>` | 整文档评论拒绝时回退为新顶层评论 |
| `addReaction` / `removeReaction` | `(target, replyId, emojiType = 'Typing')` | 评论表情 |

### 会议通道 — `channel.joinMeeting` / `channel.followMyMeeting`

两个入口分别对应用户身份与应用身份，均返回 `MeetingSession`，其事件与方法完全一致。

| 方法 | 签名 | 身份 |
|---|---|---|
| `followMyMeeting` | `(opts: FollowMeetingOptions): Promise<MeetingSession>` | **User access token**。跟随 token 持有者当前所在的会议，会议中不出现任何机器人 |
| `joinMeeting` | `(meetingNo: string, opts?: JoinMeetingOptions): Promise<MeetingSession>` | 应用（tenant）凭据。Bot 作为真实参会者入会 |
| `getMeetingEventHealth` | `(): MeetingEventHealth` | 会中事件链路的诊断数据 |
| `getRetainedMeetings` | `(): MeetingMembership[]` | Bot 仍在会中、但没有会话在监听的会议 |

```ts
// 用户身份 —— 不需要 connect()，这条路径只走 REST 轮询
const m = await channel.followMyMeeting({
  userAccessToken: () => myAuth.freshToken(), // 每轮轮询前现取
  stabilizeMs: 800,                           // 一句说完再投递
});

// 应用身份 —— 需要 connect()，它依赖事件推送
channel.on('meetingInvited', async (invite) => {
  const m = await channel.joinMeeting(invite.meetingNo, { callId: invite.callId });

  m.on('chat', async ({ content, selfEcho }) => {
    if (selfEcho) return;                     // 见下面「自己跟自己对话」
    await m.sendMessage(`收到:${content}`);
  });
});
```

| 会话事件 | 载荷 | 说明 |
|---|---|---|
| `transcript` | `{ actor, text, sentenceId, language, startMs, endMs, selfEcho }` | 字幕。同 `sentenceId` 的后续投递为覆盖，需要会议已开启字幕 / 转写 |
| `chat` | `{ actor, content, messageId, messageType, sendTime, selfEcho }` | 会中聊天。Bot 自己发出的消息也会以此回流，`selfEcho` 为 `true` |
| `participant` | `{ actor, action: 'joined' \| 'left', joinTime, leaveTime, leaveReason }` | 参会人进出。`leaveReason` 为平台原始取值 |
| `share` | `{ actor, action: 'started' \| 'ended', shareId, doc, time }` | 文档共享开始 / 结束。文档切换会在一次推送内成对出现，顺序即语义 |
| `documentContext` | `{ contextType, commentFocus \| sectionLocation \| elementPreview, … }` | 共享文档内的上下文变化（评论聚焦 / 章节定位 / 元素预览）。只带标识，不带正文或素材 |
| `end` | `{ meetingId, reason }` | 会话结束。`reason` 取值见 `MeetingEndReason`：`meeting_ended` / `no_longer_active` / `idle_timeout` / `error` / `left` / `disposed` |
| `error` | `LarkChannelError` | 会话内的错误（轮询失败、拆包异常、handler 抛错）。未注册该 handler 时降级为日志，不会打挂进程 |

`session.on()` 是**多播**（与单槽的 `channel.on()` 不同）：同一事件可注册多个 handler，返回的退订函数只摘掉自己注册的那一个。

| 方法 | 说明 |
|---|---|
| `sendMessage(text)` | 发会中消息。跟随模式下抛 `not_supported` —— Bot 并不在会议里 |
| `leave()` | 离会并归还并发槽位，然后结束会话。幂等；**接口失败也照样完成回收**，且**会话已结束之后仍然有效** |
| `dispose()` | 只停定时器与订阅，**不离会**。幂等 |
| `getStats()` | 本会话按 activity 类型的解析计数 |

#### 语义说明

**`dispose()` 与 `leave()`** — `dispose()` 停止本会话的定时器与事件订阅，不调用任何接口，Bot 仍留在会议中。`leave()` 调用 `bots/leave` 使 Bot 退出会议、归还并发槽位，然后结束会话；在会话已结束之后（包括 `dispose()` 或 `disconnect()` 之后）仍然可以调用。`disconnect()` 对所有活跃会话执行 `dispose()`。

**`disconnect()` 之后需要重新 attach** —— `disconnect()` 只 dispose 会话、不退出会议，Bot 仍留在会中；之后再 `connect()` 会重新注册事件 handler，但**不会重建会话**，这些会议的推送随即被丢弃。会话以 `reason: 'disposed'` 结束作为信号。`getRetainedMeetings()` 以 `{ meetingId, meetingNo }` 列出这些会议；用 `joinMeeting(meetingNo)` 重新 attach（对已持有的会议不占用新的并发槽位），或在拿到新会话后调 `leave()` 归还槽位。放着不处理，Bot 会一直留在会议里收不到事件、并占着槽位，直到会议结束。

**`meeting.idleTimeoutMs`** — 空闲回收阈值（毫秒），默认 `0` 即关闭。设为正值时，会话在该时长内未收到任何会中活动事件即结束、调用 `bots/leave` 离会并归还槽位。仅作用于应用身份会话。

**`meeting.livenessProbeIntervalMs`** — 探活间隔（毫秒），默认 `300000`。周期性确认 Bot 仍在会议中，用于覆盖不产生 `meeting_ended_v1` 的场景（被移出会议、会议转让）。仅作用于应用身份会话。

**`meeting.maxConcurrentSessions`** — 并发会话上限，默认 `32`。达到上限时 `joinMeeting()` 抛 `too_many_sessions`，且不会发出 `bots/join` 请求。计数按「已入会且未离会」的会议统计，因此 `disconnect()` 不释放计数、`leave()` 才释放。

**`meeting.sendRateLimitPerMinute`** — 每会话每分钟的会中消息上限，默认 `20`。超出时 `sendMessage()` 抛 `rate_limited`。

**`selfEcho`** — 标记该条目由本 Bot 产生：Bot 发出的会中消息会以 `chat` 回流，其发言经会议转写后进入 `transcript`。带该标记的条目照常投递，由调用方决定是否忽略。Bot 自身 open_id 尚未解析完成时取 `true`；跟随模式下恒为 `false`。

**投递顺序** — 同一次推送内的条目按数组顺序串行投递，异步 handler 的返回值会被 await 后再投递下一条。

**`stabilizeMs`** — 字幕定稿防抖窗口（毫秒），默认 `0`。`0` 时每次文本变化都投递；正值时同一 `sentenceId` 在该时长内没有新内容才投递一次。同 `sentenceId` 的后续投递为覆盖语义，调用方应按其 upsert。

「后续」以 `endMs` 判定，而非以到达顺序：一个会话同时从事件推送和探活的 REST 读取摄入，因此同一句话的较早、较短版本可能最后到达。定稿窗口内，`endMs` 比已持有版本更旧的投递会被忽略；相等时保持「后到者覆盖」，因为转写纠错会在不延长这句话的前提下改写文本。`stabilizeMs: 0` 时没有缓冲可比较，顺序由调用方自行处理。

**`getMeetingEventHealth()`** — 按两条入站链路分别返回计数，形状为 `{ push, poll }`。两者都带 `received`（已收到的活动数）、`lastAt`，以及按 activity 类型统计的 `{ received, empty }`；`empty` 指该类型的活动拆包后条目数为 0，用于区分「平台未推送」与「已推送但未能解析」。

`push` 另外带 `registered`（channel 内部的 `vc.bot.*` handler 是否已注册，由 `connect()` 置上）以及未注册时的 `reason`。`registered` 描述的是注册状态而非连接状态：WebSocket 断开重连期间它仍为 `true`。`poll` 另外带 `sessions`，即存活的跟随会话数，因此 `received: 0` 且 `sessions: 0` 表示「没有可轮询的对象」，而不是故障。

两条链路分开计数，因为它们独立失效——推送停了而轮询照常工作是可能的，合成一个总数会让其中一条的流量替另一条背书。划分依据是**传输方式**而非会话身份：应用身份会话的探活走 REST 读取，因此它补读到的活动计入 `poll`。

**跟随模式的可见性** — 跟随模式不入会，参会者列表中不出现机器人，同时可读取全部参会者的发言。告知参会者并取得同意由接入方负责，SDK 不代为提示。

示例：[`examples/10-meeting-follow.ts`](examples/10-meeting-follow.ts)、[`examples/11-meeting-join.ts`](examples/11-meeting-join.ts)。

### 未封装事件 — `channel.onRawEvent`

```ts
const off = channel.onRawEvent('vc.bot.meeting_started_v1', (payload) => { … });
off(); // 只移除这一个 handler
```

**这个 API 做什么** — 按飞书事件类型名注册一个回调，回调拿到的是解密后的原始事件 payload（平台发来的样子）。同一个事件类型可以注册多个回调，彼此不覆盖；返回值用于移除刚注册的那一个。

**它解决什么问题** — channel 只封装了固定几类事件：IM 消息、卡片回调、表情回复、机器人入群、云文档评论，以及会议通道所依赖的三个会议推送（`vc.bot.meeting_invited_v1`、`_activity_v1`、`_ended_v1`）。其余类型 —— 审批、日历、通讯录变更，以及上面示例里的 `vc.bot.meeting_started_v1` —— 都没有自己的入口。两种绕法都不好：直接写 dispatcher 的私有 handler map，版本一升就坏；为同一个应用再开一条长连接，飞书会把事件在两条连接之间分流投递，channel 自己的 IM 消息就会时有时无。`onRawEvent` 让这些事件类型走 channel 已经持有的那条连接。

**需要关注的副作用** — 回调收到的是**未经处理**的事件，channel 的入站防护对它不生效。验签与解密仍然会做（那在更前面一层），但归一化之后的每一步都跳过了：`PolicyGate`（`dmMode` / `dmAllowlist` / `groupAllowlist` / `requireMention`）、去重、按 chat 串行的处理锁、防回环、过期事件丢弃。具体来说：

- 给 channel **已经封装**的事件类型注册 raw handler，等于为它开了第二条不设防的入口。最需要留意的是 `im.message.receive_v1`：内建路径上被白名单拒掉的消息，raw handler 照样收得到。
- payload 不做脱敏，也不受 `includeRawEvent: false` 影响 —— 里面有 `tenant_key`、完整用户 ID、消息原文。要打日志或转发给第三方，得自己处理。
- raw handler 是纯观察者：它的返回值一律被丢弃（签名即 `=> void | Promise<void>`），因此改不了回给飞书的内容，但会推迟这个内容发出的时间。一次事件的处理顺序是：内建 handler 跑完 → 你的 raw handler 逐个跑完 → 才向飞书返回响应。响应内容只可能来自内建 handler；未封装的事件类型没有内建 handler，回给飞书的就固定是"无响应"—— 也就是说 `onRawEvent` 无法用来给飞书回内容。多数事件类型不受影响（飞书只要一个确认）。但 `card.action.trigger` 的响应内容就是用户点按钮后看到的结果（如 toast、卡片更新），飞书对它有超时限制 —— raw handler 里做一次耗时几秒的请求，内建 handler 早就把正确结果算好了，也会因为迟迟发不出去而让用户看到操作失败。所以这个事件类型上的 raw handler 要立即返回，真正的活儿交给队列异步做。

### normalize 工具函数（高级）

`normalize` / `normalizeCardAction` / `normalizeReaction` / `normalizeBotAdded` / `normalizeComment` —— 把原始 Feishu 事件载荷归一化，供自定义传输或单测使用。`normalize` 必返回结果；其余 4 个在缺少必需身份字段时返回 `null`。

### 错误处理 — `LarkChannelError`

出站 / 连接失败统一 reject 出 `LarkChannelError`，带稳定 `code`：

| code | 含义 |
|---|---|
| `format_error` | 内容格式错误（已尝试降级纯文本） |
| `target_revoked` | 回复目标已撤回（已尝试去 replyTo 重发） |
| `rate_limited` | 触发限流 |
| `permission_denied` | 权限 / 鉴权失败 |
| `upload_failed` / `ssrf_blocked` | 媒体上传失败 / URL 被 SSRF 拦截 |
| `send_timeout` / `not_connected` / `unknown` | 超时 / 未连接 / 其它 |
| `not_supported` | 当前模式下不可用（如对「跟随」的会议调 `sendMessage`） |
| `meeting_not_found` | 没有可跟随的活跃会议，或目标会议已不活跃 |
| `too_many_sessions` | 达到 `meeting.maxConcurrentSessions` |

权限不足时，会议链路可能在 `context.consoleUrl` 上带回飞书返回的**带签名一键授权链接**。**请当凭据对待**：它逐字节原样透传（重新编码会让签名失效），非 `https:` 取值会被直接丢弃。SDK 自身不会把它写进日志，但也不清洗日志 —— 日志安全（含 node-sdk 对失败请求写出的内容）由接入方负责。把它交给运维，不要回显到聊天、前端或工单里。

```ts
try {
  await channel.send(chatId, { markdown });
} catch (e) {
  const err = e as LarkChannelError;
  console.log(err.code, err.message, err.context); // err.cause 是原始错误
}
```

> 入站 handler 内部抛的错不会冒泡到你的 `await`，而是统一进 `error` 事件。

## Bot-at-bot

多个 bot 在同一群里协作（互相 @ 接力）需要一些额外信号与守卫。以下能力**默认全部关闭、
需要时才手动打开，且都是新增功能**——不开就跟现在的行为完全一样，不会影响你已有的代码。

**分清谁发的。** 每条 `message` 带 `senderType`（`'user'` / `'bot'` / …）和便捷布尔
`senderIsBot`，agent 能区分人、自己、别的 bot。用 `getBotIdentity()` 拿本 bot 身份写进
system prompt。开 `resolveSenderNames` 从群成员 roster 填 `senderName`。

**收得到别的 bot 的事件。** 除非应用开了 `im:message.group_at_msg` / `include_bot`
权限，飞书**默认不投递**「别的 bot @ 我」的事件——且失败**静默**。平台无自查 API；若
bot 间 @ 收不到，先确认该权限。**只 @ 一下也能唤醒 bot。** 有人 @ 了 bot 但没打任何字时，
这条消息照常投递（不会被当成空消息丢弃）：`mentionedBot` 为 `true`、`content` 为空。
用 `mentionedBot && !content.trim()` 就能识别这种「只戳一下 bot」的情况。

**回到正确位置。** 用 `channel.reply(msg, input)` 代替手算回复目标。它回复 `msg`，并
**跟随触发消息本来的形态**：`replyTo` 默认取 `msg.messageId`，`replyInThread` 默认取
`Boolean(msg.threadId)`——触发消息在话题里就留在话题里，是平铺的就平铺回复。

| 触发消息 | 默认 `replyInThread` | 结果 |
|---|---|---|
| 话题群（每条消息都归属话题） | `true` | 回复落回同一个话题 |
| 普通群，平铺消息（不在任何话题里） | `false` | 普通引用式回复——**不会**开话题 |
| 普通群，消息本就在某话题里 | `true` | 回复留在那个已存在的话题里 |

`reply()` 只「跟随」触发消息，**不会**主动把平铺消息升级成话题。需要时用 `opts` 覆写：

```ts
channel.reply(msg, input, { replyInThread: true });   // 对平铺消息强制起一个话题
channel.reply(msg, input, { replyInThread: false });  // 在话题里也发普通回复
```

**按名字 @。** 要 @ 回某人，要么传结构化 `mentions`（只带 `{ name }` 会用群 roster 补
open_id），要么设 `resolveMentionsInText: true` 把 text/markdown 正文里的 `@名字` 归一。
名字来源 = `getChatMembers`（用户）+ `getChatBots`（机器人）+ 之前入站 mention 里观察到的
身份。因此按名字 @ 别的 bot 需先调一次 `getChatBots(chatId)` 预热，或依赖它已在群里露过面；
否则需显式传入它的 open_id。名字**未知或被多个成员共用**时，会原样保留为纯文本、不会误 @
——安全敏感的接力使用显式 open_id 更稳妥。

**限定谁能触发 bot：按群名单，而不是逐个发送方。** 发送方的 open_id 通常事先拿不到，靠
`dmAllowlist` 一个个列发送方并不现实。更省事的做法：用 `groupAllowlist: ['oc_…']` 只允许
指定的群，再配 `requireMention: true` 要求 @ 才响应——这样就把 bot 圈定在这些群里，不必
关心具体是谁发的。

**打断 ping-pong 死循环。** 两 bot 可能互 @ 停不下来。默认关闭、需手动开启的
`policy.botLoopGuard` 只统计「别的 bot @ 我」的消息（人发言会清零），在滑动窗口内超阈值即命中：

```ts
policy: {
  botLoopGuard: {
    enabled: true,
    windowMs: 60_000,      // 滑动窗口 W
    maxBotMentions: 5,     // W 内到 N 条 bot @ 即命中
    scope: 'chat',         // 或 'chat+sender'
    onTrip: 'reject',      // 'drop'（默认）静默停回；'reject' 触发 reject 事件
  },
}
```

按业务节奏调 `windowMs` / `maxBotMentions`——设太低会误伤正常高频接力。默认
`onTrip: 'drop'` 会**静默**停回（仅首次命中打一条 warn）；需要感知被静默时用 `'reject'`
（触发 `reason: 'bot_loop'` 的 reject 事件）。这是启发式兜底，非协议级保证。

## License

MIT
