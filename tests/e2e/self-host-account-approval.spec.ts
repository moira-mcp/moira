import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test.describe("self-host account approval experience", () => {
  test("registration stays pending until an administrator approves the account", async ({
    page,
    browser,
    request,
  }) => {
    const featuresResponse = await request.get(`${BASE_URL}/api/features`);
    expect(featuresResponse.ok()).toBe(true);
    const features = await featuresResponse.json();
    expect(features.data.deploymentMode).toBe("self-host");
    expect(features.data.features.accountApproval).toBe(true);
    expect(features.data.features.userManagement).toBe(true);
    expect(features.data.features.multiUserAdmin).toBe(false);

    let featureAttempts = 0;
    await page.route("**/api/features", async (route) => {
      featureAttempts += 1;
      if (featureAttempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: { message: "Temporary failure" } }),
        });
        return;
      }
      await route.continue();
    });

    const email = `approval-ui-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const password = "ApprovalUi123!";

    await page.goto(`${BASE_URL}/register`);
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Create an account" }).click();

    await page.waitForURL(`${BASE_URL}/registration-success`);
    await expect(page.getByText("Registration status unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText(/We've sent a verification email/i)).toHaveCount(0);
    await page.getByRole("button", { name: "Try loading settings again" }).click();
    await expect(page.getByTestId("pending-approval-status")).toContainText("awaiting approval");
    await expect(page.getByRole("status")).toContainText("Checking approval status");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(featureAttempts).toBe(2);
    await page.unroute("**/api/features");

    let protectedStatusFailed = false;
    let pendingStatusFailed = false;
    await page.route("**/api/user/me", async (route) => {
      const currentPath = new URL(page.url()).pathname;
      if (currentPath === "/" && !protectedStatusFailed) {
        protectedStatusFailed = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: { message: "Temporary failure" } }),
        });
        return;
      }
      if (
        currentPath === "/registration-success" &&
        protectedStatusFailed &&
        !pendingStatusFailed
      ) {
        pendingStatusFailed = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: { message: "Temporary failure" } }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`${BASE_URL}/`);
    await expect(page.getByRole("alert")).toContainText("could not load your account status");
    await expect(page).toHaveURL(`${BASE_URL}/`);
    await page.getByRole("button", { name: "Try again" }).click();
    await page.waitForURL(`${BASE_URL}/registration-success`);
    await expect(page.getByRole("alert")).toContainText("could not check your approval status");
    await expect(page.getByRole("alert")).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId("pending-approval-status")).toBeVisible();
    expect(protectedStatusFailed).toBe(true);
    expect(pendingStatusFailed).toBe(true);
    await page.unroute("**/api/user/me");

    let signOutAttempts = 0;
    await page.route("**/api/auth/sign-out", async (route) => {
      signOutAttempts += 1;
      if (signOutAttempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: { message: "Temporary failure" } }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("alert")).toContainText("could not sign you out");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
    await page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/user/me") &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    await expect(page.getByRole("alert")).toContainText("could not sign you out");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(`${BASE_URL}/login`);
    expect(signOutAttempts).toBe(2);

    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Login" }).click();
    await page.waitForURL(`${BASE_URL}/registration-success`);

    await page.goto(`${BASE_URL}/`);
    await page.waitForURL(`${BASE_URL}/registration-success`);
    await expect(page.getByTestId("pending-approval-status")).toBeVisible();

    const listEmail = `approval-list-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const listSignupResponse = await request.post(`${BASE_URL}/api/auth/sign-up/email`, {
      data: { email: listEmail, password, name: "List approval user" },
    });
    expect(listSignupResponse.ok()).toBe(true);

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    try {
      await loginAsAdmin(adminPage, false);
      await adminPage.goto(`${BASE_URL}/admin/users`);
      await adminPage.getByTestId("user-management-search").fill(email);

      const userCard = adminPage.getByTestId("user-card").filter({ hasText: email });
      await expect(userCard).toBeVisible();
      await expect(userCard.getByTestId("approval-status-pending")).toBeVisible();
      await userCard.click();
      await adminPage.waitForURL(/\/admin\/users\/[^/]+$/);

      await expect(adminPage.getByTestId("user-approval-pending")).toBeVisible();
      const approveButton = adminPage.getByTestId("approve-user-button");
      await expect(approveButton).toHaveAccessibleName("Approve account");
      await approveButton.click();

      const dialog = adminPage.getByRole("alertdialog");
      const confirmButton = dialog.getByRole("button", { name: "Approve account" });
      await expect(dialog).toContainText(email);

      let approvalAttempts = 0;
      await adminPage.route("**/api/admin/users/*/approve", async (route) => {
        approvalAttempts += 1;
        if (approvalAttempts === 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ success: false, error: { message: "Temporary failure" } }),
          });
          return;
        }
        await route.continue();
      });

      await confirmButton.click();
      await expect(confirmButton).toBeDisabled();
      const liveRegion = adminPage.locator(
        'section[aria-live="polite"][aria-relevant="additions text"]',
      );
      await expect(liveRegion).toContainText("Failed to approve account");
      await expect(dialog).toBeVisible();
      await expect(confirmButton).toBeEnabled();

      const approvalResponse = adminPage.waitForResponse(
        (response) =>
          response.url().endsWith("/approve") &&
          response.request().method() === "POST" &&
          response.status() === 200,
      );
      await confirmButton.focus();
      await adminPage.keyboard.press("Enter");
      await approvalResponse;

      await expect(dialog).toBeHidden();
      await expect(adminPage.getByTestId("user-approval-approved")).toBeVisible();
      await expect(adminPage.getByTestId("approval-focus-target")).toBeFocused();
      await expect(liveRegion).toContainText(`${email} is approved`);
      await expect(approveButton).toHaveCount(0);

      await adminPage.goto(`${BASE_URL}/admin/users?lang=ru`);
      await adminPage.getByTestId("user-management-search").fill(listEmail);
      const listUserCard = adminPage.getByTestId("user-card").filter({ hasText: listEmail });
      await expect(listUserCard.getByTestId("approval-status-pending")).toBeVisible();
      const listApproveAction = listUserCard.getByTestId("approve-user-action");
      await listApproveAction.focus();
      await expect(listApproveAction).toHaveAccessibleName(`Подтвердить ${listEmail}`);
      await listApproveAction.click();

      const listDialog = adminPage.getByRole("alertdialog");
      await expect(listDialog).toContainText(listEmail);
      let listApprovalAttempts = 0;
      await adminPage.route("**/api/admin/users/*/approve", async (route) => {
        listApprovalAttempts += 1;
        if (listApprovalAttempts === 1) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ success: false, error: { message: "Temporary failure" } }),
          });
          return;
        }
        await route.continue();
      });

      const listConfirmButton = listDialog.getByRole("button", {
        name: "Подтвердить учётную запись",
      });
      await listConfirmButton.click();
      await expect(liveRegion.getByText("Не удалось подтвердить учётную запись")).toBeVisible();
      await expect(liveRegion.getByText("Failed to approve user", { exact: true })).toHaveCount(0);
      await expect(listDialog).toBeVisible();

      const listApprovalResponse = adminPage.waitForResponse(
        (response) =>
          response.url().endsWith("/approve") &&
          response.request().method() === "POST" &&
          response.status() === 200,
      );
      await listConfirmButton.focus();
      await adminPage.keyboard.press("Enter");
      await listApprovalResponse;
      await expect(listDialog).toBeHidden();
      await expect(listUserCard.getByTestId("approval-status-approved")).toBeVisible();
      await expect(listUserCard.getByTestId("approval-status-pending")).toHaveCount(0);
      await expect(listApproveAction).toHaveCount(0);
      await expect(listUserCard.getByTestId("approval-list-focus-target")).toBeFocused();
      await expect(liveRegion).toContainText(
        `Учётная запись ${listEmail} подтверждена и получила доступ к Moira.`,
      );
      expect(listApprovalAttempts).toBe(2);
    } finally {
      await adminContext.close();
    }

    await page.waitForURL(`${BASE_URL}/`, { timeout: 10000 });
    await expect(page.getByTestId("pending-approval-status")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  });
});

test.describe("SaaS registration experience", () => {
  test("keeps legal consent and email-verification completion content", async ({ page }) => {
    let featureAttempts = 0;
    let failNextFeatureLoad = false;
    await page.route("**/api/features", async (route) => {
      featureAttempts += 1;
      if (featureAttempts === 2 || failNextFeatureLoad) {
        failNextFeatureLoad = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: { message: "Temporary failure" } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            deploymentMode: "saas",
            mcpUrl: `${BASE_URL}/mcp`,
            features: {
              openRegistration: true,
              accountApproval: false,
              emailVerificationGate: true,
              verificationEmailOnSignup: true,
              legalConsents: true,
              betaNotices: true,
              multiUserAdmin: true,
              userManagement: true,
              socialLogin: true,
            },
          },
          timestamp: new Date().toISOString(),
        }),
      });
    });
    await page.route("**/api/auth/get-session*", async (route) => {
      const now = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          session: {
            id: "saas-session",
            userId: "saas-user",
            token: "saas-session-token",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            createdAt: now,
            updatedAt: now,
          },
          user: {
            id: "saas-user",
            name: "SaaS user",
            email: "saas-user@example.com",
            emailVerified: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      });
    });

    await page.goto(`${BASE_URL}/register`);
    await page.goto(`${BASE_URL}/registration-success`);
    await expect(page.getByText("Registration status unavailable", { exact: true })).toBeVisible();
    await expect(page.getByTestId("pending-approval-status")).toHaveCount(0);
    await expect(page.getByText(/We've sent a verification email/i)).toHaveCount(0);
    await page.getByRole("button", { name: "Try loading settings again" }).click();
    await expect(page.getByText("Registration Successful!")).toBeVisible();
    expect(featureAttempts).toBe(3);

    await page.goto(`${BASE_URL}/register`);
    await expect(page.locator('[role="checkbox"]')).toHaveCount(2);

    await page.goto(`${BASE_URL}/registration-success`);
    await expect(page.getByText("Registration Successful!")).toBeVisible();
    await expect(page.getByText(/We've sent a verification email/i)).toBeVisible();
    await expect(page.getByText(/Waiting for email verification/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Resend verification email/i })).toBeVisible();
    await expect(page.getByTestId("pending-approval-status")).toHaveCount(0);

    await page.route("**/api/user/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            id: "saas-user",
            email: "saas-user@example.com",
            handle: null,
            isAdmin: false,
            passwordResetRequired: false,
            blocked: false,
            emailVerified: false,
            approvedAt: null,
            accountApproved: true,
            accountApprovalRequired: false,
          },
          timestamp: new Date().toISOString(),
        }),
      });
    });
    failNextFeatureLoad = true;
    await page.goto(`${BASE_URL}/`);
    await expect(
      page.getByText("We could not load the deployment settings needed to check your account."),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Try loading settings again" }).click();
    await page.waitForURL(`${BASE_URL}/registration-success`);
    await expect(page.getByText(/We've sent a verification email/i)).toBeVisible();
    await expect(page.getByTestId("pending-approval-status")).toHaveCount(0);
  });
});
