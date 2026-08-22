# Test User Naming Conventions

When creating test users, use email addresses matching specific patterns.

## Why this matters

The email system redirects recognized test recipients only when the deployment
explicitly sets `EMAIL_TEST_RECIPIENTS=true`:

- `EMAIL_PROVIDER=test`: every message is logged and never sent.
- Real SMTP/Brevo provider plus `EMAIL_TEST_RECIPIENTS=true`: recognized test
  recipients are logged through the test sink; other recipients use the real provider.
- Suppression disabled: recipient naming does not change delivery.

The repository's CI environment combines a real-provider capability shape with
the explicit suppression switch. Do not run mail-producing tests against an
uncontrolled production deployment.

## Recommended formats

### Unit/Integration tests

```typescript
// test@example.com
test("password reset", async () => {
  await requestPasswordReset("test@example.com");
});

// testuser@example.com
test("sign up", async () => {
  await signUp({ email: "testuser@example.com", password: "Pass123" });
});

// user.test@example.com
test("email verification", async () => {
  await signUp({ email: "user.test@example.com", password: "Pass123" });
});
```

### E2E tests (Playwright)

```typescript
// e2e-<test-name>@moira.local
test("sign up flow", async () => {
  await page.goto("/signup");
  await page.fill('[name="email"]', "e2e-signup@moira.local");
  await page.fill('[name="password"]', "TestPass123");
  await page.click('button[type="submit"]');
});

// playwright-<scenario>@moira.local
test("login flow", async () => {
  await page.goto("/login");
  await page.fill('[name="email"]', "playwright-auth@moira.local");
  // ...
});
```

### Dynamically created users

```typescript
// test-<timestamp>@test.local
test("concurrent users", async () => {
  const timestamp = Date.now();
  const users = await Promise.all([
    signUp({ email: `test-${timestamp}@test.local`, password: "Pass123" }),
    signUp({ email: `test-${timestamp + 1}@test.local`, password: "Pass123" }),
  ]);
});

// test-<random>@test.local
test("unique users", async () => {
  const randomId = Math.random().toString(36).substr(2, 9);
  await signUp({ email: `test-${randomId}@test.local`, password: "Pass123" });
});
```

## Supported patterns

```typescript
/^[^@]+@example\.com$/i                    // IANA-reserved example domain
/^[^@]+@test\.com$/i                       // legacy CI fixture domain
/^[^@]+@test\.local$/i                     // local test fixtures
/^[^@]+@moira\.local$/i                    // local Moira fixtures
/^[^@]+@load-testing-noverify\.local$/i     // authenticated load-test fixtures
/^[^@]+@[^@]+\.test$/i                     // IANA-reserved .test TLD
```

These patterns have an effect only while `EMAIL_TEST_RECIPIENTS=true`.

## What NOT to use

❌ **admin@moira.local** - may conflict with a real admin

```typescript
// Bad
test("admin features", async () => {
  await signIn("admin@moira.local", "password"); // ❌
});

// Good
test("admin features", async () => {
  await signIn("e2e-admin@moira.local", "password"); // ✅
});
```

❌ **user@moira.local** - too generic, may be a real user

```typescript
// Bad
test("user profile", async () => {
  await signUp({ email: "user@moira.local", password: "Pass123" }); // ❌
});

// Good
test("user profile", async () => {
  await signUp({ email: "e2e-profile@moira.local", password: "Pass123" }); // ✅
});
```

❌ **Any real email addresses**

```typescript
// Bad - real email address
test("notifications", async () => {
  await signUp({ email: "john.doe@gmail.com", password: "Pass123" }); // ❌
});

// Good - test pattern
test("notifications", async () => {
  await signUp({ email: "test-notifications@example.com", password: "Pass123" }); // ✅
});
```

## Examples across test types

### Jest (Unit Tests)

```typescript
describe("Email Service", () => {
  it("sends verification email", async () => {
    const user = await createUser({
      email: "test@example.com",
      password: "Pass123",
    });

    await sendVerificationEmail(user);

    // EMAIL_PROVIDER=test logs without sending.
    expect(emailLogger.logs).toContainEqual(expect.objectContaining({ to: "test@example.com" }));
  });
});
```

### Playwright (E2E Tests)

```typescript
test.describe("Authentication Flow", () => {
  test("user can sign up", async ({ page }) => {
    await page.goto("/signup");

    await page.fill('[name="email"]', "e2e-signup@moira.local");
    await page.fill('[name="password"]', "TestPassword123");
    await page.click('button[type="submit"]');

    // In controlled CI, EMAIL_TEST_RECIPIENTS=true redirects this recipient.
    await expect(page.locator(".success-message")).toBeVisible();
  });
});
```

### Integration Tests

```typescript
describe("Workflow Notifications", () => {
  it("sends notification on workflow completion", async () => {
    const user = await createUser({
      email: "test-workflow@example.com",
      password: "Pass123",
    });

    const workflow = await createWorkflow({ userId: user.id });
    await completeWorkflow(workflow.id);

    // The explicit test provider logs without sending.
    expect(emailLogger.logs).toHaveLength(1);
  });
});
```

## Verifying in a controlled real-capability test environment

To confirm that test emails are not sent in production:

```bash
# Use reserved recipients and explicit suppression with an isolated test instance.
EMAIL_TEST_RECIPIENTS=true npm run test:e2e

# Check logs - you should see "TEST MODE: Email logged (not sent)"
# The public capability remains real; non-reserved recipients would use SMTP/Brevo.
```

## Adding new patterns

If you need to add a new pattern, edit:

```typescript
// packages/shared/src/email/index.ts
function isTestEmail(email: string): boolean {
  const testPatterns = [
    // ... existing patterns
    /^your-new-pattern@domain\.com$/i, // Add here
  ];

  return testPatterns.some((pattern) => pattern.test(email));
}
```

## FAQ

**Q: What if I forget to use a test email in a test?**

A: With `EMAIL_PROVIDER=test`, every message stays local. With a real provider,
only the explicit `EMAIL_TEST_RECIPIENTS=true` switch activates recipient
suppression. A fixture outside the recognized domains can otherwise reach the
configured provider, so CI must use the documented reserved corpus.

**Q: Can I use Gmail for tests?**

A: No. Use only test patterns. Gmail addresses will attempt to send real emails.

**Q: How do I confirm an email was not sent?**

A: Check the durable email log for `TEST MODE: Email logged (not sent)` and the
returned `delivery: logged` result. The public capability remains `real`; a
log-only result must never be reported as sent.
