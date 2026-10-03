/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { apiClient, ApiClientError } from "../../../packages/web-frontend/src/services/api-client";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import { retireReads } from "../../../packages/web-frontend/src/services/read-scope";
import { GuideProvider } from "../../../packages/web-frontend/src/guides/GuideContext";
import type {
  WorkflowFileInfo,
  WorkflowGraph,
} from "../../../packages/web-frontend/src/types/workflow-types";

// Layout is unrelated to the page's destructive action; retain its actual header, hooks and dialog.
jest.unstable_mockModule("@xyflow/react/dist/style.css", () => ({}));
jest.unstable_mockModule(
  "../../../packages/web-frontend/src/components/workflow/WorkflowGraph",
  () => ({ WorkflowGraph: () => null }),
);
jest.unstable_mockModule("../../../packages/web-frontend/src/components/flow/StepsView", () => ({
  StepsView: () => null,
}));
const { Workflows } = await import("../../../packages/web-frontend/src/pages/Workflows");
const { FlowPage } = await import("../../../packages/web-frontend/src/pages/FlowPage");
const { ShareDialog } =
  await import("../../../packages/web-frontend/src/components/workflow/ShareDialog");

const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
const owner = {
  user: { id: "owner", name: "Owner", email: "owner@example.test", emailVerified: true },
  session: {
    id: "owner-session",
    userId: "owner",
    token: "fixture-owner-session",
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};
const fileInfo: WorkflowFileInfo = {
  id: "owned-flow",
  slug: "owned-flow",
  ownerHandle: "owner",
  ownerName: "Owner",
  visibility: "private",
  accessType: "owner",
  filePath: "",
  metadata: { name: "Retained flow", description: "A selected deletion target", version: "1.0.0" },
  validation: { isValid: true, errors: [], warnings: [], status: "valid" },
  lastModified: 0,
  revision: 1,
  fileSize: 100,
};
const workflow: WorkflowGraph = {
  id: fileInfo.id,
  metadata: fileInfo.metadata,
  nodes: [
    { id: "start", type: "start", connections: { default: "done" } },
    { id: "done", type: "end" },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function sessionResponse(value: typeof owner | null) {
  globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
    if (String(input).includes("/get-session")) return Response.json(value);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  await authClient.$store.atoms.session.get().refetch();
  await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
}
beforeEach(async () => {
  globalThis.React = React;
  retireReads();
  localStorage.clear();
  await sessionResponse(owner);
  await i18n.changeLanguage("en");
  jest
    .spyOn(apiClient, "getUserSettings")
    .mockResolvedValue({ "ui.hidden_panels": ["workflows-recommended"] });
  jest.spyOn(apiClient, "getUserInfo").mockResolvedValue({
    id: "owner",
    email: owner.user.email,
    handle: "owner",
    isAdmin: false,
    passwordResetRequired: false,
    blocked: false,
    emailVerified: true,
    approvedAt: null,
    accountApproved: true,
    accountApprovalRequired: false,
  });
  jest
    .spyOn(apiClient, "getNodeTypes")
    .mockResolvedValue({ nodeTypes: [], extensionsAvailable: false });
  jest.spyOn(apiClient, "healthCheck").mockResolvedValue({
    status: "ok",
    services: {
      fileSystem: true,
      validation: true,
      mcpEngine: true,
      workflowReconciliation: true,
      codespaces: true,
    },
    reconciliation: { status: "ok", code: "READY", conflicts: [] },
    uptime: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    version: "fixture",
  });
});
afterEach(async () => {
  cleanup();
  await sessionResponse(null);
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
});
function mount(children: React.ReactNode, initial = "/workflows") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <I18nextProvider i18n={i18n}>
        <GuideProvider>{children}</GuideProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );
}

test.each(["list", "detail"] as const)(
  "%s workflow deletion keeps the selected confirmation and accessible refusal until a successful retry",
  async (page) => {
    let removed = false;
    const retry = deferred<void>();
    const remove = jest.spyOn(apiClient, "deleteWorkflow").mockImplementation(async (id) => {
      expect(id).toBe(fileInfo.id);
      if (remove.mock.calls.length === 1) throw new ApiClientError("Workflow deletion refused");
      await retry.promise;
      removed = true;
    });
    jest.spyOn(apiClient, "getWorkflows").mockImplementation(async (query) => ({
      workflows: removed || query?.slugs ? [] : [fileInfo],
      totalWorkflows: removed || query?.slugs ? 0 : 1,
      validWorkflows: 1,
      invalidWorkflows: 0,
      lastScan: 0,
    }));
    jest.spyOn(apiClient, "getWorkflow").mockResolvedValue({
      workflow,
      fileInfo,
      validation: {
        isValid: true,
        nodeValidation: {},
        globalErrors: [],
        globalWarnings: [],
        issues: [],
      },
    });
    jest
      .spyOn(apiClient, "getWorkflowProcess")
      .mockResolvedValue({ workflowId: fileInfo.id, version: "1.0.0", process: null });
    jest.spyOn(apiClient, "getWorkflowStatistics").mockResolvedValue(null);
    if (page === "list") {
      mount(<Workflows />);
      fireEvent.click(await screen.findByTestId("workflow-card-delete"));
    } else {
      mount(
        <Routes>
          <Route path="/workflows/:id" element={<FlowPage />} />
          <Route path="/workflows" element={<p>Returned to workflows</p>} />
        </Routes>,
        `/workflows/${fileInfo.id}?view=steps`,
      );
      await screen.findByTestId("flow-title");
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("pages.workflowDetail.deleteWorkflow") }),
      );
    }
    const dialog = screen.getByRole("alertdialog");
    await act(async () =>
      fireEvent.click(within(dialog).getByRole("button", { name: i18n.t("common.delete") })),
    );
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Workflow deletion refused");
    expect(removed).toBe(false);
    if (page === "list") expect(dialog).toHaveTextContent(fileInfo.metadata.name);
    else expect(screen.getByTestId("flow-title")).toHaveTextContent(fileInfo.metadata.name);
    fireEvent.click(within(dialog).getByRole("button", { name: i18n.t("common.delete") }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: i18n.t("common.delete") })).toBeDisabled(),
    );
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    await act(async () => retry.resolve());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(removed).toBe(true);
    if (page === "list")
      await waitFor(() => expect(screen.queryByTestId("workflow-card-delete")).toBeNull());
    else expect(screen.getByText("Returned to workflows")).toBeInTheDocument();
  },
);

test.each(["invite", "access"] as const)(
  "revoking %s retains the chosen row and accessible confirmation error, then completes revocation on retry",
  async (kind) => {
    const retry = deferred<{ revoked: boolean }>();
    const remove =
      kind === "invite"
        ? jest.spyOn(apiClient, "revokeInvite")
        : jest.spyOn(apiClient, "revokeAccess");
    remove
      .mockRejectedValueOnce(new ApiClientError("Sharing revocation refused"))
      .mockImplementation(async (flowId, targetId) => {
        expect([flowId, targetId]).toEqual([fileInfo.id, `selected-${kind}`]);
        return retry.promise;
      });
    jest.spyOn(apiClient, "listInvites").mockResolvedValue({
      invites: [
        {
          id: "selected-invite",
          token: "fixture-invite-token",
          createdAt: 1,
          expiresAt: 2000000000000,
          remainingMs: 60000,
          usedAt: null,
          usedBy: null,
          usedByHandle: null,
        },
      ],
      total: 1,
      hasMore: false,
    });
    jest.spyOn(apiClient, "listAccess").mockResolvedValue({
      users: [
        {
          userId: "selected-access",
          handle: "reader",
          name: "Retained reader",
          grantedAt: 1,
          grantedBy: "owner",
          grantedByHandle: "owner",
        },
      ],
      total: 1,
      hasMore: false,
    });
    mount(<ShareDialog open onClose={() => {}} workflowId={fileInfo.id} />);
    await screen.findByTestId("invite-item");
    if (kind === "access")
      fireEvent.mouseDown(
        screen.getByRole("tab", {
          name: new RegExp(i18n.t("pages.workflowDetail.sharing.tabs.access")),
        }),
        { button: 0, ctrlKey: false },
      );
    const row = await screen.findByTestId(`${kind}-item`);
    fireEvent.click(screen.getByTestId(`revoke-${kind}-button`));
    const dialog = screen.getByRole("alertdialog");
    await act(async () =>
      fireEvent.click(within(dialog).getByRole("button", { name: i18n.t("common.delete") })),
    );
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Sharing revocation refused");
    expect(row).toBeInTheDocument();
    if (kind === "access") expect(dialog).toHaveTextContent("Retained reader");
    fireEvent.click(within(dialog).getByRole("button", { name: i18n.t("common.delete") }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: i18n.t("common.delete") })).toBeDisabled(),
    );
    await act(async () => retry.resolve({ revoked: true }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(row).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  },
);
