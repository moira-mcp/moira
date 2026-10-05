/** @jest-environment jsdom */

import React from "react";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import {
  evaluateCodespaceResourcePolicy,
  projectCodespaceLimits,
  type CodespaceConnectionView,
} from "@mcp-moira/shared";
import i18n from "../../../packages/web-frontend/src/i18n";
import { GitHubCodespacesProvider } from "../../../packages/web-frontend/src/pages/settings/GitHubCodespacesData";
import { GitHubCodespaceManagement } from "../../../packages/web-frontend/src/pages/settings/GitHubCodespaceManagement";
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
const management: CodespaceManagementView = {
  readiness: {
    state: "ready",
    reason: null,
    provider: "github-codespaces",
    configuration: "available",
    resources_enabled: true,
    controls: [],
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
    },
  ],
  limits: projectCodespaceLimits({
    policy: evaluateCodespaceResourcePolicy(() => undefined),
    held: 1,
    instanceHeld: 1,
    activeOperations: 0,
    transfers: { objects: 0, bytes: 0, inflightBytes: 0 },
    idle: { autoStopEnabled: true, idleTimeoutMinutes: 30 },
    providerIdleMaxMinutes: 240,
  }),
};

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

beforeEach(async () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  await i18n.changeLanguage("en");
  jest.spyOn(apiClient, "getGitHubCodespaceConnection").mockResolvedValue(connection);
  jest.spyOn(apiClient, "getGitHubCodespaces").mockResolvedValue(management);
  jest.spyOn(apiClient, "refreshGitHubCodespaces").mockResolvedValue({
    ...management,
    codespaces: [],
    limits: { ...management.limits, codespaces: { ...management.limits.codespaces, held: 0 } },
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
  test("local provider creation remains available without GitHub and identifies two devices granting the same repository", async () => {
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
          connection: disconnected,
          repositories: [],
          limits: management.limits,
        },
        {
          provider: "local-sandboxes",
          readiness: { ...management.readiness, provider: "local-sandboxes" },
          connection,
          repositories,
          limits: management.limits,
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
      renderSettings(<GitHubCodespaceManagement />);
      const provider = await screen.findByTestId("codespace-provider");
      fireEvent.keyDown(provider, { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("option", { name: "Local Docker Sandboxes" }));
      const repository = await screen.findByTestId("github-codespace-repository");
      expect(repository).toHaveTextContent("First laptop");
      fireEvent.keyDown(repository, { key: "ArrowDown" });
      fireEvent.click(
        await screen.findByRole("option", { name: "owner/repository · Second laptop" }),
      );
      fireEvent.change(screen.getByTestId("github-codespace-ref"), {
        target: { value: "feature/local" },
      });
      fireEvent.click(screen.getByTestId("github-codespace-create-submit"));
      await waitFor(() =>
        expect(bodies).toEqual([{ repository_id: second, ref: "feature/local" }]),
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
