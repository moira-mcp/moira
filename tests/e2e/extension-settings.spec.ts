/**
 * Generic settings UI for manifest-declared extension settings.
 *
 * Persistence, masking and registry composition are integration responsibilities. This browser
 * observation owns presentation, so it keeps the real authenticated page and injects distinctive
 * definitions and already-projected values only at the HTTP boundary.
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test("extension settings show ownership, editable structure and a masked secret", async ({
  page,
}, testInfo) => {
  await loginAsAdmin(page);

  await page.route("**/api/settings/definitions", async (route) => {
    const response = await route.fetch();
    const envelope = await response.json();
    await route.fulfill({
      response,
      json: {
        ...envelope,
        data: [
          ...envelope.data,
          {
            key: "probe.token",
            type: "encrypted",
            category: "extension:probe",
            label: "Probe token",
            description: "Credential granted only to the probe extension",
            defaultValue: null,
            required: true,
            validation: null,
            adminOnly: false,
            protected: true,
            source: "extension",
            extensionName: "probe",
          },
          {
            key: "probe.routing",
            type: "json",
            category: "extension:probe",
            label: "Routing table",
            description: "Structured routing configuration",
            defaultValue: null,
            required: false,
            validation: null,
            adminOnly: false,
            protected: true,
            source: "extension",
            extensionName: "probe",
          },
        ],
      },
    });
  });

  await page.route("**/api/settings", async (route) => {
    const response = await route.fetch();
    const envelope = await response.json();
    await route.fulfill({
      response,
      json: {
        ...envelope,
        data: {
          ...envelope.data,
          "probe.token": "●●●●●●oken",
          "probe.routing": { default: "ops", fallback: "general" },
        },
      },
    });
  });

  await page.goto(`${BASE_URL}/settings?lang=en`);
  await expect(page.getByTestId("settings-flat-layout")).toBeVisible();

  const category = page.getByTestId("user-setting-category-extension:probe");
  await category.scrollIntoViewIfNeeded();
  await expect(category.getByText("Extension: probe", { exact: true })).toBeVisible();
  await expect(category.getByText("Probe token", { exact: true })).toBeVisible();
  await expect(category.getByText("Routing table", { exact: true })).toBeVisible();

  const token = page.getByTestId("user-setting-probe.token-input");
  await expect(token).toHaveAttribute("type", "password");
  await expect(token).toHaveValue("●●●●●●oken");
  await expect(page.getByText("handler-secret", { exact: true })).toHaveCount(0);

  const routing = page.getByTestId("user-setting-probe.routing-input");
  await expect(routing).toHaveValue('{\n  "default": "ops",\n  "fallback": "general"\n}');

  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach("extension-settings", { body: screenshot, contentType: "image/png" });
});
