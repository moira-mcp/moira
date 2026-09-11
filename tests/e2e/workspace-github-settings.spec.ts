import { test, expect } from "./fixtures.js";
import type { WorkspaceConnectionView } from "@mcp-moira/shared";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const baseUrl = getTestBaseUrl();
const settingsUrl = `${baseUrl}/settings#integrations-github`;

const connected: WorkspaceConnectionView = {
  state: "connected",
  reason: null,
  settingsUrl,
  installationUrl: null,
  account: { id: "25282049", login: "witqq" },
  installations: [{ externalInstallationId: "9001", repositorySelection: "selected" }],
  repositories: [
    { externalRepositoryId: "101", fullName: "witqq/private-project", private: true },
    { externalRepositoryId: "102", fullName: "witqq/open-project", private: false },
  ],
  canConnect: false,
  canDisconnect: true,
};

test("GitHub integration is connected and disconnected only from Settings", async ({
  page,
}, testInfo) => {
  await loginAsAdmin(page);
  let state: WorkspaceConnectionView = connected;
  await page.route("**/api/integrations/github", async (route) => {
    if (route.request().method() === "DELETE") {
      state = {
        ...connected,
        state: "disconnected",
        repositories: [],
        installations: [],
        canConnect: true,
        canDisconnect: false,
      };
    }
    await route.fulfill({ json: { success: true, data: state } });
  });

  await page.goto(`${baseUrl}/settings?github=connected&lang=en#integrations-github`);
  const integration = page.getByTestId("github-workspace-settings");
  await integration.scrollIntoViewIfNeeded();
  await expect(integration).toContainText("@witqq");
  await expect(integration).toContainText("witqq/private-project");
  await expect(page.getByText("GitHub connected successfully")).toBeVisible();
  expect(new URL(page.url()).searchParams.has("github")).toBe(false);

  const desktop = await page.screenshot({ fullPage: true });
  await testInfo.attach("github-connected-desktop", { body: desktop, contentType: "image/png" });

  await page.getByTestId("github-workspace-disconnect").click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).last().click();
  await expect(page.getByTestId("github-workspace-status")).toHaveText("Disconnected");
  await expect(page.getByRole("alertdialog")).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await integration.scrollIntoViewIfNeeded();
  const narrow = await page.screenshot({ fullPage: true });
  await testInfo.attach("github-disconnected-narrow", { body: narrow, contentType: "image/png" });
});

test("GitHub integration exposes safe actionable states in English and Russian", async ({
  page,
}) => {
  await loginAsAdmin(page);
  let data: WorkspaceConnectionView = {
    ...connected,
    state: "disabled",
    reason: "NOT_CONFIGURED",
    account: null,
    repositories: [],
    installations: [],
    canConnect: false,
    canDisconnect: false,
  };
  await page.route("**/api/integrations/github", (route) =>
    route.fulfill({ json: { success: true, data } }),
  );
  await page.route("**/api/integrations/github/external-revocation", async (route) => {
    data = {
      ...data,
      state: "disconnected",
      reason: null,
      repositories: [],
      installations: [],
      canConnect: true,
      canDisconnect: false,
    };
    await route.fulfill({ json: { success: true, data } });
  });

  await page.goto(`${baseUrl}/settings?lang=en#integrations-github`);
  await expect(page.getByTestId("github-workspace-settings")).toContainText(
    "GitHub workspaces are disabled",
  );

  data = {
    ...connected,
    state: "installation_required",
    reason: "INSTALLATION_REQUIRED",
    installationUrl: "https://github.com/apps/moira-workspaces/installations/new",
    repositories: [],
    installations: [],
    canConnect: true,
    canDisconnect: true,
  };
  await page.reload();
  await expect(page.getByRole("link", { name: "Install GitHub App" })).toHaveAttribute(
    "href",
    data.installationUrl,
  );

  data = {
    ...data,
    state: "refresh_failed",
    reason: "AUTH_REFRESH_FAILED",
    installationUrl: null,
  };
  await page.goto(`${baseUrl}/settings?lang=ru#integrations-github`);
  await expect(page.getByTestId("github-workspace-settings")).toContainText(
    "GitHub нужно переподключить",
  );
  await expect(page.getByTestId("github-workspace-connect")).toHaveText("Переподключить GitHub");

  data = {
    ...data,
    reason: "AUTH_GRANT_REVOCATION_REQUIRED",
    canConnect: false,
    canDisconnect: false,
  };
  await page.reload();
  await expect(page.getByTestId("github-workspace-settings")).toContainText(
    "Перед переподключением отзовите grant GitHub App",
  );
  await page.getByTestId("github-workspace-confirm-external-revocation").click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Moira не может подтвердить отзыв обновлённого credential GitHub",
  );
  await page.getByRole("button", { name: "Удалить после внешнего отзыва", exact: true }).click();
  await expect(page.getByText("Подключение GitHub удалено после внешнего отзыва")).toBeVisible();
  await expect(page.getByTestId("github-workspace-status")).toHaveText("Отключено");

  data = {
    ...data,
    state: "refresh_failed",
    reason: "CREDENTIAL_UNREADABLE",
    canConnect: false,
    canDisconnect: false,
  };
  await page.reload();
  await expect(page.getByTestId("github-workspace-settings")).toContainText(
    "Сохранённый credential GitHub нельзя расшифровать",
  );
  await page.getByTestId("github-workspace-confirm-external-revocation").click();
  await page.getByRole("button", { name: "Удалить после внешнего отзыва", exact: true }).click();
  await expect(page.getByTestId("github-workspace-status")).toHaveText("Отключено");

  data = {
    ...data,
    state: "configuration_error",
    reason: "INVALID_VAULT_KEY",
    account: null,
    canConnect: false,
    canDisconnect: false,
  };
  await page.goto(`${baseUrl}/settings?lang=en#integrations-github`);
  await expect(page.getByTestId("github-workspace-settings")).toContainText(
    "Credential vault key is invalid",
  );

  data = {
    ...connected,
    state: "revocation_pending",
    reason: "REVOCATION_PENDING",
    canConnect: false,
    canDisconnect: true,
  };
  await page.reload();
  await expect(page.getByTestId("github-workspace-settings")).toContainText(
    "GitHub access is being revoked",
  );

  data = {
    ...connected,
    state: "connecting",
    reason: null,
    canConnect: true,
    canDisconnect: false,
  };
  await page.reload();
  await expect(page.getByTestId("github-workspace-status")).toHaveText("Connecting");
});

test("Connect GitHub performs a web navigation instead of an agent authorization call", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.route("**/api/integrations/github", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          ...connected,
          state: "connection_required",
          reason: "CONNECTION_REQUIRED",
          account: null,
          repositories: [],
          installations: [],
          canConnect: true,
          canDisconnect: false,
        },
      },
    }),
  );
  await page.route("**/api/integrations/github/start", (route) => route.fulfill({ status: 204 }));
  await page.goto(`${baseUrl}/settings?lang=en#integrations-github`);
  await expect(page.getByTestId("github-workspace-status")).toHaveText("Not connected");

  const requestPromise = page.waitForRequest("**/api/integrations/github/start");
  await page.getByTestId("github-workspace-connect").click();
  const request = await requestPromise;
  expect(request.method()).toBe("GET");
});

test("GitHub connection load failure keeps Settings usable and retries", async ({ page }) => {
  await loginAsAdmin(page);
  let failed = false;
  await page.route("**/api/integrations/github", (route) => {
    if (!failed) {
      failed = true;
      return route.fulfill({ status: 503, json: { success: false } });
    }
    return route.fulfill({
      json: {
        success: true,
        data: {
          ...connected,
          state: "disabled",
          reason: "NOT_CONFIGURED",
          account: null,
          repositories: [],
          installations: [],
          canConnect: false,
          canDisconnect: false,
        },
      },
    });
  });
  await page.goto(`${baseUrl}/settings?lang=en#integrations-github`);
  const integration = page.getByTestId("github-workspace-settings");
  await expect(integration).toContainText("Failed to load the GitHub workspace connection");
  await integration.getByRole("button", { name: "Retry" }).click();
  await expect(integration).toContainText("GitHub workspaces are disabled");
});
