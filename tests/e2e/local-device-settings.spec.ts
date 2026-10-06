import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { createTestUser, login } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  MAX_LOCAL_WORK_LEASE_MS,
  type LocalControlCeiling,
  type LocalDeviceSettingsValue,
  type LocalPublicPolicy,
} from "@mcp-moira/shared";

/** The browser owns a typed request; a controlled companion reports application through real HTTP. */
test("local computer settings keep requested and applied week policy distinct through the real owner API", async ({
  page,
  request,
}) => {
  const base = getTestBaseUrl();
  const email = `local-editor-${randomUUID()}@example.test`;
  await createTestUser(email, "LocalEditor123!", "Local editor owner", true);
  await login(page, email, "LocalEditor123!");
  const deviceId = randomUUID();
  const credential = "L".repeat(43);
  const GiB = 1024 ** 3;
  let policy: LocalPublicPolicy = {
    version: 1,
    deviceId,
    label: "Browser test computer",
    enabled: true,
    leaseUntil: Date.now() + 3600000,
    maxSandboxes: 1,
    machine: {
      name: "local-approved",
      displayName: "Local approved",
      operatingSystem: "linux",
      cpuCores: 2,
      memoryBytes: 2 * GiB,
      storageBytes: 8 * GiB,
    },
    repositories: [
      {
        id: randomUUID(),
        fullName: "owner/project",
        private: true,
        allowPush: false,
        allowDelete: false,
        domains: ["github.com"],
      },
    ],
  };
  const settings: LocalDeviceSettingsValue = {
    label: policy.label,
    enabled: true,
    leaseUntil: policy.leaseUntil,
    cpuCores: 2,
    memoryBytes: 2 * GiB,
    storageBytes: 8 * GiB,
    dockerBytes: 2 * GiB,
    maxSandboxes: 1,
    maxOperationMs: 300000,
    maxOutputBytes: 1024 ** 2,
    maxConcurrent: 1,
    maxNetworkBytes: 64 * 1024 ** 2,
    maxNetworkConnections: 8,
    repositories: policy.repositories,
    gitAuthor: null,
  };
  const ceiling: LocalControlCeiling = {
    cpuCores: 4,
    memoryBytes: 8 * GiB,
    storageBytes: 32 * GiB,
    dockerBytes: 8 * GiB,
    maxSandboxes: 2,
    maxOperationMs: 3600000,
    maxOutputBytes: 8 * 1024 ** 2,
    maxConcurrent: 4,
    maxNetworkBytes: GiB,
    maxNetworkConnections: 32,
    maxLeaseMs: MAX_LOCAL_WORK_LEASE_MS,
  };
  const begin = await page.request.post(`${base}/api/integrations/local/pairings`, { data: {} });
  expect(begin.status()).toBe(201);
  const pairing = (await begin.json()).data;
  const enroll = await request.post(`${base}/api/local-devices/enroll`, {
    data: { pairingId: pairing.pairingId, pairingToken: pairing.pairingToken, credential, policy },
  });
  expect(enroll.status()).toBe(201);
  await page.goto(`${base}/settings?lang=en#integrations-local`);
  const device = page.getByTestId(`local-device-${deviceId}`);
  await device.getByRole("button", { name: "Confirm device" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm device" }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden();
  const heartbeat = (next: LocalDeviceSettingsValue, appliedRevision: number) =>
    request.post(`${base}/api/local-devices/heartbeat`, {
      headers: { Authorization: `Bearer ${credential}` },
      data: { policy, control: { ceiling, settings: next, appliedRevision } },
    });
  expect((await heartbeat(settings, 0)).status()).toBe(200);
  try {
    await page.getByRole("button", { name: "Refresh devices" }).click();
    const name = device.getByLabel("Computer name");
    await expect(name).toHaveValue(policy.label);
    await name.fill("Edited local computer");
    await device.getByLabel("RAM (GiB)").fill("4");
    await device.getByLabel("Push commits").check();
    await device.getByLabel("Create pull requests").check();
    await device.getByRole("button", { name: "Allow seven days" }).click();
    await page.getByRole("tab", { name: "GitHub connection", exact: true }).click();
    await page.getByRole("tab", { name: "Local computers", exact: true }).click();
    await expect(name).toHaveValue("Edited local computer");
    const save = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname.endsWith(`/devices/${deviceId}/settings`),
    );
    await device.getByRole("button", { name: "Request settings change" }).click();
    const saved = await save;
    expect(saved.status()).toBe(200);
    const requested = (await saved.json()).data.control;
    await expect(device).toContainText(
      `Requested revision ${requested.revision}; applied revision 0.`,
    );
    await expect(device).toContainText("Push: not allowed · Delete: not allowed");
    expect(requested.settings.memoryBytes).toBe(4 * GiB);
    expect(requested.settings.repositories[0].allowPullRequests).toBe(true);
    expect(requested.settings.leaseUntil - Date.now()).toBeGreaterThan(6 * 24 * 3600000);
    expect(requested.settings.leaseUntil - Date.now()).toBeLessThanOrEqual(MAX_LOCAL_WORK_LEASE_MS);
    policy = {
      ...policy,
      label: requested.settings.label,
      leaseUntil: requested.settings.leaseUntil,
      repositories: requested.settings.repositories,
      machine: { ...policy.machine, memoryBytes: 4 * GiB },
    };
    expect((await heartbeat(requested.settings, requested.revision)).status()).toBe(200);
    await page.getByRole("button", { name: "Refresh devices" }).click();
    await expect(device).toContainText(`Applied revision ${requested.revision}.`);
    await expect(device).toContainText("Push: allowed · Delete: not allowed");
    await page.reload();
    await expect(device.getByLabel("RAM (GiB)")).toHaveValue("4");
    await expect(device.getByLabel("Computer name")).toHaveValue("Edited local computer");
  } finally {
    const response = await page.request.get(`${base}/api/integrations/local/devices`);
    expect(response.status()).toBe(200);
    const own = (await response.json()).data.devices.find(
      (entry: { deviceId: string }) => entry.deviceId === deviceId,
    );
    expect(own).toBeTruthy();
    const revoked = await page.request.delete(
      `${base}/api/integrations/local/devices/${deviceId}`,
      { data: { expectedGeneration: own.deviceGeneration } },
    );
    expect(revoked.status()).toBe(200);
  }
});
