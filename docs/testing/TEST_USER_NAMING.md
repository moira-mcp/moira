# Test User Naming Conventions

When creating test users, use email addresses matching specific patterns.

## Why this matters

The email system automatically detects test users and:

- **Development/Test:** all emails are logged but not sent
- **Production:** emails to test addresses are logged, emails to real addresses are sent

This lets you run e2e tests against a production server without sending real emails.

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
// test<timestamp>@moira.local
test("concurrent users", async () => {
  const timestamp = Date.now();
  const users = await Promise.all([
    signUp({ email: `test${timestamp}@moira.local`, password: "Pass123" }),
    signUp({ email: `test${timestamp + 1}@moira.local`, password: "Pass123" }),
  ]);
});

// test<random>@moira.local
test("unique users", async () => {
  const randomId = Math.random().toString(36).substr(2, 9);
  await signUp({ email: `test${randomId}@moira.local`, password: "Pass123" });
});
```

## Supported patterns

```typescript
/^test.*@example\.com$/i        // test@example.com, testuser@example.com
/^.*\.test@example\.com$/i      // user.test@example.com, admin.test@example.com
/^e2e.*@moira\.local$/i         // e2e-user@moira.local, e2e123@moira.local
/^playwright.*@moira\.local$/i  // playwright-test@moira.local
/^test\d+@moira\.local$/i       // test1@moira.local, test123@moira.local
```

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

    // Email logged but not sent (test mode)
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

    // In production: email logged but not sent (test user)
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

    // Email logged but not sent
    expect(emailLogger.logs).toHaveLength(1);
  });
});
```

## Verifying in production

To confirm that test emails are not sent in production:

```bash
# Run e2e tests against production
PROD_URL=https://moira.example.com npm run test:e2e

# Check logs - you should see "TEST MODE: Email logged (not sent)"
# Real emails to non-test addresses still work normally
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

A: In development/test environments, all emails are logged. In production, a real email
will be sent to a real address.

**Q: Can I use Gmail for tests?**

A: No. Use only test patterns. Gmail addresses will attempt to send real emails.

**Q: How do I confirm an email was not sent?**

A: Check the logs - you should see `TEST MODE: Email logged (not sent)` instead of a real send.

```

```
