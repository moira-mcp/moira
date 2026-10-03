/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import type { AxiosInstance } from "axios";
import i18n from "../../../packages/web-frontend/src/i18n";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
import { observeReadSession } from "../../../packages/web-frontend/src/services/read-scope";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import { DeletedWorkflows } from "../../../packages/web-frontend/src/pages/DeletedWorkflows";
import { AdminReportedArtifacts } from "../../../packages/web-frontend/src/pages/AdminReportedArtifacts";

const axiosClient = (apiClient as unknown as { client: AxiosInstance }).client;
const originalAdapter = axiosClient.defaults.adapter;
const originalFetch = globalThis.fetch;
const originalObserver = globalThis.ResizeObserver;
const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
const session = {
  user: {
    id: "inventory-owner",
    email: "owner@example.test",
    name: "Inventory Owner",
    emailVerified: true,
  },
  session: {
    id: "inventory-session",
    userId: "inventory-owner",
    token: "test-session",
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

beforeEach(async () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
    if (String(input).includes("/get-session")) return Response.json(session);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  await authClient.$store.atoms.session.get().refetch();
  localStorage.clear();
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
    if (String(input).includes("/get-session")) return Response.json(null);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  await authClient.$store.atoms.session.get().refetch();
  axiosClient.defaults.adapter = originalAdapter;
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = originalObserver;
  observeReadSession(null, null);
  jest.restoreAllMocks();
  if (originalReact)
    (globalThis as typeof globalThis & { React?: typeof React }).React = originalReact;
  else delete (globalThis as typeof globalThis & { React?: typeof React }).React;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function show(page: React.ReactNode, route = "/admin/deleted-workflows") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <I18nextProvider i18n={i18n}>{page}</I18nextProvider>
    </MemoryRouter>,
  );
}

const deleted = {
  id: "deleted-one",
  name: "Accepted deletion",
  deletedAt: 100,
  deletedBy: "reader@example.test",
};
const reported = {
  uuid: "reported-one",
  userId: "owner-one",
  name: "Accepted report",
  reportCount: 2,
  lastReportedAt: 100,
  takenDown: false,
  takenDownAt: null,
  takenDownBy: null,
  takenDownReason: null,
  createdAt: 0,
};

function response(data: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => ({ success: ok, data }) } as Response;
}

test("deleted date replacement retains the accepted scope, count and same focused controls through failure and retry", async () => {
  const replacement = deferred<{
    workflows: (typeof deleted)[];
    total: number;
    limit: number;
    offset: number;
  }>();
  const requests: URL[] = [];
  let retry = false;
  axiosClient.defaults.adapter = async (config) => {
    const url = new URL(config.url!, "https://example.test");
    requests.push(url);
    const data = url.searchParams.has("fromDate")
      ? retry
        ? { workflows: [], total: 0, limit: 20, offset: 0 }
        : await replacement.promise
      : { workflows: [deleted], total: 40, limit: 20, offset: 0 };
    return { config, status: 200, statusText: "OK", headers: {}, data: { success: true, data } };
  };
  show(<DeletedWorkflows />);
  await screen.findByText("Accepted deletion");
  const search = screen.getByTestId("deleted-workflows-search");
  const from = screen.getByLabelText("From");
  from.focus();
  fireEvent.change(from, { target: { value: "2026-10-01" } });
  await act(async () => {});
  await waitFor(() =>
    expect(requests.map((url) => url.href)).toContain(
      `https://example.test/admin/workflows/deleted?fromDate=${new Date(2026, 9, 1).getTime()}&limit=20`,
    ),
  );
  expect(screen.getByText("Accepted deletion")).toBeInTheDocument();
  expect(screen.getByTestId("data-list-pagination")).toHaveTextContent("40");
  expect(screen.getByText(/Search: — · From: — · To: —/)).toBeInTheDocument();
  expect(screen.getByLabelText("From")).toBe(from);
  expect(from).toHaveFocus();
  await act(async () => replacement.reject(new Error("Offline")));
  expect(screen.getByText("Accepted deletion")).toBeInTheDocument();
  expect(screen.getByTestId("deleted-workflows-search")).toBe(search);
  retry = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No workflows found matching filters");
  expect(screen.getByText(/From: 2026-10-01/)).toBeInTheDocument();
  expect(screen.getByLabelText("From")).toBe(from);
});

test("a rejected deleted-workflow mutation keeps its confirmation context open", async () => {
  axiosClient.defaults.adapter = async (config) => {
    if (config.method === "post") throw new Error("Restore refused");
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: { success: true, data: { workflows: [deleted], total: 1, limit: 20, offset: 0 } },
    };
  };
  show(<DeletedWorkflows />);
  await screen.findByText("Accepted deletion");
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Restore" })).toBeEnabled(),
  );
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  expect(dialog).toHaveTextContent("Accepted deletion");
});

test("reported pages retain accepted rows and total during a delayed page, and failed takedown remains retryable", async () => {
  const replacement = deferred<Response>();
  const reads: URL[] = [];
  let acceptedSecond = false;
  let allowTakedown = false;
  globalThis.fetch = jest.fn<typeof fetch>(async (input, init) => {
    if (String(input).includes("/get-session")) return Response.json(session);
    const url = new URL(String(input), "https://example.test");
    if (init?.method === "POST") return response({}, allowTakedown);
    reads.push(url);
    if (url.searchParams.get("offset") === "20" && !acceptedSecond) return replacement.promise;
    return response({
      artifacts: [
        {
          ...reported,
          uuid: acceptedSecond ? "reported-two" : "reported-one",
          name: acceptedSecond ? "Second report" : "Accepted report",
          takenDown: allowTakedown,
        },
      ],
      total: 40,
    });
  });
  show(<AdminReportedArtifacts />, "/admin/artifacts/reported");
  await screen.findByText("Accepted report");
  fireEvent.click(screen.getByTestId("pagination-next"));
  await waitFor(() => expect(reads.at(-1)?.searchParams.get("offset")).toBe("20"));
  expect(reads[0].searchParams.get("limit")).toBe("20");
  expect(screen.getByText("Accepted report")).toBeInTheDocument();
  expect(screen.getByTestId("data-list-pagination")).toHaveTextContent("1 / 2");
  acceptedSecond = true;
  await act(async () =>
    replacement.resolve(
      response({
        artifacts: [{ ...reported, uuid: "reported-two", name: "Second report" }],
        total: 40,
      }),
    ),
  );
  fireEvent.click(screen.getByTestId("takedown-reported-two"));
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Take down" }));
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Take down" })).toBeEnabled(),
  );
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  expect(dialog).toHaveTextContent("Second report");
  allowTakedown = true;
  fireEvent.click(within(dialog).getByRole("button", { name: "Take down" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(screen.getByTestId("reported-artifact-reported-two")).toHaveTextContent("Taken down");
  expect(screen.getByTestId("reported-count")).toHaveTextContent("40");
  const disabledAction = screen.getByTestId("takedown-reported-two");
  expect(disabledAction).toBeVisible();
  expect(disabledAction).toBeDisabled();
  const callsBeforeClick = jest.mocked(globalThis.fetch).mock.calls.length;
  fireEvent.click(disabledAction);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(jest.mocked(globalThis.fetch).mock.calls).toHaveLength(callsBeforeClick);
});

test.each(["deleted", "reported"])(
  "accepted empty %s inventory retains the same view toolbar while refreshing and after an error",
  async (page) => {
    const pending = deferred<Response>();
    const deletedPending = deferred<never>();
    let refreshing = false;
    axiosClient.defaults.adapter = async (config) => {
      if (refreshing) await deletedPending.promise;
      return {
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: { success: true, data: { workflows: [], total: 0, limit: 20, offset: 0 } },
      };
    };
    globalThis.fetch = jest.fn<typeof fetch>(async (input) =>
      String(input).includes("/get-session")
        ? Response.json(session)
        : refreshing
          ? pending.promise
          : response({ artifacts: [], total: 0 }),
    );
    show(
      page === "deleted" ? <DeletedWorkflows /> : <AdminReportedArtifacts />,
      page === "deleted" ? "/admin/deleted-workflows" : "/admin/artifacts/reported",
    );
    const emptyText = page === "deleted" ? "No deleted workflows" : "No reported artifacts";
    await screen.findByText(emptyText);
    const toggle = screen.getByTestId("view-mode-grid");
    const refresh = screen.getByRole("button", { name: "Refresh" });
    refreshing = true;
    fireEvent.click(refresh);
    expect(screen.getByText(emptyText)).toBeInTheDocument();
    expect(screen.getByTestId("view-mode-grid")).toBe(toggle);
    expect(screen.getByRole("button", { name: "Refresh" })).toBe(refresh);
    await act(async () => {
      if (page === "deleted") deletedPending.reject(new Error("Unavailable"));
      else pending.reject(new Error("Unavailable"));
    });
    expect(screen.getByText(emptyText)).toBeInTheDocument();
    expect(screen.getByTestId("view-mode-grid")).toBe(toggle);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  },
);

test.each(["success", "error"])(
  "a late deleted-list %s cannot replace the accepted date/page/count or end a newer refresh",
  async (outcome) => {
    const old = deferred<unknown>();
    const latest = deferred<unknown>();
    let oldStarted = false;
    let refreshStarted = false;
    let refreshing = false;
    const oldFrom = new Date(2026, 9, 1).getTime().toString();
    const currentFrom = new Date(2026, 9, 2).getTime().toString();
    const winner = { ...deleted, id: "current-deletion", name: "Current accepted deletion" };
    const current = { workflows: [winner], total: 100, limit: 20, offset: 80 };
    axiosClient.defaults.adapter = async (config) => {
      const url = new URL(config.url!, "https://example.test");
      let data: unknown;
      if (url.searchParams.get("fromDate") === oldFrom) {
        oldStarted = true;
        data = await old.promise;
      } else if (refreshing) {
        refreshStarted = true;
        data = await latest.promise;
      } else {
        data =
          url.searchParams.get("fromDate") === currentFrom
            ? { ...current, offset: Number(url.searchParams.get("offset") ?? 0) }
            : { workflows: [deleted], total: 80, limit: 20, offset: 0 };
      }
      return { config, status: 200, statusText: "OK", headers: {}, data: { success: true, data } };
    };
    show(<DeletedWorkflows />);
    await screen.findByText("Accepted deletion");
    const from = screen.getByLabelText("From");
    fireEvent.change(from, { target: { value: "2026-10-01" } });
    await waitFor(() => expect(oldStarted).toBe(true));
    fireEvent.change(from, { target: { value: "2026-10-02" } });
    await screen.findByText("Current accepted deletion");
    fireEvent.click(screen.getByRole("button", { name: "Go to last page" }));
    await waitFor(() =>
      expect(screen.getByTestId("data-list-pagination")).toHaveTextContent("5 / 5"),
    );
    refreshing = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(refreshStarted).toBe(true));
    await act(async () => {
      if (outcome === "success")
        old.resolve({ workflows: [deleted], total: 40, limit: 20, offset: 0 });
      else old.reject(new Error("Former date request failed"));
    });
    expect(screen.getByText("Current accepted deletion")).toBeInTheDocument();
    expect(screen.queryByText("Accepted deletion")).toBeNull();
    expect(screen.getByTestId("data-list-pagination")).toHaveTextContent("5 / 5");
    expect(screen.getByTestId("data-list-pagination")).toHaveTextContent("81-81 of 100");
    expect(screen.getByText(/From: 2026-10-02/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("data-list-items").closest("[aria-busy]")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await act(async () => latest.resolve(current));
    expect(screen.getByTestId("data-list-items").closest("[aria-busy]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(screen.getByText("Current accepted deletion")).toBeInTheDocument();
  },
);

test.each(["success", "error"])(
  "a late reported-list %s cannot replace accepted rows/page/count or end a newer refresh",
  async (outcome) => {
    const old = deferred<Response>();
    const latest = deferred<Response>();
    let oldStarted = false;
    let refreshStarted = false;
    let refreshing = false;
    const winner = { ...reported, uuid: "current-report", name: "Current accepted report" };
    globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
      if (String(input).includes("/get-session")) return Response.json(session);
      const url = new URL(String(input), "https://example.test");
      if (url.searchParams.get("offset") === "20") {
        oldStarted = true;
        return old.promise;
      }
      if (refreshing) {
        refreshStarted = true;
        return latest.promise;
      }
      return url.searchParams.get("offset") === "60"
        ? response({ artifacts: [winner], total: 100 })
        : response({ artifacts: [reported], total: 80 });
    });
    show(<AdminReportedArtifacts />, "/admin/artifacts/reported");
    await screen.findByText("Accepted report");
    fireEvent.click(screen.getByTestId("pagination-next"));
    await waitFor(() => expect(oldStarted).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Go to last page" }));
    await screen.findByText("Current accepted report");
    refreshing = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(refreshStarted).toBe(true));
    await act(async () => {
      if (outcome === "success") old.resolve(response({ artifacts: [reported], total: 40 }));
      else old.reject(new Error("Former page request failed"));
    });
    expect(screen.getByTestId("reported-artifact-current-report")).toBeInTheDocument();
    expect(screen.queryByTestId("reported-artifact-reported-one")).toBeNull();
    expect(screen.getByTestId("reported-count")).toHaveTextContent("100");
    expect(screen.getByTestId("data-list-pagination")).toHaveTextContent("4 / 5");
    expect(screen.getByTestId("data-list-pagination")).toHaveTextContent("61-61 of 100");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("data-list-items").closest("[aria-busy]")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await act(async () => latest.resolve(response({ artifacts: [winner], total: 100 })));
    expect(screen.getByTestId("data-list-items").closest("[aria-busy]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(screen.getByTestId("reported-artifact-current-report")).toBeInTheDocument();
  },
);
