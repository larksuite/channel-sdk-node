# examples — runnable API verification scripts

Import the source directly (`../src`) and run with
[`tsx`](https://github.com/privatenumber/tsx) — **no build needed**.

## Setup

```bash
pnpm install      # installs dependencies (incl. tsx)
```

Put credentials in **`examples/.env`** (gitignored; read by both terminal runs
and VS Code debugging):

```ini
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_TEST_CHAT_ID=oc_xxx        # target chat for send/receive examples (open_chat_id)
# needed by the comment example (05):
LARK_TEST_DOC_TOKEN=doccnxxx
LARK_TEST_DOC_TYPE=docx
LARK_TEST_COMMENT_ID=xxx
# optional:
LARK_DOMAIN=https://open.feishu.cn
HTTPS_PROXY=http://127.0.0.1:7890
```

> You can skip `.env` and `export` to your shell instead — either works (when
> `.env` is missing it falls back to shell environment variables).
> The bot needs the relevant scopes enabled in the developer console (send /
> read messages, reactions, cloud-doc comments, …) and must be added to the
> `LARK_TEST_CHAT_ID` chat.

> **VS Code debugging**: open `channel-sdk-node` as the workspace → open any
> `examples/*.ts` → F5 ("Debug current file (tsx)"). Credentials come from
> `examples/.env`.

## Run

```bash
pnpm exec tsx examples/06-normalize.ts   # offline — run this first to verify the setup
pnpm exec tsx examples/07-policy.ts      # offline
pnpm exec tsx examples/01-connect.ts
pnpm exec tsx examples/02-outbound.ts
pnpm exec tsx examples/03-stream.ts
pnpm exec tsx examples/04-receive.ts     # long-running, Ctrl-C to exit
pnpm exec tsx examples/05-comments.ts    # needs DOC_TOKEN + COMMENT_ID
```

Shortcut: `pnpm example examples/01-connect.ts`.

## Coverage map

| Script | Network? | APIs covered |
|---|---|---|
| `01-connect` | yes | `createLarkChannel` · `connect` · `botIdentity` · `getConnectionStatus` · `disconnect` |
| `02-outbound` | yes | `send` (text/markdown/post/image/card) · `updateCard` · `editMessage` · `recallMessage` · `addReaction` · `removeReactionByEmoji` · `getChatInfo` · `getChatMode` |
| `03-stream` | yes | `stream` (markdown typewriter) · `MarkdownStreamController.append` |
| `04-receive` | yes | `on` (message/cardAction/reaction/botAdded/comment/reject/error/reconnecting/reconnected) · `fetchMessage` · `downloadResource` · `send` (reply) |
| `05-comments` | yes | `comments.resolveTarget` · `fetch` · `reply` · `addReaction` · `removeReaction` |
| `06-normalize` | no | `normalize` · `normalizeCardAction` · `normalizeReaction` · `normalizeBotAdded` · `normalizeComment` · null behavior |
| `07-policy` | no | `getPolicy` · `updatePolicy` |
| `08-chats` | yes | list the groups the bot is in (to grab a `chat_id`, `im.v1.chat.list`) |
| `09-register` | no* | `registerApp` (one-click QR registration; *no appId/secret needed, but needs network + scanning) |

> `02-outbound` wraps each step in its own try/catch so one failure doesn't
> stop the rest — making it easy to see which APIs pass at a glance (failures
> print `LarkChannelError.code`).
