import { test, expect, type Page } from "./fixtures.js";
import type {
  CodespaceConnectionView,
  CodespaceLimitsView,
  CodespaceReadinessView,
  CodespaceSummaryView,
} from "@mcp-moira/shared";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const baseUrl = getTestBaseUrl();
const settingsUrl = `${baseUrl}/settings#integrations-github`;
const CODESPACE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

const connection: CodespaceConnectionView = {
  state: "connected",
  reason: null,
  settingsUrl,
  installationUrl: null,
  account: { id: "25282049", login: "witqq" },
  installations: [{ externalInstallationId: "9001", repositorySelection: "selected" }],
  repositories: [{ externalRepositoryId: "101", fullName: "witqq/private-project", private: true }],
  canConnect: false,
  canDisconnect: true,
};

const readiness: CodespaceReadinessView = {
  state: "ready",
  reason: null,
  provider: "github-codespaces",
  configuration: "available",
  resources_enabled: true,
  controls: [
    { scope: "global", disabled: false, reason: null, updated_at: null },
    { scope: "provider:github-codespaces", disabled: false, reason: null, updated_at: null },
  ],
  connector: { state: "available", reason: null },
  reconciliation: { due_resources: 0, due_operations: 0, oldest_due_age_ms: null },
  usage: {
    active_resources: 1,
    max_active_resources: 4,
    active_operations: 0,
    max_active_operations: 20,
    transfer_live_bytes: 0,
    max_transfer_live_bytes: 1024 ** 3,
  },
  checked_at: Date.now(),
};

/** The user's limits as `GET /api/integrations/github/codespaces` reports them. */
const limits: CodespaceLimitsView = {
  codespaces: {
    held: 2,
    max_per_user: 4,
    instance_held: 3,
    max_instance: 16,
    create_throttle_seconds: 60,
  },
  machine_ceiling: { cpu_cores: 4, memory_bytes: 8 * 1024 ** 3, storage_bytes: 32 * 1024 ** 3 },
  operations: {
    active: 1,
    max_concurrent_per_user: 8,
    max_input_bytes: 1024 ** 2,
    max_stdout_bytes: 1024 ** 2,
    max_stderr_bytes: 256 * 1024,
    max_retained_output_bytes: 64 * 1024 ** 2,
    max_duration_seconds: 900,
    max_background_seconds: 14_400,
  },
  transfers: {
    // A long value ("12 MB of 100 MB") beside the short ones is what once made the meters uneven.
    used_bytes: 12 * 1024 ** 2,
    objects: 0,
    inflight_bytes: 0,
    max_bytes_per_user: 100 * 1024 ** 2,
    max_inflight_bytes_per_user: 40 * 1024 ** 2,
    max_objects_per_user: 10,
    max_file_bytes: 4 * 1024 ** 2,
    ttl_seconds: 600,
  },
  lifecycle: {
    retention_days: 30,
    start_wait_seconds: 180,
    idle: { auto_stop_enabled: true, timeout_minutes: 30, provider_max_minutes: 240 },
  },
  provider: { billing: "unavailable" },
};

function codespace(overrides: Partial<CodespaceSummaryView> = {}): CodespaceSummaryView {
  return {
    codespace_id: CODESPACE_ID,
    provider: "github-codespaces",
    repository_id: "101",
    repository: "witqq/private-project",
    requested_ref: "main",
    current_ref: "main",
    machine: {
      name: "basicLinux32gb",
      display_name: "2 cores, 8 GB RAM, 32 GB storage",
      operating_system: "linux",
      cpu_cores: 2,
      memory_bytes: 8 * 1024 ** 3,
      storage_bytes: 32 * 1024 ** 3,
    },
    state: "usable",
    retention_policy: "persistent",
    desired_state: "running",
    observed_state: "running",
    generation: 3,
    created_at: Date.now() - 3_600_000,
    updated_at: Date.now() - 60_000,
    ...overrides,
  };
}

/** The three usage meters share one layout: equal height, value on the same line in each. */
async function expectEvenMeters(page: Page) {
  const meters = ["held", "commands", "transfers"].map((name) =>
    page.getByTestId(`codespace-limit-${name}`),
  );
  const boxes = await Promise.all(meters.map((meter) => meter.boundingBox()));
  const heights = boxes.map((box) => Math.round(box!.height));
  expect(new Set(heights).size, `meter heights ${heights.join(", ")}`).toBe(1);
  const valueOffsets = await Promise.all(
    meters.map((meter) =>
      meter.evaluate((element) => {
        const value = element.children[1] as HTMLElement;
        return Math.round(value.getBoundingClientRect().top - element.getBoundingClientRect().top);
      }),
    ),
  );
  expect(new Set(valueOffsets).size, `value offsets ${valueOffsets.join(", ")}`).toBe(1);
}

test("codespaces are created, stopped and deleted with confirmation from Settings", async ({
  page,
}, testInfo) => {
  await loginAsAdmin(page);
  let codespaces: CodespaceSummaryView[] = [
    codespace(),
    codespace({
      codespace_id: SECOND_ID,
      state: "create_submitted",
      observed_state: "provisioning",
    }),
  ];
  const requests: string[] = [];
  await page.route("**/api/integrations/github", (route) =>
    route.fulfill({ json: { success: true, data: connection } }),
  );
  await page.route("**/api/integrations/github/codespaces**", async (route) => {
    const request = route.request();
    requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/codespaces")) {
      await route.fulfill({
        json: {
          success: true,
          data: {
            readiness,
            connection,
            limits,
            repositories: [{ repository_id: "101", name: "witqq/private-project", private: true }],
            repositories_stale: true,
            codespaces,
          },
        },
      });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/codespaces")) {
      const body = request.postDataJSON() as { repository_id: string; ref: string };
      const created = codespace({
        codespace_id: "33333333-3333-4333-8333-333333333333",
        requested_ref: body.ref,
        current_ref: null,
        state: "create_submitted",
        observed_state: "provisioning",
        generation: 1,
      });
      codespaces = [...codespaces, created];
      await route.fulfill({ status: 201, json: { success: true, data: { codespace: created } } });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/stop")) {
      const stopped = codespace({
        state: "stopped",
        desired_state: "stopped",
        observed_state: "stopped",
        generation: 4,
      });
      codespaces = codespaces.map((item) => (item.codespace_id === CODESPACE_ID ? stopped : item));
      await route.fulfill({
        json: { success: true, data: { codespace: stopped, data_preserved: true } },
      });
      return;
    }
    if (request.method() === "DELETE") {
      const body = request.postDataJSON() as {
        confirm_delete: boolean;
        expected_generation: number;
      };
      expect(body).toEqual({ confirm_delete: true, expected_generation: 4 });
      const deleted = codespace({
        state: "delete_pending",
        desired_state: "deleted",
        generation: 5,
      });
      codespaces = codespaces.map((item) => (item.codespace_id === CODESPACE_ID ? deleted : item));
      await route.fulfill({
        json: { success: true, data: { codespace: deleted, data_preserved: false } },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { success: false } });
  });

  await page.goto(`${baseUrl}/settings?lang=en#integrations-github`);
  const management = page.getByTestId("github-codespace-management");
  await management.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("github-codespace-instance-state")).toHaveText("Ready");
  await expect(page.getByTestId("github-codespace-disclosure")).toContainText(
    "read any secrets configured for that Codespace",
  );
  await expect(page.getByTestId("github-codespace-repositories-stale")).toContainText(
    "GitHub could not be reached",
  );
  await expect(management).not.toContainText(/chat|session/i);
  await expect(page.getByTestId(`github-codespace-state-${CODESPACE_ID}`)).toHaveText("Running");
  await expect(page.getByTestId(`github-codespace-state-${SECOND_ID}`)).toHaveText("Creating");
  await expect(page.getByTestId(`github-codespace-delete-${SECOND_ID}`)).toBeDisabled();
  await expect(management).toContainText("personal billing");
  // The create hint and the limits panel count held codespaces, stopped ones included.
  await expect(page.getByTestId("github-codespace-create")).toContainText(
    "You hold 2 of 4 codespaces",
  );
  await expect(page.getByTestId("codespace-limit-held")).toContainText("2 of 4");
  await expect(page.getByTestId("codespace-limit-transfers")).toContainText("12 MB of 100 MB");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectEvenMeters(page);
  // Technical details stay folded until asked for.
  await expect(page.getByTestId(`github-codespace-details-${CODESPACE_ID}`)).toHaveCount(0);
  await page.getByTestId(`github-codespace-details-toggle-${CODESPACE_ID}`).click();
  await expect(page.getByTestId(`github-codespace-details-${CODESPACE_ID}`)).toContainText(
    "generation 3",
  );

  const desktop = await page.screenshot({ fullPage: true });
  await testInfo.attach("codespace-management-desktop", {
    body: desktop,
    contentType: "image/png",
  });

  await page.getByTestId("github-codespace-ref").fill("feature/e2e");
  await page.getByTestId("github-codespace-create-submit").click();
  await expect(page.getByText("Codespace creation was accepted")).toBeVisible();
  await expect(page.getByTestId("github-codespace-list")).toContainText("feature/e2e");

  await page.getByTestId(`github-codespace-stop-${CODESPACE_ID}`).click();
  await expect(page.getByTestId(`github-codespace-state-${CODESPACE_ID}`)).toHaveText(
    "Stopped (data kept)",
  );
  await expect(page.getByTestId(`github-codespace-start-${CODESPACE_ID}`)).toBeVisible();

  // Keyboard path: open with Enter, dismiss with Escape, focus returns to the trigger.
  const deleteButton = page.getByTestId(`github-codespace-delete-${CODESPACE_ID}`);
  await deleteButton.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Use Stop instead to keep the data");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(deleteButton).toBeFocused();
  expect(requests.some((entry) => entry.startsWith("DELETE"))).toBe(false);

  await deleteButton.click();
  await expect(dialog).toContainText("Use Stop instead to keep the data");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId(`github-codespace-state-${CODESPACE_ID}`)).toHaveText("Deleting");
  expect(requests).toContain(`DELETE /api/integrations/github/codespaces/${CODESPACE_ID}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectEvenMeters(page);
  await management.scrollIntoViewIfNeeded();
  const narrow = await page.screenshot({ fullPage: true });
  await testInfo.attach("codespace-management-narrow", { body: narrow, contentType: "image/png" });
});

test("a codespace the server finished disappears from the card", async ({ page }) => {
  await loginAsAdmin(page);
  // The server answers a delete it can confirm at once with state "deleted" and then stops
  // listing that codespace, so the card must not keep the row its response echoed.
  let codespaces: CodespaceSummaryView[] = [codespace()];
  await page.route("**/api/integrations/github", (route) =>
    route.fulfill({ json: { success: true, data: connection } }),
  );
  await page.route("**/api/integrations/github/codespaces**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/codespaces")) {
      await route.fulfill({
        json: {
          success: true,
          data: {
            readiness,
            connection,
            limits,
            repositories: [{ repository_id: "101", name: "witqq/private-project", private: true }],
            codespaces,
          },
        },
      });
      return;
    }
    if (request.method() === "DELETE") {
      const deleted = codespace({
        state: "deleted",
        desired_state: "deleted",
        observed_state: "absent",
        generation: 4,
      });
      codespaces = [];
      await route.fulfill({
        json: { success: true, data: { codespace: deleted, data_preserved: false } },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { success: false } });
  });

  await page.goto(`${baseUrl}/settings?lang=en#integrations-github`);
  const management = page.getByTestId("github-codespace-management");
  await management.scrollIntoViewIfNeeded();
  await expect(page.getByTestId(`github-codespace-state-${CODESPACE_ID}`)).toBeVisible();

  await page.getByTestId(`github-codespace-delete-${CODESPACE_ID}`).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByTestId(`github-codespace-state-${CODESPACE_ID}`)).toBeHidden();
  await expect(management).toContainText("No codespaces yet");
});

test("disabled and administrator-stopped instances explain themselves in both languages", async ({
  page,
}) => {
  await loginAsAdmin(page);
  let state: CodespaceReadinessView = {
    ...readiness,
    state: "disabled",
    reason: "NOT_CONFIGURED",
    configuration: "absent",
    connector: { state: "not_applicable", reason: null },
  };
  await page.route("**/api/integrations/github", (route) =>
    route.fulfill({
      json: { success: true, data: { ...connection, state: "disabled", reason: "NOT_CONFIGURED" } },
    }),
  );
  await page.route("**/api/integrations/github/codespaces", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { readiness: state, connection, limits, repositories: [], codespaces: [] },
      },
    }),
  );
  await page.goto(`${baseUrl}/settings?lang=en#integrations-github`);
  await expect(page.getByTestId("github-codespace-management")).toContainText(
    "An administrator must configure the GitHub App",
  );
  await expect(page.getByTestId("github-codespace-create")).toHaveCount(0);
  await expect(page.getByTestId("github-codespace-empty")).toBeVisible();

  state = { ...readiness, state: "control_disabled", reason: "global" };
  await page.goto(`${baseUrl}/settings?lang=ru#integrations-github`);
  await expect(page.getByTestId("github-codespace-instance-state")).toHaveText(
    "Остановлено администратором",
  );
  await expect(page.getByTestId("github-codespace-management")).toContainText(
    "Существующие файлы сохранены",
  );
});

test("administrators stop and resume codespace work with an explicit confirmation", async ({
  page,
}) => {
  await loginAsAdmin(page);
  let current: CodespaceReadinessView = readiness;
  const updates: Array<{ scope: string; body: unknown }> = [];
  await page.route("**/api/admin/codespaces", (route) =>
    route.fulfill({
      json: { success: true, data: { readiness: current, controls: current.controls } },
    }),
  );
  await page.route("**/api/admin/codespaces/controls/*", async (route) => {
    const url = new URL(route.request().url());
    const scope = decodeURIComponent(url.pathname.split("/").pop()!);
    const body = route.request().postDataJSON();
    updates.push({ scope, body });
    const disabled = (body as { disabled: boolean }).disabled;
    current = {
      ...readiness,
      state: disabled ? "control_disabled" : "ready",
      reason: disabled ? scope : null,
      controls: readiness.controls.map((control) =>
        control.scope === scope
          ? { ...control, disabled, reason: (body as { reason: string | null }).reason }
          : control,
      ),
    };
    await route.fulfill({
      json: { success: true, data: { readiness: current, controls: current.controls } },
    });
  });

  await page.goto(`${baseUrl}/admin/settings?tab=codespaces&lang=en`);
  await expect(page.getByTestId("admin-codespace-readiness-state")).toHaveText("Ready");
  await expect(page.getByTestId("admin-codespace-readiness-facts")).toContainText("1 / 4");

  await page.getByLabel("Reason shown to operators").first().fill("incident response");
  await page.getByTestId("admin-codespace-disable-global").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("no data is deleted");
  await dialog.getByRole("button", { name: "Stop new work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("admin-codespace-readiness-state")).toHaveText(
    "Stopped by control",
  );
  await expect(page.getByTestId("admin-codespace-control-state-global")).toHaveText("Stopped");
  expect(updates).toEqual([
    { scope: "global", body: { disabled: true, reason: "incident response" } },
  ]);

  await page.getByTestId("admin-codespace-enable-global").click();
  await expect(page.getByTestId("admin-codespace-readiness-state")).toHaveText("Ready");
  expect(updates[1]).toMatchObject({ scope: "global", body: { disabled: false } });
});
