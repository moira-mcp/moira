# Security boundaries

When changing a sensitive path, identify its caller, current authority, source owner and irreversible effect before changing parsing, retries or cleanup. [Authentication](../reference/authentication.md) owns account/resource decisions; [workspaces](../reference/workspaces.md) owns physical, stream and credential custody; [execution](../reference/execution.md) owns attempts and replay. A reference, cached observation, model answer or successful schema check does not replace any of those checks.

## Admission and effect ownership

Enforce authority on the server, not only in navigation. An administrator role does not grant owner-use authority on another user's run. Deployment capabilities govern named surfaces, not every privileged route uniformly. Match actual middleware mounting and the resource action to the operation; apply account, credential, repository/device/resource and generation guards where those owners require them.

Authenticate before reading private incremental bodies or binary control frames and revalidate after asynchronous reads/configuration. Explicit typed credential mismatch may select a supported authentication path; database/internal failure is not permission to try a weaker authority. HTTP body limits, response windows, authentication clocks and effect lifetime are different controls. Losing a transport response never proves cancellation or permission to repeat a dispatched effect.

Use the original owner's durable receipt for collection after uncertainty. Preserve unknown credential issuance/disposal, vendor outcomes and physical settlement rather than deleting evidence or creating a fresh request. Revoking a parent or blocking an account is not proof that all derived children are disposed. The account may remain blocked while cleanup returns pending. See [account operations](../operator/accounts.md).

## Secrets and private data

Keep original GitHub OAuth/refresh credentials in their vault; repository/action-scoped children remain inside fixed trusted brokers and never enter project files, command environments, argv, agent output or logs. Native attachment descriptors belong on stdin, not shell history. Binary-extension secret/recipient/endpoint settings stay at the broker. An extension child process and the same-UID guest broker are not general sandboxes against hostile authorized code.

Sensitive settings use authenticated AES-GCM envelopes with a dedicated key. This is not database-wide at-rest encryption. Persistent API/device/pairing token digests, password hashing, session storage and OAuth custody have different owners; do not promise that all secrets use one storage scheme or all responses are automatically filtered. Protected backups must preserve matching keys and database state. Unreadable ciphertext is retained for explicit recovery, not silently discarded.

Session, audit, email and administrative records can contain identity, address, IP, user-agent, timestamps, subjects and action metadata. Use narrow projections for each reader, safe audit markers and [logging redaction](observability.md#service-logs-and-error-boundaries). Redaction at one boundary does not sanitize every DB field, debug body or arbitrary logger metadata. Deployments must explicitly choose retention, data-access and erasure policies; this repository does not establish universal retention periods, anonymization or regulatory compliance.

## Administrative data access

User administration exposes account identity, approval/verification/admin/block/reset state and the timestamps/actors associated with those controls. Detail reads can also expose session IP/user-agent/country/times, OAuth client/scopes/consent/counts and email type/recipient/subject/status/error/time. Audit reads include action, resource, source, address/user-agent and explicit metadata/change records. Treat these as privileged personal data; adding a summary projection must not accidentally include credentials or raw working state.

Activity is recorded evidence, not continuous presence. Accepted audit actions and observed renewal of unexpired provider sessions contribute activity; registration, blocked sign-in and historical session timestamps do not establish renewal. Missing observations remain unknown and are not backfilled. Owned-workflow/execution counts, running samples and popular-flow participants have their own selection windows and bounds. Installation analytics requires its capability, while narrow user management keeps its own inventory. Browser analytics exclusions are display scope, not a restriction on administrator management authority.

Execution list/overview projections omit contexts, graphs and raw error input; full inspection is a separate permitted read. General row updates do not prove an accepted step. Active locks, genuine refusal records and stale accepted-step/input-wait evidence have distinct attention meanings. Preserve those distinctions when changing support views; exact DTOs and temporal predicates belong to [HTTP analytics](../reference/http-api.md#analytics) and [execution projections](../reference/execution.md).

## Browser artifacts

User HTML is untrusted and may execute scripts. [static-artifacts.ts](../../packages/web-backend/src/routes/static-artifacts.ts) serves each artifact on its own UUID subdomain, with a Moira-controlled warning/footer wrapper and sandboxed iframe. The frame's content-security policy blocks fetch/XHR/WebSocket and form submission while permitting HTTPS images and selected script/style/font resources. The sandbox restricts forms, top navigation and wrapper access; it is not complete network isolation or content vetting. Basic HTML acceptance is not sanitization.

Keep per-artifact Host resolution, wildcard origin/TLS configuration, raw-frame top-level navigation protection, abuse reporting/takedown and wrapper headers together when changing delivery. Do not broaden the CSP merely to make an example work. Public artifacts differ from expiring owner-native publications and execution-bound one-use image grants; each has its own authorization and lifetime.

## External callbacks and ingress

Configure trusted proxies to the real topology before trusting forwarded client addresses. CORS governs browsers and cannot authenticate server-to-server callers. Rate limits and callback state/account binding are independent checks. GitHub connection callbacks retain same-account/state and predecessor-custody rules; sanitize callback queries and tokenized paths in logs and error diagnostics.

Telegram webhook verification uses the configured secret when present; the current handler skips that check when no secret is stored. Do not treat an absent secret as enforced verification. Registration/delivery configuration and actual [telegram-webhook.ts](../../packages/web-backend/src/routes/telegram-webhook.ts) behavior must agree before relying on that boundary. Callback content and a model-provided approval answer do not grant new administrative or repository authority.

## Verification scope

Use [the testing guide](../../tests/TESTING-GUIDE.md) to choose checks matching the claim. Pure policy/fixture tests verify their inputs and modeled refusals; offline guest packaging checks verify installed payload behavior. They do not prove physical SDK isolation, live provider revocation, customer-data erasure or a deployment's network topology. Test unknown/refused/replayed states separately from success, inspect actual stored/effect ownership where that is the requirement, and retain genuine unexecuted limits in the result.
