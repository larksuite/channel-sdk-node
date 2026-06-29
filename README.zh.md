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

`PolicyConfig`：`requireMention` · `dmMode`（`'open' \| 'allowlist' \| 'pair' \| 'disabled'`）· `dmAllowlist` · `groupAllowlist` · `respondToMentionAll`。

`SafetyConfig`：`dedup`（`ttl`/`maxEntries`/`sweepIntervalMs`）· `chatQueue`（`enabled`、`mergeWhileBusy`）· `batch.text` / `batch.media` · `staleMessageWindowMs`。

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
  senderName?: string;
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
type RejectReason = 'group_not_allowed' | 'sender_not_allowed' | 'no_mention' | 'dm_disabled' | 'mention_all_blocked';
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

interface SendOptions { replyTo?: string; replyInThread?: boolean; mentions?: MentionInfo[]; }
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

```ts
try {
  await channel.send(chatId, { markdown });
} catch (e) {
  const err = e as LarkChannelError;
  console.log(err.code, err.message, err.context); // err.cause 是原始错误
}
```

> 入站 handler 内部抛的错不会冒泡到你的 `await`，而是统一进 `error` 事件。

## License

MIT
