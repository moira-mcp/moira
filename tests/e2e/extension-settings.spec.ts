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
  let testRequestBody: string | null = "not-called";

  await page.route("**/api/notifications/channels", async (route) => {
    const response = await route.fetch();
    const envelope = await response.json();
    await route.fulfill({
      response,
      json: {
        ...envelope,
        data: [
          ...envelope.data,
          {
            id: "probe.notifications",
            title: "Probe notifications",
            description: "Distinctive extension channel",
            origin: "extension",
            extensionName: "probe",
            extensionVersion: "1.2.3",
            settingKeys: ["probe.token", "probe.routing"],
            helpUrl: null,
            capabilities: { text: true, image: false, document: true },
            enabled: true,
            configured: true,
            available: true,
            state: "ready",
            trustedDelivery: { declared: true, approved: false, eligible: false },
          },
        ],
      },
    });
  });
  await page.route("**/api/notifications/channels/probe.notifications/test", async (route) => {
    testRequestBody = route.request().postData();
    await route.fulfill({
      json: {
        success: true,
        data: {
          status: "delivered",
          configuredChannels: 1,
          deliveredChannels: 1,
          channels: [{ channelId: "probe.notifications", status: "delivered" }],
        },
      },
    });
  });

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

  const channel = page.getByTestId("communication-channel-probe.notifications");
  await channel.scrollIntoViewIfNeeded();
  await expect(channel.getByText("Probe notifications", { exact: true })).toBeVisible();
  await expect(channel.getByText("Extension", { exact: true })).toBeVisible();
  await expect(channel.getByText("Ready", { exact: true })).toBeVisible();
  await expect(channel.getByText("Probe token", { exact: true })).toBeVisible();
  await expect(channel.getByText("Routing table", { exact: true })).toBeVisible();
  await expect(
    channel.getByText("Trusted delivery requires administrator approval.", { exact: true }),
  ).toBeVisible();

  const token = page.getByTestId("user-channel-probe.notifications-probe.token-input");
  await expect(token).toHaveAttribute("type", "password");
  await expect(token).toHaveAccessibleName("Probe token");
  await expect(token).toHaveValue("●●●●●●oken");
  await expect(page.getByText("handler-secret", { exact: true })).toHaveCount(0);

  const routing = page.getByTestId("user-channel-probe.notifications-probe.routing-input");
  await expect(routing).toHaveAccessibleName("Routing table");
  await expect(routing).toHaveValue('{\n  "default": "ops",\n  "fallback": "general"\n}');

  const testButton = page.getByTestId("communication-channel-probe.notifications-test");
  await expect(testButton).toHaveAccessibleName("Send a test through Probe notifications");
  await testButton.click();
  await expect(page.getByText("Test delivered through Probe notifications")).toBeVisible();
  expect(testRequestBody).toBeNull();

  await page.setViewportSize({ width: 1440, height: 1000 });
  const desktop = await page.screenshot({ fullPage: true });
  await testInfo.attach("communication-channels-desktop", {
    body: desktop,
    contentType: "image/png",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.screenshot({ fullPage: true });
  await testInfo.attach("communication-channels-mobile", {
    body: mobile,
    contentType: "image/png",
  });
});
