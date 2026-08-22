# Test Coverage Map

Mapping of test files to functional domains and test levels.
Agents MUST update this file when adding, moving, or deleting tests.

## Coverage inventory

The domain sections below are the maintained inventory. Aggregate repository and
domain totals and per-file test counts are intentionally omitted: they duplicated
the file list or test-run output and drifted independently from both. Domain and
level headings classify the tracked test paths listed beneath them.

## Domain Details

### admin

**api**

- `tests/api/admin-analytics.test.ts`
- `tests/api/admin-user-security-api.test.ts`
- `tests/api/admin-user-security.test.ts`

**unit**

- `tests/unit/web-backend/operational-metrics.test.ts`
- `tests/unit/shared/admin-workflow-list.test.ts` — admin workflow repository listing, ownership metadata, filtering, sorting, and pagination

**e2e**

- `tests/e2e/admin-analytics.spec.ts`
- `tests/e2e/admin-execution-errors.spec.ts`
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
- `tests/api/admin-tokens-api.test.ts`

**mcp-tools**

- `tests/mcp-tools/persistent-token-auth.test.ts`

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

- `tests/unit/web-backend/account-approval-route-gating.test.ts` — disabled-mode administrator approval route returns before the mutation/audit service boundary
- `tests/unit/web-frontend/account-admission-ui.test.ts` — independent approval/email route decisions and deployment-capability selection for the registration completion page
- `tests/unit/web-frontend/account-approval-admin-ui.test.tsx` — capability-aware account-approval status and actions in the administrator list and detail surfaces, including the SaaS null-timestamp regression
- `tests/unit/web-frontend/admin-navigation-capabilities.test.ts` — narrow Users capability remains independent of broader multi-user administration in self-host and SaaS navigation
- `tests/unit/shared/account-admission.test.ts` — mode-independent approval state, fail-closed null/missing identity handling, and blocked/approval/email-verification denial precedence
- `tests/unit/shared/deployment-mode-config.test.ts` — DEPLOYMENT_MODE resolution: default self-host, case/whitespace normalization, invalid-value throws, isSelfHost/isSaas predicates
- `tests/unit/shared/feature-resolver.test.ts` — ModeFeatureResolver per-mode flags, unknown-feature safe default, singleton get/override/reset
- `tests/unit/shared/secrets-bootstrap.test.ts` — self-host secret generation+persist, mask vs expose, no-regenerate-when-present, restart idempotency, saas no-op, loadPersistedSecrets no-override + absent-file
- `tests/unit/shared/deployment-mode-safeguard.test.ts` — unset-DEPLOYMENT_MODE safeguard: production+public→error/refuse-boot, non-prod+public→warn, mode-set/localhost/127.x/empty-host→ok

**integration**

- `tests/integration/account-approval.test.ts` — legacy migration backfill and fresh-account persistence; downgrade preparation requires confirmation, blocks pending accounts through the legacy control, and revokes only their credentials; atomic concurrent approval with one timestamp and one audit event; missing-user no-op audit behavior
- `tests/integration/auth-mode-gating.test.ts` — mode feature contract: self-host registration with account approval and no email/legal gate; SaaS behavior unchanged; MCP/token issuance without verification in self-host; only an explicitly enabled reserved-domain registration with an authenticated load-test header is auto-approved, while disabled, wrong-secret, and wrong-domain cases remain pending; an existing blocked SaaS session is denied at non-public Better Auth operations
- `tests/integration/create-admin-user.test.ts` — recovery refuses a missing operator password without creating an identity; supplied credentials create an approved admin with a Better Auth-verifiable hash, never log the secret, and safely replace an existing credential

**api**

- `tests/api/auth/self-host-auth.test.ts` — complete self-host HTTP/MCP lifecycle from pending registration through concurrent admin approval, one audit transition, and Better Auth/product/token/OAuth unlock; pending OAuth code, refresh-token, and bearer-introspection denial with admitted introspection success; default-denied session-authorized Better Auth capabilities; sign-in, real signed verification, and stored reset-token flows with a pending cookie; admin authorization, audit actor identity, self-block rejection, and missing-user contracts; blocked/approval/email independence; pending status/sign-out; bootstrap-admin token issuance
- `tests/api/auth/saas-auth-invariants.test.ts` — explicit SaaS mode, consent enforcement, verification-email capability, no account-approval gate including profile mutation, blocked-first/email-verification gates for persistent tokens, OAuth code/refresh exchange, direct MCP bearer access, and bearer introspection, plus successful verified/unblocked code, refresh, MCP, and introspection paths
- `tests/api/features-api.test.ts` — public GET /api/features contract: no-auth 200 + {success,data,timestamp} envelope; valid deploymentMode; boolean for every gated feature flag, exact key set; runtime-resolved mcpUrl is an absolute http(s) URL ending in /mcp on the request host

**e2e**

- `tests/e2e/feature-mode-ui.spec.ts` — UI gating via the exact mocked mode capability sets: self-host exposes Users in the sidebar/dashboard while hiding broader multi-user administration and legal consent; SaaS retains both; direct navigation is guarded independently by the narrow and broad capabilities; beta modal is absent in self-host
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

### error-handling

**unit**

- `tests/unit/mcp-server/error-logging-levels.test.ts`
- `tests/unit/mcp-server/error-sanitizer.test.ts`
- `tests/unit/shared/domain-errors.test.ts`
- `tests/unit/shared/errors/app-error.test.ts`
- `tests/unit/web-backend/error-sanitizer.test.ts`
- `tests/unit/web-frontend/ErrorBoundary.test.tsx` — frontend error-boundary fallback and recovery actions

**integration**

- `tests/integration/error-logging-flow.test.ts`
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
- `tests/mcp-tools/workflow-execution.test.ts`

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

### health

**e2e**

- `tests/e2e/admin-ui-security-status.spec.ts`

### help-system

**unit**

- `tests/unit/mcp-server/get-help-mdx.test.ts`

### http-infrastructure

**unit**

- `tests/unit/web-backend/client-logs.test.ts`
- `tests/unit/web-backend/headers.test.ts`
- `tests/unit/web-backend/request-body-logger.test.ts`

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

- `tests/unit/workflow-cli/workflow-schema.test.ts` — deterministic complete workflow control-flow schemas: locale-independent canonical edge/mapping order, basic blocks, conditions, many independent cycles, separate start/teleport/disconnected reachability, dangling edges, current node data-flow declarations including batch write-note and materialize registry reads, context references, deep iterative traversal, terminal-control-safe structural tokens, non-mutation, and duplicate-ID rejection
- `tests/unit/scripts/workflow-tool-identity.test.ts` — set-name and set-slug: exact replacement, kebab-case validation, catalog-entry warning, version bump, and no collateral change to slug/owner/description/nodes
- `tests/unit/scripts/workflow-tool-variables.test.ts` — incl. registry-backed globals, metadata, file-backed arguments, source diagnostics, fail-fast validation, atomic replace/sync, End projection/path qualification, and inert-retry migration
- `tests/unit/services/mcp-text-service.test.ts`

**integration**

- `tests/integration/cli-mcp-parity.test.ts`
- `tests/integration/workflow-schema-cli.test.ts` — public schema command output, shared `structure --graph` rendering, canonical equivalence across permuted JSON object keys, terminal-control-safe decoded JSON, source-byte preservation, and non-zero ambiguous-graph failure
- `tests/integration/essential-cases-split.test.ts`
- `tests/integration/get-current-step-enhanced.test.ts` — including read-only materialize re-presentation versus empty public `step()` completion
- `tests/integration/mcp-text-service.test.ts`
- `tests/integration/step-response-child-info.test.ts`

**api**

- `tests/api/auth/mcp-blocked-user.test.ts`
- `tests/api/auth/mcp-protection.test.ts`
- `tests/api/auth/mcp-version-check.test.ts`
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

- `tests/unit/shared/lock-service.test.ts`
- `tests/unit/web-backend/telegram-webhook.test.ts`

**workflow**

- `tests/workflow/scenarios/lock-node.test.ts`

**mcp-tools**

- `tests/mcp-tools/lock-tool.test.ts`
- `tests/mcp-tools/lock-step-integration.test.ts` — incl. malformed-Telegram-token resilience: lock step still pauses, start() does not crash

**api**

- `tests/api/admin-lock-management.test.ts`
- `tests/api/user-lock-management.test.ts`

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

- `tests/mcp-tools/user-settings.test.ts`

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

- `tests/unit/mcp-server/telegram-preflight.test.ts`

**integration**

- `tests/integration/start-workflow-telegram-preflight.test.ts`

### template-engine

**integration**

- `tests/integration/advanced-templates.test.ts`
- `tests/integration/telegram-template-verification.test.ts`

### tokens

**integration**

- `tests/integration/workflow-file-tokens.test.ts` — including fixed five-minute materialize TTL, grant binding, and atomic one-use claim

**mcp-tools**

- `tests/mcp-tools/workflow-tokens.test.ts`

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

- `tests/api/user-profile-api.test.ts`

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

- `tests/unit/config/nginx-sensitive-logging.test.ts` — both shipped nginx modes suppress materialize grant URLs from access logs
- `tests/unit/shared/logging/express-middleware.test.ts` — materialize grant redaction with routing/query preservation and unrelated-URL non-regression
- `tests/unit/web-backend/execution-materialize.test.ts` — current-definition fetch, execution binding, tar response, one-use endpoint behavior, non-consumption on render overflow, and expected-4xx versus unexpected-boundary error mapping
- `tests/unit/logging/compute-changes.test.ts`
- `tests/unit/shared/workflow-query-service.test.ts` — incl. setWorkflowVariable preserves rich schema
- `tests/unit/shared/workflow-catalog.test.ts` — catalog identity/ownership metadata is excluded from the executable graph; readWorkflowCatalogs multi-dir merge: union, later-dir-wins precedence on (owner,slug) collision, per-owner duplicate slugs preserved, missing/empty dirs skipped, single-dir == readWorkflowCatalog; getWorkflowsDirs config: default, WORKFLOWS_DIR fallback, colon-separated WORKFLOWS_DIRS, empty-segment drop
- `tests/unit/web-frontend/workflow-transformer.test.ts` — including materialize registration on the shared CompactNode, factory output, frontend validation boundaries, content-free file summary data, success/error edge styling, and no fallback warning
- `tests/unit/workflow-engine/variable-resolver.test.ts`
- `tests/unit/workflow-engine/workflow-schema-keywords.test.ts` — ordered unique-reference plans, deep evidence-prefix correlation, protected plan prefixes, non-mutating blocked responses, global-input inlining, and GraphValidator keyword registration
- `tests/unit/workflow-engine/registry-converter.test.ts`
- `tests/unit/workflow-engine/node-output-scope.test.ts` — incl. whole-descriptor inlining: enum/items/pattern/properties + end-to-end rejection
- `tests/unit/workflow-engine/strict-schema-validation.test.ts` — recursive strict JSON Schema normalization
- `tests/unit/workflow-engine/telegram-inline-keyboard.test.ts` — Telegram inline-keyboard schema and rendering contracts
- `tests/unit/workflow-engine/template-injection-and-validation.test.ts` — template-injection protection and runtime placeholder validation

**integration**

- `tests/integration/workflow-file-tokens.test.ts` — upload/download lifecycle plus five-minute materialize TTL boundary, real SQLite grant-failure normalization, user/execution/node binding, and atomic one-use claim
- `tests/integration/agent-response-contract.test.ts`
- `tests/integration/workflow-catalog-loader.test.ts` — owner/visibility mapping, version-aware idempotence including persisted legacy root catalog metadata, missing owners, content mismatch, cross-owner isolation, soft-deleted restoration, explicit previous-slug migration without duplicate catalog entries, and multi-directory merge/install behavior
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
- `tests/mcp-tools/workflow-documentation.test.ts`
- `tests/mcp-tools/workflow-ownership.test.ts`
- `tests/mcp-tools/workflow-pagination.test.ts`
- `tests/mcp-tools/workflow-search.test.ts`

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

- `tests/workflow/scenarios/architecture-design-flow.test.ts`
- `tests/workflow/scenarios/artifacts-demo-dashboard-builder.test.ts`
- `tests/workflow/scenarios/artifacts-demo-report-publisher.test.ts`
- `tests/workflow/scenarios/bug-hunting-workflow.test.ts`
- `tests/workflow/scenarios/conditional-branching.test.ts`
- `tests/workflow/scenarios/content-creation.test.ts`
- `tests/workflow/scenarios/coverage.test.ts`
- `tests/workflow/scenarios/data-analysis.test.ts` — public identity and detailed neighboring-flow description; immutable source authority separated from typed acquisition evidence; schema rejection of invented availability, incomplete source projection, and hidden canonical mutation; autonomous and interactive runs; inline and filesystem delivery; reviewed limited results; readiness and final repair reaches; guarded process revision; complete ordinary node and branch coverage
- `tests/workflow/scenarios/development-workflow.test.ts` — v13 filesystem-first state and authority; autonomous and gated operation; local semantic gates and delegated completeness review; cause-aware pass/repair/replan contracts; mechanically distinguishable acceptance evidence; meta-validation drift stop; bounded class-wide repair; verification-only versus product mutation routing; architecture-currency reset and invalidation; plan-revision teleport; acceptance, rejection, blocker, VCS, documentation, checkpoint, finalization, and complete executable node/branch coverage
- `tests/workflow/scenarios/execution-retrospective.test.ts` — catalog identity/version, exact archive materialization, sufficient/partial/unavailable semantic fixtures, independent analysis/final review oracles, proposal-only authority, all nodes/branches and contained/spreading repair routes
- `tests/workflow/scenarios/directive-validation.test.ts`
- `tests/workflow/scenarios/infinite-task-loop.test.ts` — public identity/version and detailed neighboring-flow description; exact current-task state; atomic cross-task reset; strict decision and feedback schemas; authority and persistence boundaries; plan revision, result rework, and complete executable node and branch coverage
- `tests/workflow/scenarios/iterative-research.test.ts` — public identity/version and detailed neighboring-flow description; execution workspace and engine-owned identity gate; bounded review and repair schemas; invalid identity and publication-coupling rejection; local, published, notified, failed, limited, aborted, repair, materialize-error, and process-revision outcomes
- `tests/workflow/scenarios/lock-node.test.ts`
- `tests/workflow/scenarios/marketing-campaign.test.ts`
- `tests/workflow/scenarios/notes-demo-metrics-collector.test.ts`
- `tests/workflow/scenarios/notes-demo-metrics-reporter.test.ts`
- `tests/workflow/scenarios/prd-creation.test.ts` — public identity, planning and review contracts, repair routes, terminal outcomes, and executable node and branch coverage
- `tests/workflow/scenarios/quick-task.test.ts` — autonomous plan-gate bypass and mid-execution replan; filesystem workspace and immutable iteration paths; bounded typed outputs; disk-only evidence; plan repair and user revision; cursor-preserving resumption; result repair and rework; empty End output
- `tests/workflow/scenarios/deep-corpus-research.test.ts` — catalog identity that cannot be confused with Robust Task, cost and consent markers in name/description, the consent gate enforced in the entry node in both modes, operating-mode routing with both notification outcomes, evidence-based bounded gates
- `tests/workflow/scenarios/robust-task.test.ts` — v9 durable recovery and public identity; complete producer ownership; cause-aware plan, step, and final pass/repair/replan contracts; result versus evidence/projection repair budgets; changed/reassess ownership; six source-pure direct/reassessment replan paths; bounded retry and review decisions; truthful incomplete delivery; autonomous plan-gate bypass; teleport replanning; complete executable node and branch coverage
- `tests/workflow/scenarios/simple-plan-execution.test.ts` — public identity/version and detailed neighboring-flow description; bounded canonical state; semantic plan identity; autonomous and interactive execution; projection/work/task/plan repair reaches; process revision; bounded terminal projection; complete node and branch coverage
- `tests/workflow/scenarios/smart-purchase-assistant.test.ts`
- `tests/workflow/scenarios/software-development-flow-lite.test.ts`
- `tests/workflow/scenarios/startup-idea-validation.test.ts`
- `tests/workflow/scenarios/task-breakdown-flow.test.ts` — public identity/version and detailed neighboring-flow description; bounded ordered plan/evidence and safe terminal projections; autonomous memory execution; strict feedback; blocked plan repair; materially changed retry; final projection rework; protected-prefix validation
- `tests/workflow/scenarios/telegram-setup.test.ts`
- `tests/workflow/scenarios/test-generation.test.ts`
- `tests/workflow/scenarios/test-planning.test.ts` — catalog identity and selection description; clean-or-repair graph; traversal-safe workspace; producer/repair schema identity; runtime contract rejection; zero-finding delivery; mismatch repair with re-review; complete node and branch coverage; no test-execution authority
- `tests/workflow/scenarios/test-suite-audit.test.ts` — public identity and selection description; immutable audit standard; execution-bound workspace; strict correction and delivery schemas; scope and taxonomy correction routes; complete terminal outcomes; targeted checks; independent review and repair; complete node and branch coverage
- `tests/workflow/scenarios/todo-list.test.ts` — minimal registry and graph contract, absence of a per-workflow system reminder with its rules carried by the execute node, unified planning/supplied-task intake, unchanged typed supplied tasks, one-based projection, local evidence bounds and malformed-input retry, empty End output, the mid-run revision teleport (jump-only entry, engine-derived total and cursor, resume without re-executing completed tasks), and reachable node/branch coverage
- `tests/workflow/scenarios/user-onboarding.test.ts` — public identity/version and authority description; minimal selection/handoff graph; complete catalog pagination; identity bounds; create-own binding; start/defer consent; parent-linked execution evidence; bounded terminal projection; complete ordinary node and branch coverage
- `tests/workflow/scenarios/universal-research-workflow.test.ts` — public identity/version and neighboring-flow selection description; filesystem and bounded-memory state; execution-bound workspace; authority and evidence-truth boundaries; independent reviews and repair reaches; publication and notification authority; correction, process revision, abort, and materialization fallback
- `tests/workflow/scenarios/ux-design.test.ts` — public identity/version and neighboring-flow selection description; execution workspace; correlated intake, artifact-path, reviewer, repair, feedback, and authority contracts; foreign-path rejection; accepted, limited, blocked, aborted, repair, feedback, and process-revision outcomes
- `tests/workflow/scenarios/verified-research.test.ts`
- `tests/workflow/scenarios/workflow-management-flow.test.ts` — embedded authoring policy, minimal state and operating-mode routing; shared pre-mutation design review; pass/repair/replan and changed/reassess routing; Proxy, scanner, metatest, guard, and proof-token regression fixtures; create, edit, audit, publication, error, local-sync, autonomous, and process-revision routes; complete node and branch coverage
- `tests/workflow/scenarios/workflow-presentation-generator.test.ts`

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
