import { test, expect } from "./fixtures.js";
import type {
  WorkspaceConnectionView,
  WorkspaceReadinessView,
  WorkspaceSummaryView,
} from "@mcp-moira/shared";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const baseUrl = getTestBaseUrl();
const settingsUrl = `${baseUrl}/settings#integrations-github`;
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

const connection: WorkspaceConnectionView = {
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

const readiness: WorkspaceReadinessView = {
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

function workspace(overrides: Partial<WorkspaceSummaryView> = {}): WorkspaceSummaryView {
  return {
    workspace_id: WORKSPACE_ID,
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

test("workspaces are created, stopped and deleted with confirmation from Settings", async ({
  page,
}, testInfo) => {
  await loginAsAdmin(page);
  let workspaces: WorkspaceSummaryView[] = [
    workspace(),
    workspace({
      workspace_id: SECOND_ID,
      state: "create_submitted",
      observed_state: "provisioning",
    }),
  ];
  const requests: string[] = [];
  await page.route("**/api/integrations/github", (route) =>
    route.fulfill({ json: { success: true, data: connection } }),
  );
  await page.route("**/api/integrations/github/workspaces**", async (route) => {
    const request = route.request();
    requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/workspaces")) {
      await route.fulfill({
        json: {
          success: true,
          data: {
            readiness,
            connection,
            repositories: [{ repository_id: "101", name: "witqq/private-project", private: true }],
            workspaces,
          },
        },
      });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/workspaces")) {
      const body = request.postDataJSON() as { repository_id: string; ref: string };
      const created = workspace({
        workspace_id: "33333333-3333-4333-8333-333333333333",
        ref: body.ref,
        state: "create_submitted",
        observed_state: "provisioning",
        generation: 1,
      });
      workspaces = [...workspaces, created];
      await route.fulfill({ status: 201, json: { success: true, data: { workspace: created } } });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/stop")) {
      const stopped = workspace({
        state: "stopped",
        desired_state: "stopped",
        observed_state: "stopped",
        generation: 4,
      });
      workspaces = workspaces.map((item) => (item.workspace_id === WORKSPACE_ID ? stopped : item));
      await route.fulfill({
        json: { success: true, data: { workspace: stopped, data_preserved: true } },
      });
      return;
    }
    if (request.method() === "DELETE") {
      const body = request.postDataJSON() as {
        confirm_delete: boolean;
        expected_generation: number;
      };
      expect(body).toEqual({ confirm_delete: true, expected_generation: 4 });
      const deleted = workspace({
        state: "delete_pending",
        desired_state: "deleted",
        generation: 5,
      });
      workspaces = workspaces.map((item) => (item.workspace_id === WORKSPACE_ID ? deleted : item));
      await route.fulfill({
        json: { success: true, data: { workspace: deleted, data_preserved: false } },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { success: false } });
  });

  await page.goto(`${baseUrl}/settings?lang=en#integrations-github`);
  const management = page.getByTestId("github-workspace-management");
  await management.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("github-workspace-instance-state")).toHaveText("Ready");
  await expect(page.getByTestId("github-workspace-disclosure")).toContainText(
    "read any secrets configured for that Codespace",
  );
  await expect(management).not.toContainText(/chat|session/i);
  await expect(page.getByTestId(`github-workspace-state-${WORKSPACE_ID}`)).toHaveText("Running");
  await expect(page.getByTestId(`github-workspace-state-${SECOND_ID}`)).toHaveText("Creating");
  await expect(page.getByTestId(`github-workspace-delete-${SECOND_ID}`)).toBeDisabled();
  await expect(management).toContainText("personal billing");

  const desktop = await page.screenshot({ fullPage: true });
  await testInfo.attach("workspace-management-desktop", {
    body: desktop,
    contentType: "image/png",
  });

  await page.getByTestId("github-workspace-ref").fill("feature/e2e");
  await page.getByTestId("github-workspace-create-submit").click();
  await expect(page.getByText("Workspace creation was accepted")).toBeVisible();
  await expect(page.getByTestId("github-workspace-list")).toContainText("feature/e2e");

  await page.getByTestId(`github-workspace-stop-${WORKSPACE_ID}`).click();
  await expect(page.getByTestId(`github-workspace-state-${WORKSPACE_ID}`)).toHaveText(
    "Stopped (data kept)",
  );
  await expect(page.getByTestId(`github-workspace-start-${WORKSPACE_ID}`)).toBeVisible();

  // Keyboard path: open with Enter, dismiss with Escape, focus returns to the trigger.
  const deleteButton = page.getByTestId(`github-workspace-delete-${WORKSPACE_ID}`);
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
  await expect(page.getByTestId(`github-workspace-state-${WORKSPACE_ID}`)).toHaveText("Deleting");
  expect(requests).toContain(`DELETE /api/integrations/github/workspaces/${WORKSPACE_ID}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await management.scrollIntoViewIfNeeded();
  const narrow = await page.screenshot({ fullPage: true });
  await testInfo.attach("workspace-management-narrow", { body: narrow, contentType: "image/png" });
});

test("disabled and administrator-stopped instances explain themselves in both languages", async ({
  page,
}) => {
  await loginAsAdmin(page);
  let state: WorkspaceReadinessView = {
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
  await page.route("**/api/integrations/github/workspaces", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { readiness: state, connection, repositories: [], workspaces: [] },
      },
    }),
  );
  await page.goto(`${baseUrl}/settings?lang=en#integrations-github`);
  await expect(page.getByTestId("github-workspace-management")).toContainText(
    "An administrator must configure the GitHub App",
  );
  await expect(page.getByTestId("github-workspace-create")).toHaveCount(0);
  await expect(page.getByTestId("github-workspace-empty")).toBeVisible();

  state = { ...readiness, state: "control_disabled", reason: "global" };
  await page.goto(`${baseUrl}/settings?lang=ru#integrations-github`);
  await expect(page.getByTestId("github-workspace-instance-state")).toHaveText(
    "Остановлено администратором",
  );
  await expect(page.getByTestId("github-workspace-management")).toContainText(
    "Существующие файлы сохранены",
  );
});

test("administrators stop and resume workspace work with an explicit confirmation", async ({
  page,
}) => {
  await loginAsAdmin(page);
  let current: WorkspaceReadinessView = readiness;
  const updates: Array<{ scope: string; body: unknown }> = [];
  await page.route("**/api/admin/workspaces", (route) =>
    route.fulfill({
      json: { success: true, data: { readiness: current, controls: current.controls } },
    }),
  );
  await page.route("**/api/admin/workspaces/controls/*", async (route) => {
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

  await page.goto(`${baseUrl}/admin/settings?tab=workspaces&lang=en`);
  await expect(page.getByTestId("admin-workspace-readiness-state")).toHaveText("Ready");
  await expect(page.getByTestId("admin-workspace-readiness-facts")).toContainText("1 / 4");

  await page.getByLabel("Reason shown to operators").first().fill("incident response");
  await page.getByTestId("admin-workspace-disable-global").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("no data is deleted");
  await dialog.getByRole("button", { name: "Stop new work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("admin-workspace-readiness-state")).toHaveText(
    "Stopped by control",
  );
  await expect(page.getByTestId("admin-workspace-control-state-global")).toHaveText("Stopped");
  expect(updates).toEqual([
    { scope: "global", body: { disabled: true, reason: "incident response" } },
  ]);

  await page.getByTestId("admin-workspace-enable-global").click();
  await expect(page.getByTestId("admin-workspace-readiness-state")).toHaveText("Ready");
  expect(updates[1]).toMatchObject({ scope: "global", body: { disabled: false } });
});
