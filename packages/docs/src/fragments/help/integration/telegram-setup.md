Moira workflows can send notifications through `telegram-notification` nodes and deliver approval PINs through `lock` nodes. Both use the current user's configured Telegram bot and chat ID.

## Setup

### 1. Create a Bot via @BotFather

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Choose a display name (e.g., "My Moira Notifications")
4. Choose a username ending in `bot` (e.g., `my_moira_bot`)
5. BotFather will reply with a bot token — copy it (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Get Your Chat ID

**Method A — @userinfobot:**

1. Search for `@userinfobot` in Telegram
2. Send any message
3. The bot replies with your user ID — that is your chat ID

Do not put the bot token into a browser URL. URLs can be retained in browser history, screenshots, proxies, and logs. Use `@userinfobot` or the guided workflow instead.

### 3. Save Settings

1. Open Moira and go to **Settings**
2. Click the **Telegram** tab
3. Enter your **Bot Token** in the corresponding field
4. Enter your **Chat ID** in the corresponding field
5. Make sure **Enabled** is toggled on
6. Click **Save** for each setting

### 4. Send a Test Notification

On the same Telegram tab in Settings, click **Test Notification**. You should receive a message from your bot in Telegram.

:::caution[Important]
You must send at least one message to your bot in Telegram before testing. The Telegram API requires this before the bot can message you.
:::

## Guided Setup via Agent

If you're using Moira through an MCP client (Claude Code, Claude Desktop), you can start the guided setup workflow:

```
start({
  workflowId: "moira/telegram-setup",
  parentExecutionId: "none",
  skipTelegramCheck: true
})
```

`skipTelegramCheck: true` is required for this bootstrap workflow when Telegram is not configured; otherwise the normal notification preflight prevents an execution from starting. The flag bypasses only preflight for optional `telegram-notification` nodes. It cannot bypass trusted PIN delivery for a `lock` node.

The workflow inspects masked existing settings, lets you test or explicitly replace them, keeps credentials out of workflow output, verifies persisted settings, sends a secret-free test, and confirms actual receipt.

## Workflow locks

A workflow containing a `lock` node starts only when the current user has a valid bot token and chat ID. When execution reaches the node, Moira sends the generated PIN only to that configured chat and activates the lock after the send succeeds. Missing or invalid settings return setup guidance without a Process ID. A later send failure leaves no usable lock from that attempt; retry the same node after delivery is available.

MCP and workflow responses do not reveal the generated PIN. Unlock by entering a PIN provided by the user or by using the Approve button in Telegram.

## Troubleshooting

### "Chat not found" Error

The bot cannot send messages until you send it a message first. Open Telegram, find your bot, send any text (e.g., "hello"), then retry.

### "Invalid token" Error

The bot token is incorrect or expired. Go to @BotFather, send `/mybots`, select your bot, and check the token. Generate a new one if needed.

### "Network error" or "Timeout"

Temporary connectivity issue. Wait a moment and retry. If persistent, check that the Moira server can reach `api.telegram.org`.

### Bot Does Not Respond

Bots created via @BotFather do not respond to messages by default. Moira sends through them when a workflow triggers a `telegram-notification` node or needs trusted PIN delivery for a `lock` node.

### Notification Not Received

1. Verify you sent a message to the bot (required by Telegram API)
2. Check your chat ID is correct (use @userinfobot to confirm)
3. Verify Telegram is enabled in Settings > Telegram tab
4. Check the bot token has not been revoked
