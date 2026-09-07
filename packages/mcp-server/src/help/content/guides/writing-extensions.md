---
title: Writing an Extension
description: Add custom nodes and outbound communication channels with the extension SDK and isolated runner
---

An extension adds namespaced node types, outbound communication channels, or both to Moira. Custom
nodes use the same workflow graph as built-in nodes: Moira validates their configuration, calls the
isolated extension runner, stores a successful result under the node ID, and follows the node's
`error` connection on failure when it exists. Without that connection, Moira records the diagnostic
and pauses on the node for retry. Communication channels are transports used by Moira's generic
`user-notification` node; they are not node types and never receive workflow or user identity.

Extension code never runs in the Moira application processes. The runner imports each bundle in a
separate child process. This contains crashes and deadlines, but it is not a hostile-code sandbox:
administrators must install only code they trust.

## Bundle layout

Each installed directory contains a manifest and an entrypoint:

```text
my-extension/
├── moira-extension.json
└── index.ts
```

The runner scans one directory below `MOIRA_EXTENSIONS_DIR`. Directories without a manifest are
ignored. An invalid bundle is rejected with reasons while other bundles remain available. Restart
the runner and Moira after adding, removing, or changing a bundle; both catalogues are loaded at
process startup.

## Manifest

```json
{
  "apiVersion": "moira.extensions/v1",
  "name": "corporate-messenger",
  "version": "1.0.0",
  "entrypoint": "index.ts",
  "nodes": [
    {
      "type": "corporate-messenger.send",
      "title": "Send a message",
      "description": "Sends a message to a chat.",
      "configSchema": {
        "type": "object",
        "required": ["chat", "text"],
        "additionalProperties": false,
        "properties": {
          "chat": { "type": "string" },
          "text": { "type": "string" }
        }
      },
      "outputSchema": {
        "type": "object",
        "required": ["messageId"],
        "additionalProperties": false,
        "properties": { "messageId": { "type": "string" } }
      }
    }
  ],
  "communicationChannels": [
    {
      "id": "corporate-messenger.notifications",
      "title": "Corporate messenger notifications",
      "description": "Delivers ordinary notifications to the configured chat.",
      "capabilities": {
        "text": true,
        "image": false,
        "document": false,
        "trustedDelivery": false
      },
      "configurationSchema": {
        "type": "object",
        "required": ["corporate-messenger.enabled", "corporate-messenger.default_chat"],
        "additionalProperties": false,
        "properties": {
          "corporate-messenger.enabled": { "type": "boolean" },
          "corporate-messenger.default_chat": { "type": "string", "minLength": 1 }
        }
      },
      "enabledSetting": "corporate-messenger.enabled",
      "settings": ["corporate-messenger.enabled", "corporate-messenger.default_chat"],
      "permissions": {
        "network": ["api.example.com"],
        "secrets": ["corporate-messenger.token"]
      }
    }
  ],
  "settings": [
    {
      "key": "corporate-messenger.enabled",
      "type": "boolean",
      "label": "Enable notifications",
      "defaultValue": "true"
    },
    {
      "key": "corporate-messenger.default_chat",
      "type": "string",
      "label": "Default notification chat",
      "required": true
    },
    {
      "key": "corporate-messenger.token",
      "type": "encrypted",
      "label": "Bot token"
    }
  ],
  "permissions": {
    "network": ["api.example.com"],
    "secrets": ["corporate-messenger.token"]
  }
}
```

- `apiVersion` must be `moira.extensions/v1`.
- `name` is the namespace. Every node type and channel ID must use `<name>.<contribution>`.
- `entrypoint` must resolve inside the bundle directory.
- `configSchema`, optional `inputSchema`, and `outputSchema` are JSON Schemas compiled when the
  manifest is registered. Configuration and input are checked before the call; output is checked
  before it reaches workflow state.
- `settings` declares values shown in Moira's generic settings editor.
- Top-level `permissions` grants services only to node handlers. Every communication channel has a
  separate `permissions` object; grants do not cross that boundary.

Extension names, node types, channel IDs, and setting keys must be unique across installed bundles.
The setting key must use the extension namespace. Moira's built-in setting namespaces are reserved.
A bundle may omit node definitions and contribute only channels; an explicit empty `nodes` array
remains valid for compatibility with the version 1 manifest format.

## Settings

Supported setting types are `string`, `number`, `boolean`, `json`, and `encrypted`. Definitions stay
in the manifest rather than the database. Removing a bundle hides its definitions; per-user values
remain and become available if the same definitions are installed again.

`encrypted` values are stored encrypted and masked in public reads. A `json` declaration may include
a JSON Schema in `validation`; the generic editor accepts JSON text, validates the parsed structure,
and preserves its JSON meaning. A handler receives a JSON setting as serialized JSON text and must
parse it with `JSON.parse`.

Settings are per user. The handler receives values belonging to the user whose execution is running.
An `adminOnly` setting is writable only through the authenticated API or MCP settings tool by an
administrator; it is still not a shared installation-wide value. Use `adminOnly` only for nodes
intended to run as that administrator.

Declaring a setting does not grant it. To read a value, list the same key in
`permissions.secrets` and call `services.secret(key)`. An undeclared or ungranted key is refused by
name. A granted key with no value returns `null`.

## Communication channel declaration

Each entry in `communicationChannels` declares one ordinary outbound transport:

- `id` is stable, namespaced with the extension name, and at most 128 characters long.
- `capabilities` states whether the handler accepts text, image, or document messages.
  `trustedDelivery` only asks to become eligible for security-sensitive delivery; it grants nothing
  by itself.
- `enabledSetting` names a declared boolean user setting. A false value disables ordinary delivery
  through this channel for that user.
- `settings` lists non-secret aliases passed to the handler as JSON. `configurationSchema` validates
  the object formed from exactly those aliases before delivery.
- channel `permissions.network` and `permissions.secrets` grant only that channel handler. Secret
  aliases are read with `services.secret` and must not also appear in `settings`.

Moira rejects a bundle when a channel references undeclared settings, uses a foreign namespace,
lists an encrypted value as ordinary configuration, or disagrees with the entrypoint declaration.
The enabled setting, configured values, and secrets are resolved for the notification's current
user. The handler receives none of that user's identity, workflow, execution, repository, artifact,
or log data.

An extension channel participates in the fan-out of the built-in `user-notification` node. A missing,
disabled, invalid, or payload-incompatible channel is skipped. A runner or handler health failure is
a failed channel with a bounded, sanitized reason; with no successful sibling the aggregate is
`all_failed`, and with a successful sibling it is `partial`. Neither result exposes endpoint
responses or credentials.

Each installed channel appears as a card under Settings > Notifications. Moira uses the
declaration's title, description, capabilities, `enabledSetting`, and exact setting aliases; the
existing settings schema editor renders and saves those values. The card reports ready, disabled,
incomplete, or unavailable state and sends a fixed test through the common service using stored
current-user settings. The browser sends only the channel ID and never resubmits secrets or
destinations. Removing a bundle removes its card and definitions but retains saved per-user values
for reinstall. A registered channel that is disabled or fails its current health check remains
visible. Trusted-delivery
declaration and administrator approval are shown as read-only state on the user card.

## Handler

```typescript
/* index.ts */ import { defineExtension, defineNode } from "@mcp-moira/extension-sdk";

const send = defineNode({
  type: "corporate-messenger.send",
  async handler({ config, signal, services }) {
    const token = await services.secret("corporate-messenger.token");
    if (!token) throw new Error("corporate-messenger.token is not set");

    const response = await services.fetch("https://api.example.com/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ chat: config.chat, text: config.text }),
      signal,
    });
    if (!response.ok) throw new Error(`message was not accepted: ${response.status}`);

    const body = (await response.json()) as { id: string };
    services.log("message sent", { chat: String(config.chat) });
    return { messageId: body.id };
  },
});

export default defineExtension({ nodes: [send] });
```

The manifest is the schema authority. A schema may also be repeated in `defineNode`; if it is, the
runner requires the two declarations to be identical when the child process first loads the code.

The handler receives:

| Value                   | Contract                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| `config`                | Deep-template-rendered node configuration, checked against `configSchema` |
| `input`                 | Mapped call input, checked against `inputSchema` when declared            |
| `executionId`, `nodeId` | Identifiers for this call; no other execution state                       |
| `signal`                | Aborted when the call is cancelled or reaches its deadline                |
| `services`              | Explicit capabilities granted by the manifest                             |

There is no ambient access to Moira's database, environment, configuration, or filesystem.

## Communication channel handler

Use `defineChannel` for a transport and export it through `communicationChannels`:

```typescript
/* index.ts */ import { defineChannel, defineExtension } from "@mcp-moira/extension-sdk";

const notifications = defineChannel({
  id: "corporate-messenger.notifications",
  async handler({ message, settings, signal, services }) {
    const token = await services.secret("corporate-messenger.token");
    const chat = settings["corporate-messenger.default_chat"];
    if (!token || typeof chat !== "string") throw new Error("channel is not configured");

    const response = await services.fetch("https://api.example.com/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat, text: message.text }),
      signal,
    });
    if (!response.ok) throw new Error(`message was not accepted: ${response.status}`);
  },
});

export default defineExtension({ communicationChannels: [notifications] });
```

The handler receives a portable message, the schema-checked non-secret settings, an abort signal,
and only `fetch` and `secret`. It has no logging or artifact service. If the handler repeats
`configurationSchema` in `defineChannel`, it must exactly match the manifest. Text is always
available; declare image or document support only when the handler handles the optional binary
attachment and its filename and MIME type. One generic attachment is limited to 20 MiB.

## Trusted delivery approval

Security-sensitive messages require more than a manifest claim. Effective eligibility requires all
of these conditions at the time of use:

- the installed channel declares `capabilities.trustedDelivery: true`;
- an administrator has independently approved that channel ID;
- its per-user configuration is valid and enabled;
- the runner-backed adapter is healthy.

An administrator inspects declarations with `GET /api/admin/communication/trusted-channels` and
persists or revokes the independent decision with:

```http
PUT /api/admin/communication/trusted-channels/corporate-messenger.notifications
Content-Type: application/json

{ "approved": true }
```

Approval is installation-wide, audited, survives runner restarts, and does not add network or secret
permissions. It does not turn an ordinary channel into a trusted one. Built-in lock PIN delivery
remains Telegram-specific; extension channels never receive that PIN through ordinary notification
fan-out.

## Services and permissions

- `services.log(message, fields)` writes a structured runner log. Never include values returned by
  `secret`; logs do not scan or redact them.
- `services.fetch(url, init)` permits only exact hosts in `permissions.network`. Redirects are
  checked again, and sensitive headers are removed when the origin changes.
- `services.secret(alias)` returns a granted setting as text or `null` when unset.
- `services.writeArtifact(name, content)` requires `permissions.artifacts: true`. Artifacts travel
  with the successful result. One artifact is limited to 256 KiB and one call to 1 MiB in total;
  exceeding either limit fails the call.

## Results, failures, and deadlines

Successful output is stored under the node ID. For a node named `send-message`, a declared
`messageId` is read later as `{{send-message.messageId}}`. Extension nodes cannot declare global
writes.

Every failure has a named diagnostic. When `connections.error` exists, the workflow follows it:

| Kind                 | Meaning                                                   |
| -------------------- | --------------------------------------------------------- |
| `invalid-input`      | Rendered configuration or input failed its schema         |
| `handler-error`      | The handler threw or its entrypoint failed to load        |
| `timeout`            | The call exceeded the node deadline                       |
| `runner-unavailable` | The runner could not be reached or the child process died |
| `invalid-output`     | The returned value failed `outputSchema`                  |

Without an `error` connection, Moira records the diagnostic and pauses the running execution on the
same node. Resuming it invokes the extension again. The runner reuses a supervised handler process
across calls and may run several calls in it concurrently; it replaces that process after a crash,
deadline, or cancellation. Do not rely on process-local state. Handlers must be re-entrant and safe
to terminate.

:::caution
An extension node is one synchronous, deadline-bounded call. Extensions cannot create native
background tasks, wake an agent, or install a callback. Model a long operation as workflow nodes:
start it, store its handle in node-scoped output, check it later, and loop through a condition node.
Do not keep one handler waiting.
:::

## Generic workflow editor

The browser never loads extension frontend code. It obtains the live node-type catalog from Moira
and renders a generic form from `configSchema`. A schema-supported primitive, array, object, enum,
or nested field is editable there; unsupported presentation needs must be expressed with schema
descriptions rather than custom JavaScript.

If the configured runner cannot be reached, validation and the editor report the extension registry
as unavailable instead of silently treating every custom type as unknown. If the registry is live
but a namespaced type is absent, Moira reports which extension is not installed.

## Reference example

`examples/extensions/webhook-notify` contains both a complete outbound action node and an ordinary
text communication channel. They share declared per-user endpoint settings but have separate exact
network and secret grants. The node has named rate-limit failures and a node-scoped `messageId`; the
channel uses the configured default recipient and deliberately does not request trusted delivery.
It is not an incoming webhook trigger. Copy and adapt it rather than using the test-only bundles
under `tests/fixtures`.

See [Self-hosting: Enable extensions](/docs/getting-started/self-hosting/#enable-extensions) for
installation and troubleshooting commands.
