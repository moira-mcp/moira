import { test, expect } from "./fixtures.js";
import type {
  CodespaceConnectionView,
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

function codespace(overrides: Partial<CodespaceSummaryView> = {}): CodespaceSummaryView {
  return {
    codespace_id: CODESPACE_ID,
    provider: "github-codespaces",
    repository_id: "101",
    repository: "witqq/private-project",
    ref: "main",
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
        ref: body.ref,
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
        data: { readiness: state, connection, repositories: [], codespaces: [] },
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
