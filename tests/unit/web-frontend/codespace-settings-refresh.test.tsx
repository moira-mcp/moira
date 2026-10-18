/** @jest-environment jsdom */

import React from "react";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { type CodespaceConnectionView, type LocalDeviceView } from "@mcp-moira/shared";
import i18n from "../../../packages/web-frontend/src/i18n";
import { GitHubCodespacesProvider } from "../../../packages/web-frontend/src/pages/settings/GitHubCodespacesData";
import { GitHubCodespaceManagement } from "../../../packages/web-frontend/src/pages/settings/GitHubCodespaceManagement";
import { CodespaceManagement } from "../../../packages/web-frontend/src/pages/settings/CodespaceManagement";
import { CodespaceBillingFromData } from "../../../packages/web-frontend/src/pages/settings/CodespaceBillingPanel";
import { GitHubCodespaceSettings } from "../../../packages/web-frontend/src/pages/settings/GitHubCodespaceSettings";
import { apiClient, MoiraApiClient } from "../../../packages/web-frontend/src/services/api-client";
import type { CodespaceManagementView } from "../../../packages/web-frontend/src/types/api-types";

const CODESPACE_ID = "00000000-0000-4000-8000-000000000001";
const connection: CodespaceConnectionView = {
  state: "connected",
  reason: null,
  settingsUrl: "https://moira.example/settings#integrations-github",
  installationUrl: "https://github.com/apps/moira-codespaces/installations/new",
  account: { id: "101", login: "owner" },
  installations: [],
  repositories: [{ externalRepositoryId: "301", fullName: "owner/repository", private: true }],
  canConnect: false,
  canDisconnect: true,
};
const management = {
  readiness: {
    state: "ready",
    reason: null,
    provider: "github-codespaces",
    configuration: "available",
    resources_enabled: true,
    checked_at: 1,
  },
  connection,
  repositories: [{ repository_id: "301", name: "owner/repository", private: true }],
  repositories_stale: false,
  resources_stale: false,
  codespaces: [
    {
      codespace_id: CODESPACE_ID,
      provider: "github-codespaces",
      repository_id: "301",
      repository: "owner/repository",
      requested_ref: "main",
      current_ref: "main",
      machine: {
        name: "basic",
        display_name: "2 cores",
        operating_system: "linux",
        cpu_cores: 2,
        memory_bytes: 8 * 1024 ** 3,
        storage_bytes: 32 * 1024 ** 3,
      },
      state: "usable",
      retention_policy: "persistent",
      desired_state: "running",
      observed_state: "running",
      generation: 1,
      created_at: 1,
      updated_at: 1,
      observed_at: 1,
      lifecycle_error: null,
    },
  ],
  provider_billing: "unavailable",
  controllers: [
    { device_id: "11111111-1111-4111-8111-111111111111", label: "Controller", available: true },
  ],
} satisfies CodespaceManagementView;

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

beforeEach(async () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  await i18n.changeLanguage("en");
  jest.spyOn(apiClient, "getGitHubCodespaceConnection").mockResolvedValue(connection);
  jest.spyOn(apiClient, "getGitHubCodespaces").mockResolvedValue(management);
  jest.spyOn(apiClient, "refreshGitHubCodespaces").mockResolvedValue({
    ...management,
    codespaces: [],
  });
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});

function renderSettings(content: React.ReactNode) {
  return render(
    <I18nextProvider i18n={i18n}>
      <GitHubCodespacesProvider>{content}</GitHubCodespacesProvider>
    </I18nextProvider>,
  );
}

describe("GitHub Codespaces Settings", () => {
  test.each([true, false])(
    "keeps unavailable Local identities read-only with healthy peers=%s and replaces them only after an observation",
    async (healthyPeer) => {
      const computerId = "11111111-1111-4111-8111-111111111111";
      const unavailableId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const local = {
        ...management.codespaces[0],
        provider: "local-sandboxes",
        repository_id: `local:${computerId}:44444444-4444-4444-8444-444444444444`,
      };
      const next: CodespaceManagementView = {
        ...management,
        readiness: { ...management.readiness, provider: "local-sandboxes" },
        repositories: [],
        codespaces: healthyPeer ? [local] : [],
        unavailable: [
          {
            codespace_id: unavailableId,
            provider: "local-sandboxes",
            repository_id: local.repository_id,
            repository: "owner/unobserved",
            requested_ref: "feature/original",
            device_id: computerId,
            created_at: 1,
            error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" },
          },
        ],
      };
      jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue(next);
      jest.mocked(apiClient.refreshGitHubCodespaces).mockResolvedValue({
        ...next,
        unavailable: [],
        codespaces: [
          ...(healthyPeer ? [local] : []),
          { ...local, codespace_id: unavailableId, repository: "owner/unobserved", generation: 9 },
        ],
      });
      renderSettings(
        <CodespaceManagement
          scope={{
            provider: "local-sandboxes",
            computer: {
              deviceId: computerId,
              status: "active",
              owner: {
                state: "available",
                local: {
                  state: "configured",
                  policy: { enabled: true, leaseUntil: Date.now() + 600_000 },
                },
                github: { resources: [] },
              },
            } as LocalDeviceView,
          }}
        />,
      );
      const row = await screen.findByTestId(`codespace-unavailable-${unavailableId}`);
      expect(row).toHaveTextContent("owner/unobserved");
      expect(row).toHaveTextContent("feature/original");
      expect(row).toHaveTextContent("State could not be confirmed");
      expect(within(row).queryByRole("button")).toBeNull();
      expect(screen.queryByTestId("github-codespace-empty")).toBeNull();
      expect(screen.queryByTestId(`github-codespace-${CODESPACE_ID}`) !== null).toBe(healthyPeer);
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      expect(await screen.findByTestId(`github-codespace-${unavailableId}`)).toBeInTheDocument();
      expect(screen.queryByTestId(`codespace-unavailable-${unavailableId}`)).toBeNull();
      expect(screen.getByTestId(`github-codespace-stop-${unavailableId}`)).toBeEnabled();
    },
  );
  test("shows provider failures without borrowing healthy peer metadata or claiming an empty list", async () => {
    jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue({
      ...management,
      readiness: undefined,
      connection: undefined,
      codespaces: [],
      repositories: [],
      provider_errors: [
        { provider: "github-codespaces", error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" } },
      ],
      providers: [
        {
          provider: "github-codespaces",
          error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" },
        },
        {
          provider: "local-sandboxes",
          readiness: { ...management.readiness, provider: "local-sandboxes" },
          connection,
          repositories: [],
          repositories_stale: false,
          resources_stale: false,
        },
      ],
    });
    renderSettings(
      <>
        <GitHubCodespaceManagement />
        <CodespaceBillingFromData />
      </>,
    );
    expect(await screen.findByText("Provider data could not be loaded")).toBeInTheDocument();
    expect(screen.getByTestId("github-codespace-billing-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("github-codespace-instance-state")).toBeNull();
    expect(screen.queryByTestId("github-codespace-empty")).toBeNull();
    expect(screen.queryByTestId("github-codespace-create")).toBeNull();
    expect(
      screen.getByText(i18n.t("common.codespaceErrors.CODESPACE_PROVIDER_UNAVAILABLE")),
    ).toBeInTheDocument();
  });
  test("an in-flight refresh that loses an observation disables an already opened delete confirmation", async () => {
    let complete!: (next: CodespaceManagementView) => void;
    jest.mocked(apiClient.refreshGitHubCodespaces).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const remove = jest.spyOn(apiClient, "deleteGitHubCodespace");
    renderSettings(<GitHubCodespaceManagement />);
    await screen.findByTestId(`github-codespace-${CODESPACE_ID}`);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByTestId(`github-codespace-delete-${CODESPACE_ID}`));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: i18n.t("pages.settings.codespaces.delete"),
    });
    expect(confirm).toBeEnabled();
    await act(async () =>
      complete({
        ...management,
        codespaces: [],
        unavailable: [
          {
            codespace_id: CODESPACE_ID,
            provider: "github-codespaces",
            repository_id: "301",
            repository: "owner/repository",
            requested_ref: "main",
            created_at: 1,
            error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" },
          },
        ],
      }),
    );
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(remove).not.toHaveBeenCalled();
  });
  test("the GitHub list excludes local codespaces even when the management response contains both providers", async () => {
    const localId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue({
      ...management,
      codespaces: [
        ...management.codespaces,
        {
          ...management.codespaces[0],
          codespace_id: localId,
          provider: "local-sandboxes",
          repository_id:
            "local:11111111-1111-4111-8111-111111111111:44444444-4444-4444-8444-444444444444",
        },
      ],
    });
    renderSettings(<GitHubCodespaceManagement />);
    expect(await screen.findByTestId(`github-codespace-${CODESPACE_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`github-codespace-${localId}`)).toBeNull();
    expect(screen.queryByTestId("codespace-provider")).toBeNull();
  });
  test("local creation targets its computer when another computer grants the same repository and GitHub is disconnected", async () => {
    const first = "local:11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333";
    const second =
      "local:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333";
    const repositories = [
      {
        repository_id: first,
        name: "owner/repository",
        private: true,
        provider: "local-sandboxes",
        device_label: "First laptop",
      },
      {
        repository_id: second,
        name: "owner/repository",
        private: true,
        provider: "local-sandboxes",
        device_label: "Second laptop",
      },
    ];
    const disconnected = { ...connection, state: "disconnected" as const };
    jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue({
      ...management,
      connection: disconnected,
      repositories,
      providers: [
        {
          provider: "github-codespaces",
          readiness: management.readiness,
          repositories_stale: false,
          resources_stale: false,
          connection: disconnected,
          repositories: [],
          provider_billing: "unavailable",
        },
        {
          provider: "local-sandboxes",
          readiness: { ...management.readiness, provider: "local-sandboxes" },
          repositories_stale: false,
          resources_stale: false,
          connection,
          repositories,
        },
      ],
    });
    const originalAdapter = axios.defaults.adapter;
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = () => undefined;
    const bodies: unknown[] = [];
    axios.defaults.adapter = async (config) => {
      bodies.push(JSON.parse(config.data));
      return {
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          success: true,
          data: { codespace: { ...management.codespaces[0], provider: "local-sandboxes" } },
        },
      };
    };
    const client = new MoiraApiClient();
    jest
      .spyOn(apiClient, "createGitHubCodespace")
      .mockImplementation(client.createGitHubCodespace.bind(client));
    try {
      const computerId = "22222222-2222-4222-8222-222222222222";
      renderSettings(
        <CodespaceManagement
          scope={{
            provider: "local-sandboxes",
            computer: {
              deviceId: computerId,
              status: "active",
              owner: {
                state: "available",
                local: {
                  state: "configured",
                  policy: { enabled: true, leaseUntil: Date.now() + 600_000 },
                },
                github: { resources: [] },
              },
            } as LocalDeviceView,
          }}
        />,
      );
      const repository = await screen.findByTestId(`local-codespace-${computerId}-repository`);
      await waitFor(() => expect(repository).toHaveTextContent("owner/repository"));
      fireEvent.keyDown(repository, { key: "ArrowDown" });
      expect(await screen.findAllByRole("option")).toHaveLength(1);
      fireEvent.click(screen.getByRole("option", { name: "owner/repository" }));
      fireEvent.change(screen.getByTestId(`local-codespace-${computerId}-ref`), {
        target: { value: "feature/local" },
      });
      fireEvent.click(screen.getByTestId(`local-codespace-${computerId}-create-submit`));
      await waitFor(() =>
        expect(bodies).toEqual([
          {
            repository_id: second,
            ref: "feature/local",
            request_id: expect.stringMatching(/^ws1-/),
          },
        ]),
      );
      expect(
        screen.queryByText(/Codespaces are billed to your personal GitHub account/),
      ).toBeNull();
    } finally {
      axios.defaults.adapter = originalAdapter;
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });
  test("Refresh uses the provider sync response and removes an externally deleted row", async () => {
    renderSettings(<GitHubCodespaceManagement />);
    const card = await screen.findByTestId("github-codespace-management");
    expect(await within(card).findByTestId(`github-codespace-${CODESPACE_ID}`)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(apiClient.refreshGitHubCodespaces).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId(`github-codespace-${CODESPACE_ID}`)).not.toBeInTheDocument(),
    );
  });

  test("a connected user can open GitHub App installation for an organization", async () => {
    renderSettings(<GitHubCodespaceSettings />);
    const link = await screen.findByTestId("github-codespace-add-installation");
    expect(link).toHaveTextContent("Add account or organization");
    expect(link).toHaveAttribute("href", connection.installationUrl);
  });

  test("provider refresh failure keeps codespaces, the branch draft and focus, then retries", async () => {
    let reject!: (error: unknown) => void;
    jest.mocked(apiClient.refreshGitHubCodespaces).mockImplementationOnce(
      () =>
        new Promise((_yes, no) => {
          reject = no;
        }),
    );
    renderSettings(<GitHubCodespaceManagement />);
    const row = await screen.findByTestId(`github-codespace-${CODESPACE_ID}`);
    const branch = screen.getByTestId("github-codespace-ref");
    fireEvent.change(branch, { target: { value: "feature/draft" } });
    branch.focus();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByTestId(`github-codespace-${CODESPACE_ID}`)).toBe(row);
    expect(screen.getByTestId("github-codespace-ref")).toBe(branch);
    expect(branch).toHaveFocus();
    await act(async () => reject(new Error("GitHub unavailable")));
    expect(await screen.findByText("Failed to load cloud codespaces")).toBeInTheDocument();
    expect(row).toBeInTheDocument();
    expect(branch).toHaveValue("feature/draft");
    expect(branch).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("github-management-region")).toHaveAttribute("aria-busy", "false"),
    );
    expect(branch).toHaveValue("feature/draft");
  });
});
