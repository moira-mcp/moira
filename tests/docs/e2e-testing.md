# E2E Testing Guide

## Authentication in E2E Tests

**ALWAYS use authentication helpers. NEVER write manual login/registration logic.**

**Why:**

- Email verification is required for login
- Tests must use unique users to avoid pollution
- Admin operations need proper authentication
- Manual auth code forgets critical steps

### Available Helpers

```typescript
import { createVerifiedTestUser, loginAsAdmin, loginAsUser } from "../utils/auth-helpers.js";

// Create new test user with email verified
const { email, password, userId } = await createVerifiedTestUser(page);

// Login as admin
await loginAsAdmin(page);

// Login as specific user
await loginAsUser(page, email, password);
```

### Registration Form Helper

```typescript
import { fillConsentCheckboxes } from "./helpers/consent-helper.js";

// Fill GDPR consent checkboxes in registration form
// Must be called AFTER filling email/password and BEFORE clicking submit
await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
await page.getByRole("textbox", { name: "Password" }).fill(testPassword);
await fillConsentCheckboxes(page); // Terms + Residency checkboxes
await page.getByRole("button", { name: "Create an account" }).click();
```

---

## Console Error Monitoring

All E2E tests automatically monitor browser console for authentication errors.

**Monitored patterns:**

- `[Login Error]`
- `[Register Error]`
- `[Forgot Password Error]`
- `[Reset Password Error]`
- `[OAuth Login Error]`

**When errors detected:**

- Written to stderr immediately
- Shown in test output with timestamp
- Helps diagnose forgotten authentication steps

**Example output when auth fails:**

```
[Browser Console Error] [Login Error] Email not verified
[Browser Console Error] [Login Error] Invalid credentials
```

**If you see these in test logs, check:**

1. Did you use `createVerifiedTestUser()` helper?
2. Did you verify email before login attempt?
3. Are credentials correct?

### Enable console monitoring

```typescript
// Import from console-monitor fixture instead of @playwright/test
import { test, expect } from "./fixtures/console-monitor.js";

test("my test", async ({ page }) => {
  // Console errors will be automatically captured and reported
});
```

**How it works:**

- The fixture uses `auto: true` which runs automatically for every test
- No need to explicitly use the fixture in test code
- Just import `test` from the fixture file instead of `@playwright/test`

---

## E2E Test Architecture: Setup vs Test

### The Problem

E2E test often requires data preparation before testing UI:

- Create user before login test
- Block user before "blocked user can't login" test
- Verify email before login test

**Bad approach:** doing setup through browser automation (Playwright/Chromium).

**Why it's bad:**

1. **Slow** - each chromium.launch() = seconds
2. **Unreliable** - race conditions between browser instances
3. **Hard to debug** - is it setup failing or the actual test?
4. **Fragile** - UI changed → setup breaks → test fails for wrong reason

### Solution: Separate Setup and Test

**Key question: WHAT exactly are we testing?**

#### Scenario 1: Testing UI functionality

Example: "admin can block user via UI"

```typescript
test("admin can block user via UI", async ({ page }) => {
  // Tested functionality = block UI
  // So EVERYTHING through browser:
  await loginAsAdmin(page);
  await page.goto("/admin/users");
  await page.click(`text=${testUserEmail}`);
  await page.click('button:has-text("Block User")');
  await page.fill("textarea", "Test block reason");
  await page.click('button:has-text("Confirm")');

  // Verify UI result
  await expect(page.locator("text=User blocked")).toBeVisible();
});
```

#### Scenario 2: Blocking = prerequisite, testing something else

Example: "blocked user cannot login"

```typescript
test("blocked user cannot login", async ({ page }) => {
  // Setup via API - fast and reliable
  const { userId } = await createTestUser(email, password, name, true);
  await blockUserViaApi(userId, "Test reason"); // ← API, not browser!

  // Tested functionality = login UI for blocked user
  await page.goto("/login");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');

  // Verify login rejected
  await expect(page.locator("text=/blocked/i")).toBeVisible();
});
```

### HTTP Helpers for Setup

Use `tests/utils/mcp-auth.ts` for API operations:

```typescript
import { verifyUserEmail, DEFAULT_ADMIN_CREDENTIALS } from "../../utils/mcp-auth.js";

// Create user
const signUpResponse = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, name }),
});

// Verify email (through admin session)
await verifyUserEmail(BASE_URL, email);

// Block user
await blockUserViaApi(BASE_URL, userId, adminSessionCookie);
```

### When to Use What

| Situation                           | Setup                           | Test    |
| ----------------------------------- | ------------------------------- | ------- |
| Testing block UI                    | Browser (it's the test subject) | Browser |
| Testing login for blocked user      | API (prerequisite)              | Browser |
| Testing registration                | -                               | Browser |
| Testing "blocked user redirected"   | API (prerequisite)              | Browser |
| Testing admin UI shows "blocked by" | API (create blocked user)       | Browser |

### Rule

**E2E test verifies UI interaction.**

- If action is test subject → Browser
- If action is data preparation → API

---

## Fixtures Import Rule

```typescript
// ✅ CORRECT
import { test, expect } from "./fixtures.js";

// ❌ WRONG
import { test, expect } from "@playwright/test";
```

**Why:** Fixtures enable automatic browser console/network logging.

---

## User Credentials

**CRITICAL RULE**: Tests that modify user credentials (password, email) MUST use dedicated test users, NOT shared credentials.

**Why**: Tests run in parallel. Modifying shared credentials causes race conditions.

**Do's**:

```typescript
// ✅ CORRECT: Dedicated test user for password change tests
const PASSWORD_TEST_USER = {
  email: "password-test@example.com",
  password: "InitialPass123!",
};

test("change password workflow", async () => {
  // This user is ONLY for password change tests
  const newPassword = "NewPass456!";
  await changePassword(PASSWORD_TEST_USER.email, PASSWORD_TEST_USER.password, newPassword);
  // ... restore password for this user only
});
```

**Don'ts**:

```typescript
// ❌ WRONG: Using admin credentials that other tests depend on
test("change password workflow", async () => {
  await changePassword("admin@moira.local", "AdminTest123", "NewPass!");
  // Other tests running in parallel will fail with 401!
});
```

**Helper Usage**:

- `DEFAULT_ADMIN_CREDENTIALS` - Read-only. Use for verification, listing, admin actions. NEVER modify.
- `verifyUserEmail(email)` - Uses admin login internally. Safe for any user EXCEPT admin.
- Create dedicated test users with unique emails for destructive operations.
