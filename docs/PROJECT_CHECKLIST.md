# Project Checklist

Mandatory checks before every commit.

**IMPORTANT:** If an item is not relevant to the current commit, treat it as satisfied (skip it).

## 1. Audit Trail for New Functionality

- [ ] If the new functionality involves user actions worth surfacing in the audit log (for error analysis, marketing research, security)
- [ ] Logging added to the audit trail table
- [ ] Verified that the following are logged: user_id, action, metadata, timestamp
- [ ] **For EDIT/UPDATE actions:** use `computeChanges(oldState, newState)` from `@mcp-moira/shared` and pass the result into `logAuditEvent(..., { changes })`

## 2. Environment Variables Synchronization

- [ ] New environment variables synchronized into the relevant `.env*` files for each deployment target
- [ ] Updated `.env.example` (and any deployment-specific env files in use) if mandatory variables were added
- [ ] Verified that every variable used is defined in your local env file before starting the app

## 3. Docker Port Configuration & Test Base URLs

- [ ] All new tests (E2E, integration) use `getTestBaseUrl()` from `tests/utils/test-config.ts`
- [ ] NO hardcoded `localhost:XXXX` ports in tests — everything goes through `getTestBaseUrl()`
- [ ] `DOCKER_PORT` in your local env matches the test environment (default `8080`; see `.env.local.example`)

## 4. API Rate Limiting & Size Limits

- [ ] New endpoints with large payloads respect the limits: workflow=5MB, context=10MB
- [ ] If new API endpoints were added — rate limiting checked (`apiLimiter`, `authLimiter` middleware)
- [ ] Documented in API.md if new limits were added

## 5. Frontend/Backend API Compatibility

- [ ] If the API contract changes (request/response structure) — both frontend AND backend updated together
- [ ] Types in web-backend and web-frontend kept in sync (using shared types from `@mcp-moira/shared`)
- [ ] Verified there are no type errors (TypeScript is checked during the Docker build)

## 6. Logging & Audit Trail Completeness

- [ ] Logging added via `createLogger()` for every new critical operation (auth, workflow execution, settings changes)
- [ ] Verified that sensitive data (passwords, tokens) is NOT logged (use `[REDACTED]`)
- [ ] Logs carry the correct service context (Service.WEB_BACKEND, Service.MCP_SERVER, etc.)

## 7. Frontend Admin Route Guards

- [ ] If new admin routes were added — verified they are protected by `requireAdmin` in ProtectedRoute
- [ ] E2E tests added to verify non-admin users are redirected away from admin routes
- [ ] Verified that admin navigation is not visible to non-admin users (Sidebar filtering by `isAdmin`)

## 8. Test Code Quality & DRY Principle

- [ ] New tests follow the patterns in `tests/TESTING-GUIDE.md`
- [ ] Existing helpers are reused instead of duplicating code (DRY principle)
- [ ] **Example:** E2E tests use `loginAsAdmin(page)` from `tests/e2e/helpers/auth-helper.ts` instead of logging in manually through the form
- [ ] Verified that tests do not duplicate logic from other tests or helpers

## 9. Internationalization (i18n)

- [ ] If frontend code changed — verified there are no hardcoded strings for UI text
- [ ] All user-facing strings use `t('key')` from `useTranslation()`
- [ ] Translations added to `locales/en.json` and `locales/ru.json`
- [ ] Verified that keys follow the structure: `pages.{pageName}.{section}.{key}`

## 10. Documentation Sync (Engine/Workflow Changes)

Mandatory documentation updates when the system changes.

### ⚠️ Public documentation is MANDATORY for user-facing changes

For any code change that alters user-facing behavior (the variable model —
`variableRegistry`/`globalInputs`/`node-id.name`; node types and their schemas; the
workflow-definition schema; MCP tools — names/parameters/actions/descriptions; template
syntax, magic variables, condition operators; workflow authoring rules):

- [ ] The matching public documentation (`packages/docs/src/content/docs/`) is updated in the SAME change
- [ ] BOTH versions are updated — English (`docs/...`) and Russian (`ru/docs/...`), in parity
- [ ] All examples match current behavior (`variableRegistry`/`globalInputs` shapes, valid JSON, current command syntax)
- [ ] Searching the public docs does not surface removed concepts (e.g. `initialData`) except as explicit negations

Details and criteria: `docs/DOCUMENTATION-STYLE-GUIDE.md`, section "Mandatory Sync With Code Changes" (Public Documentation).

### When adding a new workflow pattern:

- [ ] Pattern added to `docs/WORKFLOW.md`, section "Workflow Patterns"
- [ ] Page created under `packages/docs/src/content/docs/docs/patterns/`
- [ ] `packages/docs/astro.config.ts` updated (sidebar navigation)
- [ ] Topic available via the MDX file (auto-discovered)
- [ ] `workflow-management-flow` updated with the pattern description in onboarding

### When adding a new node type:

- [ ] Specification added to `docs/WORKFLOW.md`, section "Node Specifications"
- [ ] Page `packages/docs/src/content/docs/docs/concepts/nodes.mdx` updated
- [ ] Support added to the Web UI visualization (`packages/web-frontend/`)
- [ ] Types added to `packages/shared/src/types/`

### When adding a new universal workflow:

- [ ] Workflow documented under `packages/docs/src/content/docs/docs/reference/workflows/`
- [ ] Description added to `docs/VISION.md` if it is a core workflow
- [ ] README.md created in the workflow directory (for public workflows)

### When changing the template processor:

- [ ] "Template Variables" section in `docs/WORKFLOW.md` updated
- [ ] Usage examples added for the new features
- [ ] Tests updated in `tests/unit/workflow-engine/template-injection-and-validation.test.ts`

### When changing MCP tools:

- [ ] Tool descriptions updated in `packages/mcp-server/src/tools/`
- [ ] Documentation updated in `packages/docs/src/content/docs/docs/reference/tools.mdx`
- [ ] Topics added to the help tool if needed
- [ ] **MANDATORY: bump the version** in the root `package.json` and `packages/mcp-server/package.json` if:
  - The set of MCP tools changed (a tool added/removed)
  - A tool description changed (TOOL_DESCRIPTIONS in messages/)
  - The system prompt changed (in the help tool or instructions)
  - Tool parameters changed (schema)

  **Reason:** Clients cache tools at authorization time. A version bump triggers HTTP 426 and a reconnect that refreshes the cache.

## 11. Design System Compliance

- [ ] If UI components were added or changed — verified compliance with `docs/DESIGN-SYSTEM-CHECKLIST.md`
- [ ] If components were changed or added during implementation — the full Design System Checklist (`docs/DESIGN-SYSTEM-CHECKLIST.md`) was completed
- [ ] New pages use the `PageShell` + `FilterBar` + `DataListView` + `CardShell` pattern
- [ ] No hardcoded Tailwind color classes (`bg-gray-*`, `text-blue-*`) — semantic tokens only
- [ ] No `dark:` prefix classes — theming via CSS custom properties
- [ ] No native `confirm()` / `alert()` — use `ConfirmDialog`
- [ ] Date/size formatting via the shared `format-utils`, not local functions

## 12. No Hardcoded URLs/Domains/Emails

- [ ] No hardcoded domains in code: example.com, moira.example.com, localhost:\*
- [ ] No hardcoded email addresses (except config defaults in env.ts)
- [ ] All URLs are computed via `getBaseUrl()`, `getMcpUrl()`, `getApiUrl()` from `@mcp-moira/shared`
- [ ] Astro components use `getMcpUrl()` at build time
- [ ] React components use `process.env.MCP_URL` (injected via webpack DefinePlugin)
- [ ] MDX documentation uses the `<McpUrl />` component
- [ ] **Exception:** Only the example comment in urls.ts is allowed
