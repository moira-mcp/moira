# Webhook notify extension

This reference bundle contributes two independent outbound integrations:

- the action node `webhook-notify.post-message`, which posts text to an explicitly selected
  recipient and returns the endpoint's message identifier;
- the ordinary communication channel `webhook-notify.notifications`, which lets Moira's generic
  `user-notification` node send text to a per-user default recipient.

It does not receive webhooks or create an incoming trigger.

## Install

From the repository root:

```bash
cp -R examples/extensions/webhook-notify extensions/
```

Edit `extensions/webhook-notify/moira-extension.json` and replace `example.com` in both
`permissions.network` and `communicationChannels[0].permissions.network` with the exact host used
by your endpoint. Node and channel permissions are intentionally separate. The placeholders prevent
an unconfigured copy from contacting a real service. Then put this line in `.env` and start the
profile:

```bash
printf '\nMOIRA_EXTENSION_RUNNER_URL=http://moira-extension-runner:9110\n' >> .env
docker compose --profile extensions up -d --build
```

Each user who runs the node fills these values on Moira's Settings page:

| Setting                            | Purpose                                                    | Default            |
| ---------------------------------- | ---------------------------------------------------------- | ------------------ |
| `webhook-notify.enabled`           | Enables ordinary delivery through the extension channel    | `true`             |
| `webhook-notify.token`             | Credential for the Authorization header; encrypted at rest | none               |
| `webhook-notify.base_url`          | Base URL of the receiving service                          | none               |
| `webhook-notify.message_path`      | HTTP path that accepts a message                           | `/api/v1/messages` |
| `webhook-notify.auth_scheme`       | Authorization scheme word                                  | `Bearer`           |
| `webhook-notify.default_recipient` | Recipient used by `user-notification`                      | none               |

## Use

```json
{
  "id": "notify-team",
  "type": "webhook-notify.post-message",
  "config": {
    "text": "Deploy of {{service}} finished: {{result}}",
    "channel": "releases"
  },
  "connections": {
    "success": "done",
    "error": "report-notification-failure"
  }
}
```

Set exactly one of `channel` or `recipient`; optional `threadId` is sent as `thread_id`. On success,
later nodes read the returned identifier as `{{notify-team.messageId}}`.

The node names missing settings and invalid recipient selection before sending. HTTP 429 includes
the endpoint's `Retry-After` delay in its error. Other non-2xx responses include status and a bounded
response excerpt; a successful response without `message_id` is also an error. The handler never
sleeps or retries: express long-running retry policy in the workflow graph.

To use the communication channel, configure all required settings and add a built-in
`user-notification` node to a workflow. Moira discovers the channel from the installed manifest and
fans ordinary text notifications out to it while `webhook-notify.enabled` is true. The channel does
not receive a user ID, execution ID, workflow state, repository data, artifacts, or logs. This
example declares `trustedDelivery: false`, so it is not eligible for security-sensitive delivery.

See [Writing an
Extension](../../../packages/docs/src/content/docs/docs/guides/writing-extensions.mdx) for the full
manifest, SDK, permission and isolation contracts.
