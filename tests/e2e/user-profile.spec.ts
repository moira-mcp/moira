/**
 * User Profile E2E Tests
 * Tests profile editing, password changes, and email verification
 *
 * NOTE: Each test creates its own unique test user to avoid race conditions
 * when tests run in parallel. See TEST-WRITING-GUIDE.md for details.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { login, createTestUser } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("User Profile Management", () => {
  // Increase timeout for all tests in this suite (user creation + login + page loads)
  test.setTimeout(60000);

  test.describe("Profile viewing and editing", () => {
    test("profile page loads with user data", async ({ page }) => {
      // Create unique test user (no ! in password to avoid escaping issues)
      const testUser = {
        email: `profile-load-${Date.now()}@example.com`,
        password: "TestPass123",
        name: "Profile Load Test",
      };
      const result = await createTestUser(testUser.email, testUser.password, testUser.name, true);
      if (!result.success) {
        throw new Error(`Failed to create test user: ${result.error}`);
      }

      // Login and navigate
      await login(page, testUser.email, testUser.password);
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Wait for settings page to fully load by checking for Profile section
      await expect(page.getByLabel("Name")).toBeVisible({
        timeout: 15000,
      });

      // Security section is also visible (scrollable page, no tabs)
      await expect(page.getByLabel("Current Password")).toBeVisible();

      // Check user data fields are visible
      await expect(page.getByLabel("Name")).toBeVisible();
      await expect(page.getByLabel("Email")).toBeVisible();

      // Check email value is populated
      const emailInput = page.getByLabel("Email");
      const emailValue = await emailInput.inputValue();
      expect(emailValue).toBe(testUser.email);

      console.log("✓ Profile page loaded with user data");
    });

    test("can edit and save user name", async ({ page }) => {
      // Create unique test user
      const testUser = {
        email: `profile-edit-${Date.now()}@example.com`,
        password: "TestPass123",
        name: "Original Name",
      };
      const result = await createTestUser(testUser.email, testUser.password, testUser.name, true);
      if (!result.success) {
        throw new Error(`Failed to create test user: ${result.error}`);
      }

      // Login and navigate
      await login(page, testUser.email, testUser.password);
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Wait for settings page to load by checking for Name input
      const nameInput = page.getByLabel("Name");
      await expect(nameInput).toBeVisible({ timeout: 15000 });
      const originalName = await nameInput.inputValue();

      // Generate new name
      const newName = `Updated ${Date.now()}`;

      // Clear and type new name
      await nameInput.fill(newName);

      // Click save button
      await page.getByRole("button", { name: "Save Changes" }).click();

      // Wait for success message
      await expect(page.getByText("Profile updated successfully")).toBeVisible({ timeout: 5000 });

      // Reload page to verify persistence
      await page.reload();
      await page.waitForLoadState("domcontentloaded");

      // Wait for Name input to be visible after reload
      await expect(page.getByLabel("Name")).toBeVisible({ timeout: 15000 });

      // Verify name persisted
      const nameAfterReload = await page.getByLabel("Name").inputValue();
      expect(nameAfterReload).toBe(newName);

      console.log(`✓ Name updated from "${originalName}" to "${newName}"`);
    });

    test("validates name length (max 100 characters)", async ({ page }) => {
      // Create unique test user
      const testUser = {
        email: `profile-validation-${Date.now()}@example.com`,
        password: "TestPass123",
        name: "Validation Test",
      };
      const result = await createTestUser(testUser.email, testUser.password, testUser.name, true);
      if (!result.success) {
        throw new Error(`Failed to create test user: ${result.error}`);
      }

      // Login and navigate
      await login(page, testUser.email, testUser.password);
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      const nameInput = page.getByLabel("Name");
      await expect(nameInput).toBeVisible({ timeout: 15000 });

      // Try to enter name longer than 100 characters
      const longName = "a".repeat(101);
      await nameInput.fill(longName);

      // Click save
      await page.getByRole("button", { name: "Save Changes" }).click();

      // Wait for response
      await page.waitForTimeout(500);

      // Name should be truncated by client maxLength attribute to 100 chars
      const actualValue = await nameInput.inputValue();
      expect(actualValue.length).toBeLessThanOrEqual(100);

      console.log("✓ Name length validation triggered");
    });

    test("email verification status is displayed", async ({ page }) => {
      // Create unique test user WITH email verification
      const testUser = {
        email: `profile-verify-${Date.now()}@example.com`,
        password: "TestPass123",
        name: "Verification Test",
      };
      const result = await createTestUser(testUser.email, testUser.password, testUser.name, true);
      if (!result.success) {
        throw new Error(`Failed to create test user: ${result.error}`);
      }

      // Login and navigate
      await login(page, testUser.email, testUser.password);
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Check for email verification badge/status
      await expect(page.getByLabel("Email")).toBeVisible({ timeout: 15000 });

      // User should be verified (created with verification in helper)
      await expect(page.getByText("Verified")).toBeVisible();

      console.log("✓ Email verification status displayed");
    });
  });

  test.describe("Security section and password validation", () => {
    test("security section shows password change form", async ({ page }) => {
      // Create unique test user
      const testUser = {
        email: `security-tab-${Date.now()}@example.com`,
        password: "TestPass123",
        name: "Security Tab Test",
      };
      const result = await createTestUser(testUser.email, testUser.password, testUser.name, true);
      if (!result.success) {
        throw new Error(`Failed to create test user: ${result.error}`);
      }

      // Login and navigate
      await login(page, testUser.email, testUser.password);
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Wait for security section to be visible on scrollable page (no tab switching needed)
      await expect(page.getByLabel("Current Password")).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByLabel("New Password")).toBeVisible({ timeout: 5000 });
      await expect(page.getByLabel("Confirm Password")).toBeVisible({ timeout: 5000 });

      // Check change password button is visible
      await expect(page.getByRole("button", { name: "Change Password" })).toBeVisible();

      console.log("✓ Security tab shows password change form");
    });

    test("password change validates matching passwords", async ({ page }) => {
      // Create unique test user
      const testUser = {
        email: `password-match-${Date.now()}@example.com`,
        password: "TestPass123",
        name: "Password Match Test",
      };
      const result = await createTestUser(testUser.email, testUser.password, testUser.name, true);
      if (!result.success) {
        throw new Error(`Failed to create test user: ${result.error}`);
      }

      // Login and navigate
      await login(page, testUser.email, testUser.password);
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Security section visible on scrollable page (no tab switching)
      await expect(page.getByLabel("Current Password")).toBeVisible({ timeout: 15000 });
      await page.getByLabel("Current Password").fill(testUser.password);
      await page.getByLabel("New Password").fill("NewPassword123!");
      await page.getByLabel("Confirm Password").fill("DifferentPassword123!");

      // Try to submit
      await page.getByRole("button", { name: "Change Password" }).click();

      // Should show validation error
      await expect(page.getByText("Passwords do not match")).toBeVisible({ timeout: 2000 });

      console.log("✓ Password mismatch validation works");
    });

    test("password change validates minimum length", async ({ page }) => {
      // Create unique test user
      const testUser = {
        email: `password-minlength-${Date.now()}@example.com`,
        password: "TestPass123",
        name: "Password MinLength Test",
      };
      const result = await createTestUser(testUser.email, testUser.password, testUser.name, true);
      if (!result.success) {
        throw new Error(`Failed to create test user: ${result.error}`);
      }

      // Login and navigate
      await login(page, testUser.email, testUser.password);
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Security section visible on scrollable page (no tab switching)
      await expect(page.getByLabel("Current Password")).toBeVisible({ timeout: 15000 });

      // Fill with password shorter than 6 characters
      await page.getByLabel("Current Password").fill(testUser.password);
      await page.getByLabel("New Password").fill("12345");
      await page.getByLabel("Confirm Password").fill("12345");

      // Try to submit (HTML5 minLength validation will prevent submission)
      // Button should be visible but click may be blocked by browser validation
      await expect(page.getByRole("button", { name: "Change Password" })).toBeVisible();

      // Verify HTML5 minLength attribute is set
      const newPasswordInput = page.getByLabel("New Password");
      const minLength = await newPasswordInput.getAttribute("minLength");
      expect(minLength).toBe("6");

      console.log("✓ Password minimum length validation works (HTML5 validation)");
    });

    test("shows password strength indicator", async ({ page }) => {
      // Create unique test user
      const testUser = {
        email: `password-strength-${Date.now()}@example.com`,
        password: "TestPass123",
        name: "Password Strength Test",
      };
      const result = await createTestUser(testUser.email, testUser.password, testUser.name, true);
      if (!result.success) {
        throw new Error(`Failed to create test user: ${result.error}`);
      }

      // Login and navigate
      await login(page, testUser.email, testUser.password);
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Security section visible on scrollable page (no tab switching)
      const newPasswordInput = page.getByLabel("New Password");
      await expect(newPasswordInput).toBeVisible({ timeout: 15000 });

      // Type weak password
      await newPasswordInput.fill("weak");

      // Wait for strength indicator to update
      await page.waitForTimeout(200);

      // Type strong password
      await newPasswordInput.fill("StrongP@ssw0rd123!");
      await page.waitForTimeout(200);

      // Password strength indicator should be visible
      await expect(page.getByText("Password strength:")).toBeVisible();

      console.log("✓ Password strength indicator responds to input");
    });

    test("successful password change workflow", async ({ page }) => {
      // Create unique test user
      const testUser = {
        email: `password-change-${Date.now()}@example.com`,
        password: "OriginalPass123",
        name: "Password Change Test",
      };
      const result = await createTestUser(testUser.email, testUser.password, testUser.name, true);
      if (!result.success) {
        throw new Error(`Failed to create test user: ${result.error}`);
      }

      // Login and navigate
      await login(page, testUser.email, testUser.password);
      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Security section visible on scrollable page (no tab switching)
      await expect(page.getByLabel("Current Password")).toBeVisible({ timeout: 15000 });

      // Fill with valid matching passwords
      await page.getByLabel("Current Password").fill(testUser.password);
      const newPassword = `NewPass${Date.now()}`;
      await page.getByLabel("New Password").fill(newPassword);
      await page.getByLabel("Confirm Password").fill(newPassword);

      // Submit
      await page.getByRole("button", { name: "Change Password" }).click();

      // Wait for success message
      await expect(page.getByText("Password changed successfully")).toBeVisible({ timeout: 5000 });

      console.log(`✓ Password changed successfully to ${newPassword}`);
    });
  });
});
