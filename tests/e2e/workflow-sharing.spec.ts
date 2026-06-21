/**
 * E2E Tests: Workflow Sharing via Invite Links (#433)
 *
 * Verifies:
 * - Share button appears for workflow owner
 * - Share dialog opens with tabs for invites and access
 * - Generate invite link functionality
 * - Copy invite link to clipboard
 * - Invite accept page displays correctly
 * - Revoke invite functionality
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin, login } from "./helpers/auth-helper.js";
import { TEST_USERS } from "./fixtures/test-constants.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_HANDLE = "admin";

test.describe("Workflow Sharing - Share Button", () => {
  test("should show Share button for workflow owner", async ({ page }) => {
    await loginAsAdmin(page);

    // Create a workflow
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Share Test Workflow",
            version: "1.0.0",
            description: "Workflow for testing share functionality",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    expect(createResponse.status()).toBe(200);

    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    const workflowSlug = responseData.data?.slug;
    expect(workflowId).toBeTruthy();

    // Navigate to workflow detail
    await page.goto(`${BASE_URL}/workflows/${ADMIN_HANDLE}/${workflowSlug}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Share button should be visible for owner
    const shareButton = page.locator('[data-testid="share-workflow-button"]');
    await expect(shareButton).toBeVisible();

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });
});

test.describe("Workflow Sharing - Share Dialog", () => {
  test("should open share dialog with tabs", async ({ page }) => {
    await loginAsAdmin(page);

    // Create a workflow
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Share Dialog Test",
            version: "1.0.0",
            description: "Workflow for testing share dialog",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    const workflowSlug = responseData.data?.slug;

    // Navigate to workflow
    await page.goto(`${BASE_URL}/workflows/${ADMIN_HANDLE}/${workflowSlug}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Click share button
    await page.locator('[data-testid="share-workflow-button"]').click();

    // Dialog should open
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();

    // Should have tabs for Invites and Access
    const invitesTab = dialog.locator(
      'button:has-text("Invite Links"), button:has-text("Ссылки-приглашения")',
    );
    const accessTab = dialog.locator(
      'button:has-text("Users with Access"), button:has-text("Пользователи с доступом")',
    );
    await expect(invitesTab).toBeVisible();
    await expect(accessTab).toBeVisible();

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });

  test("should generate invite link", async ({ page }) => {
    await loginAsAdmin(page);

    // Create a workflow with UUID so we can use it directly
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Invite Generate Test",
            version: "1.0.0",
            description: "Workflow for testing invite generation",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    expect(workflowId).toBeTruthy();

    // Navigate to workflow using UUID (more reliable)
    await page.goto(`${BASE_URL}/workflows/${workflowId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Click share button
    const shareButton = page.locator('[data-testid="share-workflow-button"]');
    await expect(shareButton).toBeVisible({ timeout: 10000 });
    await shareButton.click();

    // Wait for dialog to open
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Wait for loading to complete (generate button should be enabled)
    const generateButton = page.locator('[data-testid="generate-invite-button"]');
    await expect(generateButton).toBeVisible({ timeout: 10000 });
    await expect(generateButton).toBeEnabled({ timeout: 5000 });

    // Generate invite
    await generateButton.click();

    // Wait for invite to be created
    await page.waitForTimeout(2000);

    // Should show invite item
    const inviteItem = page.locator('[data-testid="invite-item"]');
    await expect(inviteItem).toBeVisible({ timeout: 10000 });

    // Should have copy button
    const copyButton = page.locator('[data-testid="copy-invite-button"]');
    await expect(copyButton).toBeVisible();

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });

  test("should revoke invite", async ({ page }) => {
    await loginAsAdmin(page);

    // Create a workflow
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Invite Revoke Test",
            version: "1.0.0",
            description: "Workflow for testing invite revocation",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    expect(workflowId).toBeTruthy();

    // Navigate to workflow using UUID
    await page.goto(`${BASE_URL}/workflows/${workflowId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Click share button
    const shareButton = page.locator('[data-testid="share-workflow-button"]');
    await expect(shareButton).toBeVisible({ timeout: 10000 });
    await shareButton.click();

    // Wait for dialog to open
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Wait for and click generate button
    const generateButton = page.locator('[data-testid="generate-invite-button"]');
    await expect(generateButton).toBeVisible({ timeout: 10000 });
    await expect(generateButton).toBeEnabled({ timeout: 5000 });
    await generateButton.click();
    await page.waitForTimeout(2000);

    // Verify invite exists
    const inviteItem = page.locator('[data-testid="invite-item"]');
    await expect(inviteItem).toBeVisible({ timeout: 10000 });

    // Handle confirm dialog — now using ConfirmDialog component instead of native confirm()
    // Click revoke button
    const revokeButton = page.locator('[data-testid="revoke-invite-button"]');
    await revokeButton.click();

    // Wait for ConfirmDialog to appear and confirm
    const confirmButton = page.getByRole("button", { name: /delete|удалить/i });
    await expect(confirmButton).toBeVisible({ timeout: 5000 });
    await confirmButton.click();

    // Wait for revocation
    await page.waitForTimeout(1000);

    // Invite should be removed or marked as revoked
    await expect(inviteItem).not.toBeVisible();

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });
});

test.describe("Workflow Sharing - Invite Accept Page", () => {
  test("should display invite info for valid token", async ({ page }) => {
    await loginAsAdmin(page);

    // Create a workflow
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Invite Accept Test",
            version: "1.0.0",
            description: "Workflow for testing invite acceptance",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;

    // Create invite via API
    const inviteResponse = await page.request.post(
      `${BASE_URL}/api/workflows/${workflowId}/invites`,
    );
    expect(inviteResponse.status()).toBe(201);
    const inviteData = await inviteResponse.json();
    const token = inviteData.data?.invite?.token;
    const inviteUrl = inviteData.data?.inviteUrl;
    console.log("=== INVITE DATA ===");
    console.log("Token:", token);
    console.log("InviteUrl:", inviteUrl);
    console.log("Full response:", JSON.stringify(inviteData, null, 2));
    expect(token).toBeTruthy();

    // Clear cookies to test as unauthenticated user
    await page.context().clearCookies();

    // Navigate to invite accept page
    await page.goto(`${BASE_URL}/invites/${token}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    // Should show workflow name
    const workflowName = page.getByText("Invite Accept Test");
    await expect(workflowName).toBeVisible({ timeout: 10000 });

    // Should show sign in button for unauthenticated user
    const signInButton = page.getByRole("link", { name: /Sign In|Войти/i });
    await expect(signInButton).toBeVisible({ timeout: 10000 });

    // Cleanup (login as admin to delete)
    await loginAsAdmin(page);
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });

  test("should show error for invalid token", async ({ page }) => {
    // Navigate to invite page with invalid token
    await page.goto(`${BASE_URL}/invites/invalid-token-12345678`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    // Should show not found message (CardTitle renders as div, not heading)
    const notFoundTitle = page.getByText(/Invite Not Found|Приглашение не найдено/i);
    await expect(notFoundTitle).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Workflow Sharing - Handle/Slug Format", () => {
  test("should generate invite and copy link on existing workflow react-flow-theme-test", async ({
    page,
  }) => {
    await loginAsAdmin(page);

    // Use existing workflow that user reported as broken
    const handle = "admin";
    const slug = "react-flow-theme-test";

    // Navigate using handle/slug format
    await page.goto(`${BASE_URL}/workflows/${handle}/${slug}`);
    await page.waitForLoadState("networkidle");

    // Open share dialog
    await page.locator('[data-testid="share-workflow-button"]').click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Click generate
    await page.locator('[data-testid="generate-invite-button"]').click();

    // Wait for invite to appear and click copy button (use first() since there may be multiple invites)
    const copyButton = page.locator('[data-testid="copy-invite-button"]').first();
    await expect(copyButton).toBeVisible({ timeout: 5000 });
    await copyButton.click();
  });
});

test.describe("Workflow Sharing - Shared Workflow Visibility", () => {
  test("shared workflow should appear in recipient's workflow list", async ({ page, context }) => {
    await loginAsAdmin(page);

    // Create a private workflow
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Shared Visibility Test",
            version: "1.0.0",
            description: "Test that shared workflow appears in list",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    expect(workflowId).toBeTruthy();

    // Create invite
    const inviteResponse = await page.request.post(
      `${BASE_URL}/api/workflows/${workflowId}/invites`,
    );
    expect(inviteResponse.status()).toBe(201);
    const inviteData = await inviteResponse.json();
    const token = inviteData.data?.invite?.token;
    expect(token).toBeTruthy();
    console.log("Created invite token:", token);

    // Login as MCP_TOOLS_TEST user in new page using the proper helper
    const newPage = await context.newPage();
    await login(newPage, TEST_USERS.MCP_TOOLS_TEST.email, TEST_USERS.MCP_TOOLS_TEST.password, true);

    // Accept invite as MCP_TOOLS_TEST user
    const acceptResponse = await newPage.request.post(`${BASE_URL}/api/invites/${token}/accept`);
    console.log("Accept response status:", acceptResponse.status());
    const acceptData = await acceptResponse.json();
    console.log("Accept response:", JSON.stringify(acceptData, null, 2));
    expect(acceptResponse.status()).toBe(201);

    // Navigate to workflows list as MCP_TOOLS_TEST user
    await newPage.goto(`${BASE_URL}/workflows`);
    await newPage.waitForLoadState("networkidle");
    await newPage.waitForTimeout(2000);

    // Check that shared workflow appears in list (use first() in case of duplicates from previous test runs)
    const sharedWorkflow = newPage.getByText("Shared Visibility Test").first();
    await expect(sharedWorkflow).toBeVisible({ timeout: 10000 });

    // Cleanup
    await newPage.close();
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });
});

test.describe("Workflow Sharing - Access List", () => {
  test("should show access tab with no users initially", async ({ page }) => {
    await loginAsAdmin(page);

    // Create a workflow
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Access List Test",
            version: "1.0.0",
            description: "Workflow for testing access list",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    expect(workflowId).toBeTruthy();

    // Navigate to workflow using UUID
    await page.goto(`${BASE_URL}/workflows/${workflowId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Open share dialog
    const shareButton = page.locator('[data-testid="share-workflow-button"]');
    await expect(shareButton).toBeVisible({ timeout: 10000 });
    await shareButton.click();

    // Wait for dialog to open
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Wait for loading to complete
    await page.waitForTimeout(1000);

    // Click on Access tab (shadcn Tabs uses role="tab")
    const accessTab = page.getByRole("tab", {
      name: /Users with Access|Пользователи с доступом/i,
    });
    await accessTab.click();
    await page.waitForTimeout(1000);

    // Should show empty message
    const emptyMessage = page.getByText(
      /No users have shared access yet|Пока нет пользователей с общим доступом/i,
    );
    await expect(emptyMessage).toBeVisible({ timeout: 10000 });

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });
});

test.describe("Workflow Sharing - Revoke Access", () => {
  test("owner can revoke user access via API", async ({ page, browser }) => {
    await loginAsAdmin(page);

    // Create a private workflow
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Revoke Access Test",
            version: "1.0.0",
            description: "Test revoking user access",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    expect(workflowId).toBeTruthy();

    // Create invite
    const inviteResponse = await page.request.post(
      `${BASE_URL}/api/workflows/${workflowId}/invites`,
    );
    expect(inviteResponse.status()).toBe(201);
    const inviteData = await inviteResponse.json();
    const token = inviteData.data?.invite?.token;
    expect(token).toBeTruthy();

    // Login as another user in separate context to accept invite
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await login(
      secondPage,
      TEST_USERS.MCP_TOOLS_TEST.email,
      TEST_USERS.MCP_TOOLS_TEST.password,
      true,
    );

    // Accept invite
    const acceptResponse = await secondPage.request.post(`${BASE_URL}/api/invites/${token}/accept`);
    expect(acceptResponse.status()).toBe(201);
    await secondContext.close();

    // Get list of users with access as admin
    const accessListResponse = await page.request.get(
      `${BASE_URL}/api/workflows/${workflowId}/access`,
    );
    expect(accessListResponse.status()).toBe(200);
    const accessListData = await accessListResponse.json();
    console.log("Access list:", JSON.stringify(accessListData, null, 2));

    // Should have at least one user with access
    expect(accessListData.data.users.length).toBeGreaterThan(0);
    const sharedUserId = accessListData.data.users[0].userId;
    expect(sharedUserId).toBeTruthy();

    // Revoke access
    const revokeResponse = await page.request.delete(
      `${BASE_URL}/api/workflows/${workflowId}/access/${sharedUserId}`,
    );
    console.log("Revoke response status:", revokeResponse.status());
    const revokeData = await revokeResponse.json();
    console.log("Revoke response:", JSON.stringify(revokeData, null, 2));
    expect(revokeResponse.status()).toBe(200);
    expect(revokeData.data.revoked).toBe(true);

    // Verify access is revoked
    const accessListAfter = await page.request.get(
      `${BASE_URL}/api/workflows/${workflowId}/access`,
    );
    const accessListAfterData = await accessListAfter.json();
    expect(accessListAfterData.data.users.length).toBe(0);

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });

  test("owner can revoke access via UI", async ({ page, browser }) => {
    test.slow();
    await loginAsAdmin(page);

    // Create a private workflow
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Revoke Access UI Test",
            version: "1.0.0",
            description: "Test revoking user access via UI",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    expect(workflowId).toBeTruthy();

    // Create invite
    const inviteResponse = await page.request.post(
      `${BASE_URL}/api/workflows/${workflowId}/invites`,
    );
    expect(inviteResponse.status()).toBe(201);
    const inviteData = await inviteResponse.json();
    const token = inviteData.data?.invite?.token;
    expect(token).toBeTruthy();

    // Login as another user in separate context to accept invite
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await login(
      secondPage,
      TEST_USERS.MCP_TOOLS_TEST.email,
      TEST_USERS.MCP_TOOLS_TEST.password,
      true,
    );

    // Accept invite
    const acceptResponse = await secondPage.request.post(`${BASE_URL}/api/invites/${token}/accept`);
    expect(acceptResponse.status()).toBe(201);
    await secondContext.close();

    // Navigate to workflow as admin
    await page.goto(`${BASE_URL}/workflows/${workflowId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Open share dialog
    const shareButton = page.locator('[data-testid="share-workflow-button"]');
    await expect(shareButton).toBeVisible({ timeout: 10000 });
    await shareButton.click();

    // Wait for dialog to open
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Click on Access tab (shadcn Tabs uses role="tab")
    const accessTab = page.getByRole("tab", {
      name: /Users with Access|Пользователи с доступом/i,
    });
    await accessTab.click();
    await page.waitForTimeout(1000);

    // Should see user with access
    const accessItem = page.locator('[data-testid="access-item"]');
    await expect(accessItem).toBeVisible({ timeout: 10000 });

    // Click revoke access button — opens ConfirmDialog
    const revokeAccessButton = page.locator('[data-testid="revoke-access-button"]');
    await revokeAccessButton.click();

    // Wait for ConfirmDialog and confirm
    const confirmButton = page.getByRole("button", { name: /delete|удалить/i });
    await expect(confirmButton).toBeVisible({ timeout: 5000 });
    await confirmButton.click();

    // Wait for revocation
    await page.waitForTimeout(1000);

    // Access item should be removed
    await expect(accessItem).not.toBeVisible();

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });
});

test.describe("Workflow Sharing - Redirect URL Format", () => {
  test("accept invite API returns handle/slug for redirect", async ({ page, context }) => {
    await loginAsAdmin(page);

    // Create a workflow
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Redirect Test Workflow",
            version: "1.0.0",
            description: "Test that accept returns handle/slug for redirect",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    const workflowSlug = responseData.data?.slug;
    expect(workflowId).toBeTruthy();
    expect(workflowSlug).toBeTruthy();

    // Create invite
    const inviteResponse = await page.request.post(
      `${BASE_URL}/api/workflows/${workflowId}/invites`,
    );
    expect(inviteResponse.status()).toBe(201);
    const inviteData = await inviteResponse.json();
    const token = inviteData.data?.invite?.token;
    expect(token).toBeTruthy();

    // Login as another user to accept invite
    const newPage = await context.newPage();
    await login(newPage, TEST_USERS.MCP_TOOLS_TEST.email, TEST_USERS.MCP_TOOLS_TEST.password, true);

    // Accept invite and verify response includes handle/slug
    const acceptResponse = await newPage.request.post(`${BASE_URL}/api/invites/${token}/accept`);
    expect(acceptResponse.status()).toBe(201);
    const acceptData = await acceptResponse.json();
    console.log("Accept response:", JSON.stringify(acceptData, null, 2));

    // Verify response contains ownerHandle and slug for redirect
    expect(acceptData.data.ownerHandle).toBe(ADMIN_HANDLE);
    expect(acceptData.data.slug).toBe(workflowSlug);
    expect(acceptData.data.workflowId).toBe(workflowId);

    // Cleanup
    await newPage.close();
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });
});
