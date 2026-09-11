# Test Coverage Map

Mapping of test files to functional domains and test levels.
Agents MUST update this file when adding, moving, or deleting tests.

## Coverage inventory

The domain sections below are the maintained inventory. Aggregate repository and
domain totals and per-file test counts are intentionally omitted: they duplicated
the file list or test-run output and drifted independently from both. Domain and
level headings classify the tracked test paths listed beneath them.

## Domain Details

### operator scripts

**unit**

- `tests/unit/config/docker-image-contract.test.ts` — canonical parameterized OSS runtime image contract, one Node engine across package/docs/CI/Docker, explicit non-secret compile-time inputs, and prohibition on embedding deployment env files
- `tests/unit/scripts/sqlite-online-backup.test.ts` — coherent SQLite online backup under concurrent WAL writes, integrity verification, and missing-source fail-closed behavior
- `tests/unit/scripts/self-host-startup-guard.test.ts` — pre-Supervisor generation reset, real SQLite success, stale/ordered terminal sentinels, partial-init restore with persistent reconciliation-bundle retention and hard-failure guidance, interrupted existing/first-start recovery, removal/marker/sentinel faults, staging/restore symlink rejection, SIGTERM/SIGKILL recovery, prompt-manifest integrity, and bounded rotation including WAL sidecars
- `tests/unit/scripts/self-host-upgrade-contract.test.ts` — latest-image quickstart, image-owned startup-guard wiring, plus optional pinned-image isolated preflight, health check, and rollback
- `tests/unit/docs/self-host-upgrade-docs.test.ts` — executable EN/RU MCP-owned semantic-source parity for `pull`/`up`, automatic recovery location and semantics, latest consistency across Compose/env, optional advanced preflight guidance, and internal revision/rationale-bound local Compose recovery without obsolete migration/WMF commands
- `tests/unit/scripts/test-email.test.ts` — explicit-recipient refusal and validation plus captured
  provider-boundary request for an IANA-reserved recipient

### admin

**api**

- `tests/api/admin-analytics.test.ts`
- `tests/api/capability-boundary-api.test.ts` — real self-host administrator HTTP denial with the exact named capability for installation-wide administrator statistics, every mounted analytics/operations and monitoring-test method, and bounded cross-user workflow/execution/artifact/session aliases, including Express-accepted case/trailing-slash variants and user-prefixed artifact takedown and quota routes, with the shared `ACCESS_DENIED` contract and ordinary-user approval preserved
- `tests/api/admin-user-security-api.test.ts` — administrator temporary-password recovery, malformed-boundary rejection without mutation, mandatory follow-up change, exact session/API/OAuth-token/OAuth-consent revocation, linked-provider token clearing, old credential denial, audit secrecy, atomic rollback for both final user-update and audit-completion failures, and distinct-admin-target/self/non-admin denial with credential/session preservation alongside existing security actions
- `tests/api/admin-user-security.test.ts`

**integration**

- `tests/integration/temporary-password-recovery-serialization.test.ts` — deterministic overlap pauses production recovery at its password-hash boundary, completes ordinary-user promotion, and proves the serialized recovery decision rejects without changing password/reset, session, API-token, OAuth-token/consent, or linked-provider authority

**unit**

- `tests/unit/web-backend/operational-metrics.test.ts`
- `tests/unit/web-backend/monitoring-test-delay.test.ts` — monitoring slow-request delay preserves every finite 100-10000 ms value, clamps both boundaries, rejects malformed/non-finite input, and projects the production validation error contract
- `tests/unit/shared/admin-workflow-list.test.ts` — admin workflow repository listing, ownership metadata, filtering, sorting, and pagination

**e2e**

- `tests/e2e/admin-analytics.spec.ts`
- `tests/e2e/admin-execution-errors.spec.ts` — the admin execution page: error history of another user's execution and its variables panel
- `tests/e2e/flow-page.spec.ts` — the flow page on Quick Task: the definition as a process (outline default with seven sections, canvas with a cycle edge, lanes (a React Flow rail) with return arcs and no run status or run sentence (definition mode note), split with the node finder, the technical graph with its controls and sidebar, a block-panel step opening the graph), the walkthrough landing on split for step and evidence, a non-owner without edit mode; an owner's edit session on a private copy (a renamed block, a relabelled return, a moved routing node reported as an `unlabeled-edge` diagnostic that disables the save until moved back, an edited directive, expression, registry default and whole registry declaration as JSON Schema, the inline diagnostic on the moved step, the export listing exactly the five changed flow-file entries, a save that persists, advances the revision to 1 and re-derives on reload); a save refused on a stale revision (409, edits kept, text asks to reload) and on an invalid definition (400, edits kept); and a phone-width page with vertical lanes, the panel under the picture and no horizontal overflow
- `tests/e2e/execution-progress-ui.spec.ts` — the run page on a real Quick Task run with a repair loop: lanes statuses with the pass count and return arc, block-detail steps with expected evidence, deep-linked block selection and technical-graph focus (two steps, two viewport transforms), the route cursor dimming later visits and changing the lanes, the answered variable's history opened under its row and its value read at the start visit and without a cursor, canvas and outline loop rendering, the walkthrough in the URL, answering the waiting step from the page (required fields gating submit, a schema-invalid answer refused with the step's message, the accepted answer moving the lanes and recorded as the person's adjustment on the route, the agent's stale attempt), the variables table keeping its names inside the panel with long values, the loading state, and a phone-width page kept usable (folded mode note, picture height kept, no horizontal scroll) when the projection fails or the workflow has no process view
- `tests/e2e/sdf-progress-ui.spec.ts` — one bounded real SDF path from MCP start through a successfully consumed PNG progress-image token to the run page's waiting Intake lane and the answer form for the intake step; exhaustive phase semantics remain unit-owned
- `tests/e2e/admin-executions.spec.ts`
- `tests/e2e/admin-user-security.spec.ts`
- `tests/e2e/operational-dashboard.spec.ts`
- `tests/e2e/docs-serving.spec.ts` — built Starlight docs served at /docs in the image: /docs serves Starlight not the Web UI SPA; /ru/docs RU; / still Web UI; missing doc 404s instead of SPA fallthrough
- `tests/e2e/admin-workflows.spec.ts` — admin workflow listing, visibility filtering, and search
- `tests/e2e/verify-step23b.spec.ts` — admin repository-backed list endpoints and dependent admin pages

### api-tokens

**unit**

- `tests/unit/shared/api-token.test.ts`

**api**

- `tests/api/tokens-api.test.ts`
- `tests/api/admin-tokens-api.test.ts` — mode-aware admitted-user token fixtures plus authenticated administrator list/filter/pagination/revocation and non-admin/anonymous denial through the production admin namespace

**mcp-tools**

- `tests/mcp-tools/persistent-token-auth.test.ts` — deployment-aware admitted-user setup plus valid, revoked, expired, missing, and blocked persistent-token behavior; OAuth coexistence; null/stale 426 without mutation; exact same-token initialize; sibling isolation; invalid shapes; and concurrent catalog acceptance without rotation

**e2e**

- `tests/e2e/api-tokens-settings.spec.ts`
- `tests/e2e/admin-tokens.spec.ts`

### artifacts

**unit**

- `tests/unit/shared/artifact-service.test.ts`
- `tests/unit/shared/url-config.test.ts` — artifact URL/subdomain resolution
- `tests/unit/web-backend/artifact-rate-limit-key.test.ts` — per-artifact rate-limit keying
- `tests/unit/web-backend/static-artifact-report-notification.test.ts` — per-admin portable artifact-report delivery through the common communication service, extension-only channel outcomes, no-channel/provider-failure/thrown-attempt isolation, and content/provider-diagnostic log redaction

**integration**

- `tests/integration/artifact-abuse.test.ts` — report/takedown/getPublic suppression + audit

**api**

- `tests/api/artifacts-api.test.ts` — CRUD + abuse controls (provider-neutral best-effort report notification, takedown, frame CSP)

**mcp-tools**

- `tests/mcp-tools/artifact-tokens.test.ts`
- `tests/mcp-tools/artifacts-tool.test.ts`
- `tests/mcp-tools/static-artifacts.test.ts`

**e2e**

- `tests/e2e/admin-artifacts.spec.ts`
- `tests/e2e/admin-reported-artifacts.spec.ts` — abuse review + takedown via UI
- `tests/e2e/artifact-security.spec.ts` — wrapper/sandbox/footer/interstitial/report + CSP
- `tests/e2e/artifacts-ui.spec.ts`

### audit

**integration**

- `tests/integration/audit-logging.test.ts`
- `tests/integration/database/audit-repository.test.ts`

**mcp-tools**

- `tests/mcp-tools/workflow-audit.test.ts`

**e2e**

- `tests/e2e/audit-log.spec.ts`

### auth

**unit**

- `tests/unit/shared/better-auth-schema-compatibility.test.ts` — fresh migration chain exposes the MCP OAuth `redirectUrls` column under Better Auth's exact logical field name, and the Drizzle model persists and reads the same stored representation
- `tests/unit/shared/test-origin-fetch.test.ts` — direct Node.js test clients add the browser-equivalent Origin only to unsafe Better Auth requests while preserving explicit origins, safe methods, and unrelated endpoints
- `tests/unit/shared/oauth-page-paths.test.ts` — the OAuth plugin's login and consent pages are configured under the Web UI base path, prefixed when one is set and unprefixed at the root

**integration**

- `tests/integration/forced-password-reset.test.ts`
- `tests/integration/user-password-reset-fields.test.ts`

**api**

- `tests/api/admin-logout-all.test.ts`
- `tests/api/auth/registration-consent.test.ts`
- `tests/api/authorization.test.ts`
- `tests/api/user-oauth-sessions-api.test.ts`

**e2e**

- `tests/e2e/admin-logout-all.spec.ts`
- `tests/e2e/auth-ux-quality.spec.ts`
- `tests/e2e/forced-password-reset.spec.ts`
- `tests/e2e/forgot-password.spec.ts`
- `tests/e2e/inspector-oauth-registration.spec.ts`
- `tests/e2e/logout.spec.ts`
- `tests/e2e/oauth-consent.spec.ts`
- `tests/e2e/user-oauth-sessions.spec.ts`
- `tests/e2e/web-login.spec.ts`
- `tests/e2e/web-registration.spec.ts`

### chat

**unit**

- `tests/unit/mcp-server/messages.test.ts` — attempt-error categorization, including identical processing retries, automatic `current_step` recovery for stale, conflicting, and explicitly recoverable unavailable step attempts, rejected-input disposal, and retained no-retry boundaries for unavailable starts, outcome-unknown, and unrecoverable states
- `tests/unit/workflow-engine/telegram-error-messages.test.ts` — actionable Telegram categories with provider/template detail redacted from generic API error projections

**integration**

- `tests/integration/agent-message-enhancement.test.ts` — formatted agent messages via MCPEngine over the integration DB: first directive with task, criteria and input schema, next directive after input, a full simple-linear cycle to completion

### context

**unit**

- `tests/unit/logging/context.test.ts`
- `tests/unit/mcp-server/prompt-context.test.ts`
- `tests/unit/shared/logging/service-context-propagation.test.ts`
- `tests/unit/shared/logging/service-logger-error-context.test.ts`
- `tests/unit/web-frontend/context-variable-model.test.ts` — the variables surfaces' lookups: declared global names from the registry, node ids as node-local scopes, registry descriptions

**integration**

- `tests/integration/execution-context-tools.test.ts`
- `tests/integration/execution-context-per-key-update.test.ts` — per-key context merging plus target-revision rejection of sequential and simultaneous stale snapshots without consuming the workflow-step generation
- `tests/integration/subgraph-context-mapping.test.ts`

**mcp-tools**

- `tests/mcp-tools/execution-context.test.ts`

**e2e**

- `tests/e2e/context-variable-editor.spec.ts` — the run page's variables panel on a seeded execution: two collapsible groups (declared variables, node outputs) and no undeclared group, a promoted global shown once, the registry description as a tooltip, the tree-aware filter, per-path nested save verified in SQLite, the long-text modal, an empty value as a full-height field, the declared group collapsing and an in-place edit of a policy-enabled string shown again after a reload

### deployment-mode

**unit**

- `tests/unit/web-backend/account-approval-route-gating.test.ts` — disabled-mode administrator approval returns before mutation/audit; neutral status remains successful when broad repository reads are forbidden; the enabled production route selector returns computed non-empty workflow/execution totals, running count, ordered recent activity, and the compatible definition/health/reconciliation fields
- `tests/unit/web-backend/capability-middleware.test.ts` — the same injected resolver controls public feature exposure and backend authorization; disabled, unknown, selected-path, and resolver-error decisions fail closed before handler side effects, while mixed overrides keep operations and development independent and cannot authorize a case-variant operational route through analytics
- `tests/unit/web-frontend/account-admission-ui.test.ts` — independent approval/email route decisions and deployment-capability selection for the registration completion page
- `tests/unit/web-frontend/account-approval-admin-ui.test.tsx` — capability-aware account-approval status and actions in the administrator list/detail surfaces, including SaaS null-timestamp behavior, self-host suppression of the artifact-quota request/card, temporary-password form submission, real versus unavailable profile/admin delivery controls, and fail-closed forgot-password loading/error/unavailable states
- `tests/unit/web-frontend/admin-navigation-capabilities.test.ts` — generic named-capability filtering keeps narrow Users independent from broader multi-user and operational navigation
- `tests/unit/shared/account-admission.test.ts` — mode-independent approval state, fail-closed null/missing identity handling, and blocked/approval/email-verification denial precedence
- `tests/unit/shared/deployment-mode-config.test.ts` — DEPLOYMENT_MODE resolution: default self-host, case/whitespace normalization, invalid-value throws, isSelfHost/isSaas predicates
- `tests/unit/shared/feature-resolver.test.ts` — complete ModeFeatureResolver matrix including analytics, operations, and operations/development boundaries; unknown-feature safe default; singleton get/override/reset
- `tests/unit/shared/secrets-bootstrap.test.ts` — self-host secret generation+persist, mask vs expose, no-regenerate-when-present, restart idempotency, saas no-op, loadPersistedSecrets no-override + absent-file
- `tests/unit/shared/deployment-mode-safeguard.test.ts` — unset-DEPLOYMENT_MODE safeguard: production+public→error/refuse-boot, non-prod+public→warn, mode-set/localhost/127.x/empty-host→ok

**integration**

- `tests/integration/account-approval.test.ts` — legacy migration backfill and fresh-account persistence; downgrade preparation requires confirmation, blocks pending accounts through the legacy control, and revokes only their credentials; atomic concurrent approval with one timestamp and one audit event; missing-user no-op audit behavior
- `tests/integration/auth-mode-gating.test.ts` — mode feature contract: self-host registration with account approval and no email/legal gate; SaaS behavior unchanged; MCP/token issuance without verification in self-host; only an explicitly enabled reserved-domain registration with an authenticated load-test header is auto-approved, while disabled, wrong-secret, and wrong-domain cases remain pending; an existing blocked SaaS session is denied at non-public Better Auth operations
- `tests/integration/create-admin-user.test.ts` — recovery refuses a missing operator password without creating an identity; supplied credentials create an approved admin with a Better Auth-verifiable hash, never log the secret, and safely replace an existing credential

**api**

- `tests/api/auth/self-host-auth.test.ts` — complete self-host HTTP/MCP lifecycle from pending registration through concurrent admin approval, one audit transition, and Better Auth/product/token/OAuth unlock; valid initialize denial for pending persistent and OAuth credentials; pending OAuth code, refresh-token, and bearer-introspection denial with admitted introspection success; explicit unavailable delivery from both Better Auth reset aliases, verification, profile resend, and admin APIs without false success, email-log creation, or target-account recovery/verification-row side effects measured before every affected call under parallel API workers; independent manual email verification/forced-reset actions; admin authorization, audit actor identity, self-block rejection, and missing-user contracts; blocked/approval/email independence; pending status/sign-out; bootstrap-admin token issuance
- `tests/api/auth/saas-auth-invariants.test.ts` — explicit SaaS real-delivery mode, consent enforcement, verification email, profile resend/cooldown, logged-only administrator delivery results and observable test-sink messages for suppressed test recipients, no account-approval gate including profile mutation, blocked-first/email-verification gates for persistent tokens, OAuth code/refresh exchange, valid MCP initialize denial for blocked/unverified bearer credentials, bearer introspection, and successful verified/unblocked code, refresh, MCP, and introspection paths
- `tests/api/features-api.test.ts` — public GET /api/features contract: no-auth envelope, exact authorization-capability keys, runtime MCP URL, sanitized delivery state/provider/reason, and `available` true only for real delivery

**e2e**

- `tests/e2e/feature-mode-ui.spec.ts` — exact mocked mode capabilities: self-host exposes Users while omitting broad, logout-all, analytics, operations, and monitoring affordances and requests; SaaS shows them and issues analytics requests; direct navigation fails closed; legal/beta mode behavior remains intact
- `tests/e2e/self-host-account-approval.spec.ts` — failed-then-recovered deployment-capability loading selects neither the wrong self-host nor SaaS admission flow and cannot open a protected SaaS route before retry; explicit self-host registration → pending status/sign-out → protected-route denial and transient status retry → administrator list/detail confirmation with loading/error/retry/live-region/keyboard/focus recovery and Russian localized failure behavior → automatic rendered product access; explicit mocked SaaS legal-consent and email-verification completion UI

### self-host-limits

**unit**

- `tests/unit/shared/note-quotas-configurable.test.ts` — note quotas from global settings: per-note size, per-user total, max versions; fallback to hardcoded defaults when absent or garbage/non-positive
- `tests/unit/shared/execution-retention-service.test.ts` — execution retention: deleteCompletedOlderThan deletes only expired completed, keeps running/fresh/active-parent; service no-op when retention_days 0/unset; deletes when configured

### pin-hash

**unit**

- `tests/unit/shared/pin-hash.test.ts` — execution-lock PIN scrypt hashing: scrypt$salt$hash format, per-hash salt, correct/incorrect verify, legacy-plaintext rejected, malformed-stored rejected without throw, isHashedPin

### email

**unit**

- `tests/unit/email/email-error-classification.test.ts`
- `tests/unit/email/email-delivery-config.test.ts` — explicit real/test/unavailable/configuration-error states including unknown provider selection; explicit and automatic SMTP/Brevo selection, legacy Brevo compatibility under partial/default SMTP variables, complete-SMTP precedence and validation; complete CI recipient-domain suppression through provider-neutral sending with zero real-provider calls and durable logged history for every recipient; actual startup-validation wiring for SaaS no-provider/test-sink fatal, self-host unavailable, and both-mode invalid/unknown configuration, with fatal status proven to come from the product-owned exit code
- `tests/unit/email/brevo-provider.test.ts` — provider-neutral Brevo selection with a local SDK transport stub, exact message projection, returned sent contract, and persisted sent email history without network access
- `tests/unit/email/smtp-provider.test.ts` — provider-neutral `sendEmail` selection reaches an isolated loopback SMTP fixture with exact recipient, subject, text, and HTML and persists a sent `emailLog`; direct adapter checks observe configured authentication, propagate transport rejection without external network access, and verify implicit-TLS/required-STARTTLS option forwarding

### error-handling

**unit**

- `tests/unit/mcp-server/error-logging-levels.test.ts`
- `tests/unit/mcp-server/error-sanitizer.test.ts`
- `tests/unit/shared/domain-errors.test.ts`
- `tests/unit/shared/errors/app-error.test.ts`
- `tests/unit/web-backend/error-sanitizer.test.ts`
- `tests/unit/web-frontend/ErrorBoundary.test.tsx` — frontend error-boundary fallback and recovery actions

**integration**

- `tests/integration/error-logging-flow.test.ts` — durable validation/system-error history, idempotent cancellation, and the run projection of a real cancellation on an open wait (the block stays the frontier, the last visit stays open)
- `tests/integration/execution-visits-persistence.test.ts` — the route log persisted with the execution row through the migrated database repository: save/get round trip growing with the revision, an adjustment visit appended in the same guarded context write, a stale context revision appending nothing, and empty or malformed legacy rows reading back as an empty log
- `tests/integration/subgraph-error-scenarios.test.ts` — root/child/grandchild error provenance, durable root ownership, authored recovery edges, and persisted root/one/nested retry exhaustion without mutation replay

**api**

- `tests/api/error-handling-flow.test.ts`

**mcp-tools**

- `tests/mcp-tools/error-diagnostics.test.ts`

**e2e**

- `tests/e2e/error-boundary.spec.ts`
- `tests/e2e/error-history-display.spec.ts`

### execution

**unit**

- `tests/unit/mcp-server/replay-safe-step-schema.test.ts` — required Step attempt identity in the public schema plus conflict and unavailable-step recovery in the runtime prompt and default/Cursor static descriptions, with rejection of attempt-less guidance
- `tests/unit/mcp-server/replay-safe-start-schema.test.ts` — flat root-object public Start contract plus exact runtime prepare/execute discrimination, including rejection of cross-phase and unknown fields
- `tests/unit/shared/execution-repository-errors.test.ts` — including terminal-result persistence, owner-identity validation, legacy null rows, and fail-closed empty/falsy payload handling
- `tests/unit/shared/execution-status-mapping.test.ts` — legacy execution-status normalization

**integration**

- `tests/integration/execution-attempt-persistence-migration.test.ts` — additive attempt-storage migration, durable step/start receipts, forced transactional claim rollback, restart-stable unknown-start attachment, revision- and blocking-row-bound atomic cancellation, fenced ownership across SQLite connections, post-eviction no-create behavior, and independent preparation/receipt age/count retention; a presentation superseded by an outside answer (stale claim, executing guard, eviction with old receipts)
- `tests/integration/replay-safe-start-attempts.test.ts` — no-effect preparation, execute-only ordinary/lock preflight, intentional distinct starts, concurrent external-effect coalescing, exact replay without lifecycle metric duplication, foreign non-disclosure, independent digest/version/access binding, start heartbeat reconciliation, stable changed-precondition receipt, expiry rejection, and owner-visible/revision-bound outcome-unknown recovery
- `tests/integration/replay-safe-step-attempts.test.ts` — exact replay, legacy missing-attempt adoption, revision-only stale presentation recovery, metadata-stable step generations, cancellation semantics, conflicting/foreign binding rejection, coalesced external effects, fenced leases, atomic completion/current presentation, materialize/teleport behavior, retention, and terminal metrics; an answer from outside the flow superseding the agent's presentation (stale attempt, current_step presenting the new node, refusal while an attempt executes)
- `tests/integration/replay-safe-step-audit.test.ts` — bounded content-free audit and Prometheus classifications for all applicable step/start outcomes, actual start-boundary identical `ATTEMPT_PROCESSING` retry guidance without a user stop, and proof that a start replay creates no duplicate execution-start business audit transition
- `tests/integration/replay-safe-step-mcp-boundary.test.ts` — public parsing, exact replay, and automatic `current_step` recovery for stale, conflicting, and expired step attempts without a user stop, stale-input replay, or execution mutation
- `tests/integration/execution-filters.test.ts`
- `tests/integration/parent-execution-continuation.test.ts`
- `tests/integration/start-workflow-parent-execution.test.ts`
- `tests/integration/subgraph-step-execution.test.ts`
- `tests/integration/workflow-execution.test.ts`

**api**

- `tests/api/executions-errors-api.test.ts` — `GET /api/executions` `errorCount` and `GET /api/executions/:id` `errors[]` for an execution that recorded one input-schema validation error (type `validation`, node id of the rejecting step)

**mcp-tools**

- `tests/mcp-tools/execution-audit.test.ts`
- `tests/mcp-tools/execution-errors.test.ts`
- `tests/mcp-tools/workflow-execution.test.ts` — process-level authenticated prepare/execute start, current Step attempt propagation, step/session execution, context and branching behavior, intentional validation pause, concurrent intentional starts, and `isError` preservation for a genuine failed step
- `tests/mcp-tools/communication-tool.test.ts` — authenticated text delivery projection plus attachment grant owner binding, credential/grant separation, pre-delivery release and terminal single-use behavior through the real proxy and MCP process

**e2e**

- `tests/e2e/execution-inspector-ux.spec.ts` — the run page keeps the inspector's toolbar (id copy, status, refresh), the variables tab (no separate context tab) with its fullscreen panel at least twice the docked panel's width, the errors/steps/locks tabs, the technical node graph one click away opening with the current step's card inside the graph's box, the fit control giving the overview and the toolbar's current-node button bringing the card back, the panel beside the run on desktop and under it on a phone, where neither the run canvas nor the technical graph draws a minimap; the admin variant (owner info, waiting process view, read-only context, answer form) on instances with the multi-user admin capability
- `tests/e2e/executions-navigation.spec.ts`
- `tests/e2e/executions-page.spec.ts`

### extension-runtime

**unit**

- `tests/unit/extension-runner/bundle-loader.test.ts` — manifest-only node/channel bundle discovery, canonical entrypoint containment, isolated refusal, namespace conflicts and missing-directory behavior
- `tests/unit/workflow-engine/extension-node-execution.test.ts` — custom-node graph dispatch, node-scoped result storage, downstream template access, startup-unreachable error traversal versus live catalog absence, process-default registry/client composition, and in-memory extension-setting parity for empty defaults plus stored/default/unset JSON null
- `tests/unit/workflow-engine/extension-node-handler.test.ts` — template/config/input/output boundaries, normalized error routing, explicit-registry secret grants and schema refresh on long-lived handlers
- `tests/unit/workflow-engine/extension-node-validation.test.ts` — registered/unresolvable/missing custom types, declared config schemas, registry refresh and unchanged built-in validation
- `tests/unit/workflow-engine/extension-registry-reach.test.ts` — process registry propagation, schema-bearing node/channel snapshot round trips, corrupt/legacy snapshot refusal, registry-origin distinctions, failure-preserving startup synchronization and publication, and built-in type authority
- `tests/unit/workflow-engine/extension-registry.test.ts` — versioned node/channel manifests, bounded schema dialect, scoped settings/permission declarations, contribution conflicts, registry lifecycle and snapshot projection
- `tests/unit/workflow-engine/extension-communication.test.ts` — process and local channel reconciliation, maximum/overlong identity admission with atomic manifest refusal and bounded approval, generic fan-out, enable/configuration behavior, least-authority runner requests, sanitized failures, removal, and declaration/approval/health/configuration trusted-eligibility matrix
- `tests/unit/workflow-engine/extension-runner-client-http.test.ts` — transport deadlines, metadata status/envelope/version authority, and mapping of HTTP/network responses to extension failure classes
- `tests/unit/workflow-engine/node-type-catalog.test.ts` — complete engine-owned built-in catalog, live/unconfigured/unreachable/snapshot registry distinctions, extension declarations and schema exposure without settings leakage
- `tests/unit/workflow-engine/validator-node-diagnostics.test.ts` — complete missing-field diagnostics with bounded nested schema-error volume
- `tests/unit/web-backend/node-types-route.test.ts` — node-type endpoint delegates to the active process registry rather than rebuilding a private catalog
- `tests/unit/web-backend/settings-route-extension-values.test.ts` — public settings HTTP state for per-key save/reset, structural values, mixed 207 outcomes, unknown keys and admin-only mutation/read boundaries
- `tests/unit/web-backend/validation-service-node-types.test.ts` — visualization compatibility shares engine built-ins and extension classification instead of a drifting backend allowlist
- `tests/unit/web-frontend/settings-editor-structural-value.test.tsx` — extension-category ownership in EN/RU, editable structural/unset values and visible refusal that preserves a dirty edit
- `tests/unit/web-frontend/workflow-transformer-node-catalog.test.ts` — catalog-driven generic cards preserve real type, declaration, origin, owner, schema and configuration; missing, unavailable and unknown fallbacks remain semantic presentation states; dedicated built-ins keep their renderer
- `tests/unit/web-frontend/workflow-sidebar-schema-readout.test.tsx` — extension ownership plus English and Russian presentation of declared, unset and undeclared configuration fields in the generic node detail panel

**integration**

- `tests/integration/extension-runner-contract.test.ts` — real HTTP/child-process node and communication delivery, protocol/schema reconciliation, startup and queue deadlines, cancellation/shutdown, crash recovery, scoped redirect/secret/artifact permissions, malformed IPC containment and node-scoped error routing
- `tests/integration/webhook-notify-example.test.ts` — shipped reference node/channel bundle loaded by the real runner and isolated child handler against a loopback receiver, with exact configured requests, generic configured-recipient delivery, node result and named rate-limit failure without external network access
- `tests/integration/extension-registry-consumers.test.ts` — MCP process registry and separate CLI snapshot consumption validate the same custom-node workflow and its declared configuration schema consistently
- `tests/integration/extension-settings-migration.test.ts` — migration 0022 remains applicable before later migrations, preserves prior tables and rows, and creates the extension value-store shape
- `tests/integration/communication-attachment-grant-migration.test.ts` — migration 0023 upgrades an existing database with the indexed digest-only communication grant shape
- `tests/integration/extension-settings-repository-seam.test.ts` — production repository merges manifest definitions without stored rows, enforces declared primitive types and lossless JSON round trips including array serialization hooks, persists encrypted/typed per-user values, separates trusted and masked projections, audits mutation and supplies only granted values to handlers
- `tests/integration/extension-settings-audit-atomicity.test.ts` — real settings HTTP routes inject audit-insert failure and prove save/reset value rows, audit rows and bulk saved/refused output remain one atomic result; also covers HTTP refusal of malformed primitive values
- `tests/integration/extension-settings.test.ts` — manifest definition lifetime, typed and schema-valid defaults, extension value repository encryption/isolation, complete declared-schema validation and handler least-authority cases
- `tests/integration/node-types-endpoint.test.ts` — real HTTP route exposes built-in and live extension types from the process registry without extension setting keys

**api**

- `tests/api/settings-api.test.ts` — authenticated settings CRUD plus explicit mixed bulk 207 results, unknown-key continuation and admin-only definition/value visibility rules on the real container

**docker**

- `tests/docker/extensions-profile.sh` — default-off service selection, optional healthy runner dependency, current runner protocol/image build, shipped example node/channel discovery and read-only bundle mount

### expressions

**api**

- `tests/api/expression-node-api.test.ts`

**mcp-tools**

- `tests/mcp-tools/expression-loop.test.ts`
- `tests/mcp-tools/expression-node.test.ts`

**e2e**

- `tests/e2e/expression-node-display.spec.ts`

### file-transfer

**mcp-tools**

- `tests/mcp-tools/workflow-upload-visibility.test.ts` — upload visibility public/private/default via `test.each`, plus an invalid value → 400

### github-collaboration

**unit**

- `tests/unit/github/security-automation-contract.test.cjs` — root-only workspace lock ownership, grouped Dependabot sources/title prefixes, complete immutable external Action inventory, base-owned dependency/workflow security gate, trusted actionlint policy, tool inputs and SECURITY/CONTRIBUTING alignment
- `tests/unit/github/pr-policy.test.cjs` — bounded title/body policy, same-repository issue linkage, permission-bound no-issue declarations, concrete Testing evidence, per-commit DCO, exact verified Dependabot exception, complete findings and input bounds
- `tests/unit/github/pr-policy-adapter.test.cjs` — paginated GitHub commit/closing-reference collection, API fact mapping, permission failure semantics and bounded overflow
- `tests/unit/github/pr-policy-workflow-contract.test.cjs` — stable read-only check, trusted default-branch execution, repair triggers, pinned Actions, contributor/template marker alignment and CODEOWNERS coverage
- `tests/unit/github/release-policy-contract.test.cjs` — shared analyzer/release-notes preset, exact no-release scopes, deployed/isolated toolchain version parity, CI/root-command wiring, persistent dependency isolation and contributor documentation alignment
- `tests/unit/github/issue-claim-transitions.test.cjs` — exact command parsing, centralized claim eligibility, ordered coalescing-safe command draining with trusted processed reactions including GitHub's non-enumerable repository context, verified claim/release invariants, trusted human-readable lease record, fault-injected partial/silent GitHub mutations and response replay, ownership-safe compensation, external interleaving preservation, and owner-only release
- `tests/unit/github/issue-claim-leases.test.cjs` — attributable issue/closing-PR activity, excluded external activity, direct and scheduled renewal, delayed reminder timestamps, retriable visible-reminder cleanup, post-reminder grace, expiry, interrupted/duplicate/malformed record recovery, manual-state preservation, repeat safety, and manual discovery targeting
- `tests/unit/github/issue-claim-workflow-contract.test.cjs` — trusted default-branch checkout, least-privilege permissions, shared per-issue concurrency, command/schedule/manual triggers, and matrix reconciliation wiring

### health

**e2e**

- `tests/e2e/admin-ui-security-status.spec.ts`

### help-system

**unit**

- `tests/unit/mcp-server/get-help-mdx.test.ts` — MCP-owned non-tools corpus matches public topic identities and EN/RU metadata/imports (the process-view concept topic included), resolves every real topic composition and the process/run/blocks aliases, advertises the special typed `tools` topic and alias in the shared catalog, uses canonical registry-selected client configuration/token/deeplink generation, imports system instructions, removes presentation syntax, preserves aliases/errors, and renders direct typed tools; the process-view help topics (concepts workflows/process-view, guides editing-workflows/flow-page/run-page, EN and RU) carry none of the retired terms (milestone, display connection, user-visible or observable waiting node)

**integration**

- `tests/integration/docs-client-registry-propagation.test.ts` — one added registry-shaped client reaches both the real Starlight `ClientSetupTabs` build and MCP-owned runtime Markdown directly with its label, setup title, and deeplink semantics

### http-infrastructure

**unit**

- `tests/unit/web-backend/client-logs.test.ts`
- `tests/unit/web-backend/headers.test.ts`
- `tests/unit/web-backend/request-body-logger.test.ts` — request logging plus emitted-log proof that administrator temporary credentials are omitted while a safe neighboring body remains observable

**api**

- `tests/api/notification-test-api.test.ts` — authenticated built-in channel descriptor without secret/destination values, stored-current-user neutral test delivery, browser-supplied credential refusal, unknown-channel non-disclosure and unauthenticated denial
- `tests/api/request-body-logging.test.ts`

### i18n

**unit**

- `tests/unit/web-frontend/i18n.test.ts`

**e2e**

- `tests/e2e/i18n-stage1-verification.spec.ts`
- `tests/e2e/i18n-stage2-admin-verification.spec.ts`
- `tests/e2e/i18n-stage2-layout.spec.ts`
- `tests/e2e/i18n-stage3-pages.spec.ts`
- `tests/e2e/i18n-stage4-admin.spec.ts`
- `tests/e2e/i18n-stage4-functionality-check.spec.ts`
- `tests/e2e/i18n-stage5-language-switcher.spec.ts`
- `tests/e2e/i18n-url-param.spec.ts`

### infrastructure

**unit**

- `tests/unit/scripts/detect-test-env.test.ts`
- `tests/unit/scripts/remigrate-registry-schemas.test.ts` — registry schema restoration: strengthen type-guard, mergeOldSchemas safe merge/union/absence-unbounded/items-properties-reconcile/required-intersection, gate-enum inference, collectExpressionTargets counter-guard, bumpMinor
- `tests/unit/shared/version-utils.test.ts` — including root-only catalog metadata normalization without masking nested graph content

### input-parsing

**unit**

- `tests/unit/mcp-server/input-parser-simple.test.ts`

**integration**

- `tests/integration/input-enhancement.test.ts` — `parseInputData` at the `executeStep` tool boundary: JSON-string and object inputs advance; nested, primitive, malformed and null inputs receive schema feedback and stay on the same node

**mcp-tools**

- `tests/mcp-tools/json-formatting.test.ts`

**functional**

- `tests/functional/input-parsing-functional.test.ts`

### inspector

**e2e**

- `tests/e2e/inspector-mcp-tools.spec.ts`

### mcp-tools

**unit**

- `tests/unit/mcp-server/tool-definitions.test.ts` — unique typed catalog ownership, root-object schemas without top-level composition through real registration, flat Start discovery with mixed-phase runtime rejection, strict least-authority communication contract, projected blank-selector rejection, complete manage action projection, all-example/schema validity and rendering, deterministic client-visible revision boundaries, EN/RU renderer parity, and closed workspace schemas with published native-file metadata participating in the catalog revision
- `tests/unit/mcp-server/tool-examples.test.ts` — exact-key, current notification-category, and all-settings registry examples reach the masked read projection
- `tests/unit/mcp-server/mcp-catalog-lifecycle.test.ts` — SDK-valid singleton initialize classification, exact successful-result stamp ordering, error/other-result non-stamping, and successful-result suppression when the credential cannot be stamped
- `tests/unit/mcp-server/mcp-tools-revision.test.ts` — deterministic matching, null, and stale catalog-revision decisions with package version retained only as diagnostic response data
- `tests/unit/mcp-server/communication-attachment-route.test.ts` — configured MCP text delegation, exact attachment bytes, provider-attempt race and terminal failure, plus pre-buffer length/MIME/body/in-flight refusal with retryable claim release
- `tests/integration/docs-tool-contract-rendering.test.ts` — actual EN/RU public routes render every identity, localized fact, action, schema, result, example, and CodeBlock directly from the MCP contract model
- `tests/unit/scripts/static-tool-description-migration.test.ts` — exact retirement of database-backed default/agent/model descriptions plus nullable persistent-token revision migration with existing identity/hash preservation
- `tests/unit/mcp-server/progress-authoring-schema.test.ts` — MCP manage rich-progress goal/facts/content acceptance, the mandatory block description (`content.summary`), plus strict unknown-field and bound rejection

- `tests/unit/workflow-cli/workflow-derive.test.ts` — `derive` output of the annotated Quick Task (blocks, labelled transitions, explained returns, no diagnostics), diagnostics of an incompletely annotated flow, the no-progress message, and determinism
- `tests/unit/workflow-cli/workflow-schema.test.ts` — deterministic complete workflow control-flow schemas: locale-independent canonical edge/mapping order, basic blocks, conditions, many independent cycles, separate start/teleport/disconnected reachability, dangling edges, current node data-flow declarations including batch write-note and materialize registry reads, complete ordered progress topology and structured content with backward display edges and many-to-one primary mappings, context references, deep iterative traversal, terminal-control-safe structural tokens, non-mutation, and duplicate-ID rejection
- `tests/unit/scripts/workflow-tool-identity.test.ts` — set-name and set-slug: exact replacement, kebab-case validation, catalog-entry warning, version bump, and no collateral change to slug/owner/description/nodes, plus `--force`/`--no-version-bump` keeping the version without leaking into the stored name or description
- `tests/unit/scripts/workflow-tool-process.test.ts` — block-contract authoring commands through the real CLI: set-label (forward and explained return), clear-label, set-block, add-block with placement, edit-block with field removal, remaining-diagnostics report, version bump versus `--no-version-bump`/`--force`, and refusal of unknown nodes, keys, blocks, duplicate ids, empty summaries and half-explained returns without touching the file
- `tests/unit/scripts/workflow-tool-progress.test.ts` — static rich progress graph set/clear, node mapping and active-only label/content set/clear/scope, portable and legacy notification attachment set/clear, malformed input, and wrong-node-type rejection
- `tests/unit/workflow-engine/execution-progress.test.ts` — run projection from the recorded route: task/goal/facts/content rendering, active merge and exact context-revision replacement, pending/skipped outcome suppression, repeated blocks with pass counts and loop markers, completion with nothing unvisited done, a cancellation on an open wait kept as the frontier, route-less executions inferring nothing, variables with history and adjustment marks, a bypassed and an unrun block skipped, a route cursor projecting the run as it stood at a visit (cut route, active block, values written up to it, registry defaults for later writes, whole route at or beyond the last visit), injection protection, output bounds with explicit overflow failure, mapping/scope validation rules, and immutability; a fact over an unset variable omitted from the projection instead of rendering the undefined marker; an adjusted visit carrying an exit key closing the wait it sits on while an open adjustment leaves the run waiting
- `tests/unit/workflow-engine/wmf-process-contract.test.ts` — the bundled Workflow Management Flow teaches and demands the process block contract: its materialised progress reference states every rule (the every-block-connected rule included), every diagnostic code (`unconnected-block` included), CLI command and run status, the `no-start` diagnostic of `derive`, the two skipped-block rules, the accepted-but-unused legacy display order and the `progress.nodes` cap, and none of the retired model; the six design/review/build gates name the contract and the reference, the quality repair step completes a process-view repair only with `derive` clean, and both design repair owners read it
- `tests/unit/workflow-engine/execution-visits.test.ts` — per-visit variable diff (globals by name, node-local outputs as node.field, value not identity), appending engine visits (numbering, open wait continued on resume also beneath stacked adjustment visits, repeated invalid input leaving it open, teleport exit also after an adjustment, adjustment visits never continued or closed), the in-flight visit copy notification nodes render from, and the adjustment visit shape
- `tests/unit/workflow-engine/process-derivation.test.ts` — process derivation from the authored graph: the annotated Quick Task and Software Development Flow reproduce their block, transition, return and hub counts in authored order with no diagnostics; synthetic graphs for forward/return classification, returns to a lower-index block, hubs, and every diagnostic (unowned node, unknown block, empty description, unlabelled boundary edge, unexplained return, outcome template duplicated or unowned); validator enforcement of the same rules as errors and the no-progress exemption; a block with no transition to or from another block (a self-return alone does not count) is the `unconnected-block` diagnostic and a validation error, silent on the six annotated flows
- `tests/unit/workflow-engine/execution-progress-image.test.ts` — shared rich visual model, full-text wrapping, deterministic multi-row and loop/cross-row edges, SVG escaping, semantic content in PNG, byte determinism, theme/state differences, and image metadata bounds; every derived transition into a hub is a drawn connector in the process view, sources into one hub sharing one bundled lane and one port, labelled inside the source
- `tests/unit/workflow-engine/execution-progress-geometry.test.ts` — the progress image places every label and badge without overlap: on the six annotated flows at 720 and 1280 px, in both views, with blocks repeated twelve times, every label box is inside the image and disjoint from other labels, blocks and other arcs' lane runs, every repeat badge sits between the mark and the title inside its block, every label carries its whole text, the model is deterministic; the text metric orders glyph widths and weights and width wrapping never truncates
- `tests/unit/web-frontend/flow-editing.test.ts` — the flow page's edit model on Quick Task: block, transition, ownership, node-text and registry edits applied without mutating the input; the export diff naming exactly the changed flow-file entries and omitting no-op edits; a moved routing node surfacing as a derivation diagnostic before any save; the run-less projection (title, goal, every block pending) and the split mode's step ordering from the entry node
- `tests/unit/web-frontend/run-route-model.test.ts` — run page view helpers: process blocks joined with their run state (a rendered summary that repeats the block's description or name is dropped, a templated one kept), a block's writes at the cursor, route stretches with return markers, per-block counts under a cursor, cursor clamping, exit labels from transitions, lanes arcs nested by span, and step descriptions (first sentence, expected evidence, routing nodes) from a workflow definition
- `tests/unit/web-frontend/run-answer-form.test.tsx` — the answer form's typed parsing: numbers, booleans and JSON objects or arrays by declared type, strings passed through, empty drafts omitted, malformed JSON rejected
- `tests/unit/web-frontend/run-layout.test.ts` — canvas layout of the six annotated bundled flows through ELK: no overlapping blocks, every transition drawn as an edge (a hub target as a bundled hub edge into one port plus a chip in the source, never crossing a block), forward edges never pointing backwards, deterministic placement, hubs after their sources, and parallel forward transitions between one pair of adjacent blocks on distinct paths and label rows, and every forward label pill drawn at rest inside its gap clear of both blocks (the gap grows to the widest pill)
- `tests/unit/web-frontend/run-lanes-links.test.ts` — the lanes rail's forward connectors: exactly the non-adjacent forward transitions of the six flows, hubs linked from every skipping source, nesting depth by span and path endpoints
- `tests/unit/web-frontend/run-lanes-phone.test.tsx` — the phone lanes stepper renders every non-adjacent forward transition and every return as a chip naming its target with the label (and a return's cause) as the tooltip, and draws no connector SVG or arc
- `tests/unit/web-frontend/run-transition-chips.test.ts` — the chip model shared by lanes, canvas and the phone stepper over the six annotated flows: the canvas chip keys equal the keys of the laid-out cycle, skip and hub edges and the lane chip keys equal the rail's arc and link keys, each side unique; a source with several transitions into one hub gets one chip carrying every label; three or more adjacent forward transitions into one block fold into one forward chip on the canvas (fewer get none, lanes never show one) and the canvas edge keys include such bundles; the SDF lists all of its returns; a chip's title carries the label and a return's cause and exit
- `tests/unit/web-frontend/step-card-model.test.tsx` — the step card's shared facts: on Quick Task and SDF every connection of every step is classified internal (points at the sibling step) or external (names the owning block, which contains the target), in authored order; a node without connections yields none; the panel tab badge shows a count with its accessible label, a warning mark, or nothing
- `tests/unit/web-frontend/graph-model.test.ts` — the technical graph's model on four annotated flows: one graph step per workflow node in node order with the same StepInfo as `stepsOf`, owned by the block the derivation names and carrying `stepConnections`; one link per connection with a known target; every derived cycle edge is a return link and every return link is a cycle edge or leads to an earlier block; forward links never go back, external ones cross a block; without a process view nothing is grouped and every link is forward
- `tests/unit/web-frontend/graph-routing.test.ts` — the technical graph's edge routing on a hand-laid pair of blocks: a forward link inside a block is drawn straight; a return inside a block runs through the block's bottom corridor (below its cards, inside its box) and enters before its target; two returns sharing a corridor take different lanes; a link into a later block runs in the gap after its source's block; a return to an earlier block climbs the margin before the groups and comes in through the target block's corridor; a row of blocks transposes the geometry; the routed polyline starts at the source handle, ends at the target handle and rounds every corner; and, on the full layout of all six annotated flows in both directions, no lane segment crosses a card, no point leaves the canvas, every lane keeps its clearance from the cards and the blocks' borders, and the busiest cards' arrivals take their own approach columns up to the declared limit
- `tests/unit/web-frontend/variable-rows.test.ts` — the variables panel's grouping model: declared rows in name order from the registry and the context with description, policy editability and projection history; a cursor shows the projection's value while the context stays the edit target; a global a node wrote is one declared row and not an output; a node scope holding only such globals is no group; an undeclared key is still a row; no history without a projection
- `tests/unit/web-frontend/run-lanes-layout.test.ts` — the horizontal lanes rail's flow-coordinate layout: lane cards in one row at fixed equal spacing below the links band, lane centres in the middle of each card, the row pushed down by the links band and the height extended by the arcs band, arc and link geometry landing in their bands, the viewport height as the geometry plus the fit padding with a floor for the zoom controls, the chip-aware card height, and the rows lit label pills take (one each beyond the outermost lit connector), with the bands reserving those rows so a revealed column stays inside the rail
- `tests/unit/web-frontend/diagram-viewport.test.ts` — the shared diagram interaction policy for canvas, lanes and graph: a plain wheel pans freely and never zooms, pinch zooms, drag pans, nodes are not draggable, the page does not scroll under the pointer, the view opens fitted, and the per-kind zoom range
- `tests/unit/web-frontend/diagram-placement.test.tsx` — the shared opening placement hook: places once the substrate is ready, again only when the followed key changes, never on a same-key re-render, and waits for ready when the key changes early
- `tests/unit/web-frontend/workflow-detail-hook.test.tsx` — the workflow detail hook on the store: a refetch of the same id keeps the workflow current with `pending` set and `loading` clear; a change of id is a first load (`loading` true, `current` false) until the new workflow arrives
- `tests/unit/web-frontend/use-resource.test.tsx` — the page-local data store behind navigation without flicker: a pending refetch keeps the previous value and reports pending, a failed refetch keeps the value and exposes the error until the next success, a key change keeps the old value until the new key resolves, a stale response never overwrites a newer one, and a null key clears
- `tests/unit/scripts/workflow-tool-variables.test.ts` — incl. registry-backed globals, metadata, file-backed arguments, source diagnostics, fail-fast validation, atomic replace/sync, End projection/path qualification, and inert-retry migration
- `tests/unit/services/mcp-text-service.test.ts`

**integration**

- `tests/integration/mcp-contract-completeness.test.ts` — complete authored workflow retrieval and independent inclusion flags; presence-based exact/category/all settings selectors including empty and ambiguous rejection, masking, not-found, and both admin access directions; default, continuing, and terminal workflow-list page metadata through the real repository
- `tests/integration/cli-mcp-parity.test.ts`
- `tests/integration/workflow-schema-cli.test.ts` — public schema command output, shared `structure --graph` rendering, canonical equivalence across permuted JSON object keys, terminal-control-safe decoded JSON, source-byte preservation, and non-zero ambiguous-graph failure
- `tests/integration/essential-cases-split.test.ts`
- `tests/integration/get-current-step-enhanced.test.ts` — public SQLite-backed legacy/revision-only attempt recovery, truthful node-stale rejection, concurrent `current_step` convergence, metadata-stable public variable writes with continued claimability, and read-only materialize re-presentation versus empty public `step()` completion
- `tests/integration/mcp-text-service.test.ts`
- `tests/integration/step-response-child-info.test.ts`

**api**

- `tests/api/auth/mcp-blocked-user.test.ts`
- `tests/api/auth/mcp-protection.test.ts` — unauthenticated ordinary-request rejection and invalid-bearer rejection before a valid initialize can reach catalog acceptance
- `tests/api/auth/mcp-version-check.test.ts` — real OAuth issuance leaves credentials uninitialized; refresh preserves exact null, current, and stale catalog states; null/stale ordinary requests remain gated without mutation; the official SDK initializes only the exact row, continues on a refreshed current token without synthetic reinitialize, and recovers a stale successor through reconnect
- `tests/api/mcp-spec.test.ts`

**mcp-tools**

- `tests/mcp-tools/tool-catalog.test.ts` — authenticated HTTP `tools/list` exposes every tool as a root object without top-level unions and keeps Start discoverable with its direct action enum and both phase field sets
- `tests/mcp-tools/new-features.test.ts`

**e2e**

- `tests/e2e/mcp-prompts.spec.ts`
- `tests/e2e/workflow-toolbar-redesign.spec.ts`

### mcp-clients

**unit**

- `tests/unit/shared/mcp-clients.test.ts`

### metrics

**unit**

- `tests/unit/shared/metrics.test.ts`

### node-handlers

**unit**

- `tests/unit/workflow-engine/telegram-handler-errors.test.ts` — legacy Telegram routing/error behavior, current Settings > Notifications and directly usable Telegram Setup recovery guidance, progress images, explicit-recipient preservation, and destination/message log redaction

### notes

**unit**

- `tests/unit/shared/note-repository.test.ts`
- `tests/unit/shared/note-service.test.ts`

**integration**

- `tests/integration/execution-note.test.ts` — start/step/repository note persistence, including repository note updates that leave the current workflow-step revision unchanged

**api**

- `tests/api/notes-api.test.ts`

**mcp-tools**

- `tests/mcp-tools/notes-tool.test.ts`

**e2e**

- `tests/e2e/note-nodes-rendering.spec.ts`
- `tests/e2e/notes-management.spec.ts`

### execution-lock

**unit**

- `tests/unit/shared/lock-service.test.ts` — human one-time PIN creation plus agent-path pending/activate/failure lifecycle, hashed storage, exact-attempt isolation, validation, approval, and audit behavior
- `tests/unit/workflow-engine/trusted-lock-delivery.test.ts` — configuration-before-generation, configured-chat delivery, ordinary-channel registry isolation, non-secret result, and sender-error/PIN-safe projection at the trusted Telegram boundary

**integration**

- `tests/integration/trusted-lock-delivery-lifecycle.test.ts` — production LockHandler with database-persisted same-node re-entry across missing, malformed, send-failure, fresh-success, exact earlier-context isolation, and MCP create success/failure without real Telegram
- `tests/unit/web-backend/telegram-webhook.test.ts`

**workflow**

- `tests/workflow/scenarios/lock-node.test.ts`

**mcp-tools**

- `tests/mcp-tools/lock-tool.test.ts` — status/list/unlock/session and active-step behavior seeded through the authenticated human path, plus agent lock fail-closed behavior without trusted delivery
- `tests/mcp-tools/lock-step-integration.test.ts` — public mandatory lock-delivery preflight, including skipTelegramCheck denial without execution creation

**api**

- `tests/api/admin-lock-management.test.ts` — admin lock endpoints (`hasActiveLock` in the list, `activeLock` in the detail, `/locks`, `/locks/:lockId/unlock`) against an MCP-started execution locked through the owner lock route: shapes, exact 404s, admin override unlock once then 400
- `tests/api/user-lock-management.test.ts` — owner, non-owner and admin access to `/locks` and `/validate-pin` (401 non-owner, 404 unknown execution, 400 missing PIN), locked-status filters and owner-only PIN creation, all against an admin-owned execution created in setup

**e2e**

- `tests/e2e/user-lock-management.spec.ts`

### other

**integration**

- `tests/integration/admin-definition-to-ui.test.ts`

**e2e**

- `tests/e2e/admin-monitoring-test.spec.ts`
- `tests/e2e/admin-panel.spec.ts`
- `tests/e2e/verify-step23.spec.ts` — cross-domain list-query pagination, filtering, and admin UI verification

### rate-limiting

**integration**

- `tests/integration/cors-rate-limit-middleware.test.ts` — CORS origin allowlist: allowlisted/localhost reflected, disallowed/no-origin; rate-limit IPv6 key fallback via ipKeyGenerator avoids ERR_ERL_KEY_GEN_IPV6

**unit**

- `tests/unit/web-backend/rate-limit-bypass.test.ts`

### security

**unit**

- `tests/unit/logging/e2e-request-redaction.test.ts` — E2E failure-capture formatter masks temporary credential and confirmation fields while preserving safe request diagnostics
- `tests/unit/services/encryption.test.ts`
- `tests/unit/shared/logging/sanitize-input.test.ts` — generic secret removal, communication content/filename suppression, masking and bounded diagnostic projection
- `tests/unit/shared/communication-attachment-grant-service.test.ts` — digest-only storage, owner binding, atomic claim/replay behavior, pre-delivery release, terminal completion, expiry and outstanding quota
- `tests/unit/mcp-server/communication-attachment-inflight.test.ts` — per-user concurrent-buffer and byte-budget refusal, user isolation and idempotent lease release

### settings

**unit**

- `tests/unit/services/global-settings-service.test.ts`
- `tests/unit/services/settings-repository.test.ts`

**integration**

- `tests/integration/database/global-settings-repository.test.ts` — typed global-setting persistence including extension channel trust approval across service reconstruction and revocation
- `tests/integration/mcp-settings-tools.test.ts`
- `tests/integration/telegram-user-settings.test.ts`

**api**

- `tests/api/admin-settings-api.test.ts` — protected definition/global-setting behavior plus authenticated admin-only, identity-bounded, persisted and audited extension channel trust approval/revocation
- `tests/api/global-settings-api.test.ts`
- `tests/api/settings-api.test.ts`

**mcp-tools**

- `tests/mcp-tools/user-settings.test.ts` — registered MCP settings list/get/set behavior, exact and category retrieval, encrypted masking, and rejection of empty or ambiguous selectors

**e2e**

- `tests/e2e/admin-settings.spec.ts`
- `tests/e2e/settings-page.spec.ts` — flat settings layout plus Telegram settings grouped under its metadata-driven communication card with masked secret and persisted enable control
- `tests/e2e/admin-prompt-editor.spec.ts` — admin prompt-editor master-detail interactions

### sharing

**unit**

- `tests/unit/shared/workflow-sharing-repository.test.ts`

**integration**

- `tests/integration/workflow-sharing-service.test.ts`

**api**

- `tests/api/workflow-sharing-api.test.ts`

**mcp-tools**

- `tests/mcp-tools/workflow-sharing.test.ts`

**e2e**

- `tests/e2e/workflow-sharing.spec.ts`

### slug-handle

**integration**

- `tests/integration/database/upload-pipeline-slug.test.ts`
- `tests/integration/mcp-slug-operations.test.ts` — MCP completion-marker/session equality for Todo's empty terminal result, parent linkage, and optional-output omission

**api**

- `tests/api/user-handle-api.test.ts`
- `tests/api/workflow-slug-api.test.ts`

### storage

**unit**

- `tests/unit/scripts/prompt-migration.test.ts` — including safe cleanup of removed managed agent overrides and preservation of manually edited values as conflicts

### telegram

**unit**

- `tests/unit/mcp-server/telegram-preflight.test.ts` — legacy Telegram and provider-neutral node detection; configured non-Telegram channel discovery; safe adapter-failure handling; canonical skip/deprecated-alias conflict semantics; directly usable Telegram Setup command; and optional ordinary versus mandatory trusted Telegram setup responses

**integration**

- `tests/integration/start-workflow-telegram-preflight.test.ts` — repository-backed generic preflight with a configured non-Telegram adapter, channel-neutral missing-configuration guidance, directly usable Telegram Setup command, canonical and deprecated skip inputs with contradiction rejection, legacy Telegram preflight, and mandatory lock-only/combined/malformed trusted-delivery preflight without execution creation

### template-engine

**integration**

- `tests/integration/advanced-templates.test.ts`
- `tests/integration/telegram-template-verification.test.ts`

### tokens

**integration**

- `tests/integration/workflow-file-tokens.test.ts` — including fixed five-minute materialize TTL, reusable same-node authorization, binding rejection, and repeated HTTP download until expiry or node transition, plus current-presentation grant resolution that ignores superseded grants, other users, and expired windows

**mcp-tools**

- `tests/mcp-tools/workflow-tokens.test.ts` — formatted upload/download MCP results, one-use HTTP lifecycle, force-new/update behavior, and deployment-aware cross-user ownership/admin-override authorization

### url-routing

**unit**

- `tests/unit/docs/docs-package-structure.test.ts` — packages/docs Starlight extraction: docs content at packages/docs (old landing-page location gone); EN/RU parity (same relative .mdx file set); every astro.config sidebar slug resolves to a real EN .mdx
- `tests/unit/shared/remote-url-resolver.test.ts`
- `tests/unit/shared/url-config.test.ts`
- `tests/unit/web-frontend/return-url.test.ts`
- `tests/unit/web-frontend/routes.test.ts`

### user-admin-resolution

**integration**

- `tests/integration/user-admin-resolution.test.ts` — getAdminUserIds: active admins only, excludes non-admins + blocked admins; service delegates to repo

### user-blocking

**integration**

- `tests/integration/user-blocking.test.ts`

**e2e**

- `tests/e2e/user-blocking-api.spec.ts`
- `tests/e2e/user-blocking.spec.ts`

### user-management

**api**

- `tests/api/user-profile-api.test.ts` — deployment-independent profile and password lifecycle; deployment-specific verification resend behavior is owned by the SaaS and self-host authentication API suites

**e2e**

- `tests/e2e/user-menu.spec.ts`
- `tests/e2e/user-profile.spec.ts`

### validation

**unit**

- `tests/unit/shared/slug-handle-validation.test.ts`
- `tests/unit/shared/workflow-validation-cache.test.ts`

**integration**

- `tests/integration/validation-loops.test.ts`

**api**

- `tests/api/workflow-validation-caching.test.ts`

### web-ui

**unit**

- `tests/unit/web-frontend/backend-health.test.ts` — a reconciliation-degraded backend remains operable/connected while a hard health error disconnects
- `tests/unit/web-frontend/admin-reconciliation-status.test.tsx` — self-host administrator dashboard makes no disabled analytics request and renders managed-workflow conflict identity, classification, all candidate references, WMF instruction, and clear state
- `tests/unit/web-frontend/quick-start-card.test.ts` — i18n completeness, config/deeplink generation, setupType consistency, + resolveMcpUrl deployment-mode gating: self-host runtime, self-host baked fallback, saas baked, null mode baked

**e2e**

- `tests/e2e/node-type-catalog.spec.ts` — anonymous catalog denial plus a real authenticated browser workflow whose custom catalog node renders its non-derivable title, exact type, extension owner/version and config-scoped schema, with screenshot evidence
- `tests/e2e/extension-settings.spec.ts` — authenticated generic settings page renders a distinctive extension communication descriptor, state/capability/trust metadata, schema-backed structured JSON and masked secret, and sends a body-free channel-neutral test request, with screenshot evidence
- `tests/e2e/dashboard.spec.ts`
- `tests/e2e/mobile-navigation.spec.ts`
- `tests/e2e/sidebar.spec.ts`
- `tests/e2e/theme-integration.spec.ts`
- `tests/e2e/theme-loading-state.spec.ts`
- `tests/e2e/verify-step24.spec.ts` — navigation, dashboard statistics, execution-card behavior, and beta-banner placement and dismissal
- `tests/e2e/visual-regression.spec.ts` — light/dark screenshots of the principal application pages

### workspace-connections

**unit**

- `tests/unit/shared/workspace-github-config.test.ts` — disabled-by-default, complete strong configuration, malformed client/key-version rejection, exact same-origin HTTPS callback, GitHub installation URL and dedicated vault-key validation
- `tests/unit/shared/workspace-credential-vault.test.ts` — versioned AES-GCM envelope, random nonce, plaintext absence and authenticated tenant/provider/connection binding
- `tests/unit/shared/logging/express-middleware.test.ts` — includes GitHub callback code/state and private workspace-transfer capability URL redaction
- `tests/unit/config/nginx-sensitive-logging.test.ts` — both runtime nginx modes omit the credential-bearing GitHub callback request from access logs and route private workspace downloads to MCP unbuffered without access/error path logging
- `tests/unit/config/workspace-github-deployment-config.test.ts` — complete distinct GitHub App/vault environment names in examples and operator-owned Compose references with no committed secret value
- `tests/unit/web-backend/workspace-connection-routes.test.ts` — browser redirect, secret-free successful/failed/early-status callback outcomes, generic sensitive-query suppression, explicit external-revocation confirmation and sanitized status projection at the HTTP boundary
- `tests/unit/web-backend/github-workspace-client.test.ts` — authorization-code and refresh exchanges for expiring user tokens, refresh-error secrecy, bounded same-origin pagination, lossless GitHub IDs and app-owned revocation request boundaries
- `tests/unit/shared/workspace-provider-registry.test.ts` — reviewed provider IDs, stable contract version, duplicate rejection and provider-neutral lookup
- `tests/unit/shared/workspace-resource-policy.test.ts` — disabled safe defaults, finite lifecycle/operation/transfer ceilings, unit conversion and fail-closed malformed or inconsistent resource and aggregate transfer limits
- `tests/unit/web-backend/github-codespaces-provider.test.ts` — exact REST methods/paths, explicit machine/marker/retention, machine and bounded same-origin Codespace pagination, immutable owner/billable/repository/machine parsing, unknown-state containment, background acceptance, sanitized definitive/unknown failures and exact absence
- `tests/unit/web-backend/github-codespaces-connector.test.ts` — Unix-socket credential delivery, bounded exec and typed file wire envelopes at the accepted raw input/output maxima, adversarial argv, exact exit, binary file results, explicit remote finalization, token-free options and secret-free generated SSH capability probe; connector-owned patch-summary budget projection plus complete discriminated file-result validation for paths, ranges, stat/version invariants, search coordinates/bounds, write versions, patch uniqueness/summary and bidirectional outer-state consistency
- `tests/unit/web-backend/github-codespaces-egress-proxy.test.ts` — reviewed GitHub/Codespaces host suffixes, literal-host denial and exact public/private/link-local/documentation address classification
- `tests/unit/web-backend/github-codespaces-remote-supervisor.test.ts` — direct Codespace-user argv/stdin execution, exact exit and separated output, repeatable terminal inspection, timeout/output bounds, PID fencing and verified cancellation; descriptor-anchored stat/search/range/write/patch, complete-envelope search truncation, catastrophic-regex termination, connector-supplied non-default patch-summary budgets with missing/below-minimum/above-ceiling refusal and content-free aggregate totals, binary bytes, link/special-file refusal, parent device/inode substitution fencing for absent and existing targets during commit/recovery, complete patch-staging cleanup, coherent journal recovery, complete-candidate exact-marker ownership, live contention and dead-owner recovery
- `tests/unit/shared/workspace-transfer-service.test.ts` — digest-only tenant/purpose capability storage, binary integrity, UTF-8/JSON and PDF/ZIP/gzip/tar/PNG/JPEG/GIF/WebP content admission, MIME/name/declared/observed-size validation, per-user/global object/aggregate/in-flight quotas before source I/O, expired-byte quota retention until physical cleanup, partial and post-rename/pre-ready crash cleanup, absolute-expiry cleanup, single use, current/separate live-process reservation preservation, dead-owner cleanup, and restart invalidation of missing, linked, changed-size or changed-digest ready objects
- `tests/unit/web-backend/workspace-native-reference-fetcher.test.ts` — narrow OpenAI issuer hosts, HTTPS-only form, public-only direct/redirect DNS answers, connected-peer pinning, private/mixed/rebound refusal and response metadata validation
- `tests/unit/mcp-server/workspace-transfer-route.test.ts` — private binary attachment response, no-store/noindex/nosniff/no-referrer headers, generic invalid-capability result and claim consumption after complete or interrupted delivery
- `tests/unit/shared/workspace-observability.test.ts` — one shared readiness decision (disabled/misconfigured/control_disabled/connector_unavailable/ready), the health-degradation rule for every state, no connector probe while disabled, bounded probe timeout with cached liveness snapshot reuse and one shared recomputation, identifier-free readiness projection, gauge values, closed-label connection/lifecycle/operation/rejection metrics and unknown-code rejection
- `tests/unit/web-backend/workspace-management-routes.test.ts` — website workspace list/create/get/start/stop/delete over the shared services: no-store headers, sanitized summaries, fail-closed not-configured with same-origin Settings link, create without lifecycle capability, malformed input rejection, confirmed generation-fenced delete, bounded status mapping without provider detail and metadata-only operation history
- `tests/unit/web-backend/admin-workspace-routes.test.ts` — administrator readiness with both kill switches, body validation before service contact, disable forwarding with administrator identity and trimmed reason in the readiness control shape, and fail-closed unconfigured or foreign-scope controls
- `tests/unit/mcp-server/manage-workspaces.test.ts` — opaque-ID-only pre-validation log context, secret-free workspace/operation projections against sentinel internal fields, private creation capability, stop/delete distinction with confirmed generation, exclusive text/native stdin dispatch without reference echo, resume by operation ID without re-dispatch, terminal exec/file failures as tool errors retaining operation identity, UTF-8 read/patch/upload/download projection without base64, native `resource_link` without raw URL, bounded setup/foreign-workspace/binary-read errors, and server-side reporting of unexpected failures behind the generic internal error

**integration**

- `tests/integration/workspace-connections-migration.test.ts` — migration 0024 clean install, representative existing-database preservation, transactional failure rollback and ciphertext-only credential/revocation storage
- `tests/integration/workspace-connection-service.test.ts` — expired/session/cross-tenant one-time state, foreign-installation rejection before repository enumeration, GitHub identity/install/repository binding, encrypted cross-tenant persistence, same-process and cross-service refresh single-flight, persisted pre-provider recovery authority plus successor disposition across staging/provider/CAS/disconnect failures, submitted-lease waiter recovery, ambiguous/expired/abandoned refresh failure, classic-OAuth rejection, combined exact pending revocation, active and pending-only unreadable recovery, restored-key exact disconnect, and installation-required behavior
- `tests/integration/workspace-connection-http-lifecycle.test.ts` — real authenticated route, connection service, vault and SQLite start/callback/status/disconnect lifecycle with only outbound GitHub transport substituted and callback/token secrecy observed
- `tests/integration/workspace-resources-migration.test.ts` — migration 0025 preserves Unit 1 connection data, creates secret-free lifecycle authority atomically and rolls back injected failure
- `tests/integration/workspace-resource-lifecycle.test.ts` — persistent create/list/get/start/stop/delete, pre-submission disconnect, submitted create/stop and start/stop races, explicit generation-fenced deletion, provider-absence convergence, same-account/grant reauthorization, tenant isolation, durable lifecycle intent/accounting, exact identity, response-loss reconciliation, legacy cleanup, resource limits and kill switches
- `tests/integration/workspace-operation-lifecycle.test.ts` — provider-neutral operation reservation, canonical workspace projection, argv/stdin/result non-persistence, daily/concurrent limits, cross-tenant and desired-state fencing, pre-dispatch credential failure, crash-abandoned reservation expiry without connector contact, durable dispatch intent and post-crash exact-marker recovery after claim expiry, unknown remote outcomes, background-observed result retrieval before bounded cleanup, cancellation/generation races and retryable remote finalization; one-call structured native-reference fetch/store/exact-binary dispatch, tenant-bound internal reference stdin, size/MIME/unavailable rejection, and foreign/missing/stopped/disabled/busy workspace rejection before source fetch, credentials or provider contact, plus claim release and consumption after durable dispatch
- `tests/integration/workspace-persistent-operations-migration.test.ts` — authorization/lifecycle migration of accepted resources to explicit legacy retention, metadata-only operation schema and atomic rollback on an injected migration failure
- `tests/integration/workspace-file-lifecycle.test.ts` — tenant/generation-fenced durable file-operation admission, invalid/cross-tenant stat rejection, serialized metadata-only write persistence, response-loss recovery through a fresh service, native upload authority rejection before source fetch, post-ingest generation/expiry/begin-dispatch/credential cancellation cleanup, complete-envelope bounded search completion, content-free failure completion independent of payload budget, and native upload/download consumption with outbound maximum-capacity reservation and per-user/global object, aggregate-byte and in-flight rejection before credentials or provider transport
- `tests/integration/workspace-transfers-migration.test.ts` — additive private-transfer authority/accounting schema, absence of bytes/source URLs and atomic rollback on injected migration failure
- `tests/integration/workspace-controls.test.ts` — real SQLite global kill switch: refused create before provider contact, persistent workspace stop through reconciliation without deletion, control audit, readiness transitions including backlog age, foreign-scope rejection and connector-loss readiness
- `tests/integration/workspace-mcp-client-flow.test.ts` — ChatGPT-compatible MCP client over the real registry, request context, connection/vault, SQLite, resource/operation/file/transfer services, production connector framing and remote supervisor: actual file write/stat/read/search/patch, executed passing/failing commands with exact exits, Git diff, native upload, exact native-stdin digest, text stdin, consumed download bytes, workspace reuse after reopened SQLite and a fresh client, stop preserving files, generation-fenced delete; lost write/exec/download recovery by operation ID with one remote dispatch, foreign-user refusal and content/credential-free operation rows

**mcp-tools**

- `tests/mcp-tools/workspace-tools.test.ts` — published fourteen-tool catalog, instance readiness in `workspace_list` matching MCP `/health` with top-level native file parameters and resume schemas, safe default-disabled readiness with same-origin Settings link, private download routing and exact single-use byte delivery with protective headers through the public origin, website-only setup errors over HTTP, and boundary rejection of mixed stdin or agent-supplied auth/chat/session fields

**api**

- `tests/api/workspace-connections-api.test.ts` — authenticated default-disabled status plus fail-closed start/disconnect without credential metadata or provider contact
- `tests/api/workspace-management-api.test.ts` — default-disabled website workspace list, fail-closed create, unauthenticated refusal, the same readiness through `/api/health` and admin system status, workspace gauges on the internal metrics endpoint, and administrator-only fail-closed kill switches

**e2e**

- `tests/e2e/workspace-management.spec.ts` — Settings workspace management with intercepted routes: readiness badge, agent-authority disclosure without chat/session wording, personal-billing context, busy state without actions, create, stop keeping data, confirmed generation-bound delete, disabled and administrator-stopped explanations in EN/RU, administrator stop/resume with confirmation, and inspected desktop/narrow screenshots
- `tests/e2e/workspace-github-settings.spec.ts` — website-only connect navigation, callback outcome, connected repositories, disconnect confirmation, unreadable-credential and untracked-refresh full-grant recovery, safe actionable EN/RU states and inspected desktop/narrow screenshots

### workflow-engine

**unit**

- `tests/unit/config/nginx-sensitive-logging.test.ts` — both shipped nginx modes suppress path grants from access logs and route bounded authenticated communication uploads to MCP without JSON MIME rewriting
- `tests/unit/shared/logging/express-middleware.test.ts` — materialize grant redaction with routing/query preservation and unrelated-URL non-regression
- `tests/unit/web-backend/execution-materialize.test.ts` — current-definition fetch, execution binding, repeated concurrent tar responses, late authorization, render-overflow handling, and expected-4xx versus unexpected-boundary error mapping
- `tests/unit/mcp-server/deliver-materialize.test.ts` — context delivery of rendered bodies for the caller's current presentation, fallback-specific counting that leaves the archive series untouched, refusal without partial data for a missing grant or an oversized set, and a single indistinguishable refusal message across conditions
- `tests/unit/workflow-engine/materialize-context-delivery.test.ts` — byte-identical delivery between the archive channel and the in-context fallback for one grant, the resolver's expired-grant, node-transition, foreign-owner, stale-context-revision and lost-authorization refusals, aggregate context-budget refusal without truncation, and verbatim per-file block presentation; its `workflow_node_unavailable` refusal is not yet exercised
- `tests/unit/logging/compute-changes.test.ts`
- `tests/unit/shared/workflow-query-service.test.ts` — incl. setWorkflowVariable preserves rich schema
- `tests/unit/shared/workflow-catalog.test.ts` — catalog identity/ownership metadata is excluded from the executable graph; readWorkflowCatalogs multi-dir merge: union, later-dir-wins precedence on (owner,slug) collision, per-owner duplicate slugs preserved, missing/empty dirs skipped, single-dir == readWorkflowCatalog; getWorkflowsDirs config: default, WORKFLOWS_DIR fallback, colon-separated WORKFLOWS_DIRS, empty-segment drop
- `tests/unit/shared/managed-resource-reconciler.test.ts` — closed three-way classification for first install/adoption, unchanged, user-only, upstream-only, converged, conflict, soft/hard deletion, removal, and tombstone reintroduction
- `tests/unit/shared/workflow-reconciliation-bundle.test.ts` — path-safe atomic local candidate publication including interrupted final publication cleanup, same-handle no-follow digest-bound conflict reconstruction, database-free multi-conflict choice accumulation, merged-file binding, stale-choice preservation, exclusive locking, every branch-specific instruction family, pending/candidate symlink plus oversized/tampered-file rejection, durable applied markers, idempotent pending/retired post-commit states, and startup cleanup of exact retired UUID directories with live-pending preservation plus unsafe/partial-failure rejection
- `tests/unit/web-frontend/workflow-transformer.test.ts` — materialize transformed with content-free file summary data, success/error edge styling and no fallback warning; note nodes; fallback nodes
- `tests/unit/workflow-engine/variable-resolver.test.ts`
- `tests/unit/workflow-engine/workflow-schema-keywords.test.ts` — ordered unique-reference plans, deep evidence-prefix correlation, protected plan prefixes, non-mutating blocked responses, global-input inlining, and GraphValidator keyword registration
- `tests/unit/workflow-engine/execution-parent-revision.test.ts` — workflow-step revision rejects stale full saves and previous-generation context writes; an independent parent revision rejects stale same-generation parent snapshots; valid same-owner attach, replace, detach and idempotent repetition leave the step generation unchanged; database integration additionally proves concurrent inverse changes cannot commit a cycle
- `tests/unit/workflow-engine/execution-reminders.test.ts` — standalone/child completion-only reminder delivery without consuming step revision, independent collection-revision conflicts, literal template-like text, no intermediate leakage, idempotent add, targeted update/cancel and sibling preservation
- `tests/unit/workflow-engine/execution-progress.test.ts` — static progress schema/semantic validation plus the route-based run projection rules listed above
- `tests/unit/workflow-engine/sdf-execution-progress.test.ts` — real bundled fifteen-block SDF projected from shortest authored routes: active block, label, revision and version per waiting node, only route-visited blocks done, a teleported replan with its teleport exit, completion with nothing unvisited done, and a route-less execution reporting only its current block
- `tests/unit/workflow-engine/execution-progress-image.test.ts` — shared horizontal visual model carrying block statuses, forward/backward geometry, deterministic light/dark PNG bytes, state differences, bounds and image decoding; the export views: block/node id resolution, a hidden block removed with its transitions collapsed onto where it led (display chain and process transitions, labels joined), the process view drawing labelled transitions and a dashed loop with its cause while the cards view draws none, a collapsed block as a label-only chip, overlapping returns on nested lanes with hub transitions written inside their source, and the process view byte-deterministic and distinct from the cards view; a collapsed chip as a pill of its own height and a self-return drawn as a visible bracket
- `tests/unit/workflow-engine/execution-progress-geometry.test.ts` — label and badge boxes of the progress image never overlap on the six flows at two widths; metric and width wrapping
- `tests/unit/workflow-engine/execution-progress-wrapper.test.ts` — public workflow/execution image API metadata and byte parity, null no-progress behavior, render failure propagation, and input immutability
- `tests/unit/workflow-engine/progress-image-service.test.ts` — normalized step-revision/context-revision/version/options-bound grants (view, hide and collapse resolved to block ids and stored; an unknown id refused before any token exists), successful single use, render-failure non-consumption and stale-state denial
- `tests/unit/workflow-engine/telegram-client-photo.test.ts` — reusable MIME-aware Telegram multipart photo/document transport with exact bytes, caption/options, empty/oversized photo pre-allocation rejection, and token/destination/content log redaction
- `tests/unit/workflow-engine/user-communication.test.ts` — mutable shared channel registry, least-authority configuration/payload boundary, mixed Telegram/second-channel fan-out, channel-scoped test delivery through shared limits, sanitized aggregate outcomes, skipped-capability routing, absent-user isolation, portable progress attachments, workflow/direct shared provider budgets with independent providers, concurrent bounded availability, bounded-key rate/concurrency budgets, deadlines, quotas, and long attachment text
- `tests/unit/web-backend/notifications-route.test.ts` — metadata and same-user readiness projection without secret values, extension trusted-state visibility, body-free selected-channel testing through the common service, browser authority refusal and unknown-channel denial
- `tests/unit/web-backend/workflow-process.test.ts` — `GET /api/workflows/:id/process` response: the same derivation the CLI prints, diagnostics carried for a contract-violating flow, and a null process without `progress`
- `tests/unit/web-backend/execution-progress-image.test.ts` — progress image reservation completion on response finish and release on close/write failure
- `tests/unit/web-frontend/run-route-model.test.ts` — run page view helpers over the projection (blocks, stretches, counts, cursor, arcs, steps)
- `tests/unit/web-frontend/run-answer-form.test.tsx` — typed answer parsing and empty-field omission of the run page's answer form
- `tests/unit/web-frontend/run-layout.test.ts` — deterministic non-overlapping ELK canvas layout of every annotated bundled flow
- `tests/unit/web-frontend/run-lanes-links.test.ts` — lanes forward connectors over the annotated flows
- `tests/unit/web-frontend/run-lanes-phone.test.tsx` — phone stepper forward and return chips
- `tests/unit/web-frontend/run-transition-chips.test.ts` — shared chip model: chip keys equal the canvas and rail connector keys; hub bundles; titles
- `tests/unit/web-frontend/step-card-model.test.tsx` — step connections classified per block (internal sibling / owning block) on Quick Task and SDF; the panel tab badge (count, warning, nothing)
- `tests/unit/web-frontend/graph-model.test.ts` — the technical graph's model equals the process-view step model: steps, owners, connections, return links (derived cycle edges or into an earlier block), flat without a process
- `tests/unit/web-frontend/graph-routing.test.ts` — the technical graph's edge routing: straight forward links, in-block returns in the block's corridor, cross-block links in the gap, returns to earlier blocks along the margin, distinct lanes, transposed rows; on every bundled flow in both directions no lane crosses a card or leaves the canvas, lanes keep clear of cards and block borders, and arrivals at one card take their own approach columns
- `tests/unit/web-frontend/variable-rows.test.ts` — the variables panel's grouping model: declared rows, cursor values, per-node outputs without promoted globals, no history without a projection
- `tests/unit/web-frontend/run-lanes-layout.test.ts` — horizontal lanes rail layout and viewport height
- `tests/unit/web-frontend/diagram-viewport.test.ts` — shared diagram gesture policy and zoom ranges
- `tests/unit/web-frontend/diagram-placement.test.tsx` — shared opening placement hook
- `tests/unit/web-frontend/use-resource.test.tsx` — last-good data store (pending, error, stale response, key change)
- `tests/unit/web-frontend/workflow-detail-hook.test.tsx` — detail hook: refetch keeps the workflow current and pending; a new id is a first load
- `tests/api/execution-parent-api.test.ts` — authenticated HTTP parent attach, idempotent repetition, replacement, detach, detail projection, unchanged step revision, and stale parent-target conflict against executions created through the public MCP start surface
- `tests/api/execution-reminders-api.test.ts` — authenticated HTTP reminder add/idempotent retry/filter/update/cancel with unchanged step revision and collection-revision continuity against an execution created through public MCP start
- `tests/mcp-tools/execution-answer.test.ts` — answering a waiting step from the run page on a real Quick Task run: refusals for a non-owner, a stale revision, a malformed body and schema-invalid input with the run untouched; the owner's accepted answer continuing the route and recorded as an adjustment visit by the user; the agent's outstanding attempt rejected as stale and recovered through `session current_step`; the route cursor on `session progress` and the HTTP projection with an invalid cursor refused; an administrator answering another user's run; and a completed run refusing
- `tests/mcp-tools/execution-variables.test.ts` — MCP/HTTP runtime ownership, filters (including false/current/other branches), unknown versus unset, effective editability/denial reasons, schema-valid top-level and inspector-path mutation with unchanged step revision and stale context-token rejection, unchanged sibling/node state on path rejection, audit redaction, definition discovery and HTTP policy authoring/invalid-policy reporting; progress create/edit preservation, strict rejection without mutation of forbidden progress/node/connection fields, transport identity of the run projection (recorded route through start and step, adjustment visits by the agent and the web user, adjusted variable history), owner/administrator/foreign access, and absent-definition errors
- `tests/unit/workflow-engine/registry-converter.test.ts`
- `tests/unit/workflow-engine/node-output-scope.test.ts` — incl. whole-descriptor inlining: enum/items/pattern/properties + end-to-end rejection
- `tests/unit/workflow-engine/strict-schema-validation.test.ts` — recursive strict JSON Schema normalization
- `tests/unit/workflow-engine/telegram-inline-keyboard.test.ts` — Telegram inline-keyboard schema and rendering contracts
- `tests/unit/workflow-engine/template-injection-and-validation.test.ts` — template-injection protection, runtime placeholder validation, and structured StartNode initialData recognition for registry writer analysis

**integration**

- `tests/integration/workflow-file-tokens.test.ts` — upload/download lifecycle, five-minute materialize TTL boundary, reusable materialize HTTP authorization with user/execution/node/context binding and transition rejection, real SQLite grant-failure normalization, and step-revision/context-revision/version-bound progress-image grants with atomic one-use claims
- `tests/integration/agent-response-contract.test.ts`
- `tests/integration/workflow-catalog-loader.test.ts` — the definition revision advanced by a bundled update and kept by an unchanged re-run; owner/visibility mapping and three-way visibility changes, baseline adoption/divergence, distinct previous/current/incoming candidate content and canonical digests, upstream/user/two-sided changes, semver regression and same-version divergent content, catalog-wide preflight, user soft/hard deletion, upstream removal/tombstone/reintroduction and lifecycle resolution, conflict recovery across declared previous-slug migration for every selection route, required inspected revisions, durable resolution context, cross-snapshot staged portability that recomputes the actual incoming catalog on a fresh target while applying safe additions/updates and preserving unrelated target data, runtime validation of serialized staged artifacts, source/catalog/conflict-set/revision fail-closed behavior, local image CLI status/diff/get/validate/choose/apply with invalid merged-file rejection, catalog/target drift retention without partial mutation, no database mutation before complete apply, and committed-state bundle retirement semantics, lightweight summaries that do not parse malformed candidate bodies, multi-directory overlays, real SQLite rollback on a later apply failure, stale workflow/conflict/baseline guards across graph/visibility/lifecycle/alias changes, competing resolutions, real catalog evidence replacement, baseline creation/update/rename races, malformed baseline failure, explicit recovery, structured MCP response, administrator resolution, and SaaS CLI failure on a copied database without source mutation
- `tests/integration/mcp-reconciliation-notice.test.ts` — real in-memory MCP initialization and ordinary registered tool call both expose the graph-free managed-workflow reconciliation notice
- `tests/integration/database/workflow-privacy-defaults.test.ts`
- `tests/integration/manage-workflow-actions.test.ts`
- `tests/integration/manage-workflow-new-actions.test.ts`
- `tests/integration/step-on-completed-workflow.test.ts`
- `tests/integration/subgraph-agent-transparency.test.ts`
- `tests/integration/subgraph-nested-levels.test.ts` — three-level execution plus Todo's exact empty terminal result at root/one/nested levels with persisted reload
- `tests/integration/subgraph-performance.test.ts`
- `tests/integration/subgraph-sequential.test.ts`
- `tests/integration/workflow-mutation-service.test.ts`
- `tests/integration/workflow-revision.test.ts` — the workflow definition revision: migration `0026_workflow_revision` gives existing rows 0 (rolled back and re-applied on a file database); the shared repository save starts a new workflow at 0, advances on every graph update and not on a visibility write, and the revision is read by `getFullInfo` and `list`
- `tests/integration/workflow-outputs.test.ts`
- `tests/integration/workflow-pagination.test.ts`
- `tests/integration/teleport-execution.test.ts` — teleport execution, validation, context preservation, and response hints

**docker**

- `tests/docker/self-host-reconciliation-lifecycle.sh` — isolated public-policy image lifecycle from a healthy baseline through a plain `docker compose up -d` restored/stopped conflict under `on-failure:3`, byte-identical database recovery, local Compose CLI decision/apply, the exact plain second start reaching healthy services without a pending bundle or restart loop, and a hard invalid-catalog attempt retaining an older valid bundle while emitting only rollback guidance

**workflow**

- `tests/workflow/engine/agent-directive-validation.test.ts`
- `tests/workflow/engine/catalog-validation.test.ts` — pinned End migration inventory, root and nested terminal projections, workspace_path guard, numeric counter-pinning, and subgraph error routes
- `tests/workflow/engine/agent-message-queue.test.ts`
- `tests/workflow/engine/context-mapper.test.ts`
- `tests/workflow/engine/cycle-detector.test.ts`
- `tests/workflow/engine/error-formatting.test.ts`
- `tests/workflow/engine/expression-handler.test.ts` — ordered scalar/member/fingerprint projection, undeclared-target rejection, atomic registry-default reset/rollback, JSON-assignment metadata, content-free error-edge routing and error context
- `tests/workflow/engine/expression-parser.test.ts` — safe numeric/dynamic array reads, closed reset parsing, bounds, prototype rejection, bare-only assignment targets
- `tests/workflow/engine/max-nodes-validation.test.ts`
- `tests/workflow/engine/node-handlers.test.ts` — including strict empty/nested/missing End projection, runtime-input rejection, and engine-owned system context-path resolution
- `tests/workflow/engine/node-type-validation.test.ts`
- `tests/workflow/engine/materialize-node.test.ts` — materialize schema/source-default contract, handler directive summary including the conditional non-preferred context fallback offered after the primary command and success criteria that accept delivery by either route, expected/unexpected preparation failures, isolated re-presentation that cannot traverse an error connection, shell encoding, current-registry rendering, tar output, path safety, collision detection, and exact resource boundaries
- `tests/workflow/engine/execution-route.test.ts` — bundled flows driven through the stateful executor and their recorded route: Quick Task to the third of five units after a plan repair (exact visit sequence, changes, revision growth, repeated review, waiting execution, loop markers, variable history, PNG from the same projection), an autonomous run skipping plan approval, an SDF run aborted at the health check with nothing later done, a completed Todo List run with a teleport exit, and a route-less execution inferring nothing; a wait answered from outside the flow (rejected input changing nothing, an accepted answer continuing the route with an adjustment visit carrying the actor and the values it wrote, the variable history and block statuses reflecting it)
- `tests/workflow/engine/note-handlers.test.ts`
- `tests/workflow/engine/note-node-validation.test.ts`
- `tests/workflow/engine/path-resolver.test.ts`
- `tests/workflow/engine/registry-default-seeding.test.ts`
- `tests/workflow/engine/registry-schema-model.test.ts` — registry entry = full JSON Schema
- `tests/workflow/engine/registry-schema-validation.test.ts` — registry entry compiled as JSON Schema; malformed → blocking
- `tests/workflow/engine/schema-validator-agent-format.test.ts` — including exact context-derived artifact paths that resolve the engine-owned execution identity and reject a schema-valid foreign workspace
- `tests/workflow/engine/subgraph-delegation.test.ts`
- `tests/workflow/engine/subgraph-handler-simple.test.ts` — including discriminated child-failure provenance
- `tests/workflow/engine/subgraph-handler.test.ts` — subgraph delegation, mappings and missing-workflow errors; delegation at `_subgraphDepth` 100 still pauses (MAX_DEPTH is logged, not enforced)
- `tests/workflow/engine/subgraph-validation.test.ts`
- `tests/workflow/engine/system-reminder-priority.test.ts`
- `tests/workflow/engine/telegram-services.test.ts`
- `tests/workflow/engine/template-processor.test.ts`
- `tests/workflow/engine/template-validation.test.ts`
- `tests/workflow/engine/unified-validation.test.ts` — includes teleport reachability: a node reachable only through a teleport is not reported, a genuinely orphaned node still is
- `tests/workflow/engine/validation-error-messages.test.ts`

**api**

- `tests/api/workflow-copy.test.ts`
- `tests/api/workflow-list-performance.test.ts`
- `tests/api/workflow-visibility-patch.test.ts`
- `tests/api/workflow-update.test.ts` — `PUT /api/workflows/:id`: the GET carries `fileInfo.revision`, a matching `expectedRevision` saves, advances the revision, keeps the visibility and returns the new revision with the derived process; a create with `overwrite` advances it like any graph write (the pre-overwrite revision is then refused); a stale revision is refused with 409 and `currentRevision`, an invalid graph and a missing `expectedRevision` with 400, none touching the stored definition
- `tests/api/workflows-privacy.test.ts`

**mcp-tools**

- `tests/mcp-tools/materialize-fallback.test.ts` — live authenticated MCP delivery of materialize file bodies into the tool response while the node is presented, refusal after the execution advances, and the published `materialize` session action; cross-user scoping is asserted at the unit and integration levels instead of a third time here
- `tests/mcp-tools/progress-image-views.test.ts` — the export parameters on a real SDF run through MCP and HTTP: cards, process and hidden-block tokens rendering three distinct decodable PNGs (the hidden-block image shorter), node ids stored as their blocks, unknown ids and an invalid view refused at mint, a second use of a token refused, a token minted before the intake step is answered refused after it while a fresh one renders
- `tests/mcp-tools/workflow-crud.test.ts`
- `tests/mcp-tools/workflow-revision.test.ts` — the definition revision across the agent and page paths: `manage get` and `edit` carry it, `edit` with a stale `expectedRevision` is refused naming the stored revision and without one still saves, a token file upload over the workflow and `set-variable` advance it so a page save carrying the pre-mutation revision is refused with 409, a stranger's save is refused (404 while private, 403 once public) and `set-visibility` leaves the revision alone
- `tests/mcp-tools/workflow-documentation.test.ts` — live authenticated MCP-owned help catalog with canonical special-`tools` discoverability, presentation-model-derived client/quickstart/agent-instruction content, configured endpoint and authentication guidance, ordinary topic semantics, Markdown shape, unknown-topic guidance, and direct typed tools detail
- `tests/mcp-tools/workflow-ownership.test.ts`
- `tests/mcp-tools/workflow-pagination.test.ts`
- `tests/mcp-tools/workflow-search.test.ts` — public workflow search and page metadata plus state-based registered MCP calls for list-nodes, get-nodes, analyze-variables, and set-visibility

**e2e**

- `tests/e2e/flow-page.spec.ts` — the flow page replacing the workflow detail page (see the execution domain row for the full scope); the kept workflow-page specs below exercise its graph mode and owner actions unchanged; returns readable on demand: no arc or cycle label at rest, hovering a return chip lights one connector with its label, a `block` deep link keeps the selected block's connectors lit
- `tests/e2e/workflow-canvas-controls.spec.ts` — the technical graph's layout buttons (fit view, vertical, horizontal) sit inside the React Flow zoom cluster in one column
- `tests/e2e/diagram-gestures.spec.ts` — flow page canvas, lanes and graph modes open fitted; a plain wheel over the diagram pans it (translation changes, scale unchanged), a ctrl-wheel zooms it (scale changes), and a wheel over the side panel leaves the diagram transform untouched; the opening fit keeps a readable scale (canvas at least three quarters, the rail at full size) with the first block's card inside the diagram
- `tests/e2e/navigation-flicker.spec.ts` — navigation never blanks the page: a lazy section chunk loads behind an in-layout skeleton with the sidebar kept; the run page keeps its projection and toolbar through a held progress refetch, a mode switch and a cursor move with the first-load banner never returning; the flow page keeps its modes strip and diagram through the detail and process refetches after a save, showing a slim pending indicator and never the page loader; a progress refetch answered 500 keeps the run page projection without the unavailable banner, a detail refetch answered 500 keeps the flow page content beside an error toast, the Locks tab keeps its list through a held refetch on reopening, and an execution refresh answered 500 keeps the run page beside an error toast
- `tests/e2e/step-cards.spec.ts` — step cards on one grid: on the flow page's split view of the densest SDF block and on the run page's block panel the type badges share one box and one left edge, titles share one left edge and start on the badge's line, a card with transition chips keeps its title edge and external chips are present; the run page's current step is marked; the Steps tab lists the definition on the same cards with the start node first, done marks from the route and one current step; the panel tab strip has no horizontal overflow at 1440 and 400 px and every tab carries a hint; the status chip carries no pass count
- `tests/e2e/graph-mode.spec.ts` — the technical graph as the process view's detailed layer: on Quick Task's graph mode every workflow node is a step card, one group per block in process order top to bottom, every derived cycle edge named in both cards (a connection chip in its source, an arrival chip in its target) and not drawn at rest, appearing dashed with its label when either chip is hovered (after the fit control gives the overview back, the definition having opened on its first block), a click on the arrival chip taking the view to the far card (a zoom the overview does not have, that card centred), labels kept on the straight forward edges, Horizontal/Vertical/Fit View and the sidebar working, the definition opening at a zoom of at least 0.7 with the first group's header inside the graph's box, group nodes stacked below edges and edges not above cards; on the Software Development Flow's 130 cards no two card boxes intersect after the measured layout pass; on a run's Graph tab the groups carry the run's block status and the current step is marked
- `tests/e2e/workflow-card-compact.spec.ts`
- `tests/e2e/workflow-copy-button.spec.ts`
- `tests/e2e/workflow-delete-restore.spec.ts`
- `tests/e2e/workflow-list-performance.spec.ts`
- `tests/e2e/workflow-visibility-toggle.spec.ts`
- `tests/e2e/workflow-visibility.spec.ts`

### workflow-scenarios

**workflow**

- `tests/workflow/scenarios/architecture-design-flow.test.ts` — new/existing architecture execution; source and delivery authority; completion-before deterministic and independent semantic gates; cause-owned repair cones; corrected-contract review, process revision, interactive completion rework, complete/limited/blocked/abort/materialization outcomes, and authorized project delivery
- `tests/workflow/scenarios/artifacts-demo-dashboard-builder.test.ts`
- `tests/workflow/scenarios/artifacts-demo-report-publisher.test.ts`
- `tests/workflow/scenarios/conditional-branching.test.ts`
- `tests/workflow/scenarios/content-creation.test.ts` — durable text delivery; immutable brief and cumulative correction; evidence/content/brief repair routes; complete, limited, blocked, materialize-error, interactive rework and process revision; originating target-bound publication and provider-neutral configured-channel outcomes
- `tests/workflow/scenarios/coverage.test.ts`
- `tests/workflow/scenarios/data-analysis.test.ts` — immutable source authority separated from typed acquisition evidence; rejection of invented availability, incomplete source projection, and hidden canonical mutation; autonomous and interactive runs; inline and filesystem delivery; reviewed limited results; readiness and final repair routes; guarded process revision; complete ordinary node and branch coverage
- `tests/workflow/scenarios/development-workflow.test.ts` — content-rich execution progress across active work, repair and terminal states; provider-neutral progress-image notifications; current-plan binding; development-only planning with caller-owned follow-ups; current-plan visual/approval policy; autonomous and interactive routes; reused screenshot evidence; unit-owned permanent documentation; distinct normal/stopped terminals; repository-grounded preparation; cause-aware repair/replan; artifact failure; VCS authority; and complete executable node/branch coverage
- `tests/workflow/scenarios/execution-retrospective.test.ts` — archive materialization behavior, sufficient/partial/unavailable semantic fixtures, independent analysis/final review oracles, proposal-only authority, and contained/spreading repair routes
- `tests/workflow/scenarios/directive-validation.test.ts`
- `tests/workflow/scenarios/lock-node.test.ts`
- `tests/workflow/scenarios/marketing-campaign.test.ts` — immutable source authority; complete/limited, pre/post-workspace blocked, materialize-error, interactive rework and guarded process revision outcomes; deterministic versus semantic gates and source-specific strategy/evidence/package repair routes
- `tests/workflow/scenarios/notes-demo-metrics-collector.test.ts`
- `tests/workflow/scenarios/notes-demo-metrics-reporter.test.ts`
- `tests/workflow/scenarios/prd-creation.test.ts` — producer input rejection, independent review, repair/re-review, terminal outcomes, and executable route coverage
- `tests/workflow/scenarios/quick-task.test.ts` — autonomous plan-gate bypass; clean execution, plan repair/revision, cursor-preserving resumption, result repair/rework, and complete executable node/branch coverage
- `tests/workflow/scenarios/deep-corpus-research.test.ts` — explicit cost consent, delegated adaptive planning, source-specific plan/package/evidence repair routing, and complete, limited, corpus-repair, interactive-rework and guarded process-revision paths
- `tests/workflow/scenarios/robust-task.test.ts` — durable recovery, cause-aware plan/step/final routing, truthful incomplete delivery, autonomous plan-gate bypass, and complete executable node and branch coverage
- `tests/workflow/scenarios/smart-purchase-assistant.test.ts` — execution-correlated decision/evidence package; independent semantic review with evidence/report repair and corrected-contract reassessment; filesystem/materialize blockers; interactive rework and abort; separately authorized artifact publication and provider-neutral delivered/not-sent/error outcomes; complete executable node and branch coverage
- `tests/workflow/scenarios/startup-idea-validation.test.ts` — free-form typed intake; traceable/limited evidence; package/evidence repair and corrected-contract review; earliest-owner rework; separately authorized publication/notification; truthful complete, blocked and aborted outcomes; guarded process revision; complete executable node/branch coverage
- `tests/workflow/scenarios/telegram-setup.test.ts` — secret-safe current-user setup execution; sent/error/not-sent/receipt distinctions; cause-specific changed-evidence retry/reconfigure/incomplete routes; blocked/skipped/success outcomes; complete node and branch coverage
- `tests/workflow/scenarios/test-generation.test.ts` — executable test-code routing; test/evidence repair; production-change SDF handoff; proof-only evidence rejection; cumulative contract correction; materialization failure, interactive rework/process revision, and separate commit/push authority
- `tests/workflow/scenarios/test-planning.test.ts` — producer input rejection, zero-finding delivery, mismatch repair with re-review, complete node and branch coverage, and no test-execution authority
- `tests/workflow/scenarios/test-suite-audit.test.ts` — execution-bound materialization, correction-input rejection, scope/taxonomy correction routes, targeted checks, independent review/repair, and complete executable route coverage
- `tests/workflow/scenarios/todo-list.test.ts` — runtime checklist progress for ordinary and empty-tail completion; planning and supplied-task intake; one-based execution; evidence validation; jump-only checklist revision with atomic progress replacement, engine-derived cursor, completed-prefix preservation, and complete executable route coverage
- `tests/workflow/scenarios/user-onboarding.test.ts` — create-own input rejection; existing, authoring, start, defer and invalid-selection execution routes; optional notification bypass versus mandatory trusted delivery; setup-without-process incomplete handling; complete ordinary node and branch coverage
- `tests/workflow/scenarios/ux-design.test.ts` — foreign artifact-path rejection and accepted, limited, blocked, aborted, repair, feedback, and process-revision execution outcomes
- `tests/workflow/scenarios/verified-research.test.ts` — autonomous clarification; deterministic versus independent semantic judgment; answer/evidence repair; corrected-contract findings; complete, limited, blocked, aborted, materialize-error, interactive rework, and guarded process-revision routes; complete ordinary node and branch coverage; bounded repair-round budget with procedural limited outcome; memory-mode operation with findings handed through context; pre-acquisition source-authority gate; completion notification with observable delivery outcome
- `tests/workflow/scenarios/workflow-management-flow.test.ts` — create, edit, audit, publication, error, local-sync, autonomous, repair/replan, reassessment, and process-revision execution routes with complete node and branch coverage
- `tests/workflow/scenarios/workflow-presentation-generator.test.ts` — source/content/HTML/validation/completion repair and corrected-contract execution routes; complete/limited/blocked/abort/materialization outcomes and local-only authority

## Agent Instructions

### When Adding Tests

1. Identify the domain for the functionality being tested
2. Check which levels already have coverage for that domain
3. Add tests at the appropriate level (see TESTING-GUIDE.md)
4. Add the new test file entry under the correct domain and level

### When Deleting Tests

1. Remove the entry from this file
2. Remove an empty level or domain heading if the deleted entry was its last item

### When Moving Tests

1. Remove entry from old location
2. Add entry to new location
3. Remove an empty level or domain heading left by the move
