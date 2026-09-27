/**
 * Setup the guide E2E specs share: a fresh account, signed in, with the first-run question already
 * answered (so no prompt covers the page) and the beginner panels shown or hidden as asked.
 */

import { expect, type Page } from "@playwright/test";
import { createTestUser, login } from "./auth-helper.js";
import { getTestBaseUrl } from "../../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "TestPass123!";
const BEGINNER_PANELS = ["home-intro", "quick-start", "home-recommended", "workflows-recommended"];

/** Sign in as a new account; `label` keeps the address readable in logs. */
export async function freshReader(page: Page, label: string, hidePanels = false): Promise<void> {
  const email = `guides-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  expect((await createTestUser(email, PASSWORD, `Guides ${label}`)).success).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, email, PASSWORD);
  const saved = await page.request.put(`${BASE_URL}/api/settings`, {
    headers: { Origin: new URL(BASE_URL).origin },
    data: {
      "ui.guide_progress": { firstRun: "declined" },
      "ui.hidden_panels": hidePanels ? BEGINNER_PANELS : [],
    },
  });
  expect(saved.ok()).toBe(true);
}
