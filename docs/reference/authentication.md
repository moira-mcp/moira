# Authentication and authority

Authentication establishes the caller; account admission and resource authorization decide what that caller may do. Browser sessions, MCP credentials, paired devices and workspace credentials are separate authorities. A returned resource or operation reference is an address and captured precondition, not a credential.

## Account admission

The shared account decision rejects blocked accounts before pending approval or email-verification state. The built-in [deployment policy](../operator/configuration.md#deployment-policy) requires administrator approval for new self-host accounts and email verification for sensitive SaaS access. Approval, verification and administrator status are independent fields.

Pending self-host users may inspect `GET /api/user/me` and sign out. Product APIs, persistent-token creation, OAuth authorization/token issuance and MCP remain refused with `ACCOUNT_APPROVAL_REQUIRED`. A session created at signup does not prove product admission. `ACCOUNT_BLOCKED` and `EMAIL_NOT_VERIFIED` identify the other account-state refusals; an ordinary resource-level 403 does not mean the session must be destroyed.

Use `requireAuth` for ordinary session admission, `requireVerifiedAuth` where the mode's verification gate applies, and the narrowly scoped `requireSessionAuth` for account status. Both MCP token issuance and already-issued credentials apply current account admission. Do not rely on hidden navigation or a previously admitted session to enforce these rules.

Sources: [account policy](../../packages/shared/src/auth/account-admission.ts), [HTTP middleware](../../packages/web-backend/src/middleware/auth-middleware.ts), [Better Auth configuration](../../packages/shared/src/auth/better-auth-config.ts). Operational approval, recovery, blocking and deletion are in [account administration](../operator/accounts.md).

## Sessions and client authentication

The web backend and MCP server each compose `createAuth` with service-specific logging and an optional successful-registration callback. Shared authentication does not import the workflow engine. The callback observes a successful handler registration with an issued session and persisted user, after the final plugin response; direct `auth.api` calls, account linking, failed registration and login are not registration notifications. Delivery is detached best effort, with no durable queue or crash-safe exactly-once promise. The global `system.notify_admins_on_registration` setting and each admitted administrator's configured Telegram channel control recipients.

Browser users sign in through the configured application prefix. A social-only account can add its first password through Settings → Security & sign-in; `set-password` requires a fresh session, whereas an existing credential uses `change-password`. A stale-session refusal requires signing in again.

MCP clients follow the advertised OAuth discovery documents and browser authorization/consent flow, or send a persistent `moira_…` API token as Bearer authorization. Persistent tokens are shown once at creation; the server hashes them for lookup and checks revocation, expiry and current account state on use. OAuth consent and persistent-token management are different lifecycles; removing browser sessions alone is not a substitute for revoking both.

MCP additionally binds catalog initialization to the exact credential's `toolsVersion`. Null/stale revisions return HTTP 426 for ordinary requests. A valid singleton JSON-RPC `initialize` may proceed and records `MCP_TOOLS_REVISION` conditionally on that still-valid credential; malformed requests, batches, notifications and failed results cannot initialize it. OAuth refresh preserves the predecessor's exact catalog revision. Reinitialize with the valid credential; initialization never bypasses account admission. MCP authenticates before incremental body parsing and revalidates account/credential after the read before SDK dispatch.

Sources: [token manager](../../packages/shared/src/services/token-manager.ts), [MCP server](../../packages/mcp-server/src/server.ts), [HTTP account endpoints](http-api.md).

## Browser private state

The browser's session broadcast suspends private reads while authoritative identity is unknown. Confirming the same account restores mounted content and drafts; logout, a different account or backend retires the previous private state. Credential/capability changes can retire responses even when the user ID stays the same. Late success or failure must not overwrite the new scope, sign out a replacement account or start its redirect.

`waitForSessionSettlement` observes the current Better Auth session atom until neither pending nor refetching; merely awaiting a canceled `refetch()` is insufficient. Its abort signal cancels the caller's wait, not the shared session fetch. Callers still own mounted-operation and account guards. Forced reset, consent, authorization and invite acceptance must wait for admitted session facts before continuing. Auth error handling globally cleans up only 401 and the recognized account-state 403 codes for the request's still-current authority; other 403 refusals stay with their operation and preserve drafts.

Automatic cleanup uses `revokeObservedSession` for the original observed session, not whichever cookie later becomes current. Better Auth's targeted revoke retains target-owner checks, permits denied-account cleanup and returns no cookie update that could overwrite another tab's login. Only successful current-session revocation records sign-out. Session tokens do not belong in the shared private-read cache; a replacement, unknown session or unmounted operation cannot authorize an earlier completion/redirect.

Protected-route `returnUrl` accepts safe same-origin relative paths, rejects external/protocol-relative URLs and traversal, and uses prefix-aware login/register loop guards. An invalid return target falls back to the normal application route. Use [return-url.ts](../../packages/web-frontend/src/utils/return-url.ts) and [the shared session client](../../packages/web-frontend/src/auth/better-auth-client.ts), rather than independent redirect/session state.

## Resource authority

The pure [authorization policy](../../packages/shared/src/authorization/authorization-policy.ts) decides `view`, `use`, `edit`, `delete`, `share` and `administer`; its [service](../../packages/shared/src/authorization/authorization-service.ts) resolves current owner, visibility and grants.

- Owners have all actions on their own resource. Public visibility grants authenticated read/use, never another user's control.
- Explicit `use` grants permit read/use; `edit` additionally permits changes. Accepted workflow invitations currently issue `use`. Groups exist in the model but have no product creation path.
- Administrators receive `administer`, not implicit owner-use authority. Each route must request the action it actually performs.

For example, execution overview and working-state mutation require owner authority; selected detail/progress/answer/lock inspection surfaces permit administration. Parent-child ownership and exact attempt/grant binding remain integrity constraints even after authorization. Refer to [execution](execution.md) and [HTTP contracts](http-api.md) for each surface rather than generalizing administrator access.

## Email verification and recovery

Only the public email-delivery state `real` means messages can reach users. `test` logs messages without sending, and `unavailable` disables email actions. Invalid configuration fails startup; SaaS also refuses startup without a real provider. Self-host can run without email and use [ordinary-user temporary-password recovery](../operator/accounts.md#ordinary-user-recovery).

SaaS signup creates a session before verification. Verification and resend are separate operations; resend has a cooldown and duplicate unverified signup directs the user back to verification. Self-host does not turn verification into an account gate. The registration form's mode-specific consent fields record acceptance; they do not establish regulatory compliance. Deployments own their `/terms` and `/privacy` content.

## Device and external credential custody

Pairing is confirmed by the same admitted browser user after the companion supplies its locally generated device credential through a short-lived pairing. The server stores pairing/device digests. Device generation, pairing connection, repository grant, resource and current account remain separate checks. Device revocation rejects remote calls; it is not proof of instantaneous physical stop on an offline host. Owner-approved Local work lasts until explicit disable, subject to its current grants and physical/provider constraints.

The GitHub App connection for workspaces is independent of social login. Original OAuth/refresh credentials stay in the cloud vault. Trusted host/guest brokers receive repository/action-scoped children for fixed Git/PR/provider operations; project files, argv, command environments, logs and agent responses must not receive them. Public read-only Git has an explicit anonymous branch; private/write refusal never permits broad-token or anonymous fallback. Canonical and effective remote origins must match the admitted repository.

Disconnect fences guest/renewal/scoped authority and begins durable revocation before the external grant call. Permission update is different: its same-account/generation-guarded transaction commits the replacement and queues the exact predecessor encrypted for revocation before attempting that revocation. A failed/abandoned update before commit retains the working connection; a refused predecessor revocation remains pending without discarding either custody record. Refresh uses a durable claim/generation comparison; ambiguous successor issuance or an abandoned claim cannot authorize predecessor reuse. A classic OAuth token is not a substitute for the supported expiring App credential.

Parent retirement does not prove a derived child is revoked. Persist token-free original security identity before acquisition; after lost replies, collect that original without reissuing. Credential custody, vendor outcome and disposal uncertainty stay uncertain until upstream closure is proved. An unrelated settings revision does not retire an unchanged grant. See [workspace recovery and collection](workspaces.md#recovery-and-collection) for the original-owner and offline boundaries.

Browser authorization state is one-use, expiring and bound to user/session/provider/intent; permission updates also bind the existing connection and generation. Installation callbacks without state do not exchange their supplied code or trust the supplied installation: they reread grants using an eligible readable stored credential, respecting failed-refresh throttling. Callback results redirect to same-origin Settings with bounded outcomes, not credential JSON. Refresh reads grants; it cannot add permissions or switch GitHub accounts. Disconnect then Connect is the explicit account-switch path. See [connection-service.ts](../../packages/shared/src/codespaces/connection-service.ts).

The dedicated vault key/version must remain recoverable with ciphertext. If the key is lost, first revoke the App grant externally, then use the explicit external-revocation confirmation; ordinary reconnect cannot safely discard unreadable custody. Restoring the matching key makes normal predecessor retirement available again. [Configuration](../operator/configuration.md#github-workspace-integration) describes the integration group.

## Encrypted settings

Sensitive settings use AES-256-GCM with a random IV per value and an `iv:authTag:ciphertext` envelope under `TELEGRAM_ENCRYPTION_KEY`. This protects those values, not the whole database or every audit field. Preserve the key alongside protected backups; changing it is not a transparent rotation. Browser projections mask the value, while built-in MCP secret reads use their encrypted sentinel; extension public projections are masked. Installed declarations, secret flags and settings preparation remain authoritative, including intentional empty values. See [settings encryption](../../packages/shared/src/utils/settings-encryption.ts) and [settings service](../../packages/shared/src/services/settings-service.ts).
