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
const DEVICE_ID = "44444444-4444-4444-8444-444444444444";
const ORIGINAL_ID = "ws1-55555555-5555-4555-8555-555555555555";
const requestIdPattern = /^ws1-[0-9a-f-]{36}$/;

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
  checked_at: Date.now(),
};

const managementMetadata = {
  provider_billing: "unavailable",
  controllers: [{ device_id: DEVICE_ID, label: "Paired controller", available: true }],
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
    device_id: DEVICE_ID,
    pending_request_ids: [],
    created_at: Date.now() - 3_600_000,
    updated_at: Date.now() - 60_000,
    observed_at: Date.now() - 60_000,
    lifecycle_error: null,
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
      pending_request_ids: [ORIGINAL_ID],
    }),
  ];
  const requests: string[] = [];
  let createdId = "";
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
            ...managementMetadata,
            repositories: [{ repository_id: "101", name: "witqq/private-project", private: true }],
            repositories_stale: true,
            codespaces,
          },
        },
      });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/codespaces")) {
      const body = request.postDataJSON();
      expect(body).toEqual({
        repository_id: "101",
        ref: "feature/e2e",
        device_id: DEVICE_ID,
        request_id: expect.stringMatching(requestIdPattern),
      });
      createdId = body.request_id.slice(4);
      const created = codespace({
        codespace_id: createdId,
        requested_ref: body.ref,
        current_ref: null,
        state: "create_submitted",
        observed_state: "provisioning",
        generation: 1,
        pending_request_ids: [body.request_id],
      });
      codespaces = [...codespaces, created];
      await route.fulfill({ status: 201, json: { success: true, data: { codespace: created } } });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/stop")) {
      const id = url.pathname.split("/").at(-2)!;
      const current = codespaces.find((item) => item.codespace_id === id)!;
      expect(request.postDataJSON()).toEqual({
        expected_generation: current.generation,
        request_id: expect.stringMatching(requestIdPattern),
      });
      const stopped = codespace({
        codespace_id: id,
        state: "stopped",
        desired_state: "stopped",
        observed_state: "stopped",
        generation: current.generation + 1,
      });
      codespaces = codespaces.map((item) => (item.codespace_id === id ? stopped : item));
      await route.fulfill({
        json: { success: true, data: { codespace: stopped, data_preserved: true } },
      });
      return;
    }
    if (request.method() === "DELETE") {
      const id = url.pathname.split("/").at(-1)!;
      const current = codespaces.find((item) => item.codespace_id === id)!;
      const body = request.postDataJSON() as {
        confirm_delete: boolean;
        expected_generation: number;
      };
      expect(body).toEqual({
        confirm_delete: true,
        expected_generation: current.generation,
        request_id: expect.stringMatching(requestIdPattern),
      });
      const deleted = codespace({
        codespace_id: id,
        state: "delete_pending",
        desired_state: "deleted",
        generation: current.generation + 1,
      });
      codespaces = codespaces.map((item) => (item.codespace_id === id ? deleted : item));
      await route.fulfill({
        json: { success: true, data: { codespace: deleted, data_preserved: false } },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { success: false } });
  });

  await page.goto(`${baseUrl}/settings?lang=en#development-environments`);
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
  // Deletion remains available while creation is pending so the owner can cancel the intent.
  await expect(page.getByTestId(`github-codespace-delete-${SECOND_ID}`)).toBeEnabled();
  await expect(page.getByTestId(`github-codespace-stop-${SECOND_ID}`)).toBeEnabled();
  await page.getByTestId(`github-codespace-stop-${SECOND_ID}`).click();
  await expect(page.getByTestId(`github-codespace-state-${SECOND_ID}`)).toHaveText(
    "Stopped (data kept)",
  );
  await expect(management).toContainText("personal billing");
  await expect(page.getByTestId("codespace-limit-held")).toHaveCount(0);
  await page.getByRole("tab", { name: "GitHub connection", exact: true }).click();
  await expect(page.getByTestId("github-codespace-billing-unavailable")).toBeVisible();
  await page.getByRole("tab", { name: "GitHub Codespaces", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await expect(
    page.getByText("Request accepted. Completion has not been confirmed yet."),
  ).toBeVisible();
  await expect(page.getByTestId("github-codespace-list")).toContainText("feature/e2e");
  await page.getByTestId(`github-codespace-delete-${createdId}`).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId(`github-codespace-state-${createdId}`)).toHaveText("Deleting");
  await page.getByTestId(`github-codespace-delete-${createdId}`).click();
  await expect(
    page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(
    requests.filter((entry) => entry === `DELETE /api/integrations/github/codespaces/${createdId}`),
  ).toHaveLength(1);

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
  expect(requests).not.toContain(`DELETE /api/integrations/github/codespaces/${CODESPACE_ID}`);

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

test("a failed codespace request is explained in Russian, for a known and an unknown error code", async ({
  page,
}) => {
  await loginAsAdmin(page);
  // The server's own sentence is English and written for agents; the reader never sees it.
  const failures = [
    {
      status: 503,
      code: "CODESPACE_PROVIDER_UNAVAILABLE",
      message: "Provider unavailable",
    },
    {
      status: 422,
      code: "SOMETHING_THIS_BUILD_DOES_NOT_KNOW",
      message: "Brand new English failure",
    },
  ];
  await page.route("**/api/integrations/github", (route) =>
    route.fulfill({ json: { success: true, data: connection } }),
  );
  await page.route("**/api/integrations/github/codespaces**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const failure = failures.shift()!;
      await route.fulfill({
        status: failure.status,
        json: { success: false, error: { code: failure.code, message: failure.message } },
      });
      return;
    }
    await route.fulfill({
      json: {
        success: true,
        data: {
          readiness,
          connection,
          ...managementMetadata,
          repositories: [{ repository_id: "101", name: "witqq/private-project", private: true }],
          codespaces: [codespace()],
        },
      },
    });
  });

  await page.goto(`${baseUrl}/settings?lang=ru#development-environments`);
  await page.getByTestId("github-codespace-ref").fill("feature/probe");

  await page.getByTestId("github-codespace-create-submit").click();
  await expect(
    page.getByText("GitHub Codespaces сейчас не отвечает. Повторите чуть позже."),
  ).toBeVisible();
  await page.getByTestId("github-codespace-create-submit").click();
  await expect(
    page
      .getByTestId("github-codespace-management")
      .getByRole("alert")
      .locator('[data-slot="alert-description"]')
      .getByText("Запрос к кодспейсу отклонён", { exact: true }),
  ).toBeVisible();

  await expect(page.getByText("Provider unavailable")).toHaveCount(0);
  await expect(page.getByText("Brand new English failure")).toHaveCount(0);
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
            ...managementMetadata,
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

  await page.goto(`${baseUrl}/settings?lang=en#development-environments`);
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

test("unconfigured instances explain themselves in both languages", async ({ page }) => {
  await loginAsAdmin(page);
  const state: CodespaceReadinessView = {
    ...readiness,
    state: "disabled",
    reason: "NOT_CONFIGURED",
    configuration: "absent",
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
        data: {
          readiness: state,
          connection,
          ...managementMetadata,
          repositories: [],
          codespaces: [],
        },
      },
    }),
  );
  await page.goto(`${baseUrl}/settings?lang=en#development-environments`);
  await expect(page.getByTestId("github-codespace-management")).toContainText(
    "An administrator must configure the GitHub App",
  );
  await expect(page.getByTestId("github-codespace-create")).toHaveCount(0);
  await expect(page.getByTestId("github-codespace-empty")).toBeVisible();

  await page.goto(`${baseUrl}/settings?lang=ru#development-environments`);
  await expect(page.getByTestId("github-codespace-instance-state")).toHaveText(
    "Отключено на этом инстансе",
  );
  await expect(page.getByTestId("github-codespace-management")).toContainText("GitHub App");
});

test("administrators inspect readiness without cloud lifecycle controls", async ({ page }) => {
  await loginAsAdmin(page);
  const requests: string[] = [];
  await page.route("**/api/admin/codespaces**", async (route) => {
    requests.push(route.request().method());
    await route.fulfill({
      json: { success: true, data: { readiness } },
    });
  });

  await page.goto(`${baseUrl}/admin/settings?tab=codespaces&lang=en`);
  await expect(page.getByTestId("admin-codespace-readiness-state")).toHaveText("Ready");
  const panel = page.getByTestId("admin-codespace-controls");
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByTestId("admin-codespace-disable-global")).toHaveCount(0);
  await panel.getByRole("button").click();
  await expect(page.getByTestId("admin-codespace-readiness-state")).toHaveText("Ready");
  await expect.poll(() => requests.length).toBeGreaterThan(1);
  expect(requests.every((method) => method === "GET")).toBe(true);
});

test("a lost create reply collects the original owner request without another creation", async ({
  page,
}) => {
  await loginAsAdmin(page);
  let originalId = "",
    creates = 0;
  const collected: string[] = [];
  await page.route("**/api/integrations/github", (route) =>
    route.fulfill({ json: { success: true, data: connection } }),
  );
  await page.route("**/api/integrations/github/codespaces**", async (route) => {
    if (
      route.request().method() === "POST" &&
      new URL(route.request().url()).pathname.endsWith("/codespaces")
    ) {
      creates++;
      const body = route.request().postDataJSON();
      originalId = body.request_id;
      expect(originalId).toMatch(requestIdPattern);
      expect(body.device_id).toBe(DEVICE_ID);
      await route.fulfill({
        status: 503,
        json: {
          success: false,
          error: {
            code: "WORKSPACE_OUTCOME_UNCONFIRMED",
            message: "Outcome unconfirmed",
            request_id: originalId,
            device_id: DEVICE_ID,
          },
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        success: true,
        data: {
          readiness,
          connection,
          ...managementMetadata,
          repositories: [{ repository_id: "101", name: "witqq/private-project", private: true }],
          codespaces: [],
        },
      },
    });
  });
  await page.route(`**/api/integrations/local/devices/${DEVICE_ID}/operations/*`, async (route) => {
    expect(route.request().method()).toBe("GET");
    collected.push(new URL(route.request().url()).pathname.split("/").at(-1)!);
    await route.fulfill({
      json: { success: true, data: { requestId: originalId, state: "absent" } },
    });
  });
  await page.goto(`${baseUrl}/settings?lang=en#development-environments`);
  await page.getByTestId("github-codespace-ref").fill("feature/recovery");
  await page.getByTestId("github-codespace-create-submit").click();
  await expect(page.getByTestId("github-codespace-create-submit")).toBeDisabled();
  await page
    .getByTestId("github-codespace-management")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect.poll(() => collected).toEqual([originalId]);
  await expect(page.getByTestId("github-codespace-create-submit")).toBeEnabled();
  expect(creates).toBe(1);
});
