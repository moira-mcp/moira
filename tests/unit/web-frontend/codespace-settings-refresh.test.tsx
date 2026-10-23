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
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import type {
  CodespaceManagementView,
  WorkspaceOperationView,
} from "../../../packages/web-frontend/src/types/api-types";
import { encodeReference } from "@mcp-moira/shared/workspace-references";
import {
  observeReadSession,
  observeReadCapabilities,
  suspendReadSession,
} from "../../../packages/web-frontend/src/services/read-scope";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  controllerOperationSchema,
  controllerOperationFindResultSchema,
} from "@mcp-moira/shared/local-controller-protocol";

const CODESPACE_ID = "00000000-0000-4000-8000-000000000001";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const controller = encodeReference("controller", {
  deviceId: DEVICE_ID,
  connectionId: "22222222-2222-4222-8222-222222222222",
});
const target = encodeReference("target", {
  provider: "github-codespaces",
  repositoryId: "301",
  controller: { deviceId: DEVICE_ID, connectionId: "22222222-2222-4222-8222-222222222222" },
});
const operation = encodeReference("operation", {
  owner: {
    kind: "controller",
    deviceId: DEVICE_ID,
    connectionId: "22222222-2222-4222-8222-222222222222",
  },
  requestId: "ws1-33333333-3333-4333-8333-333333333333",
  kind: "lifecycle",
});
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
  repositories: [
    {
      repository_id: "301",
      name: "owner/repository",
      private: true,
      device_id: DEVICE_ID,
      target,
      controller,
    },
  ],
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
      workspace: encodeReference("workspace", {
        resourceId: CODESPACE_ID,
        provider: "github-codespaces",
        deviceId: DEVICE_ID,
        generation: 1,
      }),
      controller,
      pending_operations: [],
      created_at: 1,
      updated_at: 1,
      observed_at: 1,
      lifecycle_error: null,
    },
  ],
  has_diagnostics: false,
  controllers: [{ device_id: DEVICE_ID, label: "Controller", controller }],
} satisfies CodespaceManagementView;

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

beforeEach(async () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (!String(input).includes("/get-session")) throw new Error("Unexpected auth fixture request");
    return Response.json({
      user: {
        id: "discovery-owner",
        name: "Owner",
        email: "owner@example.test",
        emailVerified: true,
      },
      session: {
        id: "discovery-session",
        userId: "discovery-owner",
        token: "fixture-token",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        expiresAt: "2099-01-01",
      },
    });
  });
  await authClient.$store.atoms.session.get().refetch();
  await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
  await i18n.changeLanguage("en");
  jest.spyOn(apiClient, "getGitHubCodespaceConnection").mockResolvedValue(connection);
  jest.spyOn(apiClient, "getCodespaces").mockResolvedValue(management);
  jest.spyOn(apiClient, "refreshCodespaces").mockResolvedValue({
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
  test.each(["success", "error"] as const)(
    "renewed connection authority ignores a late old %s",
    async (late) => {
      act(() => observeReadSession("discovery-owner", "connection-before"));
      let resolve!: (value: CodespaceConnectionView) => void;
      let reject!: (error: Error) => void;
      jest
        .mocked(apiClient.getGitHubCodespaceConnection)
        .mockImplementationOnce(
          () =>
            new Promise((yes, no) => {
              resolve = yes;
              reject = no;
            }),
        )
        .mockResolvedValue({ ...connection, account: { id: "202", login: "current-owner" } });
      renderSettings(<GitHubCodespaceSettings />);
      await waitFor(() => expect(apiClient.getGitHubCodespaceConnection).toHaveBeenCalledTimes(1));
      act(() => observeReadSession("discovery-owner", "connection-after"));
      await screen.findByText("@current-owner");
      await act(async () =>
        late === "error" ? reject(new Error("Old credential read failed")) : resolve(connection),
      );
      expect(screen.getByText("@current-owner")).toBeInTheDocument();
      expect(screen.queryByText("@owner")).toBeNull();
      expect(screen.getByTestId("github-connection-region")).toHaveAttribute("aria-busy", "false");
      expect(
        within(screen.getByTestId("github-connection-region")).queryByRole("alert"),
      ).toBeNull();
    },
  );

  test("suspended discovery hides private rows, performs no read and restores the draft after same-owner renewal", async () => {
    act(() => observeReadSession("discovery-owner", "before-suspension"));
    renderSettings(<GitHubCodespaceManagement />);
    await screen.findByTestId(`github-codespace-${CODESPACE_ID}`);
    fireEvent.change(await screen.findByTestId("github-codespace-ref"), {
      target: { value: "feature/suspended-draft" },
    });
    act(() => suspendReadSession());
    expect(screen.queryByTestId(`github-codespace-${CODESPACE_ID}`)).toBeNull();
    expect(
      jest
        .mocked(apiClient.getCodespaces)
        .mock.calls.filter(([provider]) => provider === "github-codespaces"),
    ).toHaveLength(1);
    act(() => observeReadSession("discovery-owner", "after-suspension"));
    expect(await screen.findByTestId("github-codespace-ref")).toHaveValue(
      "feature/suspended-draft",
    );
    expect(
      jest
        .mocked(apiClient.getCodespaces)
        .mock.calls.filter(([provider]) => provider === "github-codespaces"),
    ).toHaveLength(2);
  });

  test.each([
    ["credential", "success"],
    ["credential", "error"],
    ["capability", "success"],
    ["capability", "error"],
  ] as const)(
    "same-owner %s renewal revalidates retained data and ignores a late old %s without losing the draft",
    async (change, late) => {
      act(() => observeReadSession("discovery-owner", "initial-session"));
      let current = management;
      jest.mocked(apiClient.getCodespaces).mockImplementation(async () => current);
      let resolve!: (value: CodespaceManagementView) => void;
      let reject!: (error: Error) => void;
      jest.mocked(apiClient.refreshCodespaces).mockImplementationOnce(
        () =>
          new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      renderSettings(<GitHubCodespaceManagement />);
      await screen.findByTestId(`github-codespace-${CODESPACE_ID}`);
      const draft = await screen.findByTestId("github-codespace-ref");
      fireEvent.change(draft, { target: { value: "feature/unsaved" } });
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      current = {
        ...management,
        codespaces: [{ ...management.codespaces[0], current_ref: "feature/current-scope" }],
      };
      act(() =>
        change === "credential"
          ? observeReadSession("discovery-owner", "renewed-session")
          : observeReadCapabilities(`renewed-${late}`, "discovery-regression"),
      );
      await waitFor(() =>
        expect(
          jest
            .mocked(apiClient.getCodespaces)
            .mock.calls.filter(([provider]) => provider === "github-codespaces"),
        ).toHaveLength(2),
      );
      await waitFor(() =>
        expect(screen.getByTestId(`github-codespace-${CODESPACE_ID}`)).toHaveTextContent(
          "feature/current-scope",
        ),
      );
      await act(async () =>
        late === "error" ? reject(new Error("Retired read failed")) : resolve(management),
      );
      expect(screen.getByTestId(`github-codespace-${CODESPACE_ID}`)).toHaveTextContent(
        "feature/current-scope",
      );
      expect(screen.queryByText("Failed to load cloud codespaces")).toBeNull();
      expect(screen.getByTestId("github-codespace-ref")).toBe(draft);
      expect(draft).toHaveValue("feature/unsaved");
    },
  );

  test("an explicitly selected registered offline controller and branch survive a diagnostics visit", async () => {
    const secondDevice = "99999999-9999-4999-8999-999999999999";
    const secondController = {
      deviceId: secondDevice,
      connectionId: "22222222-2222-4222-8222-222222222222",
    };
    const secondTarget = encodeReference("target", {
      provider: "github-codespaces",
      repositoryId: "301",
      controller: secondController,
    });
    const current: CodespaceManagementView = {
      ...management,
      controllers: [
        ...management.controllers,
        {
          device_id: secondDevice,
          label: "Second offline controller",
          available: false,
          controller: encodeReference("controller", secondController),
        },
      ],
      repositories: [
        ...management.repositories,
        {
          ...management.repositories[0],
          device_id: secondDevice,
          target: secondTarget,
          controller: encodeReference("controller", secondController),
        },
      ],
    };
    jest.mocked(apiClient.getCodespaces).mockResolvedValue(current);
    const create = jest
      .spyOn(apiClient, "createWorkspace")
      .mockResolvedValue({ operation, state: "pending" });
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = () => undefined;
    try {
      renderSettings(<GitHubCodespaceManagement />);
      const selected = await screen.findByRole("combobox", {
        name: i18n.t("localDevices.provisioning.controller"),
      });
      fireEvent.keyDown(selected, { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("option", { name: "Second offline controller" }));
      const draft = await screen.findByTestId("github-codespace-ref");
      fireEvent.change(draft, { target: { value: "feature/retained" } });
      fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Diagnostics" })).toHaveAttribute(
          "aria-pressed",
          "true",
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Current environments" }));
      await waitFor(() =>
        expect(screen.getByTestId("github-codespace-ref")).toHaveValue("feature/retained"),
      );
      expect(
        screen.getByRole("combobox", { name: i18n.t("localDevices.provisioning.controller") }),
      ).toHaveTextContent("Second offline controller");
      fireEvent.click(screen.getByTestId("github-codespace-create-submit"));
      await waitFor(() =>
        expect(create).toHaveBeenCalledWith({ target: secondTarget, branch: "feature/retained" }),
      );
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });

  test.each(["github-codespaces", "local-sandboxes"] as const)(
    "%s can remain pending without delaying its independent peer or reading hidden billing",
    async (heldProvider) => {
      const localId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const local = {
        ...management,
        readiness: { ...management.readiness, provider: "local-sandboxes" },
        repositories: [],
        codespaces: [
          {
            ...management.codespaces[0],
            codespace_id: localId,
            provider: "local-sandboxes",
            repository_id: `local:${DEVICE_ID}:44444444-4444-4444-8444-444444444444`,
          },
        ],
      };
      const held = new Promise<CodespaceManagementView>(() => undefined);
      jest
        .mocked(apiClient.getCodespaces)
        .mockImplementation(async (provider) =>
          provider === heldProvider ? held : provider === "local-sandboxes" ? local : management,
        );
      const billing = jest
        .spyOn(apiClient, "getCodespaceBilling")
        .mockImplementation(() => new Promise(() => undefined));
      renderSettings(
        <>
          <GitHubCodespaceManagement />
          <CodespaceManagement
            scope={{
              provider: "local-sandboxes",
              computer: {
                deviceId: DEVICE_ID,
                status: "active",
                owner: {
                  state: "available",
                  local: { state: "configured", policy: { enabled: true } },
                  github: { resources: [] },
                },
              } as LocalDeviceView,
            }}
          />
          <CodespaceBillingFromData active={false} />
        </>,
      );
      const visibleId = heldProvider === "github-codespaces" ? localId : CODESPACE_ID;
      expect(await screen.findByTestId(`github-codespace-${visibleId}`)).toBeInTheDocument();
      expect(
        screen.queryByTestId(
          `github-codespace-${heldProvider === "github-codespaces" ? CODESPACE_ID : localId}`,
        ),
      ).toBeNull();
      expect(apiClient.getCodespaces).toHaveBeenCalledWith("local-sandboxes", "actionable");
      expect(apiClient.getCodespaces).toHaveBeenCalledWith("github-codespaces", "actionable");
      expect(billing).not.toHaveBeenCalled();
    },
  );

  test("diagnostics and history remain explicit, collect only returned originals and refresh their selected view", async () => {
    const unavailableId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const diagnostic: CodespaceManagementView = {
      ...management,
      codespaces: [],
      unavailable: [
        {
          codespace_id: unavailableId,
          provider: "github-codespaces",
          repository_id: "301",
          repository: "owner/uncertain",
          requested_ref: "main",
          created_at: 1,
          identity: encodeReference("workspace-identity", {
            resourceId: unavailableId,
            provider: "github-codespaces",
          }),
          pending_operations: [operation],
          error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" },
        },
      ],
    };
    const history: CodespaceManagementView = {
      ...management,
      codespaces: [{ ...management.codespaces[0], state: "deleted" }],
    };
    let resolveDiagnostics!: (value: CodespaceManagementView) => void;
    const delayedDiagnostics = new Promise<CodespaceManagementView>((resolve) => {
      resolveDiagnostics = resolve;
    });
    jest
      .mocked(apiClient.getCodespaces)
      .mockImplementation(async (_provider, view) =>
        view === "diagnostics"
          ? delayedDiagnostics
          : view === "history"
            ? history
            : { ...management, has_diagnostics: true },
      );
    jest.mocked(apiClient.refreshCodespaces).mockResolvedValue(diagnostic);
    const collect = jest
      .spyOn(apiClient, "getWorkspaceOperation")
      .mockResolvedValue({ operation, state: "unconfirmed" });
    const change = jest.spyOn(apiClient, "changeWorkspace");
    renderSettings(<GitHubCodespaceManagement />);
    await screen.findByTestId(`github-codespace-${CODESPACE_ID}`);
    expect(screen.queryByTestId(`codespace-unavailable-${unavailableId}`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const archived = await screen.findByTestId(`github-codespace-${CODESPACE_ID}`);
    expect(within(archived).queryByRole("button", { name: "Start" })).toBeNull();
    expect(within(archived).queryByRole("button", { name: "Delete" })).toBeNull();
    await act(async () => resolveDiagnostics(diagnostic));
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId(`codespace-unavailable-${unavailableId}`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    const row = await screen.findByTestId(`codespace-unavailable-${unavailableId}`);
    expect(within(row).queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Check original result" }));
    await waitFor(() => expect(collect).toHaveBeenCalledWith(operation));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(apiClient.refreshCodespaces).toHaveBeenCalledWith("github-codespaces", "diagnostics"),
    );
    expect(change).not.toHaveBeenCalled();
    expect(within(row).getByRole("button", { name: "Check original result" })).toBeEnabled();
  });

  test.each([
    ["unconfigured", true],
    ["enrollment_unavailable", true],
    ["connecting", false],
    ["unavailable", false],
    ["refused", false],
  ] as const)(
    "GitHub remote %s offers explicit original setup resume=%s without starting another environment",
    async (state, resumable) => {
      const current: CodespaceManagementView = {
        ...management,
        codespaces: [
          {
            ...management.codespaces[0],
            state: "start_pending",
            lifecycle_error: resumable ? "CODESPACE_LOCAL_SETUP_INCOMPLETE" : null,
            remote: { state },
          },
        ],
      };
      jest.mocked(apiClient.getCodespaces).mockResolvedValue(current);
      jest.mocked(apiClient.refreshCodespaces).mockResolvedValue(current);
      const change = jest
        .spyOn(apiClient, "changeWorkspace")
        .mockResolvedValue({ operation, state: "pending" });
      const adopt = jest.spyOn(apiClient, "adoptWorkspace");
      renderSettings(<GitHubCodespaceManagement />);
      expect(await screen.findByTestId(`codespace-remote-${CODESPACE_ID}`)).toHaveTextContent(
        i18n.t(`localDevices.codespaces.remote.${state}`),
      );
      const resume = screen.queryByTestId(`codespace-resume-setup-${CODESPACE_ID}`);
      if (resumable) {
        expect(resume).toBeEnabled();
        await act(async () => fireEvent.click(resume!));
        expect(change).toHaveBeenCalledWith(management.codespaces[0].workspace, "resume_setup");
        expect(change).toHaveBeenCalledTimes(1);
        expect(resume).toBeDisabled();
        expect(screen.getByTestId(`workspace-original-${CODESPACE_ID}`)).toBeInTheDocument();
      } else {
        expect(resume).toBeNull();
        expect(change).not.toHaveBeenCalled();
      }
      expect(adopt).not.toHaveBeenCalled();
    },
  );
  test.each([
    ["admission", "completed", "LOCAL_CONTROL_PENDING"],
    ["collection", "completed", "LOCAL_CONTROL_PENDING"],
    ["admission", "unconfirmed", "LOCAL_CUSTODY_UNCONFIRMED"],
    ["collection", "unconfirmed", "LOCAL_CUSTODY_UNCONFIRMED"],
  ] as const)(
    "authoritative %s state %s with %s controls retained browser uncertainty",
    async (stage, state, code) => {
      const receipt = {
        operation,
        state,
        outcome: { ok: false as const, error: { code, message: "Original outcome" } },
      };
      jest
        .spyOn(apiClient, "changeWorkspace")
        .mockResolvedValue(stage === "admission" ? receipt : { operation, state: "pending" });
      jest.spyOn(apiClient, "getWorkspaceOperation").mockResolvedValue(receipt);
      jest.mocked(apiClient.refreshCodespaces).mockResolvedValue(management);
      renderSettings(<GitHubCodespaceManagement />);
      const stop = await screen.findByTestId(`github-codespace-stop-${CODESPACE_ID}`);
      await act(async () => fireEvent.click(stop));
      if (stage === "collection") {
        const retained = await screen.findByTestId(`workspace-original-${CODESPACE_ID}`);
        await act(async () =>
          fireEvent.click(within(retained).getByRole("button", { name: "Check original result" })),
        );
        expect(apiClient.getWorkspaceOperation).toHaveBeenCalledWith(operation);
      }
      if (state === "completed") {
        await waitFor(() => expect(stop).toBeEnabled());
        expect(screen.queryByTestId(`workspace-original-${CODESPACE_ID}`)).toBeNull();
      } else {
        expect(stop).toBeDisabled();
        expect(screen.getByTestId(`workspace-original-${CODESPACE_ID}`)).toBeInTheDocument();
      }
      expect(apiClient.changeWorkspace).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["start", "stop", "resume_setup", "delete", "adopt"] as const)(
    "lost completed %s discovers its actual controller descriptor and collects without another effect",
    async (action) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "moira-browser-original-")));
      try {
        const identity = {
          userId: "owner",
          deviceId: DEVICE_ID,
          deviceGeneration: 1,
          connectionId: "22222222-2222-4222-8222-222222222222",
        };
        const requestId = "ws1-33333333-3333-4333-8333-333333333333";
        // Execute the host journal under its actual Node target, outside the browser compiler.
        const owner = async (method: "run" | "find" | "inspect", input: unknown = {}) => {
          const { stdout } = await promisify(execFile)(process.execPath, [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `
              import { appendFile } from 'node:fs/promises';
              import { join, resolve } from 'node:path';
              import { pathToFileURL } from 'node:url';
              const load = path => import(pathToFileURL(resolve(path)).href);
              const { ControllerState } = await load('packages/local/src/controller-state.ts');
              const { PrivateState } = await load('packages/local/src/private-state.ts');
              const { LocalRecords } = await load('packages/local/src/space-record.ts');
              const { directory, identity, requestId, method, input } = JSON.parse(process.argv[1]);
              const state = new ControllerState(new LocalRecords(await PrivateState.open(directory)));
              const result = method === 'run'
                ? await state.run(requestId, identity, input, async () => {
                    await appendFile(join(directory, 'effect'), input.action + '\\n');
                    return { applied: true };
                  })
                : method === 'find' ? await state.find(identity, input)
                : await state.inspect(requestId, identity);
              process.stdout.write(JSON.stringify(result));
            `,
            JSON.stringify({ directory, identity, requestId, method, input }),
          ]);
          return JSON.parse(stdout) as unknown;
        };
        const local = action === "resume_setup";
        const workspace = {
          ...management.codespaces[0],
          ...(local
            ? {
                provider: "local-sandboxes",
                repository_id: `local:${DEVICE_ID}:44444444-4444-4444-8444-444444444444`,
                lifecycle_error: "CODESPACE_LOCAL_SETUP_INCOMPLETE",
              }
            : {}),
          ...(action === "start" || action === "adopt" || local
            ? { state: "stopped" as const, desired_state: "stopped" as const }
            : {}),
        };
        const current = { ...management, codespaces: [workspace] };
        jest.mocked(apiClient.getCodespaces).mockResolvedValue(current);
        jest.mocked(apiClient.refreshCodespaces).mockResolvedValue(current);
        const loseReply = async () => {
          await owner("run", { action, resourceId: CODESPACE_ID, generation: 1 });
          throw new Error("Completed first reply lost");
        };
        const effect =
          action === "delete"
            ? jest.spyOn(apiClient, "deleteWorkspace").mockImplementation(loseReply)
            : action === "adopt"
              ? jest.spyOn(apiClient, "adoptWorkspace").mockImplementation(loseReply)
              : jest.spyOn(apiClient, "changeWorkspace").mockImplementation(loseReply);
        const find = jest
          .spyOn(apiClient, "findWorkspaceOperations")
          .mockImplementation(async (_owner, query, cursor) => {
            const found = controllerOperationFindResultSchema.parse(
              await owner("find", { query, cursor }),
            );
            if (!found.operations) throw new Error("Owner discovery omitted its results");
            return {
              operations: found.operations.map((row) => {
                if (!row.requestId || !row.state) throw new Error("Invalid original operation");
                let descriptor: WorkspaceOperationView["descriptor"];
                if (row.descriptor) {
                  const { kind, description, createdAt } = row.descriptor;
                  if (!kind) throw new Error("Original descriptor omitted its kind");
                  descriptor = { kind, description, createdAt };
                }
                return {
                  operation: encodeReference("operation", {
                    owner: {
                      kind: "controller",
                      deviceId: DEVICE_ID,
                      connectionId: identity.connectionId,
                    },
                    requestId: row.requestId,
                    kind: "lifecycle",
                  }),
                  state: row.state,
                  descriptor,
                };
              }),
              ...(found.nextCursor ? { nextCursor: found.nextCursor } : {}),
            };
          });
        const collect = jest
          .spyOn(apiClient, "getWorkspaceOperation")
          .mockImplementation(async (reference) => {
            const original = controllerOperationSchema.parse(await owner("inspect"));
            if (original.state !== "completed" || original.outcome?.ok !== true)
              throw new Error("Original successful effect is not retained");
            return {
              state: original.state,
              outcome: { ok: true, result: original.outcome.result },
              operation: reference,
            };
          });
        renderSettings(
          local ? (
            <CodespaceManagement
              scope={{
                provider: "local-sandboxes",
                computer: {
                  deviceId: DEVICE_ID,
                  status: "active",
                  owner: {
                    state: "available",
                    local: { state: "configured", policy: { enabled: true } },
                    github: { resources: [] },
                  },
                } as LocalDeviceView,
              }}
            />
          ) : (
            <GitHubCodespaceManagement />
          ),
        );
        await screen.findByTestId(`github-codespace-${CODESPACE_ID}`);
        if (action === "delete") {
          fireEvent.click(screen.getByTestId(`github-codespace-delete-${CODESPACE_ID}`));
          const dialog = await screen.findByRole("alertdialog");
          await act(async () =>
            fireEvent.click(within(dialog).getByRole("button", { name: "Delete" })),
          );
          const cancel = within(dialog).getByRole("button", { name: "Cancel" });
          await waitFor(() => expect(cancel).toBeEnabled());
          fireEvent.click(cancel);
          await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        } else if (action === "adopt") {
          const adopt = within(screen.getByTestId(`github-codespace-${CODESPACE_ID}`)).getByRole(
            "button",
            {
              name: i18n.t("localDevices.provisioning.adopt"),
            },
          );
          await waitFor(() => expect(adopt).toBeEnabled());
          await act(async () => fireEvent.click(adopt));
        } else {
          await act(async () =>
            fireEvent.click(
              screen.getByTestId(
                action === "resume_setup"
                  ? `codespace-resume-setup-${CODESPACE_ID}`
                  : `github-codespace-${action}-${CODESPACE_ID}`,
              ),
            ),
          );
        }
        const retained = await screen.findByTestId(`workspace-original-${CODESPACE_ID}`);
        await waitFor(() => expect(effect).toHaveBeenCalledTimes(1));
        await expect(effect.mock.results[0].value).rejects.toThrow("Completed first reply lost");
        const actual = controllerOperationFindResultSchema.parse(await owner("find"))
          .operations?.[0];
        if (!actual?.descriptor) throw new Error("Owner omitted the actual lifecycle descriptor");
        expect(actual.descriptor?.description).not.toContain(workspace.repository);
        expect(actual.state).toBe("completed");
        fireEvent.click(within(retained).getByRole("button", { name: "Find original operation" }));
        const candidate = await within(retained).findByRole("button", {
          name: `Inspect: ${actual.descriptor.description}`,
        });
        expect(find).toHaveBeenCalledWith(controller, undefined, undefined);
        expect(collect).not.toHaveBeenCalled();
        expect(effect).toHaveBeenCalledTimes(1);
        await act(async () => fireEvent.click(candidate));
        await waitFor(() =>
          expect(screen.queryByTestId(`workspace-original-${CODESPACE_ID}`)).toBeNull(),
        );
        expect(await readFile(join(directory, "effect"), "utf8")).toBe(`${action}\n`);
        expect(effect).toHaveBeenCalledTimes(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ["original", "invalid"],
    ["original", "mismatched"],
    ["result", "invalid"],
    ["result", "mismatched"],
  ])(
    "does not turn arbitrary operation %s with a %s workspace address into a card",
    async (field, address) => {
      const foreignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const observation = {
        ...management.codespaces[0],
        codespace_id: foreignId,
        repository: "unexpected/operation-data",
        workspace:
          address === "invalid" ? "not-a-workspace-reference" : management.codespaces[0].workspace,
      };
      const change = jest
        .spyOn(apiClient, "changeWorkspace")
        .mockResolvedValue(
          field === "original"
            ? { operation, state: "pending", original: observation }
            : { operation, state: "completed", outcome: { ok: true, result: observation } },
        );
      renderSettings(<GitHubCodespaceManagement />);
      const originalCard = await screen.findByTestId(`github-codespace-${CODESPACE_ID}`);
      await act(async () => {
        fireEvent.click(screen.getByTestId(`github-codespace-stop-${CODESPACE_ID}`));
      });
      expect(change).toHaveBeenCalledWith(management.codespaces[0].workspace, "stop");
      expect(
        jest
          .mocked(apiClient.getCodespaces)
          .mock.calls.filter(([provider]) => provider === "github-codespaces"),
      ).toHaveLength(1);
      expect(screen.queryByTestId(`github-codespace-${foreignId}`)).toBeNull();
      expect(screen.getByTestId(`github-codespace-${CODESPACE_ID}`)).toBe(originalCard);
    },
  );
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
            identity: encodeReference("workspace-identity", {
              resourceId: unavailableId,
              provider: "local-sandboxes",
              deviceId: computerId,
            }),
            pending_operations: [],
            repository_id: local.repository_id,
            repository: "owner/unobserved",
            requested_ref: "feature/original",
            device_id: computerId,
            created_at: 1,
            error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" },
          },
        ],
      };
      jest.mocked(apiClient.getCodespaces).mockResolvedValue(next);
      jest.mocked(apiClient.refreshCodespaces).mockResolvedValue({
        ...next,
        unavailable: [],
        codespaces: [
          ...(healthyPeer ? [local] : []),
          { ...local, codespace_id: unavailableId, repository: "owner/unobserved" },
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
                  policy: { enabled: true },
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
    jest.mocked(apiClient.getCodespaces).mockResolvedValue({
      ...management,
      readiness: undefined,
      connection: undefined,
      codespaces: [],
      repositories: [],
      provider_errors: [
        { provider: "github-codespaces", error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" } },
      ],
    });
    renderSettings(
      <>
        <GitHubCodespaceManagement />
      </>,
    );
    expect(await screen.findByText("Provider data could not be loaded")).toBeInTheDocument();
    expect(screen.queryByTestId("github-codespace-instance-state")).toBeNull();
    expect(screen.queryByTestId("github-codespace-empty")).toBeNull();
    expect(screen.queryByTestId("github-codespace-create")).toBeNull();
    expect(
      screen.getByText(i18n.t("common.codespaceErrors.CODESPACE_PROVIDER_UNAVAILABLE")),
    ).toBeInTheDocument();
  });
  test("an in-flight refresh that loses an observation disables an already opened delete confirmation", async () => {
    let complete!: (next: CodespaceManagementView) => void;
    jest.mocked(apiClient.refreshCodespaces).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const remove = jest.spyOn(apiClient, "deleteWorkspace");
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
            identity: encodeReference("workspace-identity", {
              resourceId: CODESPACE_ID,
              provider: "github-codespaces",
            }),
            pending_operations: [],
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
    jest.mocked(apiClient.getCodespaces).mockResolvedValue({
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
    const localTarget = (repositoryId: string, deviceId: string) =>
      encodeReference("target", {
        provider: "local-sandboxes",
        repositoryId,
        controller: { deviceId, connectionId: "22222222-2222-4222-8222-222222222222" },
      });
    const repositories = [
      {
        repository_id: first,
        name: "owner/repository",
        private: true,
        provider: "local-sandboxes",
        device_label: "First laptop",
        target: localTarget(first, DEVICE_ID),
        controller,
      },
      {
        repository_id: second,
        name: "owner/repository",
        private: true,
        provider: "local-sandboxes",
        device_label: "Second laptop",
        target: localTarget(second, "22222222-2222-4222-8222-222222222222"),
        controller: encodeReference("controller", {
          deviceId: "22222222-2222-4222-8222-222222222222",
          connectionId: "22222222-2222-4222-8222-222222222222",
        }),
      },
    ];
    const disconnected = { ...connection, state: "disconnected" as const };
    jest.mocked(apiClient.getGitHubCodespaceConnection).mockResolvedValue(disconnected);
    jest.mocked(apiClient.getCodespaces).mockResolvedValue({
      ...management,
      readiness: { ...management.readiness, provider: "local-sandboxes" },
      connection,
      repositories,
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
          data: {
            operation,
            state: "completed",
            outcome: {
              ok: true,
              result: { ...management.codespaces[0], provider: "local-sandboxes" },
            },
          },
        },
      };
    };
    const client = new MoiraApiClient();
    jest
      .spyOn(apiClient, "createWorkspace")
      .mockImplementation(client.createWorkspace.bind(client));
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
                  policy: { enabled: true },
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
            target: localTarget(second, "22222222-2222-4222-8222-222222222222"),
            branch: "feature/local",
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
    await waitFor(() => expect(apiClient.refreshCodespaces).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId(`github-codespace-${CODESPACE_ID}`)).not.toBeInTheDocument(),
    );
  });

  test.each([0, 1, 2])(
    "lost creation discovers %s originals without choosing or submitting again",
    async (count) => {
      const create = jest
        .spyOn(apiClient, "createWorkspace")
        .mockRejectedValue(new Error("First reply lost"));
      const candidate = (index: number) => ({
        operation: encodeReference("operation", {
          owner: {
            kind: "controller",
            deviceId: DEVICE_ID,
            connectionId: "22222222-2222-4222-8222-222222222222",
          },
          requestId: `ws1-33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
          kind: "lifecycle",
        }),
        state: "completed" as const,
        descriptor: {
          kind: "lifecycle",
          description: `Create candidate ${index + 1}`,
          createdAt: 1,
        },
      });
      const find = jest.spyOn(apiClient, "findWorkspaceOperations").mockResolvedValue({
        operations: Array.from({ length: count }, (_, index) => candidate(index)),
      });
      const collect = jest
        .spyOn(apiClient, "getWorkspaceOperation")
        .mockImplementation(async (reference) => ({ operation: reference, state: "absent" }));
      renderSettings(<GitHubCodespaceManagement />);
      const ref = await screen.findByTestId("github-codespace-ref");
      fireEvent.change(ref, { target: { value: "feature/original" } });
      const submit = screen.getByTestId("github-codespace-create-submit");
      fireEvent.click(submit);
      const original = await screen.findByTestId("workspace-original-create");
      expect(submit).toBeDisabled();
      fireEvent.click(within(original).getByRole("button", { name: "Find original operation" }));
      await waitFor(() =>
        expect(find).toHaveBeenCalledWith(controller, "owner/repository", undefined),
      );
      expect(collect).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      if (count) {
        fireEvent.click(
          await within(original).findByRole("button", { name: "Inspect: Create candidate 1" }),
        );
        await waitFor(() => expect(collect).toHaveBeenCalledWith(candidate(0).operation));
        expect(submit).toBeDisabled();
      } else {
        expect(
          await within(original).findByText(/This does not prove the action did not happen/),
        ).toBeInTheDocument();
      }
      expect(create).toHaveBeenCalledTimes(1);
    },
  );

  test("a connected user can open GitHub App installation for an organization", async () => {
    renderSettings(<GitHubCodespaceSettings />);
    const link = await screen.findByTestId("github-codespace-add-installation");
    expect(link).toHaveTextContent("Add account or organization");
    expect(link).toHaveAttribute("href", connection.installationUrl);
  });

  test("provider refresh failure keeps codespaces, the branch draft and focus, then retries", async () => {
    let reject!: (error: unknown) => void;
    jest.mocked(apiClient.refreshCodespaces).mockImplementationOnce(
      () =>
        new Promise((_yes, no) => {
          reject = no;
        }),
    );
    renderSettings(<GitHubCodespaceManagement />);
    const row = await screen.findByTestId(`github-codespace-${CODESPACE_ID}`);
    const branch = await screen.findByTestId("github-codespace-ref");
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
