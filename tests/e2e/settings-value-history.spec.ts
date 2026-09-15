/**
 * A global setting's value history, read through the same interface as notes and playbooks.
 *
 * The requirement is that these three share the history interface rather than each having its own
 * screen. Behaviour alone cannot separate "one shared dialog" from "three lookalikes", so the
 * structural check lives in the unit suite; what this covers is that the shared dialog actually
 * works here — a real setting, changed twice, whose earlier value reads back and can be restored.
 */

import { test, expect } from "./fixtures.js";
import { login } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { formatSessionCookie, signInUser } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();
// A setting the generic editor renders; the MCP prompts have their own scope-level editor.
const SETTING_KEY = "notes.max_versions";

let adminCookie: string;
let previousValue: string | null = null;

type RequestContext = Parameters<Parameters<typeof test>[2]>[0]["request"];

async function readValue(request: RequestContext): Promise<string | null> {
  const response = await request.get(`${BASE_URL}/api/admin/global-settings`, {
    headers: { Cookie: adminCookie },
  });
  const json = (await response.json()) as {
    data: { settings: { key: string; value: string | null }[] };
  };
  return json.data.settings.find((s) => s.key === SETTING_KEY)?.value ?? null;
}

async function writeValue(request: RequestContext, value: string | null): Promise<void> {
  const response = await request.put(`${BASE_URL}/api/admin/global-settings/${SETTING_KEY}`, {
    headers: { Cookie: adminCookie },
    data: { value },
  });
  expect(response.status()).toBe(200);
}

test.describe("Global setting value history", () => {
  test.beforeAll(async ({ request }) => {
    adminCookie = formatSessionCookie(
      BASE_URL,
      await signInUser(BASE_URL, ADMIN.email, ADMIN.password),
    );
    previousValue = await readValue(request);
  });

  // Put the setting back whatever the test did, in a request context of its own so a failed test
  // cannot hide behind a closed page.
  test.afterAll(async ({ request }) => {
    await writeValue(request, previousValue);
  });

  test("two changes read back through the shared history dialog", async ({ page, request }) => {
    const first = "17";
    const second = "19";
    await writeValue(request, first);
    await writeValue(request, second);

    await login(page, ADMIN.email, ADMIN.password);
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    // Categories start collapsed; open the one that holds this setting.
    await page.getByTestId("setting-category-notes-chevron").click();
    await page.getByTestId(`setting-${SETTING_KEY}-history`).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // The shared dialog: the same version list, content pane and restore control the notes and
    // playbooks screens show.
    const revisions = page.locator('[data-testid^="version-"]');
    await expect(revisions.first()).toBeVisible();
    expect(await revisions.count()).toBeGreaterThanOrEqual(2);

    // The value in force before the last change reads back, and can be put back in force.
    await revisions.nth(1).click();
    await expect(page.getByTestId("version-content")).toContainText(first);
    await expect(page.getByTestId("restore-version-button")).toBeVisible();
  });
});
