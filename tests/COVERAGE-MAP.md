# Test Coverage Map

Mapping of test files to functional domains and test levels.
Agents MUST update this file when adding, moving, or deleting tests.

## Summary

- **47 domains**, **320 files**, **3761 tests**
- Levels: unit, integration, workflow, api, mcp-tools, e2e, functional

## Domain Overview

| Domain              | Files | Tests | Levels                                                         |
| ------------------- | ----- | ----- | -------------------------------------------------------------- |
| admin               | 10    | 113   | api:3, unit:1, e2e:6                                           |
| api-tokens          | 5     | 79    | unit:1, api:2, mcp-tools:1, e2e:1                              |
| artifacts           | 8     | 179   | api:1, e2e:3, mcp-tools:3, unit:1                              |
| audit               | 4     | 66    | e2e:1, integration:2, mcp-tools:1                              |
| auth                | 16    | 112   | api:4, e2e:10, integration:2                                   |
| chat                | 3     | 53    | integration:1, unit:2                                          |
| context             | 7     | 73    | integration:2, mcp-tools:1, unit:4                             |
| deployment-mode     | 8     | 50    | unit:4, integration:1, api:2, e2e:1                            |
| email               | 1     | 22    | unit:1                                                         |
| self-host-limits    | 2     | 12    | unit:2                                                         |
| pin-hash            | 1     | 7     | unit:1                                                         |
| error-handling      | 11    | 127   | api:1, e2e:2, integration:2, mcp-tools:1, unit:5               |
| execution           | 13    | 108   | api:1, e2e:3, integration:5, mcp-tools:3, unit:1               |
| execution-lock      | 9     | 79    | unit:2, workflow:1, mcp-tools:2, api:2, e2e:1                  |
| expressions         | 4     | 16    | api:1, e2e:1, mcp-tools:2                                      |
| file-transfer       | 1     | 4     | mcp-tools:1                                                    |
| health              | 1     | 4     | e2e:1                                                          |
| help-system         | 1     | 26    | unit:1                                                         |
| http-infrastructure | 5     | 62    | api:2, unit:3                                                  |
| i18n                | 11    | 100   | e2e:10, unit:1                                                 |
| infrastructure      | 4     | 87    | unit:4                                                         |
| input-parsing       | 4     | 60    | functional:1, integration:1, mcp-tools:1, unit:1               |
| inspector           | 1     | 1     | e2e:1                                                          |
| marketplace         | 27    | 215   | unit:11, integration:2, api:4, mcp-tools:1, e2e:6              |
| marketplace-render  | 2     | 31    | unit:2                                                         |
| mcp-clients         | 2     | 50    | e2e:1, unit:1                                                  |
| mcp-tools           | 14    | 128   | api:4, e2e:2, integration:5, mcp-tools:1, unit:2               |
| metrics             | 1     | 20    | unit:1                                                         |
| node-handlers       | 1     | 6     | unit:1                                                         |
| notes               | 7     | 166   | api:1, e2e:2, integration:1, mcp-tools:1, unit:2               |
| other               | 3     | 24    | e2e:2, integration:1                                           |
| rate-limiting       | 2     | 13    | integration:1, unit:1                                          |
| security            | 2     | 49    | unit:2                                                         |
| settings            | 11    | 142   | api:3, e2e:2, integration:3, mcp-tools:1, unit:2               |
| sharing             | 5     | 125   | api:1, e2e:1, integration:1, mcp-tools:1, unit:1               |
| slug-handle         | 4     | 52    | api:2, integration:2                                           |
| storage             | 1     | 34    | unit:1                                                         |
| telegram            | 2     | 18    | integration:1, unit:1                                          |
| template-engine     | 2     | 6     | integration:2                                                  |
| tokens              | 2     | 21    | integration:1, mcp-tools:1                                     |
| url-routing         | 5     | 65    | unit:5                                                         |
| user-blocking       | 3     | 27    | e2e:2, integration:1                                           |
| user-management     | 3     | 34    | api:1, e2e:2                                                   |
| validation          | 4     | 90    | api:1, integration:1, unit:2                                   |
| web-ui              | 7     | 61    | e2e:7                                                          |
| workflow-engine     | 63    | 835   | api:5, e2e:7, integration:13, mcp-tools:5, unit:7, workflow:26 |
| workflow-scenarios  | 23    | 138   | workflow:23                                                    |

## Domain Details

### admin

**10 files, 113 tests**

**api** (3 files)

- `tests/api/admin-analytics.test.ts` — 38 tests 🟢
- `tests/api/admin-user-security-api.test.ts` — 11 tests 🟢
- `tests/api/admin-user-security.test.ts` — 10 tests 🟢

**unit** (1 file)

- `tests/unit/web-backend/operational-metrics.test.ts` — 9 tests 🟢

**e2e** (6 files)

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

**8 files, 50 tests**

**unit** (4 files)

- `tests/unit/shared/deployment-mode-config.test.ts` — 10 tests 🟢 (DEPLOYMENT_MODE resolution: default self-host, case/whitespace normalization, invalid-value throws, isSelfHost/isSaas predicates)
- `tests/unit/shared/feature-resolver.test.ts` — 9 tests 🟢 (ModeFeatureResolver per-mode flags, unknown-feature safe default, singleton get/override/reset)
- `tests/unit/shared/secrets-bootstrap.test.ts` — 8 tests 🟢 (self-host secret generation+persist, mask vs expose, no-regenerate-when-present, restart idempotency, saas no-op, loadPersistedSecrets no-override + absent-file)
- `tests/unit/shared/deployment-mode-safeguard.test.ts` — 6 tests 🟢 (unset-DEPLOYMENT_MODE safeguard: production+public→error/refuse-boot, non-prod+public→warn, mode-set/localhost/127.x/empty-host→ok)

**integration** (1 file)

- `tests/integration/auth-mode-gating.test.ts` — 5 tests 🟢 (auth gate contract per mode: legalConsents/emailVerificationGate/verificationEmailOnSignup/openRegistration OFF in self-host, ON in saas; MCP/token issuance without verification in self-host)

**api** (2 files)

- `tests/api/auth/self-host-auth.test.ts` — 2 tests 🟢 (HTTP self-host auth branch: open registration closed (REGISTRATION_DISABLED) vs saas consent-enforced; admin token issuance on requireVerifiedAuth route; mode auto-detected from sign-up behavior)
- `tests/api/marketplace-file-transfer.test.ts` — 6 tests 🟢 (self-host export/import endpoints over HTTP: GET /api/workflows/:id/export downloads a `.moira.json` portable envelope (moiraFile/formatVersion/source.workflowId + workflow graph); export→import round-trips into an independent library copy (fresh id, appears in me/library); non-JSON / non-workflow files → 400; import requires auth → 401; **storefront download → import round-trip (D-A): GET /api/public/marketplace/listings/:h/:s/export returns the envelope with source.listingId and that exact file imports → 201 and lands in the library**; **re-import of an updated storefront flow updates in place (D-B): bump source to v2, re-download, re-import → updated=true, same workflowId, version 2.0.0, no duplicate**)
- `tests/api/features-api.test.ts` — 5 tests 🟢 (public GET /api/features contract: no-auth 200 + {success,data,timestamp} envelope; valid deploymentMode; boolean for every gated feature flag, exact key set; runtime-resolved mcpUrl is an absolute http(s) URL ending in /mcp on the request host; public-store promotion gate shape — boolean promotionEnabled + absolute store URL, true on the non-store test container)

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

**12 files, 135 tests**

**unit** (5 files)

- `tests/unit/mcp-server/error-logging-levels.test.ts` — 6 tests 🟢
- `tests/unit/mcp-server/error-sanitizer.test.ts` — 10 tests 🟢
- `tests/unit/shared/domain-errors.test.ts` — 28 tests 🟢
- `tests/unit/shared/errors/app-error.test.ts` — 32 tests 🟢
- `tests/unit/web-backend/error-sanitizer.test.ts` — 17 tests 🟢

**integration** (3 files)

- `tests/integration/error-logging-flow.test.ts` — 6 tests 🟢
- `tests/integration/subgraph-error-scenarios.test.ts` — 2 tests 🟢
- `tests/integration/error-code-taxonomy.test.ts` — 8 tests 🟢 (HTTP error boundary surfaces specific domain codes, not generic INTERNAL_ERROR, with correct status (D-N3): already-listed→409 WORKFLOW_ALREADY_LISTED, listing/workflow not-owner→403 LISTING_ACCESS_DENIED/WORKFLOW_ACCESS_DENIED, self-rate→403 SELF_RATING_FORBIDDEN, marketplace-disabled→MARKETPLACE_DISABLED, invalid-rating→INVALID_RATING, listed-cannot-go-private→409; none collapse to INTERNAL_ERROR)

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

- `tests/unit/shared/execution-repository-errors.test.ts` — 21 tests 🟢

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
- `tests/mcp-tools/workflow-import-run.test.ts` — 1 test 🟢 (Step 16 runnability: one user creates + exports a flow over HTTP, imports the file into their library (POST /api/marketplace/import, no cloud call), then starts the IMPORTED workflow via the MCP `start` tool — the offline-adopted flow runs like any owned flow, returning a process id)
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
- `tests/unit/shared/version-utils.test.ts` — 32 tests 🟢

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

**14 files, 128 tests**

**unit** (2 files)

- `tests/unit/scripts/workflow-tool-variables.test.ts` — 15 tests 🟢 (incl. registry-backed get/set/delete-variable)
- `tests/unit/services/mcp-text-service.test.ts` — 37 tests 🟢

**integration** (5 files)

- `tests/integration/cli-mcp-parity.test.ts` — 16 tests 🟢
- `tests/integration/essential-cases-split.test.ts` — 2 tests 🟢
- `tests/integration/get-current-step-enhanced.test.ts` — 2 tests 🟢
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

### mcp-clients

**1 files, 42 tests**

**unit** (1 files)

- `tests/unit/shared/mcp-clients.test.ts` — 42 tests 🟢

### metrics

**1 files, 20 tests**

**unit** (1 files)

- `tests/unit/shared/metrics.test.ts` — 20 tests 🟢

### marketplace

**19 files, 169 tests**

**unit** (9 files)

- `tests/unit/shared/i18n-plural.test.ts` — 12 tests 🟢 (pluralization/declension primitive: EN one/other + RU one/few/many CLDR categories incl. boundaries 1/2/5/11/21/0; selectForm other-fallback; formatCount; toMarketplaceLocale normalization; formatMarketplaceCount RU declensions 1 шаг/2 шага/5 шагов; marketplaceEnumLabel category/status/kind EN+RU + unknown-value fallback; countable-noun + enum-label parity)
- `tests/unit/shared/marketplace-portable-file.test.ts` — 13 tests 🟢 (portable `.moira.json` envelope: buildPortableFile wraps a graph with the `moiraFile`/`formatVersion` discriminator + importKeyFromSource (store listingId vs same-instance workflowId key, listing-precedence, null on missing/non-string identity) + compacted `source` provenance (drops undefined, omits empty); parsePortableFile round-trips an envelope (graph + source) detected strictly by the `moiraFile` discriminator, accepts a bare graph (input tolerance, no source), and rejects the legacy `{listing,workflow}` shape (no back-compat shim) / non-objects / envelopes whose workflow is not a graph / non-workflow objects with "Not a workflow file")
- `tests/unit/shared/marketplace-schema.test.ts` — 13 tests 🟢 (marketplace migration 0014: five tables + listing indexes created; listing column defaults; UNIQUE constraints — one listing/workflow, one review/(listing,user), one library entry/(user,workflow), one entitlement/(user,listing); review stars DB CHECK 1..5 boundary+reject; nullable event userId)
- `tests/unit/shared/marketplace-categories.test.ts` — 7 tests 🟢 (fixed category set: non-empty unique ids, 'other' catch-all last, MARKETPLACE_CATEGORY_IDS derivation, isValidMarketplaceCategory, normalizeMarketplaceCategory fallback)
- `tests/unit/shared/marketplace-feature-flags.test.ts` — 6 tests 🟢 (paidWorkflows off in both modes; isMarketplaceEnabled config toggle: mode defaults + MARKETPLACE_ENABLED opt-in/opt-out override)
- `tests/unit/shared/public-store-promotion-config.test.ts` — 9 tests 🟢 (public-store promotion gate (Step 15): getMarketplacePublicUrl default + MARKETPLACE_PUBLIC_URL override + scheme-less→https normalization + explicit-http untouched; isPublicStorePromotionEnabled true for a non-store origin in BOTH marketplace-flag states (orthogonal gates), false on the canonical store, when a custom store URL matches own origin, and when the store URL is configured scheme-less, origin-only comparison ignoring path/slash/case)
- `tests/unit/shared/marketplace-service.test.ts` — 33 tests 🟢 (publish/unpublish guards + unpublish unlists (row kept) + re-publish re-lists; add-as-reference + idempotency + install counter; library resolver own/added/shared excluding arbitrary public; fork independent copy + provenance; reference-auto-updates vs fork-frozen; remove + not-found; canAccess free vs paid coming-soon + paid-add rejection; detail by handle/slug + stale-private rejection; ratings/reviews — record + recompute aggregate, one-editable-per-user, average-across-users, self-rating + out-of-range rejection, removeReview, rate event; analytics events + view/start counters; trending order by recent activity)
- `tests/unit/shared/marketplace-default-library.test.ts` — 8 tests 🟢 (Step 17 default-library seeding: seedDefaultLibrary seeds a live reference (source=added, kind=reference, no listing) for each installed official base slug; tolerates a base slug not installed on the instance (skips, no throw); idempotent (second call adds nothing); independent of the marketplace feature flag (seeds when disabled); never seeds into the system owner's own library; getLibrary marks seeded base flows official:true; a seeded base flow is listed exactly once under origin 'added' (Step 18: no core origin); a user-owned flow is official:false)
- `tests/unit/shared/marketplace-listing-repository.test.ts` — 5 tests 🟢 (create defaults + read-back; delete by workflow; gallery predicate listed+public+not-deleted; category filter; install counter)
- `tests/unit/shared/library-entry-repository.test.ts` — 3 tests 🟢 (add + get by user/workflow; list by user; remove with changed-rows result)
- `tests/unit/shared/marketplace-review-repository.test.ts` — 5 tests 🟢 (upsert + transactional aggregate recompute; replace same-user review; average across users; read-back/list; delete + recompute, null when nothing to delete)
- `tests/unit/shared/marketplace-event-repository.test.ts` — 4 tests 🟢 (append + nullable userId; trending ranks by event count; type filter; window exclusion)

**integration** (9 files)

- `tests/integration/library-official-version.test.ts` — 4 tests 🟢 (provenance-based Official badge (D-N6) + version projection (D-N1/D-N7): a flow owned by system-admin (the self-host operator's login) is NOT official; a flow owned by system-moira (the official catalog account) IS official, surfaced via an added library entry; a regular user's own flow is not official and carries top-level version + updatedAt; every library item's version matches its graph metadata so same-shaped rows are distinguishable)
- `tests/integration/marketplace-library-origins.test.ts` — 5 tests 🟢 (Step 18 library origins + filter against a migrated DB: getLibrary never returns origin 'core'; seeded official base flows surface under origin 'added' with official:true + ownerHandle 'moira'; an owned-and-listed flow is listed exactly once as origin 'own'; the all/official/added/mine/shared filters each return the correct deduped subset (mine+added+shared partition all); the seeded base flows are still returned when the marketplace feature is disabled)
- `tests/integration/marketplace-public-api.test.ts` — 18 tests 🟢 (service-level public read against a migrated DB: gallery only-listed+public+total, category/search/tag filters, limit/offset pagination, sort rating/installs/trending (view-only excluded), categories, reviews-with-authors (handle resolved, userId not exposed), reviews-by-reference graph-free + unknown 404, sitemap refs + view does not move lastmod/updatedAt, detail by handle/slug with ownerHandle/startRef/entitlement + unknown 404, export free succeeds vs paid denied)
- `tests/integration/marketplace-authed-api.test.ts` — 21 tests 🟢 (service-level authed/admin against a migrated DB: publish→listed/public, unpublish→unlisted (row kept) + non-owner rejection, owner metadata edit + non-owner rejection, my-listings incl unlisted, install→library reference + startRef + install counter, fork→independent owned copy (original untouched), share-by-link grant→recipient library 'shared', entitlement owner/free + paid coming-soon, paid-publish rejection while flag off + allowed when on, admin verify/unverify badge + featured + moderation queue/status + unknown-status rejection); share(userHandle) grant + invite-link token + non-owner rejection; getLibrary('mine') own-filter
- `tests/integration/marketplace-official-flows.test.ts` — 6 tests 🟢 (service-level official-flows gallery seed (Step 19) against a migrated DB: publishOfficialFlows lists + verifies every system-moira owned flow with the officialFlowCategory-mapped category (verifiedBy=system-moira/OFFICIAL_OWNER, publishedBy=system-moira), skipping a community user's public flow; idempotent on a second run (0 published/0 verified, one listing per workflow, no duplicates, still listed+verified); the owner-based `official` gallery filter returns exactly the official-owned set and excludes the community listing; an admin-verified COMMUNITY flow joins the separate `verified` trust filter (total official+1) but NOT the owner-based `official` filter (D1 divergence proof); the `official` owner gate also applies on the trending sort path (in-memory matchesGalleryFilter drops the community listing while the official one ranks); owner + verified flags distinguish an official listing from a community one)
- `tests/integration/marketplace-public-gallery-route.test.ts` — 4 tests 🟢 (Step 19 route param parsing: mounts the real public gallery router over a stubbed getMarketplaceService (spread of the real namespace, only getMarketplaceService overridden) and asserts the route maps TWO independent literal-true booleans — `?official=true` → getGallery({ official: true }) (canonical owner-based Official filter) and `?verified=true` → getGallery({ verified: true }) (distinct trust filter); no param leaves both undefined and `?official=false` leaves official undefined so the gallery is unfiltered)
- `tests/integration/library-removal.test.ts` — 6 tests 🟢 (origin-aware library removal, fixes D-D: removing an imported/forked OWNED copy actually soft-deletes it (was a no-op); removing a plain owned flow deletes it (origin own); removing a published owned flow deletes it AND unlists the listing (publication invariant); removing an added reference unlinks it leaving the author's flow+listing untouched (origin added); removing a shared flow revokes the caller's access (origin shared); removing a flow in no part of the library throws LibraryEntryNotFoundError)
- `tests/integration/publication-invariant.test.ts` — 7 tests 🟢 (publication invariant `listed ⟹ public & !deleted`, makes the D-C fix structural: publishCoupled sets workflow public + listing listed atomically; unpublishCoupled sets private + unlisted atomically; soft-deleting a published workflow unlists its listing (no listed+deleted); making a listed flow private is rejected via updateVisibility (no listed+private); admin setListingStatus('listed') on a private workflow is rejected with WorkflowNotListableError (409); startup repairInconsistentListings() unlists a legacy listed+private row (count=1); a consistent listed+public row is left untouched (count=0))
- `tests/integration/workflow-visibility-listing.test.ts` — 6 tests 🟢 (visibility vs listing coupling, fixes D-C: editing a published flow via WorkflowService.save WITHOUT a visibility field keeps it public + listed and the storefront getDetailByReference still serves the new version (was a silent unpublish → gallery 404); editing a private flow without visibility stays private; an EXPLICIT public→private on a flow with a `status='listed'` listing is rejected with WorkflowListedCannotGoPrivateError via BOTH save() and updateVisibility(), leaving it public+listed; unpublish is the non-silent path (flow private + listing unlisted atomically), after which a content edit stays private; making a non-listed private flow public is allowed)

**api** (3 files)

- `tests/api/marketplace-public-api.test.ts` — 7 tests 🟢 (HTTP: gallery public no-auth + page envelope; sort/limit/offset query params; categories payload; sitemap.xml content-type; unknown detail/export/reviews → 404)
- `tests/api/marketplace-authed-api.test.ts` — 12 tests 🟢 (HTTP auth gating: me/listings + me/library + publish without session → 401; authed me/listings + me/library → 200 envelope; error mapping publish/delete/entitlement unknown id → 404; admin queue no-session → 401, non-admin → 403, admin → 200 envelope, verify unknown id → 404)
- `tests/api/marketplace-pages.test.ts` — 7 tests 🟢 (SSR public pages COMPONENT-rendered via the render package: /explore crawlable HTML lists a just-published flow no-rebuild + carries `data-mp`/`#root` package markup + interim string-template markers gone; /explore readable with JS disabled + ships the hydration bootstrap (stable `marketplace-hydrate.js` ref + escaped `#mp-bootstrap` initial-data island carrying the anon view-model); /w/:handle/:slug detail + OpenGraph + JSON-LD SoftwareApplication; /w/ ships the hydration bootstrap (detail island, viewer=null); /sitemap.xml canonical /w/ URL fresh from DB; unknown /w/ → 404 HTML; malicious summary HTML-escaped + cannot break out of JSON-LD OR the bootstrap island (round-trips as data, never executed))
- `tests/api/marketplace-pages-session.test.ts` — 9 tests 🟢 (SESSION-AWARE SSR public pages: anonymous /explore → cacheable fast path (`Cache-Control: public, max-age=60`, `Vary: Accept-Language`+`Cookie`), `data-mp="sign-in"` header, null `#mp-bootstrap` viewer; signed-in /explore → `private, no-store` (`Vary: Cookie`), `data-mp="sign-out"`+`account-handle`, island viewer.userId/handle set; owner sees `own-pill` on their detail; no cross-user leakage — USER_B who installed USER_A's listing gets `library-pill` not `own-pill`, owner gets `own-pill` not `library-pill`, anonymous gets neither + `signin-cta`, viewer island never carries the other user's handle; degraded session (bogus cookie) renders anonymous variant (200, sign-in, public cache) never an error; language honored server-side — `?lang=ru` + `Accept-Language: ru` → `<html lang="ru">`+RU "Каталог" chrome, default → `lang="en"`, RU detail threads `?lang=ru` into internal links)

**mcp-tools** (1 file)

- `tests/mcp-tools/marketplace-tool.test.ts` — 8 tests 🟢 (agent path over real MCP: publish produces handle/slug ref; search finds the published flow; info accessible detail; add → appears in list(source:added) as origin 'added'; start runs the added flow by ref; rate records a rating; author cannot rate own flow); list(source:official) returns the seeded official base flows (origin 'added') startable by moira/<slug> id

**e2e** (8 files)

- `tests/e2e/marketplace-storefront-affordances.spec.ts` — 6 tests 🟢 (Playwright, Step 21 storefront↔app unification: a signed-in viewer on `/w/:handle/:slug` clicks the hydrated `adopt-btn` → the listing installs and after reload the `library-pill` replaces the button + `/api/marketplace/me/library` confirms it; the JS-free `download-link` targets `/api/public/marketplace/listings/:handle/:slug/export` and returns 200 JSON; the storefront Official chip scopes `/explore` — a community flow present under `chip-all` drops out under `?official=true` (`chip-official` aria-pressed) while the seeded official listings remain; the header `open-app` "Back to library" link carries `?lang=ru` and lands in the SPA `/workflows` with the SPA i18n resolving to RU (`i18nextLng`); an anonymous visitor sees `download-link` + `signin-cta` but no `adopt-btn`; a signed-in viewer uses the header import control (`import-input`) → `importWorkflowFile` → redirect to `/workflows?filter=mine` with the imported flow in the library)
- `tests/e2e/marketplace-i18n.spec.ts` — 1 test 🟢 (Playwright SPA localization: with ?lang=ru the gallery/detail/My-Listings render translated enum labels (category→"Разработка", status→"Опубликован") and correct Russian CLDR plural counts (install/step declensions, e.g. "2 шага") with no raw enum strings)
- `tests/e2e/marketplace-pages.spec.ts` — 3 tests 🟢 (Playwright: /explore lists a just-published flow + links to its detail; /w/:handle/:slug renders the component detail page (backend, not SPA) with JSON-LD (SoftwareApplication across multiple LD blocks) + ships the hydration bootstrap (marketplace-hydrate.js script + `#mp-bootstrap` detail island); missing flow 404s instead of SPA fallthrough)
- `tests/e2e/marketplace-public-page.spec.ts` — 6 tests 🟢 (Playwright session-aware polished public pages: anonymous /explore shows topbar/brand/theme-toggle/EN-RU switch/footer + `sign-in` (no account/sign-out); anonymous /w/:ref primary action is the gated `signin-cta`→/login + neither viewer pill; JS-free language toggle (anchor click → `?lang=ru`, RU "Войти"/"Каталог" chrome, `aria-current` on RU); hydrated theme toggle (set localStorage light → click → `<html>.dark` + localStorage `theme`="dark"); signed-in /explore shows `account-handle`=@handle + `sign-out` (no sign-in), sign-out (throwaway session) → reload back to anonymous header; owner's /w/:ref shows `own-pill` not `library-pill`/`signin-cta`)
- `tests/e2e/marketplace-ui.spec.ts` — 1 test 🟢 (Playwright SPA: publisher publishes a workflow via the publish form (paid pricing present-but-disabled "coming soon"), it appears in the gallery + My Listings; a different consumer adds it to their library and rates it (self-rating forbidden, so rater ≠ owner); the old /marketplace/library redirects into the unified Workflows home where the added reference shows under the "Added" origin; before/after screenshots captured)
- `tests/e2e/marketplace-unified-home.spec.ts` — 7 tests 🟢 (Playwright: the unified "Your library" Workflows home (Step 20). One filterable surface with a `library-filter-chips` row (All/Official/Added/Mine/Shared, `?filter=...`) replacing the old origin tabs — chips scope the single client-side list of `flow-card`s; the seeded official base flows carry an `official-badge` and appear under the Official filter; the MCP-first `run-hint` shows no `start(`/`mcp__` code; the Mine filter empty state offers the import + browse-catalog adoption affordances. Publish-from-card — an own card's Publish action opens the publish form PRE-FILLED via `?workflowId` and publishing makes the card offer "View on marketplace" resolving to the public `/w/:handle/:slug` page; an owned flow shows under Mine with a Listed badge while a consumer's added-by-reference flow shows under Added with a ROOT `/w/...` source link (asserted equal to `/w/handle/slug` and 200-resolving); old `/marketplace/library` redirects to `?filter=added`; the home "Browse the public catalog" link resolves to the promoted public-store URL reported by `/api/features` (external) — see public-store-promotion for the local-fallback case)
- `tests/e2e/marketplace-public-store-promotion.spec.ts` — 4 tests 🟢 (Playwright: public-store promotion gate (Step 15), orthogonal to the local marketplace feature. The live `/api/features` reports `publicStore.promotionEnabled` true with a store URL on this non-store instance; the "Public store" sidebar link renders pointing at that URL (external). Via mocked `/api/features` + reload: with the local `marketplace` feature OFF the promotion link + home catalog link still target the store while the Marketplace nav item is gone (local catalog gracefully absent); on the canonical store (`promotionEnabled` false) the promotion link is suppressed and the home catalog link falls back to the local `/explore` path)
- `tests/e2e/marketplace-file-transfer.spec.ts` — 2 tests 🟢 (Playwright, self-host file transfer (Step 16): from the Mine tab, a flow's export action downloads a `.moira.json` file (captured + parsed) which is then set on the "Import from file" control → a success toast and the imported copy appears alongside the source (count 2); the import control is gated by the local `marketplace` feature (absent when mocked off) while the per-card export action stays available)

### marketplace-render

**2 files, 31 tests**

**unit** (2 files)

- `tests/unit/marketplace-render/render-html.test.ts` — 23 tests 🟢 (@mcp-moira/marketplace-render server render: renderExploreToHtml crawlable semantic gallery HTML + real detail `<a href>` links + escaped SEO head (title/description/canonical/OG/Twitter) + well-formed ItemList+BreadcrumbList JSON-LD; renderDetailToHtml semantic `<article>` + start command + SoftwareApplication JSON-LD with/without aggregateRating + BreadcrumbList; localized counts EN vs RU CLDR forms (published/steps "2 шага"/installs "5 установок"/"1 install"); localized category enum (RU "Исследования"/"Данные и анализ", not raw) + "Unrated"/"Без оценок"; viewer pills only when authenticated+annotated; JSON-LD XSS-safety — malicious detail/gallery title+summary cannot break out of `<script type="application/ld+json">` (`<`-escaped, no raw `</script>`/`<script>alert`/`<img onerror`); session-aware detail action area (Step 21) — anonymous → sign-in CTA + public Download link + NO adopt-btn, signed-in addable viewer → `adopt-btn` "Add to library", owner / in-library viewer → NO adopt-btn but Download still present; ExploreGallery Official filter chips — All/Official crawlable LINK chips carry `?official`/`?lang` with the active `aria-pressed` driven by the threaded filter, localized chip labels (Все/Официальные) + `&`-escaped combined query; ListingCard adopt+download — addable card shows adopt-btn + download-link, in-library/anonymous cards show download-link only)
- `tests/unit/marketplace-render/marketplace-viewer-annotation.test.ts` — 8 tests 🟢 (MarketplaceService viewer-annotation: getGalleryAnnotated/getDetailByReferenceAnnotated attach inLibrary/isOwn for owner (isOwn, not stored as library entry) / non-owner-who-added (inLibrary) / stranger (both false) / anonymous null viewer (both false, no library DB hit); gallery pagination metadata preserved; anonymous detail still resolves workflow + ownerHandle)

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
- `tests/integration/features-public-store.test.ts` — 3 tests 🟢 (REAL GET /api/features handler in-process via supertest, env-toggled (Step 15): publicStore.promotionEnabled true + default store URL for a non-store origin; true in BOTH MARKETPLACE_ENABLED states (orthogonal gate); false on the canonical store where own origin == store URL)
- `tests/integration/marketplace-import-route.test.ts` — 2 tests 🟢 (Step 16 server-side gate: mounts the real authed marketplace router + error middleware via supertest with MARKETPLACE_ENABLED=false → a valid workflow file is rejected 404 (gate enforced at the HTTP layer), and an INVALID file is ALSO 404 (the gate is checked before parse/validation, never reaching the 400 path))
- `tests/integration/marketplace-import.test.ts` — 10 tests 🟢 (offline file import at the service level against a migrated DB: importFromFile saves an independent private workflow owned by the importer with a fresh id + intact graph; records a library copy entry (source=added, kind=copy, listingId null); surfaces in getLibrary deduped to origin=own; makes NO cloud call (no listing/event row); gated by the local marketplace feature (throws MarketplaceDisabledError when off); repeated import WITHOUT provenance yields distinct ids/slugs; **re-import of a store-pull source (instance,listingId) updates the existing flow in place — id+slug kept, version bumped, updated=true, exactly one library entry**; **re-import of a same-instance source (instance,workflowId) updates in place while a distinct source stays separate**; **re-import after the imported flow was soft-deleted creates a clean copy — honest updated=false, new live id, no orphan, exactly one importKey entry (D-B regression guard)**; **re-import of a published imported copy preserves its visibility — public stays public, version bumped (no silent unpublish)**)

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

**4 files, 52 tests**

**integration** (2 files)

- `tests/integration/database/upload-pipeline-slug.test.ts` — 10 tests 🟢
- `tests/integration/mcp-slug-operations.test.ts` — 15 tests 🟢

**api** (2 files)

- `tests/api/user-handle-api.test.ts` — 12 tests 🟢
- `tests/api/workflow-slug-api.test.ts` — 15 tests 🟢

### storage

**1 files, 34 tests**

**unit** (1 files)

- `tests/unit/scripts/prompt-migration.test.ts` — 34 tests 🟢

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

**2 files, 21 tests**

**integration** (1 files)

- `tests/integration/workflow-file-tokens.test.ts` — 10 tests 🟢

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

**6 files, 38 tests**

**unit** (1 files)

- `tests/unit/web-frontend/quick-start-card.test.ts` — 14 tests 🟢 (i18n completeness, config/deeplink generation, setupType consistency, + resolveMcpUrl deployment-mode gating: self-host runtime, self-host baked fallback, saas baked, null mode baked)

**e2e** (5 files)

- `tests/e2e/dashboard.spec.ts` — 10 tests 🟢
- `tests/e2e/mobile-navigation.spec.ts` — 3 tests 🟢
- `tests/e2e/sidebar.spec.ts` — 10 tests 🟢
- `tests/e2e/theme-integration.spec.ts` — 1 tests 🟢
- `tests/e2e/theme-loading-state.spec.ts` — 3 tests 🟢

### workflow-engine

**63 files, 835 tests**

**unit** (7 files)

- `tests/unit/logging/compute-changes.test.ts` — 11 tests 🟢
- `tests/unit/shared/workflow-query-service.test.ts` — 45 tests 🟢 (incl. setWorkflowVariable preserves rich schema)
- `tests/unit/shared/workflow-catalog.test.ts` — 18 tests 🟢 (+ readWorkflowCatalogs multi-dir merge: union, later-dir-wins precedence on (owner,slug) collision, per-owner duplicate slugs preserved, missing/empty dirs skipped, single-dir == readWorkflowCatalog; + getWorkflowsDirs config: default, WORKFLOWS_DIR fallback, colon-separated WORKFLOWS_DIRS, empty-segment drop)
- `tests/unit/web-frontend/workflow-transformer.test.ts` — 13 tests 🟢
- `tests/unit/workflow-engine/variable-resolver.test.ts` — 9 tests 🟢
- `tests/unit/workflow-engine/registry-converter.test.ts` — 13 tests 🟢
- `tests/unit/workflow-engine/node-output-scope.test.ts` — 14 tests 🟢 (incl. whole-descriptor inlining: enum/items/pattern/properties + end-to-end rejection)

**integration** (13 files)

- `tests/integration/agent-response-contract.test.ts` — 3 tests 🟢
- `tests/integration/workflow-catalog-loader.test.ts` — 10 tests 🟢 (+ multi-directory → install end-to-end: merged catalog from two dirs installs incl. real-user-owned flow from the 2nd dir + idempotent; later-dir-wins override before install; WORKFLOWS_DIRS-unset → single bundled default)
- `tests/integration/database/workflow-privacy-defaults.test.ts` — 2 tests 🟡
- `tests/integration/manage-workflow-actions.test.ts` — 32 tests 🟢
- `tests/integration/manage-workflow-new-actions.test.ts` — 29 tests 🟢
- `tests/integration/step-on-completed-workflow.test.ts` — 5 tests 🟢
- `tests/integration/subgraph-agent-transparency.test.ts` — 3 tests 🟢
- `tests/integration/subgraph-nested-levels.test.ts` — 1 tests 🟢
- `tests/integration/subgraph-performance.test.ts` — 2 tests 🟡
- `tests/integration/subgraph-sequential.test.ts` — 1 tests 🟢
- `tests/integration/workflow-mutation-service.test.ts` — 18 tests 🟢
- `tests/integration/workflow-outputs.test.ts` — 3 tests 🟡
- `tests/integration/workflow-pagination.test.ts` — 7 tests 🟢

**workflow** (26 files)

- `tests/workflow/engine/agent-directive-validation.test.ts` — 9 tests 🟢
- `tests/workflow/engine/catalog-validation.test.ts` — 6 tests 🟢 (incl. workspace_path path-join guard, numeric-global counter-pinning guard)
- `tests/workflow/engine/agent-message-queue.test.ts` — 9 tests 🟢
- `tests/workflow/engine/context-mapper.test.ts` — 15 tests 🟢
- `tests/workflow/engine/cycle-detector.test.ts` — 6 tests 🟢
- `tests/workflow/engine/error-formatting.test.ts` — 11 tests 🟢
- `tests/workflow/engine/expression-handler.test.ts` — 15 tests 🟢
- `tests/workflow/engine/expression-parser.test.ts` — 42 tests 🟢
- `tests/workflow/engine/max-nodes-validation.test.ts` — 4 tests 🟢
- `tests/workflow/engine/node-handlers.test.ts` — 12 tests 🟢
- `tests/workflow/engine/node-type-validation.test.ts` — 23 tests 🟢
- `tests/workflow/engine/note-handlers.test.ts` — 34 tests 🟢
- `tests/workflow/engine/note-node-validation.test.ts` — 15 tests 🟢
- `tests/workflow/engine/path-resolver.test.ts` — 31 tests 🟢
- `tests/workflow/engine/registry-default-seeding.test.ts` — 4 tests 🟢
- `tests/workflow/engine/registry-schema-model.test.ts` — 6 tests 🟢 (registry entry = full JSON Schema)
- `tests/workflow/engine/registry-schema-validation.test.ts` — 5 tests 🟢 (registry entry compiled as JSON Schema; malformed → blocking)
- `tests/workflow/engine/schema-validator-agent-format.test.ts` — 16 tests 🟢
- `tests/workflow/engine/subgraph-delegation.test.ts` — 9 tests 🟢
- `tests/workflow/engine/subgraph-handler-simple.test.ts` — 5 tests 🟢
- `tests/workflow/engine/subgraph-handler.test.ts` — 16 tests 🟢
- `tests/workflow/engine/subgraph-validation.test.ts` — 16 tests 🟢
- `tests/workflow/engine/system-reminder-priority.test.ts` — 10 tests 🟢
- `tests/workflow/engine/telegram-services.test.ts` — 36 tests 🟢
- `tests/workflow/engine/template-processor.test.ts` — 127 tests 🟢
- `tests/workflow/engine/template-validation.test.ts` — 17 tests 🟢
- `tests/workflow/engine/unified-validation.test.ts` — 16 tests 🟢
- `tests/workflow/engine/validation-error-messages.test.ts` — 15 tests 🟢

**api** (4 files)

- `tests/api/workflow-copy.test.ts` — 6 tests 🟢
- `tests/api/workflow-list-performance.test.ts` — 5 tests 🟢
- `tests/api/workflow-owned-scope.test.ts` — 3 tests 🟢 (GET /api/workflows `ownedOnly` scope: ownedOnly=true returns ONLY the caller's own workflows both visibilities + accessType=owner; default preserves browse-all incl. another user's public; ownedOnly honors the visibility sub-filter)
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
- `tests/e2e/workflow-copy-button.spec.ts` — 5 tests 🟢
- `tests/e2e/workflow-delete-restore.spec.ts` — 2 tests 🟢 (Step 20: reaches the workflow detail by filtering the unified library home by name + the card's edit action, not the removed all-workflows search/list)
- `tests/e2e/workflow-visibility-toggle.spec.ts` — 4 tests 🟢 (public/private visibility on the workflow detail page — the surviving home for the visibility concept after Step 20)

### workflow-scenarios

**23 files, 138 tests**

**workflow** (23 files)

- `tests/workflow/scenarios/artifacts-demo-dashboard-builder.test.ts` — 5 tests 🟢
- `tests/workflow/scenarios/artifacts-demo-report-publisher.test.ts` — 5 tests 🟢
- `tests/workflow/scenarios/bug-hunting-workflow.test.ts` — 5 tests 🟡
- `tests/workflow/scenarios/conditional-branching.test.ts` — 3 tests 🟢
- `tests/workflow/scenarios/content-creation.test.ts` — 5 tests 🔴
- `tests/workflow/scenarios/coverage.test.ts` — 11 tests 🟢
- `tests/workflow/scenarios/data-analysis.test.ts` — 5 tests 🔴
- `tests/workflow/scenarios/development-workflow.test.ts` — 8 tests 🟢
- `tests/workflow/scenarios/directive-validation.test.ts` — 4 tests 🟡
- `tests/workflow/scenarios/iterative-research.test.ts` — 5 tests 🟡
- `tests/workflow/scenarios/marketing-campaign.test.ts` — 5 tests 🟡
- `tests/workflow/scenarios/notes-demo-metrics-collector.test.ts` — 10 tests 🟢
- `tests/workflow/scenarios/notes-demo-metrics-reporter.test.ts` — 13 tests 🟢
- `tests/workflow/scenarios/prd-creation.test.ts` — 5 tests 🟡
- `tests/workflow/scenarios/robust-task.test.ts` — 5 tests 🔴
- `tests/workflow/scenarios/smart-purchase-assistant.test.ts` — 5 tests 🔴
- `tests/workflow/scenarios/telegram-setup.test.ts` — 5 tests 🟢
- `tests/workflow/scenarios/test-generation.test.ts` — 5 tests 🔴
- `tests/workflow/scenarios/test-planning.test.ts` — 5 tests 🟡
- `tests/workflow/scenarios/user-onboarding.test.ts` — 5 tests 🟢
- `tests/workflow/scenarios/ux-design.test.ts` — 5 tests 🟡
- `tests/workflow/scenarios/verified-research.test.ts` — 5 tests 🟡
- `tests/workflow/scenarios/workflow-management-flow.test.ts` — 13 tests 🔴 (incl. explicit output-scope variable-model teaching + authored-per-guidance validation)

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
