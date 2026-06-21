/**
 * Helper for filling GDPR consent checkboxes in registration form
 */

import { Page } from "@playwright/test";

/**
 * Fill consent checkboxes in registration form.
 * Must be called AFTER filling email/password and BEFORE clicking submit.
 *
 * The checkboxes are rendered by Better Auth UI additionalFields.
 * They use accessible checkbox roles with descriptive labels.
 */
export async function fillConsentCheckboxes(page: Page): Promise<void> {
  // Terms of Service checkbox - use getByRole for reliable selection
  const termsCheckbox = page.getByRole("checkbox", {
    name: /Terms of Service/i,
  });
  await termsCheckbox.check();

  // Non-Russian resident checkbox
  const residencyCheckbox = page.getByRole("checkbox", {
    name: /Russian Federation/i,
  });
  await residencyCheckbox.check();
}
