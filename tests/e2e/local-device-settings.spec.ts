import { randomBytes, randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { createTestUser, login, loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import type { LocalDeviceView } from "@mcp-moira/shared";

for (const language of ["en", "ru"] as const)
  test(`persistent Local permission states are visible without renewal controls in ${language}`, async ({
    page,
  }, testInfo) => {
    await loginAsAdmin(page);
    const states = ["enabled", "disabled", "pending", "rejected", "unavailable"] as const;
    const devices: LocalDeviceView[] = states.map((state, index) => {
      const deviceId = `11111111-1111-4111-8111-11111111111${index}`;
      const settings = {
        label: `Computer ${state}`,
        enabled: state !== "disabled",
        cpuCores: 2,
        memoryBytes: 4 * 1024 ** 3,
        storageBytes: 32 * 1024 ** 3,
        dockerBytes: 4 * 1024 ** 3,
        repositories: [],
        gitAuthor: null,
        agentRepositoryManagement: null,
      };
      return {
        deviceId,
        userId: "fixture-owner",
        deviceGeneration: 1,
        connectionId: "22222222-2222-4222-8222-222222222222",
        label: settings.label,
        status: "active",
        lastSeenAt: 0,
        createdAt: 0,
        owner:
          state === "unavailable"
            ? { state: "unavailable" }
            : {
                state: "available",
                observedAt: 0,
                github: { resources: [] },
                local: {
                  state: "configured",
                  policy: {
                    version: 1,
                    deviceId,
                    label: settings.label,
                    enabled: settings.enabled,
                    machine: {
                      name: "local-approved",
                      displayName: "Local approved",
                      operatingSystem: "linux",
                      cpuCores: 2,
                      memoryBytes: settings.memoryBytes,
                      storageBytes: settings.storageBytes,
                    },
                    repositories: [],
                  },
                  control: {
                    optedIn: true,
                    revision: state === "pending" || state === "rejected" ? 4 : 3,
                    appliedRevision: 3,
                    status: state === "pending" || state === "rejected" ? state : "applied",
                    settings,
                    ceiling: {
                      cpuCores: 4,
                      memoryBytes: 8 * 1024 ** 3,
                      storageBytes: 64 * 1024 ** 3,
                      dockerBytes: 8 * 1024 ** 3,
                    },
                    error:
                      state === "rejected"
                        ? { code: "LOCAL_STORAGE_FULL", message: "Storage change refused" }
                        : null,
                    ...(state === "pending"
                      ? { pendingRequestId: "ws1-33333333-3333-4333-8333-333333333333" }
                      : {}),
                  },
                },
              },
      };
    });
    await page.route("**/api/integrations/local/devices", (route) =>
      route.fulfill({ json: { success: true, data: { devices, pairings: [] } } }),
    );
    await page.route("**/api/integrations/github", (route) =>
      route.fulfill({ json: { success: true, data: { state: "disconnected" } } }),
    );
    await page.route("**/api/integrations/github/codespaces**", (route) =>
      route.fulfill({
        json: {
          success: true,
          data: {
            codespaces: [],
            unavailable: [],
            provider_errors: [],
            repositories: [],
            readiness: { state: "ready" },
            connection: { state: "connected" },
          },
        },
      }),
    );
    await page.goto(`${getTestBaseUrl()}/settings?lang=${language}#integrations-local`);
    for (const [index, state] of states.entries()) {
      const card = page.getByTestId(`local-device-${devices[index].deviceId}`);
      await expect(card).toBeVisible();
      if (state !== "unavailable") {
        await card
          .getByRole("button", {
            name:
              language === "en" ? "Computer settings and access" : "Настройки компьютера и доступ",
            exact: true,
          })
          .click();
        await expect(card.locator('input[type="datetime-local"]')).toHaveCount(0);
        await expect(card).toContainText(
          language === "en"
            ? "When enabled, local work stays permitted until you disable it."
            : "Включённое разрешение локальной работы действует, пока вы его не отключите.",
        );
        const enabled = card.getByLabel(
          language === "en"
            ? "Allow agents to work with local codespaces"
            : "Разрешить агентам работать с локальными кодспейсами",
        );
        if (state === "disabled") await expect(enabled).not.toBeChecked();
        else await expect(enabled).toBeChecked();
        if (state === "pending")
          await expect(
            card.getByRole("button", {
              name: language === "en" ? "Check settings result" : "Проверить результат настроек",
            }),
          ).toBeVisible();
        if (state === "rejected")
          await expect(card.getByRole("alert")).toContainText("Storage change refused");
      } else {
        await expect(card).toContainText(
          language === "en"
            ? "Current settings and permissions cannot be confirmed"
            : "Текущие настройки и права не подтверждены",
        );
        await expect(card.getByRole("form")).toHaveCount(0);
      }
      // Settings scrolls inside the page. Fit this whole card between the fixed
      // navigation and footer so locator screenshots contain real visible content.
      const bounds = await card.boundingBox();
      if (!bounds) throw new Error("Local computer card has no visible bounds");
      await page.setViewportSize({
        width: page.viewportSize()!.width,
        height: Math.ceil(bounds.height) + 256,
      });
      await card.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(card).toBeInViewport({ ratio: 1 });
      await testInfo.attach(`local-permission-${language}-${state}`, {
        body: await card.screenshot(),
        contentType: "image/png",
      });
    }
  });

/** No simulated heartbeat: the paired controller is offline throughout this browser check. */
test("an offline computer exposes no current permissions and refuses settings before admission", async ({
  page,
  request,
}) => {
  const base = getTestBaseUrl(),
    email = "local-offline-" + randomUUID() + "@example.test";
  await createTestUser(email, "LocalEditor123!", "Offline owner", true);
  await login(page, email, "LocalEditor123!");
  const deviceId = randomUUID(),
    credential = randomBytes(32).toString("base64url");
  const begin = await page.request.post(base + "/api/integrations/local/pairings", { data: {} });
  expect(begin.status()).toBe(201);
  const pairing = (await begin.json()).data;
  const enrolled = await request.post(base + "/api/local-devices/enroll", {
    data: {
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      credential,
      deviceId,
      label: "Offline browser computer",
    },
  });
  expect(enrolled.status()).toBe(201);
  await page.goto(base + "/settings?lang=en#integrations-local");
  const device = page.getByTestId("local-device-" + deviceId);
  const ownerStatus = device
    .getByRole("status")
    .filter({ hasText: "Current settings and permissions cannot be confirmed" });
  await device.getByRole("button", { name: "Confirm computer" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm computer" }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden();
  try {
    await page.getByRole("button", { name: "Refresh computers" }).click();
    await expect(ownerStatus).toContainText("Current settings and permissions cannot be confirmed");
    await expect(device.getByRole("button", { name: "Request settings change" })).toHaveCount(0);
    const requestId = "ws1-" + randomUUID();
    const saved = await page.request.put(
      base + "/api/integrations/local/devices/" + deviceId + "/settings",
      {
        headers: { Origin: new URL(base).origin },
        data: {
          requestId,
          expectedRevision: 0,
          expectedGeneration: 1,
          settings: {
            label: "Must not be queued",
            enabled: false,
            cpuCores: 1,
            memoryBytes: 1024 ** 3,
            storageBytes: 32 * 1024 ** 3,
            dockerBytes: 4 * 1024 ** 3,
            repositories: [],
            gitAuthor: null,
            agentRepositoryManagement: null,
          },
        },
      },
    );
    expect(saved.status()).toBe(503);
    expect((await saved.json()).error.code).toBe("LOCAL_UNAVAILABLE");
    await page.reload();
    await expect(ownerStatus).toContainText("Current settings and permissions cannot be confirmed");
    const response = await page.request.get(base + "/api/integrations/local/devices");
    const own = (await response.json()).data.devices.find(
      (entry: { deviceId: string }) => entry.deviceId === deviceId,
    );
    expect(own.owner).toEqual({ state: "unavailable" });
    expect(own).not.toHaveProperty("policy");
    expect(own).not.toHaveProperty("control");
  } finally {
    const response = await page.request.get(base + "/api/integrations/local/devices");
    const own = (await response.json()).data.devices.find(
      (entry: { deviceId: string }) => entry.deviceId === deviceId,
    );
    expect(
      (
        await page.request.delete(base + "/api/integrations/local/devices/" + deviceId, {
          data: { expectedGeneration: own.deviceGeneration },
        })
      ).status(),
    ).toBe(200);
  }
});
