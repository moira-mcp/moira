/**
 * The Security section offers the password control that fits how the account signs in: a password
 * account changes its password; an account that signs in only through a social provider has no
 * current password to type, is told how it signs in, and may set a password as well.
 *
 * The social-only account is made from an ordinary one: it signs in with its password, then its
 * credential account row becomes a GitHub one in the container database. The session stays valid,
 * which is what a GitHub sign-in would have produced.
 */

import { test, expect } from "./fixtures.js";
import { createTestUser, login } from "./helpers/auth-helper.js";
import { execSqliteInDocker } from "../utils/docker-command.js";
import { signInUser } from "../utils/mcp-auth.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

function uniqueEmail(kind: string): string {
  return `security-${kind}-${Date.now()}-${test.info().workerIndex}-${Math.random()
    .toString(36)
    .slice(2, 7)}@example.com`;
}

test.describe("Security section by sign-in method", () => {
  test("a password account changes its password with its current one", async ({ page }) => {
    const email = uniqueEmail("password");
    await createTestUser(email, "PasswordUser123!", "Password User", true);
    await login(page, email, "PasswordUser123!");
    await page.goto(`${BASE_URL}/settings?lang=en#security`);

    const form = page.getByTestId("security-password-form");
    await expect(form).toBeVisible();
    await expect(form.getByLabel("Current Password")).toBeVisible();
    await expect(page.getByTestId("security-social-only")).toHaveCount(0);

    // A wrong current password is explained in words, never as a serialized error object.
    await form.getByLabel("Current Password").fill("not-the-password");
    await form.getByLabel("New Password").fill("BrandNewPass123!");
    await form.getByLabel("Confirm Password").fill("BrandNewPass123!");
    await form.getByRole("button", { name: "Change Password" }).click();
    await expect(form.getByRole("alert")).toHaveText("The current password is incorrect.");
  });

  test("a GitHub-only account is told how it signs in and can set a password", async ({ page }) => {
    const email = uniqueEmail("social");
    await createTestUser(email, "Temporary123!", "Social User", true);
    await login(page, email, "Temporary123!");
    execSqliteInDocker(
      `UPDATE account SET providerId = 'github', accountId = 'gh-${Date.now()}', password = NULL
       WHERE userId = (SELECT id FROM user WHERE email = '${email}');`,
    );

    await page.goto(`${BASE_URL}/settings?lang=en#security`);
    const card = page.getByTestId("security-social-only");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("security-sign-in-methods")).toContainText("GitHub");
    // No field asks for a password the account does not have.
    await expect(page.getByLabel("Current Password")).toHaveCount(0);
    await expect(page.getByTestId("security-password-form")).toHaveCount(0);

    const form = page.getByTestId("security-set-password-form");
    await form.getByLabel("New Password").fill("FirstPassword123!");
    await form.getByLabel("Confirm Password").fill("FirstPassword123!");
    await form.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByText("Password set. You can now also sign in")).toBeVisible();

    // The account now has a password: the section offers the change form, and the password signs in.
    await expect(page.getByTestId("security-password-form")).toBeVisible();
    await expect(signInUser(BASE_URL, email, "FirstPassword123!")).resolves.toEqual(
      expect.any(String),
    );
  });
});
