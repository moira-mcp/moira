/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import axios from "axios";
import { toast } from "sonner";
import { apiClient, MoiraApiClient } from "../../../packages/web-frontend/src/services/api-client";
import { UserManagement } from "../../../packages/web-frontend/src/pages/UserManagement";
import { AdminExecutions } from "../../../packages/web-frontend/src/pages/AdminExecutions";
import { AdminWorkflows } from "../../../packages/web-frontend/src/pages/AdminWorkflows";
import { AdminTokens } from "../../../packages/web-frontend/src/pages/AdminTokens";
import { AuditLog } from "../../../packages/web-frontend/src/pages/AuditLog";
import { Notes } from "../../../packages/web-frontend/src/pages/Notes";
import { Artifacts } from "../../../packages/web-frontend/src/pages/Artifacts";
import { Playbooks } from "../../../packages/web-frontend/src/pages/Playbooks";
import { Executions } from "../../../packages/web-frontend/src/pages/Executions";
import { GuideProvider } from "../../../packages/web-frontend/src/guides/GuideContext";
import { FeaturesProvider } from "../../../packages/web-frontend/src/hooks/useFeatures";
import {
  observeReadSession,
  retireReads,
  suspendReadSession,
} from "../../../packages/web-frontend/src/services/read-scope";

const originalReact = globalThis.React;
beforeEach(async () => {
  globalThis.React = React;
  retireReads();
  observeReadSession("reader", "reader-session");
  await i18n.changeLanguage("en");
  jest.spyOn(apiClient, "getUserSettings").mockResolvedValue({});
  jest
    .spyOn(apiClient, "getFeatures")
    .mockResolvedValue({ deploymentMode: "self-host", features: {} } as never);
  jest
    .spyOn(apiClient, "getAdminUserChoices")
    .mockResolvedValue({ users: [], total: 0, limit: 100, offset: 0 });
  jest
    .spyOn(apiClient, "getAuditActions")
    .mockResolvedValue({ actions: [], grouped: {}, totalCount: 0 });
  jest
    .spyOn(apiClient, "getWorkflows")
    .mockResolvedValue({ workflows: [], totalWorkflows: 0 } as never);
  jest.spyOn(apiClient, "getExecutions").mockResolvedValue({ executions: [], total: 0 } as never);
  jest
    .spyOn(apiClient, "getAdminExecutions")
    .mockResolvedValue({ executions: [], total: 0 } as never);
  jest
    .spyOn(apiClient, "getNoteStats")
    .mockResolvedValue({ totalNotes: 0, totalSize: 0, limit: 100, usedPercent: 0 });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  globalThis.React = originalReact;
});

function show(Page: React.ComponentType) {
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <FeaturesProvider>
          <GuideProvider>
            <Page />
          </GuideProvider>
        </FeaturesProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test.each(["note", "artifact", "playbook"] as const)(
  "a refused %s deletion keeps its target and accessible modal error until a successful retry",
  async (kind) => {
    const target = `refused-${kind}`;
    const retry = deferred<void>();
    let deleted = false;
    const remove = jest.fn(async () => {
      if (remove.mock.calls.length === 1) throw new Error("Deletion refused by source");
      await retry.promise;
      deleted = true;
    });
    let Page: React.ComponentType;
    if (kind === "note") {
      Page = Notes;
      jest.spyOn(apiClient, "getNotes").mockImplementation(async () => ({
        notes: deleted
          ? []
          : [
              {
                id: target,
                key: target,
                tags: [],
                size: 4,
                currentVersion: 1,
                preview: "Retained note",
                createdAt: 1,
                updatedAt: 1,
              },
            ],
        allTags: [],
        total: deleted ? 0 : 1,
      }));
      jest.spyOn(apiClient, "deleteNote").mockImplementation(async (key) => {
        expect(key).toBe(target);
        await remove();
        return { key, deleted: true };
      });
    } else if (kind === "artifact") {
      Page = Artifacts;
      jest.spyOn(apiClient, "getArtifactStats").mockResolvedValue({
        totalArtifacts: 1,
        totalSize: 4,
        storageLimit: 100,
        countLimit: 10,
        storageUsedPercent: 4,
        countUsedPercent: 10,
      });
      jest.spyOn(apiClient, "getArtifacts").mockImplementation(async () => ({
        artifacts: deleted
          ? []
          : [
              {
                uuid: target,
                name: target,
                url: "https://example.test/artifact",
                mimeType: "text/html",
                size: 4,
                executionId: null,
                createdAt: "2026-01-01",
                updatedAt: "2026-01-01",
                expiresAt: "2099-01-01",
              },
            ],
        total: deleted ? 0 : 1,
      }));
      jest.spyOn(apiClient, "deleteArtifact").mockImplementation(async (uuid) => {
        expect(uuid).toBe(target);
        await remove();
        return { uuid, deleted: true };
      });
    } else {
      Page = Playbooks;
      jest.spyOn(apiClient, "getPlaybooks").mockImplementation(
        async () =>
          ({
            playbooks: deleted
              ? []
              : [
                  {
                    id: target,
                    slug: target,
                    name: target,
                    description: "Retained playbook",
                    visibility: "private",
                    revision: 1,
                    size: 4,
                    preview: "body",
                    createdAt: 1,
                    updatedAt: 1,
                    ownerId: "reader",
                  },
                ],
            total: deleted ? 0 : 1,
          }) as never,
      );
      jest.spyOn(apiClient, "deletePlaybook").mockImplementation(async (slug) => {
        expect(slug).toBe(target);
        await remove();
      });
    }
    const deleteTestId = kind === "artifact" ? `delete-${target}` : `delete-${kind}-${target}`;
    show(Page);
    await screen.findByTestId(deleteTestId);
    fireEvent.click(screen.getByTestId(deleteTestId));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(target);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Deletion refused by source",
    );
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent(target);
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
    expect(dialog).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    await act(async () => retry.resolve());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByTestId(deleteTestId)).toBeNull();
  },
);

test.each([
  {
    Page: UserManagement,
    method: "getAdminUsers",
    result: { users: [], total: 0 },
    search: "Search by email or name...",
    empty: "No users found",
  },
  {
    Page: AdminWorkflows,
    method: "getAdminWorkflows",
    result: { workflows: [], total: 0 },
    search: "Search by name or description...",
    empty: "No workflows found",
  },
  {
    Page: AdminTokens,
    method: "getAdminTokens",
    result: { tokens: [], total: 0 },
    search: "Search by token name or user email",
    empty: "No API tokens found",
  },
  {
    Page: AuditLog,
    method: "getAuditLogs",
    result: { entries: [], total: 0 },
    search: "e.g. workflow, user",
    empty: "No audit log entries found",
  },
  {
    Page: Notes,
    method: "getNotes",
    result: { notes: [], allTags: [], total: 0 },
    search: "Search by key name...",
    empty: "No notes yet. Create your first note to get started!",
  },
  {
    Page: Playbooks,
    method: "getPlaybooks",
    result: { playbooks: [], total: 0 },
    search: "Search playbooks...",
    empty: "No playbooks yet",
  },
] as const)(
  "$method preserves an accepted empty result, focused controls and old scope on error",
  async ({ Page, method, result, search, empty }) => {
    const first = deferred<typeof result>();
    const next = deferred<typeof result>();
    const read = jest
      .spyOn(apiClient, method)
      .mockImplementationOnce(() => first.promise as never)
      .mockImplementationOnce(() => next.promise as never)
      .mockResolvedValue(result as never);
    show(Page);
    const input = screen.getByPlaceholderText(search);
    expect(screen.queryByText(empty)).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    await act(async () => first.resolve(result));
    expect(await screen.findByText(empty)).toBeInTheDocument();
    input.focus();
    fireEvent.change(input, { target: { value: "new requested query" } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByPlaceholderText(search)).toBe(input);
    expect(input).toHaveFocus();
    expect(screen.getByText(empty)).toBeInTheDocument();
    expect(screen.queryByText("Search: new requested query")).toBeNull();
    await act(async () => next.reject(new Error("source unavailable")));
    expect(await screen.findByText("source unavailable")).toBeInTheDocument();
    expect(screen.getByText(empty)).toBeInTheDocument();
    expect(input).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    expect(
      await screen.findByText(
        method === "getAuditLogs" ? /Resource: new requested query/ : /Search: new requested query/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(search)).toBe(input);
  },
);

test.each([AdminExecutions, Executions])(
  "execution list controls and accepted empty result survive explicit refresh failure",
  async (Page) => {
    const next = deferred<Awaited<ReturnType<typeof apiClient.getExecutions>>>();
    const method = Page === AdminExecutions ? "getAdminExecutions" : "getExecutions";
    const read = jest
      .spyOn(apiClient, method)
      .mockImplementation((query) =>
        query?.status === "locked" ||
        (Array.isArray(query?.status) && query.status.includes("locked"))
          ? Promise.resolve({ executions: [], total: 0 } as never)
          : read.mock.calls.filter(([request]) => request?.status === undefined).length === 1
            ? Promise.resolve({ executions: [], total: 0 } as never)
            : (next.promise as never),
      );
    show(Page);
    const empty = Page === AdminExecutions ? "No executions found" : "No executions yet";
    await screen.findByText(empty);
    const input = screen.getByPlaceholderText(
      Page === AdminExecutions ? "Execution or workflow ID" : "Search by note...",
    );
    input.focus();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByText(empty)).toBeInTheDocument();
    expect(input).toHaveFocus();
    await act(async () => next.reject(new Error("source unavailable")));
    expect(await screen.findByText("source unavailable")).toBeInTheDocument();
    expect(screen.getByText(empty)).toBeInTheDocument();
  },
);

test("nonempty users keep their accepted page/count and an open editor across a failed new page", async () => {
  const user = {
    id: "existing-user",
    email: "existing@example.test",
    name: "Existing user",
    handle: "existing",
    isAdmin: false,
    emailVerified: true,
    blockedAt: null,
    approvedAt: 1,
    createdAt: "2026-09-01",
    workflowCount: 3,
    executionCount: 1,
    lastStepAt: null,
  };
  const next = deferred<Awaited<ReturnType<typeof apiClient.getAdminUsers>>>();
  const read = jest
    .spyOn(apiClient, "getAdminUsers")
    .mockResolvedValueOnce({ users: [user], total: 40 } as never)
    .mockImplementationOnce(() => next.promise)
    .mockResolvedValue({ users: [], total: 40 } as never);
  show(UserManagement);
  const row = await screen.findByText("existing@example.test");
  fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(row).toBeInTheDocument();
  expect(screen.getByTestId("data-list-pagination")).toHaveTextContent("1 / 2");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const dialog = screen.getByRole("dialog");
  const draft = within(dialog).getByLabelText("Name");
  fireEvent.change(draft, { target: { value: "Unfinished name" } });
  draft.focus();
  await act(async () => next.reject(new Error("source unavailable")));
  expect(row).toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  expect(draft).toHaveValue("Unfinished name");
  expect(draft).toHaveFocus();
  expect(screen.getByTestId("data-list-pagination")).toHaveTextContent("1 / 2");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No users found");
  expect(screen.getByRole("button", { name: "Go to previous page" })).toBeEnabled();
  expect(screen.getByTestId("data-list-pagination")).toHaveTextContent("2 / 2");
});

test("approval of a retained row survives an older native query response and reloads the requested source", async () => {
  jest.spyOn(apiClient, "getFeatures").mockResolvedValue({
    deploymentMode: "self-host",
    features: { accountApproval: true },
  } as never);
  const user = {
    id: "pending-user",
    email: "pending@example.test",
    name: "Pending user",
    isAdmin: false,
    emailVerified: true,
    approvedAt: null as string | null,
    blocked: false,
    createdAt: "2026-09-01",
    workflowsCount: 0,
  };
  const held = deferred<unknown>();
  const originalAdapter = axios.defaults.adapter;
  const queries: string[] = [];
  let approvedAt: string | null = null;
  axios.defaults.adapter = async (config) => {
    const url = new URL(config.url!, "http://localhost");
    let data: unknown;
    if (config.method === "post" && url.pathname === "/admin/users/pending-user/approve") {
      approvedAt = "2026-10-03T10:00:00.000Z";
      data = { approvedAt, alreadyApproved: false };
    } else {
      expect(url.pathname).toBe("/admin/users");
      queries.push(url.searchParams.get("search") ?? "");
      data =
        queries.length === 2
          ? await held.promise
          : { users: [{ ...user, approvedAt }], total: 1, limit: 20, offset: 0 };
    }
    return { config, status: 200, statusText: "OK", headers: {}, data: { success: true, data } };
  };
  const client = new MoiraApiClient();
  jest.spyOn(apiClient, "getAdminUsers").mockImplementation(client.getAdminUsers.bind(client));
  jest.spyOn(apiClient, "approveUser").mockImplementation(client.approveUser.bind(client));
  try {
    show(UserManagement);
    await screen.findByText("pending@example.test");
    fireEvent.change(screen.getByTestId("user-management-search"), {
      target: { value: "pending" },
    });
    await waitFor(() => expect(queries).toEqual(["", "pending"]));
    fireEvent.click(screen.getByRole("button", { name: "Approve pending@example.test" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve account" }),
    );
    await screen.findByText("Approved");
    await act(async () => held.resolve({ users: [user], total: 1, limit: 20, offset: 0 }));
    await waitFor(() => expect(screen.getByText("Approved")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Approve pending@example.test" })).toBeNull();
    await waitFor(() => expect(queries).toEqual(["", "pending", "pending"]));
    expect(screen.getByText(/Search: pending/)).toBeInTheDocument();
  } finally {
    held.resolve({ users: [user], total: 1, limit: 20, offset: 0 });
    axios.defaults.adapter = originalAdapter;
  }
});

test.each([
  { outcome: "success", replacement: true },
  { outcome: "error", replacement: true },
  { outcome: "success", replacement: false },
  { outcome: "error", replacement: false },
])(
  "an approval $outcome cannot publish a global toast after replacement=$replacement or suspension",
  async ({ outcome, replacement }) => {
    jest.spyOn(apiClient, "getFeatures").mockResolvedValue({
      deploymentMode: "self-host",
      features: { accountApproval: true },
    } as never);
    const held = deferred<unknown>();
    const originalAdapter = axios.defaults.adapter;
    let dispatched = false;
    axios.defaults.adapter = async (config) => {
      if (config.method === "post") {
        dispatched = true;
        await held.promise;
        return {
          config,
          status: 200,
          statusText: "OK",
          headers: {},
          data:
            outcome === "success"
              ? {
                  success: true,
                  data: { approvedAt: "2026-10-03T10:00:00.000Z", alreadyApproved: false },
                }
              : { success: false, error: "Approval refused" },
        };
      }
      return {
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          success: true,
          data: {
            users: [
              {
                id: "pending-user",
                email: "pending@example.test",
                name: "Pending user",
                isAdmin: false,
                emailVerified: true,
                approvedAt: null,
                blocked: false,
                createdAt: "2026-09-01",
                workflowsCount: 0,
              },
            ],
            total: 1,
            limit: 20,
            offset: 0,
          },
        },
      };
    };
    const client = new MoiraApiClient();
    jest.spyOn(apiClient, "getAdminUsers").mockImplementation(client.getAdminUsers.bind(client));
    jest.spyOn(apiClient, "approveUser").mockImplementation(client.approveUser.bind(client));
    const success = jest.spyOn(toast, "success");
    const error = jest.spyOn(toast, "error");
    try {
      const mounted = show(UserManagement);
      await screen.findByText("pending@example.test");
      fireEvent.click(screen.getByRole("button", { name: "Approve pending@example.test" }));
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve account" }),
      );
      await waitFor(() => expect(dispatched).toBe(true));
      if (replacement) {
        mounted.unmount();
        observeReadSession("replacement-reader", "replacement-session");
      } else {
        suspendReadSession();
      }
      await act(async () => held.resolve(undefined));
      expect(success).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      held.resolve(undefined);
      axios.defaults.adapter = originalAdapter;
    }
  },
);
