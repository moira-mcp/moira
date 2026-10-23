# Account administration

Use the administrator area for ordinary-user approval, access retirement and recovery. Administrator role and deployment capabilities are distinct: the built-in self-host policy keeps user management and installation controls, while broad cross-user resource administration and analytics have separate gates. See [deployment policy](configuration.md#deployment-policy) and [authentication](../reference/authentication.md).

## Approve an account

Self-host signup is open but new accounts remain pending. `GET /api/user/me` reports status; product/API/MCP access remains refused until approval. Approve the selected user through the administrator UI or `POST /api/admin/users/:id/approve`. The conditional transition and audit event share a transaction; repeats return the original approval timestamp. Approval does not implicitly verify email, grant administrator role or clear a block. Review each control separately.

## Ordinary-user recovery

Check `GET /api/features` for email delivery. Only `real` supports verification/reset delivery. Self-host without real delivery offers **Set temporary password** on an ordinary user's detail page; transmit the password through a separate secure channel.

`POST /api/admin/users/:id/temporary-password` accepts `temporaryPassword`. Hashing precedes a single immediate database transaction that replaces/creates the credential, clears linked-provider credentials, revokes sessions, persistent API tokens, OAuth access tokens and consents, marks `passwordResetRequired`, and records revocation counts without the password. It refuses administrator targets. The next sign-in leads to the forced-reset form, where the user chooses a new password. Failed automatic sign-in after reset requires signing in with the new password; it must not terminate a replacement session.

Use [temporary-password-recovery.ts](../../packages/web-backend/src/services/temporary-password-recovery.ts) for this atomic boundary. Requiring a password change, revoking sessions, revoking API tokens and blocking an account are different operations; choose the intended effect explicitly.

## Administrator recovery

Use the installed application's recovery script with access to its database. From the directory containing `docker-compose.yml`, read the password without echoing it or placing it in shell history:

```bash
read -s ADMIN_PASSWORD
export ADMIN_PASSWORD
docker compose exec -e ADMIN_PASSWORD moira npx tsx scripts/create-admin-user.ts
unset ADMIN_PASSWORD
```

`ADMIN_PASSWORD` is required. Optional `ADMIN_EMAIL` and `ADMIN_ID` default to `admin@moira.local` and `system-admin`; pass overrides with additional `docker compose exec -e NAME` arguments. `DB_PATH` selects the database. The script creates or repairs the administrator, verifies email, approves the account, clears a block and replaces the credential. It prints account identity, never the password. This is privileged installation recovery, not the ordinary-user API. Source: [create-admin-user.ts](../../scripts/create-admin-user.ts).

## Block and retire access

Blocking commits the account fence before retiring known scoped GitHub children. A `503 SCOPED_CREDENTIAL_DISPOSAL_PENDING` means the account remains blocked but disposal is unresolved; retain encrypted custody and collect/reconcile the original security request. Do not treat the error as an uncommitted block or delete custody to clear it.

Session/OAuth revocation and API-token retirement must follow their explicit controls. Disconnecting a GitHub connection retires remote routes and credentials; it neither stops a workspace nor deletes its disk. Stop compute explicitly and delete owned resources when intended; retained disks can still incur provider storage charges.

## Account deletion

Before the **first** account-deletion request, use the account's still-admitted authority to discover its owned managed resources, including diagnostic identities and pending original operations. Collect and settle original uncertainty before deciding another effect. Explicitly stop intended compute and delete intended disks/resources through their authorized, confirmed cleanup controls; stopping alone preserves a disk. Settle outstanding parent/child credential custody and issuance/disposal before requesting account deletion. Use [workspace discovery](../reference/workspaces.md#management-and-discovery), [original-operation collection](../reference/workspaces.md#recovery-and-collection) and [provider lifecycle](../reference/workspaces.md#github-lifecycle) for those existing operations. Deletion is not a harmless inventory preflight and does not implicitly delete VM disks or resolve an unknown provider action.

The deletion route blocks the account and revokes its sessions, OAuth access tokens and consents **before** checking retirement. A pending `409` therefore already removes ordinary owner access. It preserves the blocked account, resource identities and encrypted recovery material, not a usable ordinary cleanup session or a completed erasure. If deletion was already attempted prematurely, retain that evidence and determine the remaining authorized operator/owner recovery path under the existing custody rules; do not assume the blocked user can simply continue ordinary authenticated cleanup, that administrator role grants owner-use authority, or that another delete request repairs unresolved work. Request deletion again only after the remaining retirement preconditions are confirmed.

The current route's predicates and response details are in [the HTTP account-deletion contract](../reference/http-api.md#account-deletion), with custody rules in [workspaces](../reference/workspaces.md#recovery-and-collection). Do not equate application deletion with an unverified guarantee about backups, provider records or regulatory erasure.

## Downgrade across the approval boundary

Before running a binary that does not understand `user.approvedAt`, stop external traffic and back up the database. On the current approval-aware image run:

```bash
docker compose exec moira npm run prepare:account-approval-downgrade -- \
  --confirm-block-pending-users
```

The command requires the column and explicit confirmation. One transaction converts pending accounts to the older `blocked` fence and revokes sessions, API tokens, OAuth tokens and consents. Inspect its result before starting the older binary; downgrading first would admit accounts it cannot recognize as pending. After restoring an approval-aware version, review converted users before approving and explicitly unblocking them. Source: [prepare-account-approval-downgrade.ts](../../scripts/prepare-account-approval-downgrade.ts).
