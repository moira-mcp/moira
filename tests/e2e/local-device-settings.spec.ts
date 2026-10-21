import { randomBytes, randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { createTestUser, login, loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import type { LocalDeviceView } from "@mcp-moira/shared";
import { encodeReference } from "../../packages/shared/src/codespaces/workspace-references.mjs";
import type {
  CodespaceManagementView,
  ManagedWorkspaceView,
} from "../../packages/web-frontend/src/types/api-types.js";
import type { Route } from "./fixtures.js";

for (const language of ["en", "ru"] as const)
  test(`persistent Local permission and independent setup/readiness states are visible in ${language}`, async ({
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
    const setupStates = [
      "incomplete",
      "ready-remote-unavailable",
      "ready-enrollment-unavailable",
      "unknown",
    ] as const;
    const codespaces: ManagedWorkspaceView[] = setupStates.map((state, index) => ({
      codespace_id: `44444444-4444-4444-8444-44444444444${index}`,
      device_id: devices[0].deviceId,
      provider: "local-sandboxes",
      repository_id: `local:${devices[0].deviceId}:55555555-5555-4555-8555-555555555555`,
      repository: `fixture/${state}`,
      requested_ref: "main",
      current_ref: null,
      machine: null,
      state: state === "incomplete" ? "stopped" : state === "unknown" ? "ambiguous" : "usable",
      retention_policy: "persistent",
      desired_state: "running",
      observed_state:
        state === "incomplete" ? "stopped" : state === "unknown" ? "unknown" : "running",
      observed_at: 0,
      lifecycle_error:
        state === "incomplete"
          ? "CODESPACE_LOCAL_SETUP_INCOMPLETE"
          : state === "unknown"
            ? "CODESPACE_LOCAL_CREATION_UNKNOWN"
            : null,
      ...(state === "incomplete" ? { setup_failure: "repository_unproven" as const } : {}),
      workspace: encodeReference("workspace", {
        resourceId: `44444444-4444-4444-8444-44444444444${index}`,
        provider: "local-sandboxes",
        deviceId: devices[0].deviceId,
        generation: 3,
      }),
      controller: encodeReference("controller", {
        deviceId: devices[0].deviceId,
        connectionId: devices[0].connectionId!,
      }),
      pending_operations:
        state === "unknown"
          ? [
              encodeReference("operation", {
                owner: {
                  kind: "controller",
                  deviceId: devices[0].deviceId,
                  connectionId: devices[0].connectionId!,
                },
                requestId: "ws1-66666666-6666-4666-8666-666666666666",
                kind: "unknown",
              }),
            ]
          : [],
      created_at: 0,
      updated_at: 0,
      ...(state === "ready-remote-unavailable"
        ? { remote: { state: "unavailable" as const } }
        : {}),
      ...(state === "ready-enrollment-unavailable"
        ? { remote: { state: "enrollment_unavailable" as const } }
        : {}),
    }));
    const unknown = codespaces[3];
    const unavailable: NonNullable<CodespaceManagementView["unavailable"]>[number] = {
      codespace_id: unknown.codespace_id,
      provider: unknown.provider,
      repository_id: unknown.repository_id,
      repository: unknown.repository,
      requested_ref: unknown.requested_ref,
      created_at: unknown.created_at,
      identity: encodeReference("workspace-identity", {
        resourceId: unknown.codespace_id,
        provider: "local-sandboxes",
        deviceId: devices[0].deviceId,
      }),
      pending_operations: unknown.pending_operations,
      error: { code: "CODESPACE_LOCAL_CREATION_UNKNOWN" },
    };
    const collected: string[] = [];
    const archived: ManagedWorkspaceView = {
      ...codespaces[0],
      codespace_id: "77777777-7777-4777-8777-777777777777",
      repository: "fixture/retired",
      state: "deleted",
      desired_state: "deleted",
      observed_state: "absent",
      lifecycle_error: null,
      setup_failure: undefined,
      workspace: encodeReference("workspace", {
        resourceId: "77777777-7777-4777-8777-777777777777",
        provider: "local-sandboxes",
        deviceId: devices[0].deviceId,
        generation: 4,
      }),
    };
    const heldGitHub: Route[] = [];
    let billingReads = 0;
    await page.route("**/api/integrations/local/devices", (route) =>
      route.fulfill({ json: { success: true, data: { devices, pairings: [] } } }),
    );
    await page.route("**/api/integrations/github", (route) =>
      route.fulfill({ json: { success: true, data: { state: "disconnected" } } }),
    );
    await page.route("**/api/integrations/github/codespaces**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/operation_get")) {
        expect(route.request().method()).toBe("POST");
        expect(route.request().postDataJSON()).toEqual({
          reference: unavailable.pending_operations[0],
        });
        collected.push(unavailable.pending_operations[0]);
        await route.fulfill({
          json: {
            success: true,
            data: { operation: unavailable.pending_operations[0], state: "unconfirmed" },
          },
        });
        return;
      }
      if (url.pathname.endsWith("/billing")) {
        billingReads++;
        await route.fulfill({ json: { success: true, data: "unavailable" } });
        return;
      }
      const provider = url.searchParams.get("provider");
      if (provider === "github-codespaces") {
        heldGitHub.push(route);
        return;
      }
      expect(provider).toBe("local-sandboxes");
      const view = url.searchParams.get("view") ?? "actionable";
      expect(["actionable", "diagnostics", "history"]).toContain(view);
      await route.fulfill({
        json: {
          success: true,
          data: {
            provider,
            codespaces:
              view === "history"
                ? [archived]
                : view === "diagnostics"
                  ? []
                  : codespaces.filter((row) => row.state !== "ambiguous"),
            has_diagnostics: true,
            resources_stale: false,
            repositories_stale: false,
            unavailable: view === "diagnostics" ? [unavailable] : [],
            provider_errors: [],
            repositories: [],
            readiness: { state: "ready" },
            connection: { state: "connected" },
          },
        },
      });
    });
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
    // Controlled presentation fixtures distinguish known setup recovery from an unknown
    // original create and do not claim that these cards are physical VM observations.
    for (const [index, state] of setupStates.entries()) {
      if (state === "unknown") {
        expect(billingReads).toBe(0);
        await expect(
          page.getByTestId(`github-codespace-${codespaces[index].codespace_id}`),
        ).toHaveCount(0);
        await page
          .getByTestId(`local-codespaces-${devices[0].deviceId}`)
          .getByRole("button", {
            name: language === "en" ? "Diagnostics" : "Диагностика",
            exact: true,
          })
          .click();
      }
      const card = page.getByTestId(
        `${state === "unknown" ? "codespace-unavailable" : "github-codespace"}-${codespaces[index].codespace_id}`,
      );
      await expect(card).toBeVisible();
      const resume = card.getByRole("button", {
        name: language === "en" ? "Resume setup" : "Продолжить подготовку",
        exact: true,
      });
      if (state === "incomplete") {
        await expect(resume).toBeEnabled();
        await expect(
          card.getByTestId(`codespace-setup-remedy-${codespaces[index].codespace_id}`),
        ).toContainText(language === "en" ? "Its files were preserved" : "Файлы сохранены");
        await expect(
          card.getByRole("button", {
            name: language === "en" ? "Start" : "Запустить",
            exact: true,
          }),
        ).toBeDisabled();
      } else {
        await expect(resume).toHaveCount(0);
        if (state === "ready-remote-unavailable" || state === "ready-enrollment-unavailable") {
          await expect(
            card.getByTestId(`github-codespace-state-${codespaces[index].codespace_id}`),
          ).toContainText(language === "en" ? "Running" : "Работает");
          await expect(
            card.getByTestId(`codespace-remote-${codespaces[index].codespace_id}`),
          ).toContainText(
            language === "en"
              ? "local readiness is independent"
              : "локальная готовность определяется отдельно",
          );
        } else {
          const collect = card.getByRole("button", {
            name: language === "en" ? "Check original result" : "Проверить исходный результат",
            exact: true,
          });
          await expect(collect).toBeEnabled();
          await expect(
            card.getByText(
              language === "en"
                ? "State could not be confirmed"
                : "Состояние не удалось подтвердить",
              { exact: true },
            ),
          ).toBeVisible();
          await expect(card.getByText(/State confirmed|Состояние подтверждено/)).toHaveCount(0);
          await expect(page.getByTestId(`github-codespace-${unknown.codespace_id}`)).toHaveCount(0);
          await expect(card.getByRole("button")).toHaveCount(1);
          await collect.click();
          await expect.poll(() => collected).toEqual(unavailable.pending_operations);
          await expect(collect).toBeEnabled();
          await expect(
            card.getByRole("button", {
              name: language === "en" ? "Delete" : "Удалить",
              exact: true,
            }),
          ).toHaveCount(0);
        }
      }
      const bounds = await card.boundingBox();
      if (!bounds) throw new Error("Codespace card has no visible bounds");
      await page.setViewportSize({
        width: page.viewportSize()!.width,
        height: Math.ceil(bounds.height) + 256,
      });
      await card.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(card).toBeInViewport({ ratio: 1 });
      await testInfo.attach(`local-setup-${language}-${state}`, {
        body: await card.screenshot(),
        contentType: "image/png",
      });
    }
    const environments = page.getByTestId(`local-codespaces-${devices[0].deviceId}`);
    await environments
      .getByRole("button", { name: language === "en" ? "History" : "История", exact: true })
      .click();
    const historical = page.getByTestId(`github-codespace-${archived.codespace_id}`);
    await expect(historical).toBeVisible();
    await expect(
      historical.getByRole("button", {
        name: language === "en" ? "Start" : "Запустить",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      historical.getByRole("button", {
        name: language === "en" ? "Delete" : "Удалить",
        exact: true,
      }),
    ).toHaveCount(0);
    await historical.scrollIntoViewIfNeeded();
    await testInfo.attach(`local-history-${language}`, {
      body: await historical.screenshot(),
      contentType: "image/png",
    });
    expect(heldGitHub.length).toBeGreaterThan(0);
    expect(billingReads).toBe(0);
    for (const route of heldGitHub) await route.abort();
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
