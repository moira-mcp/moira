---
title: Writing an Extension
description: Add custom nodes and outbound communication channels with the extension SDK and isolated runner
---

An extension adds namespaced node types, outbound communication channels, or both to Moira. Custom
nodes use the same workflow graph as built-in nodes: Moira validates their configuration, calls the
isolated extension runner, stores a successful result under the node ID, and follows the node's
`error` connection on failure when it exists. Without that connection, Moira records the diagnostic
and pauses on the node for retry. Communication channels are transports used by Moira's generic
`user-notification` node and by Moira's own «waiting for you» notifications and reminders; they are
not node types and never receive workflow or user identity.

Extension code never runs in the Moira application processes. Ordinary node and text handlers
run in separate runner child processes; binary handlers run beside the source at its file owner.
These process boundaries contain crashes but are not a hostile-code sandbox:
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

An effective JSON value `null` is present and reaches a granted handler as the text `"null"`;
`services.secret` returns actual `null` only when the setting has no effective value. Stored
`false`, zero and empty strings also remain values rather than triggering a default.

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
- `settings` lists non-secret configuration aliases. `configurationSchema` validates the object
  formed from exactly those aliases before delivery. The ordinary text handler receives that
  configuration; the binary handler receives the filtered settings described below.
- channel `permissions.network` and `permissions.secrets` grant only that channel handler. Secret
  aliases are read with `services.secret` and must not also appear in `settings`.

Moira rejects a bundle when a channel references undeclared settings, uses a foreign namespace,
lists an encrypted value as ordinary configuration, or disagrees with the entrypoint declaration.
The enabled setting, configured values, and secrets are resolved for the notification's current
user. The handler receives none of that user's identity, workflow, execution, repository, artifact,
or log data.

An extension channel participates in the fan-out of the built-in `user-notification` node and of
the «waiting for you» notifications. A missing, disabled, invalid, or payload-incompatible channel
is skipped. Ordinary delivery resolves current settings and sends to the handler without a
separate runner health check. A transport or handler failure is a failed channel with a bounded,
sanitized reason; with no successful sibling the aggregate is `all_failed`, and with a successful
sibling it is `partial`. Neither result exposes endpoint responses or credentials.

Each installed channel appears as a card under Settings > Notifications. Moira uses the
declaration's title, description, capabilities, `enabledSetting`, and exact setting aliases; the
existing settings schema editor renders and saves those values. The card reports ready, disabled,
incomplete, or unavailable state and sends a fixed test through the common service using stored
current-user settings. The browser sends only the channel ID and never resubmits secrets or
destinations. Removing a bundle removes its card and definitions but retains saved per-user values
for reinstall. A disabled or incompletely configured registered channel remains visible. Trusted-delivery
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

The ordinary text handler receives a portable message, schema-checked nonsecret settings,
an abort signal and only `fetch` and `secret`. It has no logging or artifact service.
If `defineChannel` repeats `configurationSchema`, it must exactly match the manifest.

Ordinary text delivery has no shared message-length, request-rate, concurrency or work-deadline
budget. The handler receives the full text and must respect its provider's payload rules. Caller
cancellation still aborts the call. The authored deadline of a workflow extension node is a
separate contract; it does not impose a deadline on channel delivery. The ordinary runner delivery
request has no default response-header or body-idle work clock; connection establishment and
explicit metadata checks remain separate.

### Streaming binary delivery

A channel supporting images or documents additionally declares `binaryTransport` and exports
`binaryHandler`. Set its image/document capabilities only for supported types. Add this
fragment inside the channel declaration; retain the declared token/default_chat settings
and grant `api.example.com` in the channel's `permissions.network`:

```json
{
  "binaryTransport": {
    "operations": [
      {
        "id": "upload",
        "endpoint": { "url": "https://api.example.com/files" },
        "method": "POST",
        "credential": {
          "header": "authorization",
          "secret": "corporate-messenger.token",
          "scheme": "Bearer"
        },
        "recipient": {
          "field": "chat",
          "setting": "corporate-messenger.default_chat"
        },
        "body": {
          "mode": "multipart",
          "fileField": "file",
          "controls": { "caption": "caption", "format": "format", "silent": "silent" }
        }
      }
    ]
  }
}
```

Add this method to the existing `defineChannel` object alongside the ordinary text `handler`:

```typescript
async binaryHandler({ message, signal, services }) {
  signal.throwIfAborted();
  await services.send("upload", {
    caption: message.text,
    format: message.format,
    silent: message.silent,
  });
}
```

The binary handler receives declared handler settings, cancellation and `message.attachment` metadata:
`kind`, `filename`, `mimeType`, `size`, `sha256`, plus `open()` returning a
`ReadableStream<Uint8Array>`. It runs beside the immutable source at the selected workspace
or paired controller, not in the ordinary text runner. It receives no cloud secret or arbitrary
authenticated fetch. Runtime values used by any declared operation as `recipient.setting` or
`endpoint.baseUrlSetting`, and all secret aliases, are excluded both before owner export and
before child invocation. Other declared settings, such as the enabled flag or formatting options,
remain available. The installed manifest still describes the operations; its static metadata does
not grant outbound authority.

Channel preparation checks current authority and configuration without receiving file metadata or
message content. It returns capabilities, permitted operation identifiers and actual provider
constraints. The owner checks its captured file's type and size and the complete selected delivery
plan before any vendor stage. An explicitly selected unsupported channel refuses the delivery;
implicit selection may filter unsupported channels, but no eligible channel is a failure rather
than successful file delivery. The built-in Telegram path chooses a caption or a separate text
stage at the owner, preserving the full message without truncation.

`services.send` chooses a declared operation and streams that captured source. Cloud Moira
rechecks current actor, workflow frame and configuration digest, resolves the fixed secret and
recipient, and constructs vendor framing for the owner-selected stage. The handler cannot
supply a URL, request headers, credentials, destination or prebuilt multipart.
An endpoint may instead use a declared nonsecret `baseUrlSetting` plus a fixed path;
the resolved host must still be granted. Raw mode uses the declared recipient header,
which must not collide with authentication or framing headers. Multipart recipient, file
and control fields must be distinct.

The original owner delivery ID binds the installed bundle and channel configuration.
Changes refuse stale delivery rather than redirecting it. After a vendor stage may have
started, uncertain results remain uncertain; collection never repeats a stage. An observer
disconnect is not evidence that no delivery occurred.

The incoming HTTP proxy can close an observer after an idle interval between I/O events. Collect the original
owner delivery ID after response loss; an idle disconnect does not authorize another send.

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
