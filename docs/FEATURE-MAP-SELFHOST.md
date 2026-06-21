# Feature Map — Self-Host Readiness

> A map of all MCP Moira functionality with a verdict for each block regarding self-host (target scenario: from single-user to a private team without public registration).
>
> **Method:** a multi-agent inventory based on the actual code of the `feature/oss-prep` branch (all 7 packages). Not based on CLAUDE.md.
>
> **Verdicts:**
>
> - 🟢 **KEEP** — works for self-host as-is (possibly with configuration via env/admin).
> - 🟡 **MODE** — disabled/hidden via `DEPLOYMENT_MODE` (see below). The code stays; behavior changes by mode.
> - 🔴 **REWORK** — requires a code change (blocks self-host or is hardcoded).
> - 💰 **EE** — paid commercial feature. **The code is open** (the "everything OSS + flags" model), gated by `FeatureResolver` (disabled/basic in self-host, enabled per plan in cloud). NOT hidden in a separate repo.
>
> **Effort:** S (≤0.5 day) / M (0.5–2 days) / L (>2 days).

---

## The `DEPLOYMENT_MODE` Concept

A single env flag `DEPLOYMENT_MODE = self-host | saas` (default for the OSS image: `self-host`). Behavior defaults depend on it. This replaces a scattering of separate `SKIP_*` flags with one conceptual switch (the Sentry pattern: one code path, a different resolver).

| Aspect                                      | `self-host`                         | `saas`  |
| ------------------------------------------- | ----------------------------------- | ------- |
| Legal consents (terms/residency) at sign-up | disabled                            | enabled |
| Email verification as a gate (OAuth/tokens) | disabled                            | enabled |
| Open registration                           | disabled (only admin creates users) | enabled |
| Beta-agreement modal / banner               | hidden                              | shown   |
| Multi-user admin pages                      | by sub-flag (single vs team)        | shown   |
| Residency checkbox in the UI                | hidden                              | shown   |
| Admin auto-create + secret auto-generation  | yes                                 | no      |

Individual targeted overrides remain possible (e.g. `REQUIRE_EMAIL_VERIFICATION=true` on top of self-host), but the default is set by the mode.

---

## Zone A — workflow-engine (execution core)

| Block                             | What                                                                                                            | Verdict | Effort | Note                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------- | ------ | ------------------------------------------- |
| Graph executor (universal/engine) | Graph execution, routing, error-as-pause                                                                        | 🟢 KEEP | —      | Pure core, deterministic, DI                |
| 12 node types                     | start/end/agent-directive/teleport/condition/expression/subgraph/telegram/lock/read-note/write-note/upsert-note | 🟢 KEEP | —      | Safe parsers (NOT eval)                     |
| Template processor `{{}}`         | Variable interpolation, escaping                                                                                | 🟢 KEEP | —      | —                                           |
| Validation (AJV + structural)     | Schema + graph validation                                                                                       | 🟢 KEEP | —      | —                                           |
| AgentMessageQueue                 | Protocol-agnostic message transport                                                                             | 🟢 KEEP | —      | —                                           |
| Telegram-notification handler     | Notifications                                                                                                   | 🟢 KEEP | —      | Graceful degradation (no token → skip)      |
| Lock handler (PIN)                | PIN gate, telegram                                                                                              | 🟢 KEEP | —      | PIN stored as a scrypt hash (`pin-hash.ts`) |

**Zone summary:** ~70% pure core, all KEEP. External deps via DI (clean interfaces).

## Zone B — mcp-server (transport + MCP tools)

| Block                                  | What                                | Verdict | Effort | Note                                                                                               |
| -------------------------------------- | ----------------------------------- | ------- | ------ | -------------------------------------------------------------------------------------------------- |
| HTTP transport (stateless)             | StreamableHTTP, POST /mcp           | 🟢 KEEP | —      | —                                                                                                  |
| OAuth 2.1 auth (MCP)                   | Better Auth plugin, browser+consent | ✅ DONE | M      | Email gate lifted in self-host via emailVerificationGate → MCP connects                            |
| API tokens (`moira_`)                  | Persistent bearer, SHA-256          | ✅ DONE | S      | `requireVerifiedAuth` is mode-driven — in self-host the token is issued without email verification |
| MCP tools (list/start/step/manage/...) | Core MCP API                        | 🟢 KEEP | —      | —                                                                                                  |
| Telegram preflight in start()          | Check before launch                 | 🟢 KEEP | —      | skipTelegramCheck=true bypasses it                                                                 |
| Sharing (invites/access in manage)     | Workflow sharing                    | 💰 EE   | —      | RBAC sharing → EE candidate                                                                        |
| Prompt overrides (model>agent>default) | Customizing tool descriptions       | 🟢 KEEP | —      | Optional; default prompts work                                                                     |
| help (help tool, MDX from DOCS_DIR)    | Documentation                       | 🟢 KEEP | —      | DOCS_DIR from the docs package                                                                     |
| Rate limiting                          | 1000/min                            | 🟢 KEEP | —      | Disableable (DISABLE_RATE_LIMIT)                                                                   |

**Zone summary:** core tools KEEP; auth (OAuth + tokens email gate) done per mode; sharing → EE.

## Zone C — shared/auth + database/schema (the most SaaS-heavy)

| Block                                     | What                                                                       | Verdict | Effort | Note                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------- | ------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| Legal consents terms/residency            | `better-auth-config.ts` legalConsents gate                                 | ✅ DONE | M      | Gated by `getFeatureResolver().isEnabled("legalConsents")`; residency checkbox hidden in self-host (Step 7) |
| Email verification gate (OAuth/API token) | `better-auth-config.ts` + `auth-middleware.ts` requireVerifiedAuth         | ✅ DONE | M      | Gated by emailVerificationGate; the MCP client connects with an API token without verification in self-host |
| Open email/password registration          | enabled=true, autoSignIn                                                   | ✅ DONE | S      | Closed in self-host via openRegistration (admin creates users)                                              |
| sendOnSignUp verification                 | emailVerification:181-210                                                  | ✅ DONE | S      | Gated by verificationEmailOnSignup                                                                          |
| OAuth GitHub/Google                       | enabled=!!clientId                                                         | 🟢 KEEP | —      | Disabled without credentials                                                                                |
| MCP OAuth plugin                          | /oauth/authorize                                                           | 🟢 KEEP | —      | Works locally                                                                                               |
| Handle auto-gen                           | from email                                                                 | 🟢 KEEP | —      | —                                                                                                           |
| User blocking                             | blocked flag, session hook                                                 | 🟢 KEEP | —      | Admin UI needed (multi-user)                                                                                |
| Load-test bypass                          | ENABLE_LOAD_TEST_AUTH                                                      | 🟢 KEEP | —      | Superfluous but harmless (don't set the env)                                                                |
| GeoIP in session                          | country lookup                                                             | 🟢 KEEP | —      | Offline, harmless                                                                                           |
| executionLock.pin hashing                 | schema.ts, `utils/pin-hash.ts`                                             | ✅ DONE | S      | scrypt hash (`hashPin`/`verifyPin`); plaintext returned once at creation                                    |
| ~25 schema tables                         | user/session/workflow/execution/notes/audit/artifacts/tokens/locks/sharing | 🟢 KEEP | —      | Multi-user structure is OK                                                                                  |

**Zone summary:** blockers (legal consents, email gate) plus registration/verification done per mode; PIN hash — security fix done.

## Zone D — shared/services + repositories (quotas, multi-user)

| Block                               | What                                    | Verdict         | Effort | Note                                                     |
| ----------------------------------- | --------------------------------------- | --------------- | ------ | -------------------------------------------------------- |
| Artifact quotas                     | 3-level (per-user → global → hardcoded) | 🟢 KEEP         | —      | Configurable via global settings                         |
| Note quotas                         | global settings (size/total/versions)   | ✅ DONE         | S      | `GlobalSettingsService` (like artifacts), migration 0012 |
| Multi-user isolation                | ownership by userId, visibility         | 🟢 KEEP         | —      | Correct                                                  |
| Workflow slug/handle resolution     | per-user slug, global handle            | 🟢 KEEP         | —      | Marketplace foundation                                   |
| Execution retention                 | global setting + periodic cleanup       | ✅ DONE         | M      | `ExecutionRetentionService`, default 0 = keep forever    |
| Settings (user encrypted + global)  | config system                           | 🟢 KEEP         | —      | —                                                        |
| Sharing service (invites)           | WorkflowSharingService                  | 💰 EE           | —      | See Zone B                                               |
| /stats endpoints (quota dashboards) | usage %                                 | 🟡 MODE / 💰 EE | S      | Basics OK; advanced quota analytics → EE                 |

**Zone summary:** artifact quotas/isolation/settings KEEP; note quotas + execution retention REWORK (S/M); sharing → EE.

## Zone E — web-backend (routes + middleware)

> The chat subsystem is NOT in the branch (future EE).

| Block                                | What                                                               | Verdict         | Effort | Note                                                                             |
| ------------------------------------ | ------------------------------------------------------------------ | --------------- | ------ | -------------------------------------------------------------------------------- |
| Core routes                          | workflows/executions/artifacts/notes/tokens/user/health/stats CRUD | 🟢 KEEP         | —      | ~75% core                                                                        |
| **Workflow sharing routes**          | invites TTL, access RBAC, accept                                   | 💰 EE           | —      | Complex RBAC                                                                     |
| Artifact/Note /stats                 | quota statistics                                                   | 🟡 MODE         | S      | Basics; advanced → EE                                                            |
| Artifact sharing                     | share endpoint                                                     | 💰 EE           | —      | —                                                                                |
| **Abuse reporting** (\_\_report)     | artifact moderation                                                | 💰 EE           | —      | Requires moderation                                                              |
| OAuth consents/sessions routes       | OAuth infra                                                        | 🟡 MODE         | S      | Per mode (OAuth optional)                                                        |
| Admin analytics                      | overview/executions/users/system                                   | 🟢 KEEP / 💰 EE | —      | read-only OK; advanced → EE                                                      |
| Admin (settings/users/workflows)     | admin CRUD                                                         | 🟢 KEEP         | —      | One admin OK                                                                     |
| user-security (block/verify/reset)   | requires email                                                     | 🟡 MODE         | S      | email-dependent ones per mode                                                    |
| Admin DB ops (vacuum/backup/restore) | direct DB access                                                   | 🟡 MODE         | S      | Exposed — tighten/hide                                                           |
| CORS origin allowlist                | `cors-middleware.ts`                                               | ✅ DONE         | S      | allowlist: getBaseUrl + EXTRA_TRUSTED_ORIGINS + CORS_ALLOWED_ORIGINS + localhost |
| IPv6 rate-limit key                  | `rate-limit-middleware.ts`                                         | ✅ DONE         | S      | ipKeyGenerator for IPv6 (artifactViewLimiter fallback)                           |
| Middleware (auth/admin/ratelimit)    | requireVerifiedAuth                                                | 🟡 MODE         | S      | email gate per mode                                                              |

**Zone summary:** core routes KEEP; sharing/abuse/advanced-analytics → EE; CORS+IPv6 done; email/DB-ops per MODE.

## Zone F — shared infra (email/metrics/audit/logging/errors/config)

| Block                               | What                     | Verdict | Effort | Note                                                                                      |
| ----------------------------------- | ------------------------ | ------- | ------ | ----------------------------------------------------------------------------------------- |
| EMAIL (Brevo + TestProvider)        | graceful fallback        | 🟢 KEEP | —      | Without BREVO_API_KEY → logs                                                              |
| EMAIL_FROM default                  | env.ts getEmailFrom      | ✅ DONE | S      | Default noreply@localhost in self-host                                                    |
| CONTACT_EMAIL default               | urls.ts getter           | ✅ DONE | S      | Default support@localhost in self-host                                                    |
| TELEGRAM_ENCRYPTION_KEY autogen     | secrets-bootstrap.ts     | ✅ DONE | S      | Auto-generated (256-bit) in self-host, persisted                                          |
| BETTER_AUTH_SECRET / ADMIN_PASSWORD | secrets-bootstrap.ts     | ✅ DONE | M      | Auto-generated on first start; ADMIN_PASSWORD shown once in logs; migration does not fail |
| METRICS (Prometheus :9090)          | monitoring               | 🟢 KEEP | —      | Optional                                                                                  |
| AUDIT (audit actions, geoip)        | observability            | 🟢 KEEP | —      | Superfluous but harmless; advanced export → EE                                            |
| LOGGING (winston)                   | —                        | 🟢 KEEP | —      | Required                                                                                  |
| ERRORS (domain/app)                 | —                        | 🟢 KEEP | —      | Required                                                                                  |
| MCP-CLIENTS (config generators)     | Cursor/VSCode/Claude/... | 🟢 KEEP | —      | Pure functions                                                                            |
| CONFIG (env singleton)              | —                        | 🟢 KEEP | —      | See required env above                                                                    |

**Zone summary:** infra mostly KEEP; **5 startup env blockers** (EMAIL_FROM, CONTACT_EMAIL, TELEGRAM_ENCRYPTION_KEY, BETTER_AUTH_SECRET, ADMIN_PASSWORD) → REWORK via auto-generation/defaults in self-host mode.

## Zone G — web-frontend + landing-page (UI)

| Block                                                        | What                                                                         | Verdict                    | Effort | Note                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------- | ------ | ---------------------------------------------------------- |
| Residency checkbox                                           | AuthProvider.tsx                                                             | ✅ DONE                    | S      | Hidden in self-host via legalConsents                      |
| Terms checkbox                                               | acceptedTermsAt                                                              | ✅ DONE                    | S      | Hidden in self-host via legalConsents                      |
| Auth pages                                                   | Login/Register/Reset/Verify/OAuth                                            | 🟢 KEEP                    | —      | Hide OAuth buttons when disabled                           |
| App pages                                                    | Dashboard/Workflows(+ReactFlow)/Executions/Notes/Artifacts/Settings/AuditLog | 🟢 KEEP                    | —      | —                                                          |
| Admin multi-user pages                                       | Users/Executions/Workflows/Artifacts/Reported                                | ✅ DONE                    | M      | Hidden in self-host via multiUserAdmin (nav + route guard) |
| Admin ReportedArtifacts                                      | moderation UI                                                                | 💰 EE                      | —      | —                                                          |
| Admin Settings/System/AuditLog/Deleted                       | schema/audit                                                                 | 🟢 KEEP                    | —      | Useful for a single admin                                  |
| **BetaAgreementModal + Banner**                              | SaaS disclaimer                                                              | 🟡 MODE                    | S      | Hide in self-host                                          |
| Quota UI (Notes/Artifacts)                                   | usedPercent                                                                  | 🟢 KEEP                    | —      | Configurable                                               |
| **landing brand** (index/developers/admin-data-access.astro) | marketing                                                                    | 🔴 REWORK (extract)        | M      | → moira-infra (see OSS-MIGRATION-PLAN Phase A)             |
| landing legal (terms/privacy.astro)                          | legal                                                                        | 🔴 REWORK                  | S      | Update for the self-host context                           |
| **docs (content/docs EN+RU)**                                | Starlight                                                                    | 🟢 KEEP (into OSS package) | M      | Extract into the docs site, DOCS_DIR (Phase 2.1)           |

**Zone summary:** residency/beta/admin-multiuser → MODE; landing brand → extract; docs → OSS package.

## Zone H — workflow-cli

| Block             | What                        | Verdict | Effort | Note                                                                     |
| ----------------- | --------------------------- | ------- | ------ | ------------------------------------------------------------------------ |
| CLI (19 commands) | view/edit/variables/version | 🟢 KEEP | —      | Standalone, offline, no auth/cloud. Critical for the self-host developer |

---

## Verdict Summary

### 🔴 REWORK (blockers/hardcoded) — priority for self-host

| #   | Block                                                                                                                                     | Effort | Zone |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| 1   | Startup env blockers: ADMIN_PASSWORD, EMAIL_FROM, CONTACT_EMAIL, TELEGRAM_ENCRYPTION_KEY (weak), BETTER_AUTH_SECRET — autogen/defaults ✅ | M      | F    |
| 2   | Legal consents terms/residency — behind DEPLOYMENT_MODE ✅                                                                                | M      | C    |
| 3   | Email verification gate (OAuth/tokens) — per mode ✅                                                                                      | M      | B,C  |
| 4   | API token email gate (requireVerifiedAuth) — lift in self-host ✅                                                                         | S      | B    |
| 5   | Note quotas hardcoded — global settings ✅                                                                                                | S      | D    |
| 6   | Execution retention/cleanup ✅                                                                                                            | M      | D    |
| 7   | CORS — configurable allowlist ✅                                                                                                          | S      | E    |
| 8   | IPv6 rate-limit key (ipKeyGenerator) ✅                                                                                                   | S      | E    |
| 9   | executionLock.pin — scrypt hash (security) ✅                                                                                             | S      | C    |
| 10  | Extract landing brand + update legal                                                                                                      | M      | G    |
| 11  | docs → separate OSS package (DOCS_DIR)                                                                                                    | M      | G    |

### 🟡 MODE (DEPLOYMENT_MODE)

Open registration, sendOnSignUp, residency/terms checkboxes, beta modal/banner, admin multi-user pages, email-dependent admin operations, OAuth consent routes, admin DB ops, basic /stats.

### 💰 EE candidates (paid layer, NOT a self-host toggle)

| EE feature                                   | Derived from                 | Zone  |
| -------------------------------------------- | ---------------------------- | ----- |
| Workflow sharing (invites + RBAC access)     | manage tool + sharing routes | B,D,E |
| Artifact sharing                             | artifacts share              | E     |
| Abuse reporting / moderation (takedown)      | \_\_report + admin reported  | E,G   |
| Advanced quota analytics / billing           | advanced /stats              | D,E   |
| Advanced admin analytics                     | analytics over-time/by-user  | E     |
| Audit export (compliance)                    | audit                        | F     |
| **chat / LLM orchestration** (not in branch) | future                       | —     |
| **SSO/SAML** (not in branch)                 | future                       | —     |
| **Central marketplace publishing**           | handle/slug + central        | —     |
| **Hosted multi-tenant cloud**                | —                            | —     |

### 🟢 KEEP (core, self-host ready)

The entire workflow-engine, core MCP tools, core backend routes, core UI, workflow-cli, settings, multi-user isolation, artifact quotas, logging/errors/config/mcp-clients, metrics/audit (optional).

---

## Overall Effort Estimate for Self-Host Code Adaptation

| Category                                  | # blocks   | Total                                    |
| ----------------------------------------- | ---------- | ---------------------------------------- |
| 🔴 REWORK                                 | 11         | ~3 S + ~5 M ≈ **6–9 days**               |
| 🟡 MODE (DEPLOYMENT_MODE infra + points)  | ~10 points | **~2–3 days** (incl. the mode mechanism) |
| 💰 EE (extraction/gating, separate track) | ~10        | depends on the EE architecture (step 4)  |
| 🟢 KEEP                                   | majority   | 0                                        |

**Conclusion:** for a working self-host (single-user → team) the main work is **DEPLOYMENT_MODE + ~11 targeted reworks (startup blockers, auth email gate, quotas, CORS/IPv6, security)**, ≈ **8–12 days**. EE extraction is a separate track (depends on the chosen EE architecture).
