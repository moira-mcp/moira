/** @jest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
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
});
