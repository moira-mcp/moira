# Browser testing

Use the [testing guide](../TESTING-GUIDE.md) for suite selection and the
[infrastructure guide](test-infrastructure.md#e2e-projects) for project dependencies and target routing.

## Fixtures and authentication

Specs under `tests/e2e/` import the shared fixture:

```typescript
import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

test("administrator opens the dashboard", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`${getTestBaseUrl()}/admin`);
  await expect(page.getByTestId("admin-system-health")).toBeVisible();
});
```

Choose a stable control from the page under test rather than copying a selector for another route.
[fixtures.ts](../e2e/fixtures.ts) captures browser console and network facts, redacts request bodies
and emits failure diagnostics. It also applies optional CPU throttling. Importing Playwright's
`test` directly bypasses those fixtures.

The fast [auth helper](../e2e/helpers/auth-helper.ts) signs in over HTTP, installs the session
cookie, sets beta acceptance by default and navigates into the app. Use its `login` or
`loginAsAdmin` when authentication is a prerequisite. When the login form itself is the subject,
use [auth-helper.browser.ts](../e2e/helpers/auth-helper.browser.ts), which fills and submits it.
Do not replace the subject action with an API call.

For fixture accounts, `createTestUser(email, password, name, verifyEmail)` performs HTTP signup and
optionally email verification and deployment-specific approval. Check its success result before
using the account. [approve-test-user.ts](../e2e/helpers/approve-test-user.ts) keeps self-host
approval distinct from email verification. Tests of registration itself act on the actual form
and use [consent-helper.ts](../e2e/helpers/consent-helper.ts) for its consent controls.

Credential changes and destructive account cases use dedicated unique users. Shared admin
credentials are for admission and setup; never change their password or email. Clean up only
records and resources owned by the case. A cookie value is not a complete Cookie header:
`getSessionCookieHeader` returns a ready header for Node-side requests, while the
[API/MCP helper](api-mcp-testing.md#http-preparation) exposes value/header primitives separately.

## Prerequisite versus observed action

If the case proves blocking a user through the UI, perform that action in the browser and assert
its visible result. If it proves the login error for an already blocked user, create/block that
user through the existing HTTP helpers, then exercise the browser login form. This keeps setup
independent without bypassing the behavior being tested.

Use the configured browser base URL and the resolver's fetch URL for Node preparation. Remote
browsers can see a different host from the local Node process; do not hard-code a localhost port
or assume `TEST_BASE_URL` redirects both. See [target selection](test-infrastructure.md#target-selection).

## Account and session acceptance

Choose cases for the changed boundary rather than treating every account check as manual-only.
[cross-tab-authority.spec.ts](../e2e/cross-tab-authority.spec.ts) already exercises real shared
cookies with controlled delayed observations. [ProtectedRoute](../../packages/web-frontend/src/components/ProtectedRoute.tsx),
[session coordination](../../packages/web-frontend/src/auth/better-auth-client.ts) and
[return URL validation](../../packages/web-frontend/src/utils/return-url.ts) own the behavior:

| Case                                         | Observation that distinguishes correct behavior                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login from a protected deep link             | Successful admission returns to the safe requested relative path; external/protocol-relative/traversal targets and prefix-aware login loops are refused.                                                     |
| Logout or account replacement in another tab | Previously admitted private content is hidden while identity is unknown; the replacement account never sees the previous account's holdings.                                                                 |
| Recheck confirms the same account            | Existing mounted content and drafts survive confirmation; an ordinary resource-level 403 does not sign the account out.                                                                                      |
| A previous account's request finishes late   | Its success, failure, targeted revoke and redirect cannot overwrite new content or expire the replacement shared cookie.                                                                                     |
| Session loss                                 | After authoritative session refusal, protected content stays hidden and sign-in remains usable. Removing a cookie tests missing credentials; server-side expiry or revocation needs its own controlled case. |
| Ordinary user opens an administrator route   | No administrator content becomes visible; separately verify server refusal, since a browser redirect alone does not prove API authorization.                                                                 |
| Administrator blocks a dedicated user        | Observe the actual UI action when that is the subject, then verify denied sign-in and existing access through the [API/MCP boundary](api-mcp-testing.md#account-admission-and-retirement).                   |

Keep self-host approval, SaaS verification, administrator role and capabilities separate. Signup
can issue a session while product access remains pending; feature hiding is not server enforcement.
For forced reset, consent and invite completion, retain the initiating account and await settled
session facts before asserting a redirect. Use owned users and avoid waiting days for expiry:
controlled session state verifies that transition, while real elapsed/provider behavior is a
separate acceptance claim. Contracts are in [authentication](../../docs/reference/authentication.md).

## Browser and external acceptance

A mocked provider or SDK OAuth fixture does not verify real Google/GitHub sign-in. When explicitly
authorized, use a configured test installation with social login enabled and an owned provider
account: exercise the actual button, provider consent, return, resulting account identity and
admitted application session. Also inspect cancellation/refusal without assuming every refusal
returns a successful login. Existing-email linking must follow the configured authentication
policy; do not assume that matching email alone authorizes linking. The built-in self-host policy
does not offer social login. [Better Auth configuration](../../packages/shared/src/auth/better-auth-config.ts)
owns provider enablement; this is distinct from workspace GitHub App pairing.

For changed email flows, verify the mode's expected action and actual received link with an owned
mailbox when real delivery is authorized. Check verification/reset completion and rejection of the
old password after reset; a test-log URL, provider acceptance or public `real` capability alone
does not prove inbox arrival. Without real delivery, verify unavailable controls and the supported
ordinary-user recovery path. Do not invent a fixed delivery time or exact subject as a release
guarantee; use [account/configuration contracts](../../docs/operator/accounts.md).

Inspect changed navigation, forms, tables and diagrams at relevant mobile/desktop widths,
keyboard focus, theme and locale. Record the actual browser/device used; a Chromium pass does
not establish Safari/Firefox/Edge compatibility. Landing/deployment presentation belongs to its
source owner. For performance changes, select a representative owned dataset and observe the
specific pagination, rendering or concurrent-request behavior; arbitrary historic item/time
thresholds are not current product guarantees. Native/provider effects remain separately scoped
below and in the [acceptance guide](../TESTING-GUIDE.md#native-and-provider-acceptance).

## Run and inspect

```bash
npm run test:e2e -- --file tests/e2e/admin-panel.spec.ts
E2E_CPU_THROTTLE=8 npm run test:e2e -- --file tests/e2e/flow-page.spec.ts -- --retries=0
```

Installation-wide settings specs run before Chromium readers even for a selected reader file.
Inspector and other external-service specs require their actual supporting services and
`PLAYWRIGHT_INCLUDE_EXTERNAL=true`; that opt-in does not prepare the services. For Inspector,
use the repository's [Compose definition](../../docker-compose.inspector.yml) and the selected
environment, then run the desired existing spec. Do not create a listener before checking the
local port inventory.

Assert observable behavior with ordinary actionable clicks, keyboard focus and persisted reads
where relevant. Wait for the state the action produces rather than a delay or forced click.
For diagrams use the settled-camera helper. For a guide's dock/rectangle, sample both facts in
one evaluation so an animation cannot split the observation.

Screenshots establish rendered presentation at the inspected viewport/theme/locale. Mocked owner
responses do not prove native settings effects, external delivery or VM recovery. Real native and
provider acceptance is [separate](../TESTING-GUIDE.md#native-and-provider-acceptance). Failure
artifacts may contain sensitive URLs or OAuth diagnostics; inspect locally and redact before sharing.
