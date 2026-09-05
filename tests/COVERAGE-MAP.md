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
- `tests/e2e/admin-execution-errors.spec.ts`
- `tests/e2e/execution-progress-ui.spec.ts` — real execution inspector desktop/mobile progress states, repair arc, long labels, technical-node focus, tab preservation and no-progress compatibility with inspected screenshots
- `tests/e2e/sdf-progress-ui.spec.ts` — actual bundled SDF 15.2 projection rendered through the shared model as desktop/mobile UI and matching PNG evidence for plan, implementation, tests, review, and completion states
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

**integration**

- `tests/integration/artifact-abuse.test.ts` — report/takedown/getPublic suppression + audit

**api**

- `tests/api/artifacts-api.test.ts` — CRUD + abuse controls (report, takedown, frame CSP)

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

- `tests/unit/mcp-server/messages.test.ts`
- `tests/unit/workflow-engine/telegram-error-messages.test.ts`

**integration**

- `tests/integration/agent-message-enhancement.test.ts`

### context

**unit**

- `tests/unit/logging/context.test.ts`
- `tests/unit/mcp-server/prompt-context.test.ts`
- `tests/unit/shared/logging/service-context-propagation.test.ts`
- `tests/unit/shared/logging/service-logger-error-context.test.ts`
- `tests/unit/web-frontend/context-variable-model.test.ts`

**integration**

- `tests/integration/execution-context-tools.test.ts`
- `tests/integration/execution-context-per-key-update.test.ts`
- `tests/integration/subgraph-context-mapping.test.ts`

**mcp-tools**

- `tests/mcp-tools/execution-context.test.ts`

**e2e**

- `tests/e2e/context-variable-editor.spec.ts`

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

- `tests/integration/error-logging-flow.test.ts` — durable validation/system-error history, idempotent cancellation, and the distinct persisted progress projections of real cancellation versus normal graph completion
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

- `tests/unit/shared/execution-repository-errors.test.ts` — including terminal-result persistence, owner-identity validation, legacy null rows, and fail-closed empty/falsy payload handling
- `tests/unit/shared/execution-status-mapping.test.ts` — legacy execution-status normalization

**integration**

- `tests/integration/execution-filters.test.ts`
- `tests/integration/parent-execution-continuation.test.ts`
- `tests/integration/start-workflow-parent-execution.test.ts`
- `tests/integration/subgraph-step-execution.test.ts`
- `tests/integration/workflow-execution.test.ts`

**api**

- `tests/api/executions-errors-api.test.ts`

**mcp-tools**

- `tests/mcp-tools/execution-audit.test.ts`
- `tests/mcp-tools/execution-errors.test.ts`
- `tests/mcp-tools/workflow-execution.test.ts` — public start/step/session execution, context and branching behavior, intentional validation pause, and `isError` preservation for a genuine failed step

**e2e**

- `tests/e2e/execution-inspector-ux.spec.ts`
- `tests/e2e/executions-navigation.spec.ts`
- `tests/e2e/executions-page.spec.ts`

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

- `tests/mcp-tools/workflow-upload-visibility.test.ts`

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

- `tests/unit/mcp-server/get-help-mdx.test.ts` — MCP-owned non-tools corpus matches public topic identities and EN/RU metadata/imports, resolves every real topic composition, advertises the special typed `tools` topic and alias in the shared catalog, uses canonical registry-selected client configuration/token/deeplink generation, imports system instructions, removes presentation syntax, preserves aliases/errors, and renders direct typed tools

**integration**

- `tests/integration/docs-client-registry-propagation.test.ts` — one added registry-shaped client reaches both the real Starlight `ClientSetupTabs` build and MCP-owned runtime Markdown directly with its label, setup title, and deeplink semantics

### http-infrastructure

**unit**

- `tests/unit/web-backend/client-logs.test.ts`
- `tests/unit/web-backend/headers.test.ts`
- `tests/unit/web-backend/request-body-logger.test.ts` — request logging plus emitted-log proof that administrator temporary credentials are omitted while a safe neighboring body remains observable

**api**

- `tests/api/notification-test-api.test.ts`
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

- `tests/integration/input-enhancement.test.ts`

**mcp-tools**

- `tests/mcp-tools/json-formatting.test.ts`

**functional**

- `tests/functional/input-parsing-functional.test.ts`

### inspector

**e2e**

- `tests/e2e/inspector-mcp-tools.spec.ts`

### mcp-tools

**unit**

- `tests/unit/mcp-server/tool-definitions.test.ts` — unique typed catalog ownership, exact normalized protocol schemas through real registration including projected blank-selector rejection, complete manage action projection, all-example/schema validity and rendering, deterministic client-visible revision boundaries, and EN/RU renderer parity
- `tests/unit/mcp-server/tool-examples.test.ts` — exact-key, current notification-category, and all-settings registry examples reach the masked read projection
- `tests/unit/mcp-server/mcp-catalog-lifecycle.test.ts` — SDK-valid singleton initialize classification, exact successful-result stamp ordering, error/other-result non-stamping, and successful-result suppression when the credential cannot be stamped
- `tests/unit/mcp-server/mcp-tools-revision.test.ts` — deterministic matching, null, and stale catalog-revision decisions with package version retained only as diagnostic response data
- `tests/integration/docs-tool-contract-rendering.test.ts` — actual EN/RU public routes render every identity, localized fact, action, schema, result, example, and CodeBlock directly from the MCP contract model
- `tests/unit/scripts/static-tool-description-migration.test.ts` — exact retirement of database-backed default/agent/model descriptions plus nullable persistent-token revision migration with existing identity/hash preservation
- `tests/unit/mcp-server/progress-authoring-schema.test.ts` — MCP manage rich-progress goal/facts/content acceptance plus strict unknown-field and bound rejection

- `tests/unit/workflow-cli/workflow-schema.test.ts` — deterministic complete workflow control-flow schemas: locale-independent canonical edge/mapping order, basic blocks, conditions, many independent cycles, separate start/teleport/disconnected reachability, dangling edges, current node data-flow declarations including batch write-note and materialize registry reads, complete ordered progress topology and structured content with backward display edges and many-to-one primary mappings, context references, deep iterative traversal, terminal-control-safe structural tokens, non-mutation, and duplicate-ID rejection
- `tests/unit/scripts/workflow-tool-identity.test.ts` — set-name and set-slug: exact replacement, kebab-case validation, catalog-entry warning, version bump, and no collateral change to slug/owner/description/nodes
- `tests/unit/scripts/workflow-tool-progress.test.ts` — static rich progress graph set/clear, node mapping and active-only label/content set/clear/scope, Telegram attachment set/clear, malformed input, and wrong-node-type rejection
- `tests/unit/workflow-engine/execution-progress.test.ts` — rich progress task/goal/facts/content projection, active merge and exact context-revision replacement, pending-outcome suppression, mapped terminal completion frontiers with legacy fallback, nested template-reference and injection protection, definition and post-interpolation output bounds with explicit overflow failure, mapping/scope rules, immutability, completion/cancellation, and label-only compatibility
- `tests/unit/workflow-engine/execution-progress-image.test.ts` — shared rich visual model, full-text wrapping, deterministic multi-row and loop/cross-row edges, SVG escaping, semantic content in PNG, byte determinism, theme/state differences, and image metadata bounds
- `tests/unit/web-frontend/execution-progress-strip.test.tsx` — always-visible task/goal/facts/stage content, textual state and current-step accessibility, mapped-node focus, and readable non-actionable milestones without hover
- `tests/unit/scripts/workflow-tool-variables.test.ts` — incl. registry-backed globals, metadata, file-backed arguments, source diagnostics, fail-fast validation, atomic replace/sync, End projection/path qualification, and inert-retry migration
- `tests/unit/services/mcp-text-service.test.ts`

**integration**

- `tests/integration/mcp-contract-completeness.test.ts` — complete authored workflow retrieval and independent inclusion flags; presence-based exact/category/all settings selectors including empty and ambiguous rejection, masking, not-found, and both admin access directions; default, continuing, and terminal workflow-list page metadata through the real repository
- `tests/integration/cli-mcp-parity.test.ts`
- `tests/integration/workflow-schema-cli.test.ts` — public schema command output, shared `structure --graph` rendering, canonical equivalence across permuted JSON object keys, terminal-control-safe decoded JSON, source-byte preservation, and non-zero ambiguous-graph failure
- `tests/integration/essential-cases-split.test.ts`
- `tests/integration/get-current-step-enhanced.test.ts` — including read-only materialize re-presentation versus empty public `step()` completion
- `tests/integration/mcp-text-service.test.ts`
- `tests/integration/step-response-child-info.test.ts`

**api**

- `tests/api/auth/mcp-blocked-user.test.ts`
- `tests/api/auth/mcp-protection.test.ts` — unauthenticated ordinary-request rejection and invalid-bearer rejection before a valid initialize can reach catalog acceptance
- `tests/api/auth/mcp-version-check.test.ts` — real OAuth issuance leaves credentials uninitialized; null/stale ordinary requests return 426 without mutation; successful same-token initialize stamps only the exact row; concurrent recovery converges; and refresh issuance starts uninitialized
- `tests/api/mcp-spec.test.ts`

**mcp-tools**

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

- `tests/unit/workflow-engine/telegram-handler-errors.test.ts`

### notes

**unit**

- `tests/unit/shared/note-repository.test.ts`
- `tests/unit/shared/note-service.test.ts`

**integration**

- `tests/integration/execution-note.test.ts`

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
- `tests/unit/workflow-engine/trusted-lock-delivery.test.ts` — configuration-before-generation, configured-chat delivery, non-secret result, and sender-error/PIN-safe projection at the trusted Telegram boundary

**integration**

- `tests/integration/trusted-lock-delivery-lifecycle.test.ts` — production LockHandler with database-persisted same-node re-entry across missing, malformed, send-failure, fresh-success, exact earlier-context isolation, and MCP create success/failure without real Telegram
- `tests/unit/web-backend/telegram-webhook.test.ts`

**workflow**

- `tests/workflow/scenarios/lock-node.test.ts`

**mcp-tools**

- `tests/mcp-tools/lock-tool.test.ts` — status/list/unlock/session and active-step behavior seeded through the authenticated human path, plus agent lock fail-closed behavior without trusted delivery
- `tests/mcp-tools/lock-step-integration.test.ts` — public mandatory lock-delivery preflight, including skipTelegramCheck denial without execution creation

**api**

- `tests/api/admin-lock-management.test.ts`
- `tests/api/user-lock-management.test.ts` — owner/foreign lock access and PIN validation boundaries plus owner-only one-time human PIN creation compatibility

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
- `tests/unit/shared/logging/sanitize-input.test.ts`

### settings

**unit**

- `tests/unit/services/global-settings-service.test.ts`
- `tests/unit/services/settings-repository.test.ts`

**integration**

- `tests/integration/database/global-settings-repository.test.ts`
- `tests/integration/mcp-settings-tools.test.ts`
- `tests/integration/telegram-user-settings.test.ts`

**api**

- `tests/api/admin-settings-api.test.ts`
- `tests/api/global-settings-api.test.ts`
- `tests/api/settings-api.test.ts`

**mcp-tools**

- `tests/mcp-tools/user-settings.test.ts` — registered MCP settings list/get/set behavior, exact and category retrieval, encrypted masking, and rejection of empty or ambiguous selectors

**e2e**

- `tests/e2e/admin-settings.spec.ts`
- `tests/e2e/settings-page.spec.ts`
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

- `tests/unit/mcp-server/telegram-preflight.test.ts` — independent notification/lock detection and optional versus mandatory Telegram setup responses

**integration**

- `tests/integration/start-workflow-telegram-preflight.test.ts` — repository-backed optional notification bypass and mandatory lock-only/combined/malformed trusted-delivery preflight without execution creation

### template-engine

**integration**

- `tests/integration/advanced-templates.test.ts`
- `tests/integration/telegram-template-verification.test.ts`

### tokens

**integration**

- `tests/integration/workflow-file-tokens.test.ts` — including fixed five-minute materialize TTL, grant binding, and atomic one-use claim

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

- `tests/unit/web-frontend/compact-node.test.tsx` — same-node refresh of materialize tooltip, validation text, and subgraph navigation callback
- `tests/unit/web-frontend/backend-health.test.ts` — a reconciliation-degraded backend remains operable/connected while a hard health error disconnects
- `tests/unit/web-frontend/admin-reconciliation-status.test.tsx` — self-host administrator dashboard makes no disabled analytics request and renders managed-workflow conflict identity, classification, all candidate references, WMF instruction, and clear state
- `tests/unit/web-frontend/quick-start-card.test.ts` — i18n completeness, config/deeplink generation, setupType consistency, + resolveMcpUrl deployment-mode gating: self-host runtime, self-host baked fallback, saas baked, null mode baked

**e2e**

- `tests/e2e/dashboard.spec.ts`
- `tests/e2e/mobile-navigation.spec.ts`
- `tests/e2e/sidebar.spec.ts`
- `tests/e2e/theme-integration.spec.ts`
- `tests/e2e/theme-loading-state.spec.ts`
- `tests/e2e/verify-step24.spec.ts` — navigation, dashboard statistics, and execution-card behavior
- `tests/e2e/visual-regression.spec.ts` — light/dark screenshots of the principal application pages

### workflow-engine

**unit**

- `tests/unit/config/nginx-sensitive-logging.test.ts` — both shipped nginx modes suppress materialize grant URLs from access logs and accept request bodies up to the backend parser limit
- `tests/unit/shared/logging/express-middleware.test.ts` — materialize grant redaction with routing/query preservation and unrelated-URL non-regression
- `tests/unit/web-backend/execution-materialize.test.ts` — current-definition fetch, execution binding, tar response, one-use endpoint behavior, non-consumption on render overflow, and expected-4xx versus unexpected-boundary error mapping
- `tests/unit/logging/compute-changes.test.ts`
- `tests/unit/shared/workflow-query-service.test.ts` — incl. setWorkflowVariable preserves rich schema
- `tests/unit/shared/workflow-catalog.test.ts` — catalog identity/ownership metadata is excluded from the executable graph; readWorkflowCatalogs multi-dir merge: union, later-dir-wins precedence on (owner,slug) collision, per-owner duplicate slugs preserved, missing/empty dirs skipped, single-dir == readWorkflowCatalog; getWorkflowsDirs config: default, WORKFLOWS_DIR fallback, colon-separated WORKFLOWS_DIRS, empty-segment drop
- `tests/unit/shared/managed-resource-reconciler.test.ts` — closed three-way classification for first install/adoption, unchanged, user-only, upstream-only, converged, conflict, soft/hard deletion, removal, and tombstone reintroduction
- `tests/unit/shared/workflow-reconciliation-bundle.test.ts` — path-safe atomic local candidate publication including interrupted final publication cleanup, same-handle no-follow digest-bound conflict reconstruction, database-free multi-conflict choice accumulation, merged-file binding, stale-choice preservation, exclusive locking, every branch-specific instruction family, pending/candidate symlink plus oversized/tampered-file rejection, durable applied markers, idempotent pending/retired post-commit states, and startup cleanup of exact retired UUID directories with live-pending preservation plus unsafe/partial-failure rejection
- `tests/unit/web-frontend/workflow-transformer.test.ts` — including materialize registration on the shared CompactNode, factory output, frontend validation boundaries, content-free file summary data, success/error edge styling, and no fallback warning
- `tests/unit/workflow-engine/variable-resolver.test.ts`
- `tests/unit/workflow-engine/workflow-schema-keywords.test.ts` — ordered unique-reference plans, deep evidence-prefix correlation, protected plan prefixes, non-mutating blocked responses, global-input inlining, and GraphValidator keyword registration
- `tests/unit/workflow-engine/execution-parent-revision.test.ts` — optimistic execution revision rejects stale full saves and context mutations; same-owner running parent attach, replace, detach and idempotent repetition preserve revision semantics, while foreign, completed, cyclic and stale changes leave state untouched; database integration additionally proves concurrent inverse changes cannot commit a cycle
- `tests/unit/workflow-engine/execution-reminders.test.ts` — standalone/child completion-only reminder delivery, literal template-like text, no intermediate leakage, idempotent add/conflict, targeted update/cancel and sibling preservation
- `tests/unit/workflow-engine/execution-progress.test.ts` — static progress schema/semantic validation, template rendering, index-derived loop/replan state, completion-vs-cancellation persistence shape, many-to-one focus metadata and projection immutability
- `tests/unit/workflow-engine/execution-progress-image.test.ts` — shared horizontal visual model, forward/backward geometry, deterministic light/dark PNG bytes, state differences, bounds and image decoding
- `tests/unit/workflow-engine/execution-progress-wrapper.test.ts` — public workflow/execution image API metadata and byte parity, null no-progress behavior, render failure propagation, and input immutability
- `tests/unit/workflow-engine/progress-image-service.test.ts` — normalized revision/version/options-bound grants, successful single use, render-failure non-consumption and stale-revision denial
- `tests/unit/workflow-engine/telegram-client-photo.test.ts` — reusable MIME-aware Telegram multipart photo transport with exact bytes, caption/options and empty/oversized pre-allocation rejection
- `tests/unit/web-backend/execution-progress-image.test.ts` — progress image reservation completion on response finish and release on close/write failure
- `tests/unit/web-frontend/execution-progress-strip.test.tsx` — shared-model progress states/back edge, current accessibility and deterministic technical-node focus callbacks
- `tests/api/execution-parent-api.test.ts` — authenticated HTTP parent attach, idempotent repetition, replacement, detach, detail projection, and stale-revision conflict against executions created through the public MCP start surface
- `tests/api/execution-reminders-api.test.ts` — authenticated HTTP reminder add/idempotent retry/filter/update/cancel and revisioned retained history against an execution created through public MCP start
- `tests/mcp-tools/execution-variables.test.ts` — MCP/HTTP runtime ownership, filters (including false/current/other branches), unknown versus unset, effective editability/denial reasons, revisioned schema-valid top-level and inspector-path mutation, unchanged sibling/node state on path rejection, audit redaction, definition discovery and HTTP policy authoring/invalid-policy reporting; progress create/edit preservation, strict rejection without mutation of forbidden progress/node/connection fields, transport identity, owner/administrator/foreign access, and absent-definition errors
- `tests/unit/workflow-engine/registry-converter.test.ts`
- `tests/unit/workflow-engine/node-output-scope.test.ts` — incl. whole-descriptor inlining: enum/items/pattern/properties + end-to-end rejection
- `tests/unit/workflow-engine/strict-schema-validation.test.ts` — recursive strict JSON Schema normalization
- `tests/unit/workflow-engine/telegram-inline-keyboard.test.ts` — Telegram inline-keyboard schema and rendering contracts
- `tests/unit/workflow-engine/template-injection-and-validation.test.ts` — template-injection protection, runtime placeholder validation, and structured StartNode initialData recognition for registry writer analysis

**integration**

- `tests/integration/workflow-file-tokens.test.ts` — upload/download lifecycle plus five-minute materialize TTL boundary, real SQLite grant-failure normalization, user/execution/node binding, and atomic one-use claim
- `tests/integration/agent-response-contract.test.ts`
- `tests/integration/workflow-catalog-loader.test.ts` — owner/visibility mapping and three-way visibility changes, baseline adoption/divergence, distinct previous/current/incoming candidate content and canonical digests, upstream/user/two-sided changes, semver regression and same-version divergent content, catalog-wide preflight, user soft/hard deletion, upstream removal/tombstone/reintroduction and lifecycle resolution, conflict recovery across declared previous-slug migration for every selection route, required inspected revisions, durable resolution context, cross-snapshot staged portability that recomputes the actual incoming catalog on a fresh target while applying safe additions/updates and preserving unrelated target data, runtime validation of serialized staged artifacts, source/catalog/conflict-set/revision fail-closed behavior, local image CLI status/diff/get/validate/choose/apply with invalid merged-file rejection, catalog/target drift retention without partial mutation, no database mutation before complete apply, and committed-state bundle retirement semantics, lightweight summaries that do not parse malformed candidate bodies, multi-directory overlays, real SQLite rollback on a later apply failure, stale workflow/conflict/baseline guards across graph/visibility/lifecycle/alias changes, competing resolutions, real catalog evidence replacement, baseline creation/update/rename races, malformed baseline failure, explicit recovery, structured MCP response, administrator resolution, and SaaS CLI failure on a copied database without source mutation
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
- `tests/workflow/engine/materialize-node.test.ts` — materialize schema/source-default contract, handler directive summary, expected/unexpected preparation failures, isolated re-presentation that cannot traverse an error connection, shell encoding, current-registry rendering, tar output, path safety, collision detection, and exact resource boundaries
- `tests/workflow/engine/note-handlers.test.ts`
- `tests/workflow/engine/note-node-validation.test.ts`
- `tests/workflow/engine/path-resolver.test.ts`
- `tests/workflow/engine/registry-default-seeding.test.ts`
- `tests/workflow/engine/registry-schema-model.test.ts` — registry entry = full JSON Schema
- `tests/workflow/engine/registry-schema-validation.test.ts` — registry entry compiled as JSON Schema; malformed → blocking
- `tests/workflow/engine/schema-validator-agent-format.test.ts` — including exact context-derived artifact paths that resolve the engine-owned execution identity and reject a schema-valid foreign workspace
- `tests/workflow/engine/subgraph-delegation.test.ts`
- `tests/workflow/engine/subgraph-handler-simple.test.ts` — including discriminated child-failure provenance
- `tests/workflow/engine/subgraph-handler.test.ts`
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
- `tests/api/workflows-privacy.test.ts`

**mcp-tools**

- `tests/mcp-tools/workflow-crud.test.ts`
- `tests/mcp-tools/workflow-documentation.test.ts` — live authenticated MCP-owned help catalog with canonical special-`tools` discoverability, presentation-model-derived client/quickstart/agent-instruction content, configured endpoint and authentication guidance, ordinary topic semantics, Markdown shape, unknown-topic guidance, and direct typed tools detail
- `tests/mcp-tools/workflow-ownership.test.ts`
- `tests/mcp-tools/workflow-pagination.test.ts`
- `tests/mcp-tools/workflow-search.test.ts` — public workflow search and page metadata plus state-based registered MCP calls for list-nodes, get-nodes, analyze-variables, and set-visibility

**e2e**

- `tests/e2e/workflow-canvas-controls.spec.ts`
- `tests/e2e/workflow-card-compact.spec.ts`
- `tests/e2e/workflow-copy-button.spec.ts`
- `tests/e2e/workflow-delete-restore.spec.ts`
- `tests/e2e/workflow-list-performance.spec.ts`
- `tests/e2e/workflow-visibility-toggle.spec.ts`
- `tests/e2e/workflow-visibility.spec.ts`

### workflow-scenarios

**workflow**

- `tests/workflow/scenarios/architecture-design-flow.test.ts` — v2 public identity and universal new/existing architecture contract; exact source and delivery authority; execution-bound package; proportional methods without fixed quotas; completion-before deterministic and independent semantic gates; five cause-owned repair cones; corrected-contract review, process revision, interactive completion rework, complete/limited/blocked/abort/materialization outcomes, and exact authorized project delivery
- `tests/workflow/scenarios/artifacts-demo-dashboard-builder.test.ts`
- `tests/workflow/scenarios/artifacts-demo-report-publisher.test.ts`
- `tests/workflow/scenarios/conditional-branching.test.ts`
- `tests/workflow/scenarios/content-creation.test.ts` — v2 durable text-deliverable contract; immutable brief and cumulative correction; evidence/content/brief repair cones; strict active-request schemas; complete, limited, blocked, materialize-error, interactive rework and process revision; originating target-bound publication and independent Telegram outcomes
- `tests/workflow/scenarios/coverage.test.ts`
- `tests/workflow/scenarios/data-analysis.test.ts` — public identity and detailed neighboring-flow description; immutable source authority separated from typed acquisition evidence; schema rejection of invented availability, incomplete source projection, and hidden canonical mutation; autonomous and interactive runs; inline and filesystem delivery; reviewed limited results; readiness and final repair reaches; guarded process revision; complete ordinary node and branch coverage
- `tests/workflow/scenarios/development-workflow.test.ts` — v15.4.2 seven-stage content-rich execution progress with bounded producer-owned outcomes, accepted-plan synopsis, always-authoritative plan fact, complete waiting-node mapping, truthful active unit/iteration/validation/review/repair content, pending-outcome suppression, mapped normal/early terminal frontiers, multi-unit/replan/finalization projection and authorized Telegram image attachment; explicit active `plan_revision` binding for every current-unit consumer, deliberate previous/current pairing only in revision writers, and a schema-derived exhaustive response-coherence invariant for all progress-owning agent and teleport nodes; development-only planning with caller-owned follow-ups stored as standalone/child completion reminders rather than plan units or authority; one intake visual preference and current-plan-owned `disabled`/`screenshots`/`html_report` plus approval policy; autonomous activation without approval directives and interactive plan/unit/final attention; one screenshot evidence pass reused by execution-linked HTML artifact upload; approval-independent report retention; unit-owned permanent documentation with non-duplicative final reconciliation; distinct normal/stopped terminal notifications; repository-grounded preparation, fresh producer completion, cause-aware repair/replan cones, architecture-currency invalidation, teleport boundaries, Artifact failure contract, VCS authority, and complete executable node/branch coverage
- `tests/workflow/scenarios/execution-retrospective.test.ts` — catalog identity/version, exact archive materialization, sufficient/partial/unavailable semantic fixtures, independent analysis/final review oracles, proposal-only authority, all nodes/branches and contained/spreading repair routes
- `tests/workflow/scenarios/directive-validation.test.ts`
- `tests/workflow/scenarios/infinite-task-loop.test.ts` — public identity/version and detailed neighboring-flow description; exact current-task state; atomic cross-task reset; strict decision and feedback schemas; authority and persistence boundaries; plan revision, result rework, and complete executable node and branch coverage
- `tests/workflow/scenarios/iterative-research.test.ts` — public identity/version and detailed neighboring-flow description; execution workspace and engine-owned identity gate; bounded review and repair schemas; invalid identity and publication-coupling rejection; local, published, notified, failed, limited, aborted, repair, materialize-error, and process-revision outcomes
- `tests/workflow/scenarios/lock-node.test.ts`
- `tests/workflow/scenarios/marketing-campaign.test.ts` — v2 evidence-aware local campaign contract; immutable source authority; strict active-request schemas; complete/limited, pre/post-workspace blocked, materialize-error, interactive rework and guarded process revision outcomes; deterministic versus semantic gates and six source-specific strategy/evidence/package repair cones
- `tests/workflow/scenarios/notes-demo-metrics-collector.test.ts`
- `tests/workflow/scenarios/notes-demo-metrics-reporter.test.ts`
- `tests/workflow/scenarios/prd-creation.test.ts` — public identity, planning and review contracts, repair routes, terminal outcomes, and executable node and branch coverage
- `tests/workflow/scenarios/quick-task.test.ts` — v4.4.4 five-stage content-rich progress with bounded producer-owned outcomes, complete 12-role waiting-node mapping, active role content that preserves the latest confirmed outcome, render-only state, and a schema-derived exhaustive response-coherence invariant for every progress-owning agent and teleport node; authoritative current-plan references after repair, user revision and teleport replan; autonomous plan-gate bypass; filesystem workspace and immutable iteration paths; bounded typed outputs; disk-only evidence; cursor-preserving resumption; result repair/rework; empty End output and complete executable node/branch coverage
- `tests/workflow/scenarios/deep-corpus-research.test.ts` — v7.1.3 expensive public identity and explicit cost consent; immutable original contract; delegated adaptive planning; strict corpus/revision schemas; source-specific plan/package/evidence repair routing; complete, limited, corpus-repair, interactive-rework and guarded process-revision paths
- `tests/workflow/scenarios/robust-task.test.ts` — v9.1.3 six-stage content-rich progress with bounded producer-owned outcomes, complete 23-role waiting-node mapping, active role content that preserves the latest confirmed outcome, and render-only state; authoritative latest-plan references across all 15 audited consumers; atomic downstream projection replacement on user revision, repair, teleport, and every direct/reassessment replan; durable recovery and public identity; cause-aware plan, step, and final pass/repair/replan contracts; result versus evidence/projection repair budgets; truthful incomplete delivery; autonomous plan-gate bypass; complete executable node and branch coverage
- `tests/workflow/scenarios/simple-plan-execution.test.ts` — public identity/version and detailed neighboring-flow description; bounded canonical state; semantic plan identity; autonomous and interactive execution; projection/work/task/plan repair reaches; process revision; bounded terminal projection; complete node and branch coverage
- `tests/workflow/scenarios/smart-purchase-assistant.test.ts` — v4 restored public identity; execution-correlated decision/evidence/Markdown/HTML package; proportional current-source provenance; strict complete/limited and repair schemas; independent semantic review with evidence/report repair and corrected-contract reassessment; filesystem/materialize blockers; interactive contract/evidence/report rework and explicit abort; separately authorized artifact publication and Telegram sent/not-sent/error outcomes; 100% executable node and branch coverage
- `tests/workflow/scenarios/software-development-flow-lite.test.ts` — v2 public identity and risk-based selection; execution-bound artifact contract; autonomous and interactive paths; strict conditional schemas; plan repair/reassessment; complete producer and completion routing; product versus verification repair; semantic repair/replan; full-SDF handoff, blocked, abort and authority-bound VCS outcomes; guarded process revision; complete executable node/branch coverage
- `tests/workflow/scenarios/startup-idea-validation.test.ts` — v2 public identity; free-form typed intake; execution-bound package; traceable/limited evidence; offline HTML contract; deterministic versus semantic judgment; package/evidence repair and corrected-contract review; earliest-owner rework; separately authorized publication/notification; truthful complete, blocked and aborted outcomes; guarded process revision; complete executable node/branch coverage
- `tests/workflow/scenarios/task-breakdown-flow.test.ts` — public identity/version and detailed neighboring-flow description; bounded ordered plan/evidence and safe terminal projections; autonomous memory execution; strict feedback; blocked plan repair; materially changed retry; final projection rework; protected-prefix validation
- `tests/workflow/scenarios/telegram-setup.test.ts` — v2 secret-safe current-user settings contract; masked existing-state inspection and post-write readback; skipTelegramCheck bootstrap; sent/error/not-sent/receipt distinctions; cause-specific changed-evidence retry/reconfigure/incomplete routes; blocked/skipped/success outcomes; no credential workflow state or terminal projection; complete node and branch coverage
- `tests/workflow/scenarios/test-generation.test.ts` — v2 executable test-code contract; completion-before-gates; real project commands; test/evidence repair; production-change SDF handoff; proof-only evidence rejection; cumulative typed contract correction; materialization failure, interactive rework/process revision, and separate commit/push authority
- `tests/workflow/scenarios/test-planning.test.ts` — catalog identity and selection description; clean-or-repair graph; traversal-safe workspace; producer/repair schema identity; runtime contract rejection; zero-finding delivery; mismatch repair with re-review; complete node and branch coverage; no test-execution authority
- `tests/workflow/scenarios/test-suite-audit.test.ts` — public identity and selection description; immutable audit standard; execution-bound workspace; strict correction and delivery schemas; scope and taxonomy correction routes; complete terminal outcomes; targeted checks; independent review and repair; complete node and branch coverage
- `tests/workflow/scenarios/todo-list.test.ts` — v3.4.7 Checklist → Prepare → Work content-rich progress with complete 3-role mapping, distinct task/revision active content, bounded producer-owned outcomes, render-only state, and all-completed ordinary and empty-tail teleport frontiers; minimal registry and graph contract; unified planning/supplied-task intake; one-based projection; local evidence bounds and malformed-input retry; empty End output; jump-only checklist revision with atomic progress replacement, engine-derived total/cursor, and completed-prefix preservation; complete reachable node/branch coverage
- `tests/workflow/scenarios/user-onboarding.test.ts` — public identity/version and authority description; minimal selection/handoff graph; complete catalog pagination; identity bounds; create-own binding; start/defer consent; parent-linked execution evidence; optional notification bypass versus mandatory current-user trusted PIN delivery; setup-without-Process-ID incomplete handling without settings or target substitution; bounded terminal projection; complete ordinary node and branch coverage
- `tests/workflow/scenarios/universal-research-workflow.test.ts` — public identity/version and neighboring-flow selection description; filesystem and bounded-memory state; execution-bound workspace; authority and evidence-truth boundaries; independent reviews and repair reaches; publication and notification authority; correction, process revision, abort, and materialization fallback
- `tests/workflow/scenarios/ux-design.test.ts` — public identity/version and neighboring-flow selection description; execution workspace; correlated intake, artifact-path, reviewer, repair, feedback, and authority contracts; foreign-path rejection; accepted, limited, blocked, aborted, repair, feedback, and process-revision outcomes
- `tests/workflow/scenarios/verified-research.test.ts` — v3 public identity and neighboring-tier selection; execution-correlated evidence package; canonical ready/limited/replan/blocked evidence class; strict autonomous clarification and terminal schemas; deterministic versus independent semantic judgment; answer/evidence repair stale cones; corrected-contract findings; complete, limited, blocked, aborted, materialize-error, interactive rework, and guarded process-revision routes; complete ordinary node and branch coverage
- `tests/workflow/scenarios/workflow-management-flow.test.ts` — v6.5 embedded authoring policy and six-stage content-rich progress with bounded producer-owned outcomes, complete waiting-node mappings/labels, conditional active content, revision/repair invalidation sets, source/create/edit/review/delivery ownership and old-server stored-field compatibility; minimal state and operating-mode routing; shared pre-mutation design review; pass/repair/replan and changed/reassess routing; Proxy, scanner, metatest, guard, and proof-token regression fixtures; create, edit, audit, publication, error, local-sync, autonomous, and process-revision routes; complete node and branch coverage
- `tests/workflow/scenarios/workflow-presentation-generator.test.ts` — v2 complete ID/file source and official structural projection; execution-bound local package; source-grounded business and complete progressive-disclosure topology; self-contained network-independent HTML; deterministic versus independent semantic/visual gates; source/content/HTML/validation/completion repair and corrected-contract routes; complete/limited/blocked/abort/materialization outcomes and local-only authority

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
