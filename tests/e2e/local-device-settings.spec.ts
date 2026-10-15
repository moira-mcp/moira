import { randomBytes, randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { createTestUser, login } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

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
            leaseUntil: 0,
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
