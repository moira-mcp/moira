# Self-Host Capability Map

Moira uses one `FeatureResolver` to expose deployment policy to the backend and frontend. The
built-in resolver selects a complete policy from `DEPLOYMENT_MODE=self-host|saas`; unknown
capabilities fail closed. A custom deployment can replace the resolver programmatically, but there
are no per-capability environment switches.

## Deployment policy

| Capability                  | Self-host | SaaS     | Effect                                                                                                             |
| --------------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `openRegistration`          | enabled   | enabled  | Allows email/password registration.                                                                                |
| `accountApproval`           | enabled   | disabled | Requires administrator approval before product, API, OAuth, or MCP access.                                         |
| `emailVerificationGate`     | disabled  | enabled  | Requires verified email for sensitive token and OAuth admission.                                                   |
| `verificationEmailOnSignup` | disabled  | enabled  | Sends a verification message after registration.                                                                   |
| `legalConsents`             | disabled  | enabled  | Requires terms and residency consent during registration.                                                          |
| `betaNotices`               | disabled  | enabled  | Shows SaaS beta notices.                                                                                           |
| `userManagement`            | enabled   | enabled  | Exposes ordinary-user list, detail, approval, blocking, and recovery.                                              |
| `multiUserAdmin`            | disabled  | enabled  | Exposes cross-user workflows, executions, artifacts, session-wide actions, and artifact quota/takedown operations. |
| `adminAnalytics`            | disabled  | enabled  | Exposes installation-wide statistics and analytics.                                                                |
| `adminOperations`           | disabled  | enabled  | Exposes the operational analytics surface.                                                                         |
| `operationsDevelopment`     | disabled  | enabled  | Enables monitoring-test endpoints that deliberately emit errors, delays, logs, and synthetic events.               |
| `socialLogin`               | disabled  | enabled  | Offers GitHub and Google sign-in when their credentials are configured.                                            |

`GET /api/features` returns the same resolved booleans used by server middleware. Hiding a route in
the Web UI is not the authorization boundary: the backend checks the named capability before the
protected handler reads data or performs an action. A disabled capability returns
`403 ACCESS_DENIED`.

## Self-host administration

The default self-host policy is a private-team installation. It keeps these administrator surfaces:

- registration approval and ordinary-user management;
- temporary-password recovery when real email delivery is unavailable;
- settings, audit, API-token, and local database administration;
- deployment-neutral backend/database health and managed-workflow reconciliation through
  `/api/admin/system-status`;
- Workflow Management Flow recovery for previous/current/incoming bundled-workflow conflicts.

It does not expose installation-wide workflow/execution totals, recent activity, cross-user
workflow/execution/artifact administration, operational analytics, or monitoring-test endpoints.
The server avoids the corresponding broad repository reads when those capabilities are disabled.

## Deployment-neutral product features

Core workflow execution, validation, MCP tools, notes, artifacts, settings, Telegram integration,
workflow sharing, account approval, user management, managed-resource reconciliation, and the Web UI
remain in the Apache-2.0 product. Security behavior such as blocked-account admission, credential
revocation, PIN hashing, request limits, and input validation is always active and is not a feature
flag.

Email delivery has a separate runtime status returned by `GET /api/features`:

- `real`: SMTP or Brevo can deliver messages;
- `test`: messages go only to the explicit test log;
- `unavailable`: delivery is disabled or not configured;
- `configuration-error`: supplied provider settings are invalid.

Self-host can run without real delivery and provides administrator-assisted ordinary-user recovery.
SaaS refuses startup unless delivery is `real`.

## Private deployment boundary

Cloud branding, landing assets, environment material, and private workflows are supplied by the
private deployment repository. The OSS runtime accepts an additional workflow catalog through
`WORKFLOWS_DIRS`; later directories can override the same `(owner, slug)` identity without moving
private definitions into the public repository.

## Sources of truth

- Capability names and built-in mode policy: `packages/shared/src/config/feature-resolver.ts`
- Server route mapping: `packages/web-backend/src/middleware/admin-route-capability.ts`
- Route mounting and monitoring-test enforcement: `packages/web-backend/src/server.ts`
- Public capability response: `packages/web-backend/src/routes/features.ts`
- Frontend navigation and route projection: `packages/web-frontend/src/components/layout/AppSidebar.tsx`,
  `packages/web-frontend/src/components/layout/AdminLayout.tsx`, and
  `packages/web-frontend/src/components/ProtectedRoute.tsx`
