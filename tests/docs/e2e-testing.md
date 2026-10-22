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
