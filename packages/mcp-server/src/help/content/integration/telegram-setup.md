---
title: Telegram Setup
description: Configure Telegram workflow notifications, administrator registration messages and trusted lock PIN delivery
sidebar:
  order: 5
---

Moira workflows send ordinary notifications through `user-notification`, and Moira itself tells you
when a run starts waiting for you (a step marked `humanGate`, or the agent's question) and, for a
marked step that sets `remindAfter`, reminds you once — also when the workflow sent the first message
about that step itself (`notify: "off"`); when Telegram is enabled, its built-in adapter uses the current user's configured bot and chat
ID for both. The deprecated
`telegram-notification` node keeps Telegram-only compatibility, while `lock` uses a separate trusted
Telegram path for approval PINs.

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

1. Open Moira and go to **Settings → Notifications**
2. Find the **Telegram** card; **Telegram setup** in the section heading walks through these steps
3. Enter your **Bot token** in the corresponding field
4. Enter your **Chat ID** in the corresponding field
5. Make sure **Send notifications to Telegram** is turned on
6. Click **Save** for each setting

### 4. Send a Test Notification

When the Telegram card shows **Ready**, click **Send test**. Moira sends a fixed test message using
the saved settings; the browser does not resend the bot token or chat ID. You should receive the
message from your bot in Telegram.

:::caution[Important]
You must send at least one message to your bot in Telegram before testing. The Telegram API requires this before the bot can message you.
:::

## Administrator registration notifications

Each receiving administrator first configures their own Telegram card as described above. The
account must be admitted by the installation's access policy; a blocked or pending administrator,
or a disabled/incomplete Telegram channel, receives no registration message.

In **Admin → Settings Manager → Values → System configuration**, use **Notify administrators of
new registrations** and save. The global boolean `system.notify_admins_on_registration` is enabled
by default. Turning it off stops registration messages for the installation without changing
anyone's personal Telegram settings. The checkbox does not store another bot token or chat ID.

A successful new email or OAuth account triggers a plain Telegram message with its name, email,
registration time and a link to its administrator detail page. Existing-user sign-in, linking
another provider and failed registration do not trigger it. The ordinary **Send test** button
checks your saved Telegram delivery configuration; it does not simulate a registration.

Delivery does not hold up the registration response. A recipient's failure does not prevent
delivery to other administrators or invalidate the new account. Delivery is best-effort: a
timeout, lost response or process interruption can leave the outcome unknown, and Moira does not
automatically resend the event.

## Guided Setup via Agent

If you're using Moira through an MCP client (Claude Code, Claude Desktop), you can start the guided setup workflow:

```
start({
  action: "prepare",
  workflowId: "moira/telegram-setup",
  parentExecutionId: "none",
  skipNotificationCheck: true
})
start({ action: "execute", startAttemptId: "<Start attempt ID from prepare>" })
```

Set `skipNotificationCheck: true` while preparing this bootstrap workflow when Telegram is not configured; otherwise execute returns a stable `START_PRECONDITION_CHANGED` receipt because of its legacy `telegram-notification` test node. The flag bypasses only optional ordinary-notification preflight. `skipTelegramCheck` remains a deprecated alias with the same behavior. Neither field can bypass trusted PIN delivery for a `lock` node.

The workflow inspects masked existing settings, lets you test or explicitly replace them, keeps credentials out of workflow output, verifies persisted settings, sends a secret-free test, and confirms actual receipt.

## Workflow locks

A workflow containing a `lock` node starts only when the current user has a valid bot token and chat ID. Execute checks that configuration before creating the execution and stores a `START_PRECONDITION_CHANGED` receipt when it is unavailable. When execution reaches the node, Moira sends the generated PIN only to that configured chat and activates the lock after the send succeeds. A later send failure leaves no usable lock from that attempt; retry the same node after delivery is available.

MCP and workflow responses do not reveal the generated PIN. Unlock by entering a PIN provided by the user or by using the Approve button in Telegram.

## Troubleshooting

### "Chat not found" Error

The bot cannot send messages until you send it a message first. Open Telegram, find your bot, send any text (e.g., "hello"), then retry.

### "Invalid token" Error

The bot token is incorrect or expired. Go to @BotFather, send `/mybots`, select your bot, and check the token. Generate a new one if needed.

### "Network error" or "Timeout"

Temporary connectivity issue. Wait a moment and retry. If persistent, check that the Moira server can reach `api.telegram.org`.

### Bot Does Not Respond

Bots created via @BotFather do not respond to messages by default. Moira sends through them when a
workflow triggers `user-notification` with Telegram enabled, a run starts waiting for you (or its
reminder is due), executes a deprecated `telegram-notification` node, or needs trusted PIN delivery
for a `lock` node.

### Notification Not Received

1. Verify you sent a message to the bot (required by Telegram API)
2. Check your chat ID is correct (use @userinfobot to confirm)
3. Verify the Telegram card is enabled and shows **Ready** under Settings > Notifications
4. Check the bot token has not been revoked
