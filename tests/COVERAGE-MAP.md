# Test Coverage Map

Mapping of test files to functional domains and test levels.
Agents MUST update this file when adding, moving, or deleting tests.

## Summary

- **40 domains**, **272 files**, **3395 tests**
- Levels: unit, integration, workflow, api, mcp-tools, e2e, functional

## Domain Overview

| Domain              | Files | Tests | Levels                                                          |
| ------------------- | ----- | ----- | --------------------------------------------------------------- |
| admin               | 7     | 89    | api:3, e2e:4                                                    |
| api-tokens          | 5     | 79    | unit:1, api:2, mcp-tools:1, e2e:1                               |
| artifacts           | 8     | 179   | api:1, e2e:3, mcp-tools:3, unit:1                               |
| audit               | 4     | 66    | e2e:1, integration:2, mcp-tools:1                               |
| auth                | 16    | 112   | api:4, e2e:10, integration:2                                    |
| chat                | 3     | 53    | integration:1, unit:2                                           |
| context             | 7     | 73    | integration:2, mcp-tools:1, unit:4                              |
| deployment-mode     | 12    | 64    | unit:5, integration:3, api:3, e2e:1                             |
| email               | 1     | 22    | unit:1                                                          |
| self-host-limits    | 2     | 12    | unit:2                                                          |
| pin-hash            | 1     | 7     | unit:1                                                          |
| error-handling      | 11    | 133   | api:1, e2e:2, integration:2, mcp-tools:1, unit:5                |
| execution           | 13    | 108   | api:1, e2e:3, integration:5, mcp-tools:3, unit:1                |
| execution-lock      | 9     | 79    | unit:2, workflow:1, mcp-tools:2, api:2, e2e:1                   |
| expressions         | 4     | 16    | api:1, e2e:1, mcp-tools:2                                       |
| file-transfer       | 1     | 4     | mcp-tools:1                                                     |
| health              | 1     | 4     | e2e:1                                                           |
| help-system         | 1     | 26    | unit:1                                                          |
| http-infrastructure | 5     | 62    | api:2, unit:3                                                   |
| i18n                | 11    | 100   | e2e:10, unit:1                                                  |
| infrastructure      | 4     | 88    | unit:4                                                          |
| input-parsing       | 4     | 60    | functional:1, integration:1, mcp-tools:1, unit:1                |
| inspector           | 1     | 1     | e2e:1                                                           |
| mcp-clients         | 2     | 50    | e2e:1, unit:1                                                   |
| mcp-tools           | 14    | 129   | api:4, e2e:2, integration:5, mcp-tools:1, unit:2                |
| metrics             | 1     | 20    | unit:1                                                          |
| node-handlers       | 1     | 6     | unit:1                                                          |
| notes               | 7     | 166   | api:1, e2e:2, integration:1, mcp-tools:1, unit:2                |
| other               | 3     | 24    | e2e:2, integration:1                                            |
| rate-limiting       | 2     | 13    | integration:1, unit:1                                           |
| security            | 2     | 49    | unit:2                                                          |
| settings            | 11    | 142   | api:3, e2e:2, integration:3, mcp-tools:1, unit:2                |
| sharing             | 5     | 125   | api:1, e2e:1, integration:1, mcp-tools:1, unit:1                |
| slug-handle         | 4     | 56    | api:2, integration:2                                            |
| storage             | 1     | 42    | unit:1                                                          |
| telegram            | 2     | 18    | integration:1, unit:1                                           |
| template-engine     | 2     | 6     | integration:2                                                   |
| tokens              | 2     | 24    | integration:1, mcp-tools:1                                      |
| url-routing         | 5     | 65    | unit:5                                                          |
| user-blocking       | 3     | 27    | e2e:2, integration:1                                            |
| user-management     | 3     | 34    | api:1, e2e:2                                                    |
| validation          | 4     | 90    | api:1, integration:1, unit:2                                    |
| web-ui              | 7     | 41    | e2e:5, unit:2                                                   |
| workflow-engine     | 69    | 926   | api:4, e2e:7, integration:14, mcp-tools:5, unit:11, workflow:28 |
| workflow-scenarios  | 33    | 154   | workflow:33                                                     |

## Domain Details

### admin

**8 files, 96 tests**

**api** (3 files)

- `tests/api/admin-analytics.test.ts` — 38 tests 🟢
- `tests/api/admin-user-security-api.test.ts` — 11 tests 🟢
- `tests/api/admin-user-security.test.ts` — 10 tests 🟢

**unit** (1 file)

- `tests/unit/web-backend/operational-metrics.test.ts` — 9 tests 🟢

**e2e** (5 files)

- `tests/e2e/admin-analytics.spec.ts` — 9 tests 🟢
- `tests/e2e/admin-execution-errors.spec.ts` — 3 tests 🟢
- `tests/e2e/admin-executions.spec.ts` — 4 tests 🟢
- `tests/e2e/admin-user-security.spec.ts` — 20 tests 🟢
- `tests/e2e/operational-dashboard.spec.ts` — 5 tests 🟢
- `tests/e2e/docs-serving.spec.ts` — 4 tests 🟢 (built Starlight docs served at /docs in the image: /docs serves Starlight not the Web UI SPA; /ru/docs RU; / still Web UI; missing doc 404s instead of SPA fallthrough)

### api-tokens

**5 files, 79 tests**

**unit** (1 files)

- `tests/unit/shared/api-token.test.ts` — 32 tests 🟢

**api** (2 files)

- `tests/api/tokens-api.test.ts` — 20 tests 🟢
- `tests/api/admin-tokens-api.test.ts` — 16 tests 🟢

**mcp-tools** (1 file)

- `tests/mcp-tools/persistent-token-auth.test.ts` — 8 tests 🟡

**e2e** (2 files)

- `tests/e2e/api-tokens-settings.spec.ts` — 3 tests 🟢
- `tests/e2e/admin-tokens.spec.ts` — 5 tests 🟢

### artifacts

**unit** (3 files)

- `tests/unit/shared/artifact-service.test.ts` — 52 tests 🟢
- `tests/unit/shared/url-config.test.ts` — artifact URL/subdomain resolution 🟢
- `tests/unit/web-backend/artifact-rate-limit-key.test.ts` — per-artifact rate-limit keying 🟢

**integration** (1 files)

- `tests/integration/artifact-abuse.test.ts` — report/takedown/getPublic suppression + audit 🟢

**api** (1 files)

- `tests/api/artifacts-api.test.ts` — CRUD + abuse controls (report, takedown, frame CSP) 🟢

**mcp-tools** (3 files)

- `tests/mcp-tools/artifact-tokens.test.ts` — 10 tests 🟢
- `tests/mcp-tools/artifacts-tool.test.ts` — 21 tests 🟢
- `tests/mcp-tools/static-artifacts.test.ts` — 17 tests 🟢

**e2e** (4 files)

- `tests/e2e/admin-artifacts.spec.ts` — 14 tests 🟢
- `tests/e2e/admin-reported-artifacts.spec.ts` — abuse review + takedown via UI 🟢
- `tests/e2e/artifact-security.spec.ts` — wrapper/sandbox/footer/interstitial/report + CSP 🟢
- `tests/e2e/artifacts-ui.spec.ts` — 11 tests 🟢

### audit

**4 files, 66 tests**

**integration** (2 files)

- `tests/integration/audit-logging.test.ts` — 36 tests 🟢
- `tests/integration/database/audit-repository.test.ts` — 14 tests 🟢

**mcp-tools** (1 files)

- `tests/mcp-tools/workflow-audit.test.ts` — 3 tests 🟢

**e2e** (1 files)

- `tests/e2e/audit-log.spec.ts` — 13 tests 🟢

### auth

**16 files, 112 tests**

**integration** (2 files)

- `tests/integration/forced-password-reset.test.ts` — 4 tests 🟢
- `tests/integration/user-password-reset-fields.test.ts` — 11 tests 🟢

**api** (4 files)

- `tests/api/admin-logout-all.test.ts` — 4 tests 🟢
- `tests/api/auth/registration-consent.test.ts` — 5 tests 🟢
- `tests/api/authorization.test.ts` — 32 tests 🟢
- `tests/api/user-oauth-sessions-api.test.ts` — 12 tests 🟢

**e2e** (10 files)

- `tests/e2e/admin-logout-all.spec.ts` — 5 tests 🟢
- `tests/e2e/auth-ux-quality.spec.ts` — 4 tests 🟢
- `tests/e2e/forced-password-reset.spec.ts` — 2 tests 🟢
- `tests/e2e/forgot-password.spec.ts` — 7 tests 🟢
- `tests/e2e/inspector-oauth-registration.spec.ts` — 2 tests 🟢
- `tests/e2e/logout.spec.ts` — 3 tests 🟢
- `tests/e2e/oauth-consent.spec.ts` — 5 tests 🟢
- `tests/e2e/user-oauth-sessions.spec.ts` — 9 tests 🟢
- `tests/e2e/web-login.spec.ts` — 1 tests 🟢
- `tests/e2e/web-registration.spec.ts` — 6 tests 🟢

### chat

**3 files, 53 tests**

**unit** (2 files)

- `tests/unit/mcp-server/messages.test.ts` — 28 tests 🟢
- `tests/unit/workflow-engine/telegram-error-messages.test.ts` — 20 tests 🟢

**integration** (1 files)

- `tests/integration/agent-message-enhancement.test.ts` — 5 tests 🟢

### context

**10 files, 108 tests**

**unit** (5 files)

- `tests/unit/logging/context.test.ts` — 12 tests 🟢
- `tests/unit/mcp-server/prompt-context.test.ts` — 29 tests 🟢
- `tests/unit/shared/logging/service-context-propagation.test.ts` — 18 tests 🟢
- `tests/unit/shared/logging/service-logger-error-context.test.ts` — 6 tests 🟢
- `tests/unit/web-frontend/context-variable-model.test.ts` — 18 tests 🟢

**integration** (3 files)

- `tests/integration/execution-context-tools.test.ts` — 5 tests 🟢
- `tests/integration/execution-context-per-key-update.test.ts` — 11 tests 🟢
- `tests/integration/subgraph-context-mapping.test.ts` — 2 tests 🟢

**mcp-tools** (1 files)

- `tests/mcp-tools/execution-context.test.ts` — 1 tests 🟢

**e2e** (1 files)

- `tests/e2e/context-variable-editor.spec.ts` — 6 tests 🟢

### deployment-mode

**12 files, 64 tests**

**unit** (5 files)

- `tests/unit/shared/account-admission.test.ts` — 3 tests 🟢 (mode-independent approval state, fail-closed null/missing identity handling, and blocked/approval/email-verification denial precedence)
- `tests/unit/shared/deployment-mode-config.test.ts` — 10 tests 🟢 (DEPLOYMENT_MODE resolution: default self-host, case/whitespace normalization, invalid-value throws, isSelfHost/isSaas predicates)
- `tests/unit/shared/feature-resolver.test.ts` — 9 tests 🟢 (ModeFeatureResolver per-mode flags, unknown-feature safe default, singleton get/override/reset)
- `tests/unit/shared/secrets-bootstrap.test.ts` — 8 tests 🟢 (self-host secret generation+persist, mask vs expose, no-regenerate-when-present, restart idempotency, saas no-op, loadPersistedSecrets no-override + absent-file)
- `tests/unit/shared/deployment-mode-safeguard.test.ts` — 6 tests 🟢 (unset-DEPLOYMENT_MODE safeguard: production+public→error/refuse-boot, non-prod+public→warn, mode-set/localhost/127.x/empty-host→ok)

**integration** (3 files)

- `tests/integration/account-approval.test.ts` — 4 tests 🟢 (legacy migration backfill and fresh-account persistence; downgrade preparation requires confirmation, blocks pending accounts through the legacy control, and revokes only their credentials; atomic concurrent approval with one timestamp and one audit event; missing-user no-op audit behavior)
- `tests/integration/auth-mode-gating.test.ts` — 8 tests 🟢 (mode feature contract: self-host registration with account approval and no email/legal gate; SaaS behavior unchanged; MCP/token issuance without verification in self-host; only an explicitly enabled reserved-domain registration with an authenticated load-test header is auto-approved, while disabled, wrong-secret, and wrong-domain cases remain pending; an existing blocked SaaS session is denied at non-public Better Auth operations)
- `tests/integration/create-admin-user.test.ts` — 2 tests 🟢 (recovery refuses a missing operator password without creating an identity; supplied credentials create an approved admin with a Better Auth-verifiable hash, never log the secret, and safely replace an existing credential)

**api** (3 files)

- `tests/api/auth/self-host-auth.test.ts` — 3 tests 🟢 (complete self-host HTTP/MCP lifecycle from pending registration through concurrent admin approval, one audit transition, and Better Auth/product/token/OAuth unlock; pending OAuth code, refresh-token, and bearer-introspection denial with admitted introspection success; default-denied session-authorized Better Auth capabilities; sign-in, real signed verification, and stored reset-token flows with a pending cookie; admin authorization, audit actor identity, self-block rejection, and missing-user contracts; blocked/approval/email independence; pending status/sign-out; bootstrap-admin token issuance)
- `tests/api/auth/saas-auth-invariants.test.ts` — 1 test 🟢 (explicit SaaS mode, consent enforcement, verification-email capability, no account-approval gate including profile mutation, blocked-first/email-verification gates for persistent tokens, OAuth code/refresh exchange, direct MCP bearer access, and bearer introspection, plus successful verified/unblocked code, refresh, MCP, and introspection paths)
- `tests/api/features-api.test.ts` — 4 tests 🟢 (public GET /api/features contract: no-auth 200 + {success,data,timestamp} envelope; valid deploymentMode; boolean for every gated feature flag, exact key set; runtime-resolved mcpUrl is an absolute http(s) URL ending in /mcp on the request host)

**e2e** (1 file)

- `tests/e2e/feature-mode-ui.spec.ts` — 6 tests 🟢 (UI gating via mocked GET /api/features: self-host hides registration legal-consent checkboxes / saas shows them; self-host hides multi-user admin sidebar nav / saas shows; direct nav to multi-user admin page redirects to dashboard; beta modal absent in self-host)

### self-host-limits

**2 files, 12 tests**

**unit** (2 files)

- `tests/unit/shared/note-quotas-configurable.test.ts` — 6 tests 🟢 (note quotas from global settings: per-note size, per-user total, max versions; fallback to hardcoded defaults when absent or garbage/non-positive)
- `tests/unit/shared/execution-retention-service.test.ts` — 6 tests 🟢 (execution retention: deleteCompletedOlderThan deletes only expired completed, keeps running/fresh/active-parent; service no-op when retention_days 0/unset; deletes when configured)

### pin-hash

**1 files, 7 tests**

**unit** (1 files)

- `tests/unit/shared/pin-hash.test.ts` — 7 tests 🟢 (execution-lock PIN scrypt hashing: scrypt$salt$hash format, per-hash salt, correct/incorrect verify, legacy-plaintext rejected, malformed-stored rejected without throw, isHashedPin)

### email

**1 files, 22 tests**

**unit** (1 files)

- `tests/unit/email/email-error-classification.test.ts` — 22 tests 🟢

### error-handling

**11 files, 133 tests**

**unit** (5 files)

- `tests/unit/mcp-server/error-logging-levels.test.ts` — 6 tests 🟢
- `tests/unit/mcp-server/error-sanitizer.test.ts` — 10 tests 🟢
- `tests/unit/shared/domain-errors.test.ts` — 28 tests 🟢
- `tests/unit/shared/errors/app-error.test.ts` — 32 tests 🟢
- `tests/unit/web-backend/error-sanitizer.test.ts` — 17 tests 🟢

**integration** (2 files)

- `tests/integration/error-logging-flow.test.ts` — 6 tests 🟢
- `tests/integration/subgraph-error-scenarios.test.ts` — 8 tests 🟢 (root/child/grandchild error provenance, durable root ownership, authored recovery edges, and persisted root/one/nested retry exhaustion without mutation replay)

**api** (1 files)

- `tests/api/error-handling-flow.test.ts` — 10 tests 🟢

**mcp-tools** (1 files)

- `tests/mcp-tools/error-diagnostics.test.ts` — 6 tests 🟢

**e2e** (2 files)

- `tests/e2e/error-boundary.spec.ts` — 7 tests 🟢
- `tests/e2e/error-history-display.spec.ts` — 3 tests 🟢

### execution

**13 files, 110 tests**

**unit** (1 files)

- `tests/unit/shared/execution-repository-errors.test.ts` — 27 tests 🟢 (including terminal-result persistence, owner-identity validation, legacy null rows, and fail-closed empty/falsy payload handling)

**integration** (5 files)

- `tests/integration/execution-filters.test.ts` — 8 tests 🟢
- `tests/integration/parent-execution-continuation.test.ts` — 5 tests 🟢
- `tests/integration/start-workflow-parent-execution.test.ts` — 7 tests 🟢
- `tests/integration/subgraph-step-execution.test.ts` — 4 tests 🟢
- `tests/integration/workflow-execution.test.ts` — 6 tests 🟢

**api** (1 files)

- `tests/api/executions-errors-api.test.ts` — 4 tests 🟢

**mcp-tools** (3 files)

- `tests/mcp-tools/execution-audit.test.ts` — 12 tests 🟢
- `tests/mcp-tools/execution-errors.test.ts` — 5 tests 🟢
- `tests/mcp-tools/workflow-execution.test.ts` — 8 tests 🟢

**e2e** (3 files)

- `tests/e2e/execution-inspector-ux.spec.ts` — 13 tests 🟢
- `tests/e2e/executions-navigation.spec.ts` — 11 tests 🟢
- `tests/e2e/executions-page.spec.ts` — 7 tests 🟢

### expressions

**4 files, 16 tests**

**api** (1 files)

- `tests/api/expression-node-api.test.ts` — 4 tests 🟢

**mcp-tools** (2 files)

- `tests/mcp-tools/expression-loop.test.ts` — 1 tests 🟢
- `tests/mcp-tools/expression-node.test.ts` — 5 tests 🟢

**e2e** (1 files)

- `tests/e2e/expression-node-display.spec.ts` — 6 tests 🟢

### file-transfer

**1 files, 4 tests**

**mcp-tools** (1 files)

- `tests/mcp-tools/workflow-upload-visibility.test.ts` — 4 tests 🟢

### health

**1 files, 4 tests**

**e2e** (1 files)

- `tests/e2e/admin-ui-security-status.spec.ts` — 4 tests 🟢

### help-system

**1 files, 26 tests**

**unit** (1 files)

- `tests/unit/mcp-server/get-help-mdx.test.ts` — 26 tests 🟢

### http-infrastructure

**5 files, 62 tests**

**unit** (3 files)

- `tests/unit/web-backend/client-logs.test.ts` — 23 tests 🟢
- `tests/unit/web-backend/headers.test.ts` — 8 tests 🟢
- `tests/unit/web-backend/request-body-logger.test.ts` — 19 tests 🟢

**api** (2 files)

- `tests/api/notification-test-api.test.ts` — 6 tests 🟢
- `tests/api/request-body-logging.test.ts` — 6 tests 🟢

### i18n

**9 files, 71 tests**

**unit** (1 files)

- `tests/unit/web-frontend/i18n.test.ts` — 3 tests 🟢

**e2e** (8 files)

- `tests/e2e/i18n-stage1-verification.spec.ts` — 3 tests 🟢
- `tests/e2e/i18n-stage2-admin-verification.spec.ts` — 6 tests 🟢
- `tests/e2e/i18n-stage2-layout.spec.ts` — 4 tests 🟢
- `tests/e2e/i18n-stage3-pages.spec.ts` — 8 tests 🟢
- `tests/e2e/i18n-stage4-admin.spec.ts` — 12 tests 🟢
- `tests/e2e/i18n-stage4-functionality-check.spec.ts` — 26 tests 🟢
- `tests/e2e/i18n-stage5-language-switcher.spec.ts` — 6 tests 🟢
- `tests/e2e/i18n-url-param.spec.ts` — 3 tests 🟢

### infrastructure

**4 files, 87 tests**

**unit** (3 files)

- `tests/unit/scripts/detect-test-env.test.ts` — 8 tests 🟢
- `tests/unit/scripts/remigrate-registry-schemas.test.ts` — 31 tests 🟢 (registry schema restoration: strengthen type-guard, mergeOldSchemas safe merge/union/absence-unbounded/items-properties-reconcile/required-intersection, gate-enum inference, collectExpressionTargets counter-guard, bumpMinor)
- `tests/unit/shared/version-utils.test.ts` — 33 tests 🟢 (including root-only catalog metadata normalization without masking nested graph content)

### input-parsing

**4 files, 60 tests**

**unit** (1 files)

- `tests/unit/mcp-server/input-parser-simple.test.ts` — 31 tests 🟢

**integration** (1 files)

- `tests/integration/input-enhancement.test.ts` — 1 tests 🟢

**mcp-tools** (1 files)

- `tests/mcp-tools/json-formatting.test.ts` — 5 tests 🟢

**functional** (1 files)

- `tests/functional/input-parsing-functional.test.ts` — 23 tests 🟢

### inspector

**1 files, 1 tests**

**e2e** (1 files)

- `tests/e2e/inspector-mcp-tools.spec.ts` — 1 tests 🟢

### mcp-tools

**14 files, 129 tests**

**unit** (2 files)

- `tests/unit/scripts/workflow-tool-identity.test.ts` — 6 tests 🟢 (set-name and set-slug: exact replacement, kebab-case validation, catalog-entry warning, version bump, and no collateral change to slug/owner/description/nodes)
- `tests/unit/scripts/workflow-tool-variables.test.ts` — 22 tests 🟢 (incl. registry-backed globals, metadata, replace/sync, End projection/path qualification, and inert-retry migration)
- `tests/unit/services/mcp-text-service.test.ts` — 37 tests 🟢

**integration** (5 files)

- `tests/integration/cli-mcp-parity.test.ts` — 16 tests 🟢
- `tests/integration/essential-cases-split.test.ts` — 2 tests 🟢
- `tests/integration/get-current-step-enhanced.test.ts` — 3 tests 🟢 (including read-only materialize re-presentation versus empty public `step()` completion)
- `tests/integration/mcp-text-service.test.ts` — 12 tests 🟢
- `tests/integration/step-response-child-info.test.ts` — 4 tests 🟡

**api** (4 files)

- `tests/api/auth/mcp-blocked-user.test.ts` — 3 tests 🟢
- `tests/api/auth/mcp-protection.test.ts` — 2 tests 🟢
- `tests/api/auth/mcp-version-check.test.ts` — 3 tests 🟢
- `tests/api/mcp-spec.test.ts` — 1 tests 🟢

**mcp-tools** (1 files)

- `tests/mcp-tools/new-features.test.ts` — 19 tests 🟢

**e2e** (2 files)

- `tests/e2e/mcp-prompts.spec.ts` — 11 tests 🟢
- `tests/e2e/workflow-toolbar-redesign.spec.ts` — 5 tests 🟢

### mcp-clients

**1 files, 42 tests**

**unit** (1 files)

- `tests/unit/shared/mcp-clients.test.ts` — 42 tests 🟢

### metrics

**1 files, 20 tests**

**unit** (1 files)

- `tests/unit/shared/metrics.test.ts` — 20 tests 🟢

### node-handlers

**1 files, 6 tests**

**unit** (1 files)

- `tests/unit/workflow-engine/telegram-handler-errors.test.ts` — 6 tests 🟢

### notes

**7 files, 166 tests**

**unit** (2 files)

- `tests/unit/shared/note-repository.test.ts` — 46 tests 🟢
- `tests/unit/shared/note-service.test.ts` — 42 tests 🟢

**integration** (1 files)

- `tests/integration/execution-note.test.ts` — 8 tests 🟡

**api** (1 files)

- `tests/api/notes-api.test.ts` — 29 tests 🟢

**mcp-tools** (1 files)

- `tests/mcp-tools/notes-tool.test.ts` — 25 tests 🟢

**e2e** (2 files)

- `tests/e2e/note-nodes-rendering.spec.ts` — 3 tests 🟢
- `tests/e2e/notes-management.spec.ts` — 13 tests 🟢

### execution-lock

**9 files, 79 tests**

**unit** (2 files)

- `tests/unit/shared/lock-service.test.ts` — 30 tests 🟢
- `tests/unit/web-backend/telegram-webhook.test.ts` — 7 tests 🟢

**workflow** (1 files)

- `tests/workflow/scenarios/lock-node.test.ts` — 5 tests 🟢

**mcp-tools** (2 files)

- `tests/mcp-tools/lock-tool.test.ts` — 11 tests 🟢
- `tests/mcp-tools/lock-step-integration.test.ts` — 5 tests 🟢 (incl. malformed-Telegram-token resilience: lock step still pauses, start() does not crash)

**api** (2 files)

- `tests/api/admin-lock-management.test.ts` — 7 tests 🟢
- `tests/api/user-lock-management.test.ts` — 8 tests 🟢

**e2e** (1 files)

- `tests/e2e/user-lock-management.spec.ts` — 13 tests 🟢

### other

**3 files, 24 tests**

**integration** (1 files)

- `tests/integration/admin-definition-to-ui.test.ts` — 2 tests 🟢

**e2e** (2 files)

- `tests/e2e/admin-monitoring-test.spec.ts` — 13 tests 🟢
- `tests/e2e/admin-panel.spec.ts` — 9 tests 🟢

### rate-limiting

**2 files, 13 tests**

**integration** (1 files)

- `tests/integration/cors-rate-limit-middleware.test.ts` — 5 tests 🟢 (CORS origin allowlist: allowlisted/localhost reflected, disallowed/no-origin; rate-limit IPv6 key fallback via ipKeyGenerator avoids ERR_ERL_KEY_GEN_IPV6)

**unit** (1 files)

- `tests/unit/web-backend/rate-limit-bypass.test.ts` — 8 tests 🟢

### security

**2 files, 49 tests**

**unit** (2 files)

- `tests/unit/services/encryption.test.ts` — 14 tests 🟢
- `tests/unit/shared/logging/sanitize-input.test.ts` — 35 tests 🟢

### settings

**11 files, 142 tests**

**unit** (2 files)

- `tests/unit/services/global-settings-service.test.ts` — 9 tests 🟢
- `tests/unit/services/settings-repository.test.ts` — 14 tests 🟢

**integration** (3 files)

- `tests/integration/database/global-settings-repository.test.ts` — 19 tests 🟢
- `tests/integration/mcp-settings-tools.test.ts` — 7 tests 🟢
- `tests/integration/telegram-user-settings.test.ts` — 3 tests 🟢

**api** (3 files)

- `tests/api/admin-settings-api.test.ts` — 18 tests 🟢
- `tests/api/global-settings-api.test.ts` — 12 tests 🟢
- `tests/api/settings-api.test.ts` — 18 tests 🟢

**mcp-tools** (1 files)

- `tests/mcp-tools/user-settings.test.ts` — 5 tests 🟢

**e2e** (2 files)

- `tests/e2e/admin-settings.spec.ts` — 32 tests 🟢
- `tests/e2e/settings-page.spec.ts` — 5 tests 🟢

### sharing

**5 files, 125 tests**

**unit** (1 files)

- `tests/unit/shared/workflow-sharing-repository.test.ts` — 46 tests 🟢

**integration** (1 files)

- `tests/integration/workflow-sharing-service.test.ts` — 33 tests 🟢

**api** (1 files)

- `tests/api/workflow-sharing-api.test.ts` — 17 tests 🟢

**mcp-tools** (1 files)

- `tests/mcp-tools/workflow-sharing.test.ts` — 17 tests 🟢

**e2e** (1 files)

- `tests/e2e/workflow-sharing.spec.ts` — 12 tests 🟢

### slug-handle

**4 files, 56 tests**

**integration** (2 files)

- `tests/integration/database/upload-pipeline-slug.test.ts` — 10 tests 🟢
- `tests/integration/mcp-slug-operations.test.ts` — MCP completion-marker/session equality for Todo's empty terminal result, parent linkage, and optional-output omission 🟢

**api** (2 files)

- `tests/api/user-handle-api.test.ts` — 12 tests 🟢
- `tests/api/workflow-slug-api.test.ts` — 15 tests 🟢

### storage

**1 files, 42 tests**

**unit** (1 files)

- `tests/unit/scripts/prompt-migration.test.ts` — 42 tests 🟢 (including safe cleanup of removed managed agent overrides and preservation of manually edited values as conflicts)

### telegram

**2 files, 18 tests**

**unit** (1 files)

- `tests/unit/mcp-server/telegram-preflight.test.ts` — 12 tests 🟢

**integration** (1 files)

- `tests/integration/start-workflow-telegram-preflight.test.ts` — 6 tests 🟢

### template-engine

**2 files, 6 tests**

**integration** (2 files)

- `tests/integration/advanced-templates.test.ts` — 2 tests 🟢
- `tests/integration/telegram-template-verification.test.ts` — 4 tests 🟢

### tokens

**2 files, 24 tests**

**integration** (1 files)

- `tests/integration/workflow-file-tokens.test.ts` — 13 tests 🟢 (including fixed five-minute materialize TTL, grant binding, and atomic one-use claim)

**mcp-tools** (1 files)

- `tests/mcp-tools/workflow-tokens.test.ts` — 11 tests 🟢

### url-routing

**4 files, 56 tests**

**unit** (4 files)

- `tests/unit/docs/docs-package-structure.test.ts` — 3 tests 🟢 (packages/docs Starlight extraction: docs content at packages/docs (old landing-page location gone); EN/RU parity (same relative .mdx file set); every astro.config sidebar slug resolves to a real EN .mdx)
- `tests/unit/shared/remote-url-resolver.test.ts` — 10 tests 🟢
- `tests/unit/shared/url-config.test.ts` — 19 tests 🟢
- `tests/unit/web-frontend/return-url.test.ts` — 14 tests 🟢
- `tests/unit/web-frontend/routes.test.ts` — 13 tests 🟢

### user-admin-resolution

**1 files, 2 tests**

**integration** (1 files)

- `tests/integration/user-admin-resolution.test.ts` — 2 tests 🟢 (getAdminUserIds: active admins only, excludes non-admins + blocked admins; service delegates to repo)

### user-blocking

**3 files, 27 tests**

**integration** (1 files)

- `tests/integration/user-blocking.test.ts` — 20 tests 🟢

**e2e** (2 files)

- `tests/e2e/user-blocking-api.spec.ts` — 4 tests 🟢
- `tests/e2e/user-blocking.spec.ts` — 3 tests 🟢

### user-management

**3 files, 34 tests**

**api** (1 files)

- `tests/api/user-profile-api.test.ts` — 15 tests 🟢

**e2e** (2 files)

- `tests/e2e/user-menu.spec.ts` — 10 tests 🟢
- `tests/e2e/user-profile.spec.ts` — 9 tests 🟢

### validation

**4 files, 90 tests**

**unit** (2 files)

- `tests/unit/shared/slug-handle-validation.test.ts` — 54 tests 🟢
- `tests/unit/shared/workflow-validation-cache.test.ts` — 28 tests 🟢

**integration** (1 files)

- `tests/integration/validation-loops.test.ts` — 2 tests 🟢

**api** (1 files)

- `tests/api/workflow-validation-caching.test.ts` — 6 tests 🟢

### web-ui

**7 files, 41 tests**

**unit** (2 files)

- `tests/unit/web-frontend/compact-node.test.tsx` — 3 tests 🟢 (same-node refresh of materialize tooltip, validation text, and subgraph navigation callback)
- `tests/unit/web-frontend/quick-start-card.test.ts` — 14 tests 🟢 (i18n completeness, config/deeplink generation, setupType consistency, + resolveMcpUrl deployment-mode gating: self-host runtime, self-host baked fallback, saas baked, null mode baked)

**e2e** (5 files)

- `tests/e2e/dashboard.spec.ts` — 10 tests 🟢
- `tests/e2e/mobile-navigation.spec.ts` — 3 tests 🟢
- `tests/e2e/sidebar.spec.ts` — 10 tests 🟢
- `tests/e2e/theme-integration.spec.ts` — 1 tests 🟢
- `tests/e2e/theme-loading-state.spec.ts` — 3 tests 🟢

### workflow-engine

**69 files, 924 tests**

**unit** (11 files)

- `tests/unit/config/nginx-sensitive-logging.test.ts` — 2 tests 🟢 (both shipped nginx modes suppress materialize grant URLs from access logs)
- `tests/unit/shared/logging/express-middleware.test.ts` — 3 tests 🟢 (materialize grant redaction with routing/query preservation and unrelated-URL non-regression)
- `tests/unit/web-backend/execution-materialize.test.ts` — 5 tests 🟢 (current-definition fetch, execution binding, tar response, one-use endpoint behavior, non-consumption on render overflow, and expected-4xx versus unexpected-boundary error mapping)
- `tests/unit/logging/compute-changes.test.ts` — 11 tests 🟢
- `tests/unit/shared/workflow-query-service.test.ts` — 45 tests 🟢 (incl. setWorkflowVariable preserves rich schema)
- `tests/unit/shared/workflow-catalog.test.ts` — 19 tests 🟢 (catalog identity/ownership metadata is excluded from the executable graph; readWorkflowCatalogs multi-dir merge: union, later-dir-wins precedence on (owner,slug) collision, per-owner duplicate slugs preserved, missing/empty dirs skipped, single-dir == readWorkflowCatalog; getWorkflowsDirs config: default, WORKFLOWS_DIR fallback, colon-separated WORKFLOWS_DIRS, empty-segment drop)
- `tests/unit/web-frontend/workflow-transformer.test.ts` — 20 tests 🟢 (including materialize registration on the shared CompactNode, factory output, frontend validation boundaries, content-free file summary data, success/error edge styling, and no fallback warning)
- `tests/unit/workflow-engine/variable-resolver.test.ts` — 9 tests 🟢
- `tests/unit/workflow-engine/registry-converter.test.ts` — 13 tests 🟢
- `tests/unit/workflow-engine/node-output-scope.test.ts` — 14 tests 🟢 (incl. whole-descriptor inlining: enum/items/pattern/properties + end-to-end rejection)
- `tests/unit/workflow-engine/in-memory-terminal-result.test.ts` — 7 tests 🟢 (strict terminal-envelope preservation, owner-identity validation, and fail-closed malformed/falsy-result rejection)

**integration** (14 files)

- `tests/integration/workflow-file-tokens.test.ts` — 13 tests 🟢 (upload/download lifecycle plus five-minute materialize TTL boundary, real SQLite grant-failure normalization, user/execution/node binding, and atomic one-use claim)
- `tests/integration/agent-response-contract.test.ts` — 3 tests 🟢
- `tests/integration/workflow-catalog-loader.test.ts` — 14 tests 🟢 (owner/visibility mapping, version-aware idempotence including persisted legacy root catalog metadata, missing owners, content mismatch, cross-owner isolation, soft-deleted restoration, explicit previous-slug migration without duplicate catalog entries, and multi-directory merge/install behavior)
- `tests/integration/database/workflow-privacy-defaults.test.ts` — 2 tests 🟡
- `tests/integration/manage-workflow-actions.test.ts` — 32 tests 🟢
- `tests/integration/manage-workflow-new-actions.test.ts` — 29 tests 🟢
- `tests/integration/step-on-completed-workflow.test.ts` — 5 tests 🟢
- `tests/integration/subgraph-agent-transparency.test.ts` — 3 tests 🟢
- `tests/integration/subgraph-nested-levels.test.ts` — three-level execution plus Todo's exact empty terminal result at root/one/nested levels with persisted reload 🟢
- `tests/integration/subgraph-performance.test.ts` — 2 tests 🟡
- `tests/integration/subgraph-sequential.test.ts` — 1 tests 🟢
- `tests/integration/workflow-mutation-service.test.ts` — 18 tests 🟢
- `tests/integration/workflow-outputs.test.ts` — 3 tests 🟡
- `tests/integration/workflow-pagination.test.ts` — 7 tests 🟢

**workflow** (28 files)

- `tests/workflow/engine/agent-directive-validation.test.ts` — 9 tests 🟢
- `tests/workflow/engine/catalog-validation.test.ts` — 11 tests 🟢 (incl. pinned 43-path/13-workflow End migration inventory, real four-scope terminal projections, workspace_path guard, numeric counter-pinning, and subgraph error routes)
- `tests/workflow/engine/agent-message-queue.test.ts` — 9 tests 🟢
- `tests/workflow/engine/context-mapper.test.ts` — 15 tests 🟢
- `tests/workflow/engine/cycle-detector.test.ts` — 6 tests 🟢
- `tests/workflow/engine/error-formatting.test.ts` — 11 tests 🟢
- `tests/workflow/engine/expression-handler.test.ts` — 23 tests 🟢 (ordered scalar/member/fingerprint projection, undeclared-target rejection, atomic registry-default reset/rollback, JSON-assignment metadata, content-free error-edge routing and error context)
- `tests/workflow/engine/expression-parser.test.ts` — 61 tests 🟢 (safe numeric/dynamic array reads, closed reset parsing, bounds, prototype rejection, bare-only assignment targets)
- `tests/workflow/engine/max-nodes-validation.test.ts` — 4 tests 🟢
- `tests/workflow/engine/node-handlers.test.ts` — 19 tests 🟢 (including strict empty/nested/missing End projection and runtime-input rejection)
- `tests/workflow/engine/node-type-validation.test.ts` — 23 tests 🟢
- `tests/workflow/engine/materialize-node.test.ts` — 10 tests 🟢 (materialize schema/source-default contract, handler directive summary, expected/unexpected preparation failures, isolated re-presentation that cannot traverse an error connection, shell encoding, current-registry rendering, tar output, path safety, collision detection, and exact resource boundaries)
- `tests/workflow/engine/note-handlers.test.ts` — 34 tests 🟢
- `tests/workflow/engine/note-node-validation.test.ts` — 15 tests 🟢
- `tests/workflow/engine/path-resolver.test.ts` — 31 tests 🟢
- `tests/workflow/engine/registry-default-seeding.test.ts` — 4 tests 🟢
- `tests/workflow/engine/registry-schema-model.test.ts` — 6 tests 🟢 (registry entry = full JSON Schema)
- `tests/workflow/engine/registry-schema-validation.test.ts` — 5 tests 🟢 (registry entry compiled as JSON Schema; malformed → blocking)
- `tests/workflow/engine/schema-validator-agent-format.test.ts` — 16 tests 🟢
- `tests/workflow/engine/subgraph-delegation.test.ts` — 9 tests 🟢
- `tests/workflow/engine/subgraph-handler-simple.test.ts` — 6 tests 🟢 (including discriminated child-failure provenance)
- `tests/workflow/engine/subgraph-handler.test.ts` — 16 tests 🟢
- `tests/workflow/engine/subgraph-validation.test.ts` — 16 tests 🟢
- `tests/workflow/engine/system-reminder-priority.test.ts` — 10 tests 🟢
- `tests/workflow/engine/telegram-services.test.ts` — 36 tests 🟢
- `tests/workflow/engine/template-processor.test.ts` — 127 tests 🟢
- `tests/workflow/engine/template-validation.test.ts` — 17 tests 🟢
- `tests/workflow/engine/unified-validation.test.ts` — 18 tests 🟢 (includes teleport reachability: a node reachable only through a teleport is not reported, a genuinely orphaned node still is)
- `tests/workflow/engine/validation-error-messages.test.ts` — 15 tests 🟢

**api** (4 files)

- `tests/api/workflow-copy.test.ts` — 6 tests 🟢
- `tests/api/workflow-list-performance.test.ts` — 5 tests 🟢
- `tests/api/workflow-visibility-patch.test.ts` — 6 tests 🟢
- `tests/api/workflows-privacy.test.ts` — 4 tests 🟢

**mcp-tools** (5 files)

- `tests/mcp-tools/workflow-crud.test.ts` — 11 tests 🟢
- `tests/mcp-tools/workflow-documentation.test.ts` — 13 tests 🟢
- `tests/mcp-tools/workflow-ownership.test.ts` — 22 tests 🟢
- `tests/mcp-tools/workflow-pagination.test.ts` — 4 tests 🟢
- `tests/mcp-tools/workflow-search.test.ts` — 6 tests 🟢

**e2e** (7 files)

- `tests/e2e/workflow-canvas-controls.spec.ts` — 4 tests 🟢
- `tests/e2e/workflow-card-compact.spec.ts` — 7 tests 🟢
- `tests/e2e/workflow-copy-button.spec.ts` — 5 tests 🟢
- `tests/e2e/workflow-delete-restore.spec.ts` — 2 tests 🟢
- `tests/e2e/workflow-list-performance.spec.ts` — 4 tests 🟢
- `tests/e2e/workflow-visibility-toggle.spec.ts` — 4 tests 🟢
- `tests/e2e/workflow-visibility.spec.ts` — 4 tests 🟢

### workflow-scenarios

**33 files, 154 tests**

**workflow** (33 files)

- `tests/workflow/scenarios/architecture-design-flow.test.ts` — 4 tests 🔴
- `tests/workflow/scenarios/artifacts-demo-dashboard-builder.test.ts` — 4 tests 🟢
- `tests/workflow/scenarios/artifacts-demo-report-publisher.test.ts` — 4 tests 🟢
- `tests/workflow/scenarios/bug-hunting-workflow.test.ts` — 4 tests 🟡
- `tests/workflow/scenarios/conditional-branching.test.ts` — 3 tests 🟢
- `tests/workflow/scenarios/content-creation.test.ts` — 4 tests 🔴
- `tests/workflow/scenarios/coverage.test.ts` — 11 tests 🟢
- `tests/workflow/scenarios/data-analysis.test.ts` — 4 tests 🔴
- `tests/workflow/scenarios/development-workflow.test.ts` — 13 tests 🟢 (source-grounded filesystem-first state/authority contract; operating-mode routing with an autonomous run that skips the requirements gate; local test-adequacy and architecture gates plus the delegated per-unit completeness review with its repair loop; the teleport replan entry returning through plan revision; conditional screenshot/HTML directives; representative baseline, planning, repair, replan, runtime, expensive, affected-documentation, documentation-repair reach, accepted-unit checkpoint success/repository-failure/abort, final acceptance/reconciliation, rejection, and abort routes; 100% node/branch scenario coverage, the five addressed standards rendered only by the workspace owner, the flow-named workspace, and the reviewer contract living in one place; every per-unit gate naming the baseline the unit's account opens with, with the four subject/staleness rules present in the review standard; the unit's account living at one per-unit address, no per-round implementation report addressed anywhere, every unit-changing repair owner obliged to leave that account true, and the report/account rules present in the review standard; the finding that belongs to the delivered work while the run's own records are corrected in place, with the reviewer's boundary at the repository and the bar unmoved for a record claiming work never done; documentation reconciled again only when the documentation or the behaviour it describes moved, with no added enum value and no memory-based decision; executable reconciliation and spreading documentation repair both writing the exact closed-round repair record and refreshing the durable unit account before the next code gate consumes those paths; the reach of a repair declared by the repairer with a required two-value enum, routed by the eight reach conditions, each naming what its own gate's `contained` protects, never mentioned by a reviewer, and with the two VCS repair owners split so neither chooses between two sources; the contained routes of the checkpoint, finalization, feature-wide and final-semantic repairs returning to their own gates without the unit chain; and the observable difference between the two routes — a contained repair returns to its own gate with the cheap gate run once, a spreading one runs it twice; the round counter owned by the engine — three expression writers, no agent schema carrying it, every repair naming the round record it writes, a two-repair run ending on the third round, and a contained completeness repair in round 2 handing that exact round's record to the reviewer; and the plan-revision counter owned by the engine — four expression advancers that keep the previous number for rendering, no schema carrying the number, both revision paths named in every revision directive, and a rejected plan reaching revision 2)
- `tests/workflow/scenarios/execution-retrospective.test.ts` — 4 tests 🟢 (catalog identity/version, exact archive materialization, sufficient/partial/unavailable semantic fixtures, independent analysis/final review oracles, proposal-only authority, all nodes/branches and contained/spreading repair routes)
- `tests/workflow/scenarios/directive-validation.test.ts` — 4 tests 🟡
- `tests/workflow/scenarios/iterative-research.test.ts` — 4 tests 🟡
- `tests/workflow/scenarios/lock-node.test.ts` — 3 tests 🔴
- `tests/workflow/scenarios/marketing-campaign.test.ts` — 4 tests 🟡
- `tests/workflow/scenarios/notes-demo-metrics-collector.test.ts` — 4 tests 🟢
- `tests/workflow/scenarios/notes-demo-metrics-reporter.test.ts` — 4 tests 🟢
- `tests/workflow/scenarios/prd-creation.test.ts` — 4 tests 🟡
- `tests/workflow/scenarios/quick-task.test.ts` — 8 tests 🟢 (4 behavioral runs including an autonomous run that skips the plan-approval gate and a mid-execution replan jump: filesystem workspace and immutable iteration paths, bounded typed path outputs, disk-only feedback/findings/evidence, minimal global state, clean execution, plan repair and user revision, the jump-only replan entry with its abuse boundary and route-independent revise-plan directive, resumption at the preserved cursor, result repair and rework, empty End output, and 100% node/branch coverage)
- `tests/workflow/scenarios/deep-corpus-research.test.ts` — 6 tests 🟢 (catalog identity that cannot be confused with Robust Task, cost and consent markers in name/description, the consent gate enforced in the entry node in both modes, operating-mode routing with both notification outcomes, evidence-based bounded gates)
- `tests/workflow/scenarios/robust-task.test.ts` — 3 tests 🟢 (filesystem-only durable state and native-routing contract; complete, plan repair/rejection, ordinary retry, verifier and teleport replanning, retry-exhaustion retry/replan/incomplete delivery, criteria/final repair and explicit loop-bound decisions; 100% node/branch scenario coverage; operating-mode routing with an autonomous run that skips the plan-approval gate)
- `tests/workflow/scenarios/smart-purchase-assistant.test.ts` — 4 tests 🔴
- `tests/workflow/scenarios/software-development-flow-lite.test.ts` — 4 tests 🔴
- `tests/workflow/scenarios/startup-idea-validation.test.ts` — 4 tests 🔴
- `tests/workflow/scenarios/telegram-setup.test.ts` — 4 tests 🟢
- `tests/workflow/scenarios/test-generation.test.ts` — 4 tests 🔴
- `tests/workflow/scenarios/test-planning.test.ts` — 4 tests 🟡
- `tests/workflow/scenarios/test-suite-audit.test.ts` — 4 tests 🔴
- `tests/workflow/scenarios/todo-list.test.ts` — 8 tests 🟢 (minimal registry and graph contract, absence of a per-workflow system reminder with its rules carried by the execute node, unified planning/supplied-task intake, unchanged typed supplied tasks, one-based projection, local evidence bounds and malformed-input retry, empty End output, the mid-run revision teleport (jump-only entry, engine-derived total and cursor, resume without re-executing completed tasks), and reachable node/branch coverage)
- `tests/workflow/scenarios/user-onboarding.test.ts` — 4 tests 🟢
- `tests/workflow/scenarios/ux-design.test.ts` — 4 tests 🟡
- `tests/workflow/scenarios/verified-research.test.ts` — 4 tests 🟡
- `tests/workflow/scenarios/workflow-management-flow.test.ts` — 2 tests 🟢 (embedded authoring policy, minimal state contract and the operating-mode routing contract; create/edit/audit/review/publication/error/local-sync routes plus both autonomous paths and the process-revision teleport, and the embedded reference sections including the addressed-reference pattern and its antipattern, with 100% node/branch scenario coverage)
- `tests/workflow/scenarios/workflow-presentation-generator.test.ts` — 5 tests 🟡

## Agent Instructions

### When Adding Tests

1. Identify the domain for the functionality being tested
2. Check which levels already have coverage for that domain
3. Add tests at the appropriate level (see TESTING-GUIDE.md)
4. Update this file: add the new test file entry under the correct domain and level

### When Deleting Tests

1. Remove the entry from this file
2. Update the domain file/test counts

### When Moving Tests

1. Remove entry from old location
2. Add entry to new location
3. Update counts in both domains/levels

### Assertion Density Indicators

- 🟢 Good (≥0.10 assertions/line)
- 🟡 Acceptable (0.03–0.10)
- 🔴 Low (<0.03) — consider adding assertions
