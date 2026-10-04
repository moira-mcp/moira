/** @jest-environment jsdom */
/** Real inspector reads/actions across executionId prop lifetimes; BrowserRouter supplies query state. */
import React from "react";
import { afterEach, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { BrowserRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
import type { ExecutionData } from "../../../packages/web-frontend/src/components/execution/ExecutionInspector";
import type { LiveOverviewHandlers } from "../../../packages/web-frontend/src/components/overview/useLiveOverview";
import type {
  WorkflowGraph,
  WorkflowDetailResponse,
} from "../../../packages/web-frontend/src/types";
import type { RunProgress } from "../../../packages/web-frontend/src/components/run/model";

let live: LiveOverviewHandlers;
// Only the event entry and expensive diagrams are replaced; request/state/action ownership is real.
jest.unstable_mockModule(
  "../../../packages/web-frontend/src/components/overview/useLiveOverview",
  () => ({
    useLiveOverview: (handlers: LiveOverviewHandlers) => {
      live = handlers;
    },
  }),
);
jest.unstable_mockModule(
  "../../../packages/web-frontend/src/components/workflow/WorkflowGraph",
  () => ({
    WorkflowGraph: ({ workflow }: { workflow: WorkflowGraph }) => (
      <div data-testid="loaded-graph">{workflow.metadata.name}</div>
    ),
  }),
);
jest.unstable_mockModule("../../../packages/web-frontend/src/components/run/MapView", () => ({
  MapView: ({ toolbarExtra }: { toolbarExtra?: React.ReactNode }) => <div>{toolbarExtra}</div>,
}));
jest.unstable_mockModule("../../../packages/web-frontend/src/components/route-skeleton", () => ({
  DiagramSkeleton: () => <div>Loading diagram</div>,
}));
jest.unstable_mockModule(
  "../../../packages/web-frontend/src/components/run/VariablesPanel",
  () => ({
    VariablesPanel: ({
      context,
      progress,
      onAnswer,
      onSavePath,
    }: {
      context?: Record<string, unknown>;
      progress?: RunProgress | null;
      onAnswer: (input: Record<string, unknown>) => Promise<string | null>;
      onSavePath?: (path: Array<string | number>, value: unknown) => Promise<boolean>;
    }) => (
      <div data-testid="loaded-context">
        {String(context?.marker)}
        <span data-testid="loaded-progress">{progress?.taskTitle ?? "No process"}</span>
        <button onClick={() => void onAnswer({ result: "accepted" })}>Answer loaded task</button>
        <button onClick={() => void onSavePath?.(["marker"], "edited")}>Edit loaded task</button>
      </div>
    ),
  }),
);

let Inspector: typeof import("../../../packages/web-frontend/src/components/execution/ExecutionInspector").ExecutionInspector;
let GuideProvider: typeof import("../../../packages/web-frontend/src/guides/GuideContext").GuideProvider;
const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
let admitted = true;
beforeAll(async () => {
  ({ ExecutionInspector: Inspector } =
    await import("../../../packages/web-frontend/src/components/execution/ExecutionInspector"));
  ({ GuideProvider } = await import("../../../packages/web-frontend/src/guides/GuideContext"));
  await i18n.changeLanguage("en");
});
beforeEach(async () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  admitted = true;
  // The real stop action requires the same admitted owner as these execution fixtures.
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (new URL(String(input), "http://localhost").pathname !== "/api/auth/get-session")
      throw new Error("Unexpected network request in inspector lifetime fixture");
    return Response.json(
      admitted
        ? {
            user: { id: "owner", email: "owner@example.test", name: "Owner" },
            session: {
              id: "owner-session",
              userId: "owner",
              expiresAt: "2099-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              createdAt: "2026-01-01T00:00:00Z",
            },
          }
        : null,
    );
  });
  await authClient.$store.atoms.session.get().refetch();
  window.history.replaceState(null, "", "/executions/A");
  jest.spyOn(apiClient, "getWorkflow").mockImplementation(async (id) => definition(id));
  jest.spyOn(apiClient, "getExecutionVariables").mockResolvedValue({ variables: [], revision: 0 });
  jest.spyOn(apiClient, "getExecutionProgress").mockResolvedValue(null);
  jest
    .spyOn(apiClient, "getNodeTypes")
    .mockResolvedValue({ nodeTypes: [], extensionsAvailable: false });
  jest.spyOn(apiClient, "answerExecutionStep").mockResolvedValue({
    executionId: "B",
    revision: 2,
    status: "running",
    currentNodeId: "work",
    waitingForInputNodeId: "work",
    progress: null,
  });
  jest.spyOn(apiClient, "updateExecutionContextPath").mockResolvedValue(true);
});
afterEach(async () => {
  cleanup();
  admitted = false;
  await authClient.$store.atoms.session.get().refetch();
  jest.restoreAllMocks();
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});

function graph(id: string): WorkflowGraph {
  return {
    id,
    metadata: { name: `Flow ${id}`, version: "1.0.0", description: "" },
    nodes: [
      {
        id: "work",
        type: "agent-directive",
        directive: "Work",
        completionCondition: "Done",
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
}
function definition(id: string): WorkflowDetailResponse {
  const workflow = graph(id);
  return {
    workflow,
    validation: { isValid: true, nodeValidation: {}, globalErrors: [], globalWarnings: [] },
    fileInfo: {
      id,
      slug: id,
      ownerHandle: "owner",
      ownerName: "Owner",
      visibility: "private",
      filePath: `memory:${id}`,
      metadata: workflow.metadata,
      validation: { isValid: true, errors: [], warnings: [] },
      lastModified: 1,
      revision: 0,
      fileSize: 100,
    },
  };
}
function execution(id: string, revision = 1): ExecutionData {
  return {
    executionId: id,
    workflowId: id,
    workflowName: `Flow ${id}`,
    taskTitle: `Task ${id} ${revision}`,
    userId: "owner",
    status: "running",
    currentNodeId: "work",
    waitingForInputNodeId: "work",
    revision,
    displayStatus: "waiting-user",
    stopReason: null,
    stopCapability: { available: true, revision },
    metadataRevisions: {
      parent: "parent",
      reminders: "reminders",
      context: `context-${id}-${revision}`,
    },
    context: { variables: { marker: `${id}-${revision}` }, nodeStates: {} },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function mount(fetch: (id: string) => Promise<ExecutionData>) {
  const node = (id: string) => (
    <BrowserRouter>
      <I18nextProvider i18n={i18n}>
        <GuideProvider>
          <Inspector executionId={id} fetchExecution={fetch} editable backRoute="/executions" />
        </GuideProvider>
      </I18nextProvider>
    </BrowserRouter>
  );
  const view = render(node("A"));
  return { ...view, go: (id: string) => view.rerender(node(id)) };
}

test("the inspector uses its authoritative capability and refreshes the same run after stopping", async () => {
  let current = execution("A");
  const stop = jest.spyOn(apiClient, "stopExecution").mockImplementation(async (id, request) => {
    current = {
      ...execution("A", 2),
      status: "completed",
      displayStatus: "stopped",
      stopReason: request.reason,
      stopCapability: { available: false, revision: 2, reason: "terminal" },
    };
    return {
      executionId: id,
      stopped: true,
      stopReason: request.reason,
      revision: 2,
      changed: true,
      displayStatus: "stopped",
      stopCapability: { available: false, revision: 2, reason: "terminal" },
    };
  });
  mount(async () => current);
  await shown("A");
  fireEvent.click(screen.getByTestId("execution-stop-A"));
  fireEvent.change(screen.getByRole("textbox", { name: "Reason for stopping" }), {
    target: { value: "The owner changed the task" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(stop).toHaveBeenCalledWith("A", {
    expectedRevision: 1,
    reason: "The owner changed the task",
  });
  expect(screen.getByTestId("run-status")).toHaveTextContent("Stopped");
  expect(screen.getByTestId("run-stop-reason")).toHaveTextContent("The owner changed the task");
  expect(screen.queryByTestId("execution-stop-A")).toBeNull();
});

test("foreign capability cannot expose a stop action even on an editable inspector", async () => {
  mount(async (id) => ({
    ...execution(id),
    stopCapability: { available: false, revision: 1, reason: "not-owner" },
  }));
  await shown("A");
  expect(screen.queryByTestId("execution-stop-A")).toBeNull();
});

test("an authoritative metadata stop marker is shown even when the separate detail read is still active", async () => {
  jest.spyOn(apiClient, "getExecutionProgress").mockResolvedValue({
    source: "metadata",
    executionId: "A",
    workflowId: "A",
    workflowName: "Flow A",
    workflowVersion: "1.0.0",
    executionWorkflowVersion: null,
    executionRevision: 2,
    executionStatus: "completed",
    stopReason: "",
    taskTitle: "Task A 1",
    taskIdentity: null,
    taskIdentityRevision: "legacy",
  });
  mount(async (id) => execution(id));
  await shown("A");
  expect(screen.getByTestId("run-status")).toHaveTextContent("Stopped");
  expect(screen.getByTestId("run-stop-reason")).toBeInTheDocument();
  expect(screen.queryByTestId("execution-stop-A")).toBeNull();
});

test.each(["good", "error"])(
  "lock history after A's %s result shows a single B pending read and then B's own error",
  async (first) => {
    const delayed = deferred<Awaited<ReturnType<typeof apiClient.getUserExecutionLocks>>>();
    const fetchLocks = jest
      .spyOn(apiClient, "getUserExecutionLocks")
      .mockImplementation(async (id) => {
        if (id === "B") return delayed.promise;
        if (first === "error") throw new Error("A lock history unavailable");
        return {
          total: 1,
          locks: [
            {
              id: "A-lock",
              nodeId: "work",
              reason: "A lock reason",
              lockedBy: "owner",
              status: "active",
              createdAt: "2026-10-01",
              unlockedAt: null,
            },
          ],
        };
      });
    const view = mount(async (id) => execution(id));
    await shown("A");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /^Locks/ }), { button: 0, ctrlKey: false });
    if (first === "good") expect(await screen.findByText("A lock reason")).toBeInTheDocument();
    else
      expect(await screen.findByTestId("locks-error")).toHaveTextContent(
        "A lock history unavailable",
      );
    view.go("B");
    await waitFor(() => expect(screen.getByTestId("run-task-title")).toHaveTextContent("Task B 1"));
    await waitFor(() => expect(fetchLocks.mock.calls.filter(([id]) => id === "B")).toHaveLength(1));
    expect(screen.getByTestId("locks-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("locks-error")).toBeNull();
    expect(screen.queryByText("A lock reason")).toBeNull();
    expect(screen.queryByText(i18n.t("pages.executionInspector.locks.noHistory"))).toBeNull();
    await act(async () => {
      delayed.reject(new Error("B lock history unavailable"));
    });
    expect(await screen.findByTestId("locks-error")).toHaveTextContent(
      "B lock history unavailable",
    );
    expect(screen.queryByTestId("locks-loading")).toBeNull();
    expect(fetchLocks.mock.calls.filter(([id]) => id === "B")).toHaveLength(1);
  },
);
async function shown(id: string, revision = 1) {
  await waitFor(() => {
    expect(screen.getByTestId("run-task-title")).toHaveTextContent(`Task ${id} ${revision}`);
    expect(screen.getByTestId("loaded-context")).toHaveTextContent(`${id}-${revision}`);
    expect(screen.getByTestId("loaded-graph")).toHaveTextContent(`Flow ${id}`);
  });
}

test.each(["B", "ABA"])(
  "a late live A response cannot replace the current %s lifetime or action target",
  async (target) => {
    const delayed = deferred<ExecutionData>();
    let delay = false;
    let version = 1;
    const fetch = jest.fn(async (id: string) =>
      delay && id === "A" ? delayed.promise : execution(id, version),
    );
    const view = mount(fetch);
    await shown("A");
    delay = true;
    let refresh!: Promise<void>;
    act(() => {
      refresh = live.refetchPage();
    });
    view.go("B");
    await shown("B");
    if (target === "ABA") {
      delay = false;
      version = 3;
      view.go("A");
      await shown("A", 3);
    }
    await act(async () => {
      delayed.resolve(execution("A", 9));
      await refresh;
    });
    const current = target === "ABA" ? "A" : "B";
    const revision = target === "ABA" ? 3 : 1;
    await shown(current, revision);
    fireEvent.click(screen.getByRole("button", { name: "Answer loaded task" }));
    await waitFor(() =>
      expect(apiClient.answerExecutionStep).toHaveBeenCalledWith(
        current,
        { result: "accepted" },
        revision,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit loaded task" }));
    await waitFor(() =>
      expect(apiClient.updateExecutionContextPath).toHaveBeenCalledWith(
        current,
        ["marker"],
        "edited",
        revision,
        `context-${current}-${revision}`,
      ),
    );
  },
);

test.each(["success", "failure"])(
  "a delayed initial A %s does not replace B or its loading/error state",
  async (outcome) => {
    const delayed = deferred<ExecutionData>();
    const view = mount(async (id) => (id === "A" ? delayed.promise : execution(id)));
    view.go("B");
    await shown("B");
    await act(async () => {
      if (outcome === "success") delayed.resolve(execution("A", 9));
      else delayed.reject(new Error("obsolete initial failure"));
    });
    await shown("B");
    expect(screen.queryByText("obsolete initial failure")).toBeNull();
  },
);

test("late manual graph/variable-access reads cannot install A's workflow after B loads", async () => {
  const delayed = deferred<WorkflowDetailResponse>();
  const view = mount(async (id) => execution(id));
  await shown("A");
  jest
    .spyOn(apiClient, "getWorkflow")
    .mockImplementation(async (id) => (id === "A" ? delayed.promise : definition(id)));
  fireEvent.click(
    screen.getByTestId("run-header").querySelector("svg.lucide-refresh-cw")!.closest("button")!,
  );
  await waitFor(() => expect(apiClient.getWorkflow).toHaveBeenCalledTimes(2));
  view.go("B");
  await shown("B");
  await act(async () => {
    delayed.resolve(definition("A"));
  });
  await shown("B");
});

test.each(["answer", "edit"])(
  "a deferred %s operation cannot refresh or replace a different run",
  async (operation) => {
    const delayed = deferred<boolean>();
    const view = mount(async (id) => execution(id));
    await shown("A");
    if (operation === "answer")
      jest.spyOn(apiClient, "answerExecutionStep").mockImplementation(async () => {
        await delayed.promise;
        return {
          executionId: "A",
          revision: 2,
          status: "running",
          currentNodeId: "work",
          waitingForInputNodeId: "work",
          progress: null,
        };
      });
    else jest.spyOn(apiClient, "updateExecutionContextPath").mockReturnValue(delayed.promise);
    fireEvent.click(
      screen.getByRole("button", {
        name: operation === "answer" ? "Answer loaded task" : "Edit loaded task",
      }),
    );
    view.go("B");
    await shown("B");
    await act(async () => {
      delayed.resolve(true);
    });
    await shown("B");
  },
);

test("same-run live rename keeps the graph DOM and scroll without fetching its definition again", async () => {
  let revision = 1;
  mount(async (id) => execution(id, revision));
  await shown("A");
  const graphElement = screen.getByTestId("loaded-graph");
  const panel = screen.getByTestId("run-panel");
  panel.scrollTop = 137;
  revision = 2;
  await act(async () => {
    await live.refetchPage();
  });
  await shown("A", 2);
  expect(screen.getByTestId("loaded-graph")).toBe(graphElement);
  expect(panel.scrollTop).toBe(137);
  expect(apiClient.getWorkflow).toHaveBeenCalledTimes(1);
});

test("a same-run rename while the initial definition is pending keeps that definition request usable", async () => {
  const delayed = deferred<WorkflowDetailResponse>();
  jest.spyOn(apiClient, "getWorkflow").mockReturnValue(delayed.promise);
  let revision = 1;
  mount(async (id) => execution(id, revision));
  await waitFor(() => expect(apiClient.getWorkflow).toHaveBeenCalledTimes(1));
  revision = 2;
  await act(async () => {
    await live.refetchPage();
  });
  await act(async () => {
    delayed.resolve(definition("A"));
  });
  await shown("A", 2);
  expect(apiClient.getWorkflow).toHaveBeenCalledTimes(1);
});

test("a current initial failure is shown and a new lifetime can load normally", async () => {
  const view = mount(async (id) => {
    if (id === "A") throw new Error("current failure");
    return execution(id);
  });
  expect(await screen.findByText("current failure")).toBeInTheDocument();
  view.go("B");
  await shown("B");
  expect(screen.queryByText("current failure")).toBeNull();
});

test.each(["success", "failure"])(
  "a late progress %s cannot replace the new lifetime's heading or error status",
  async (outcome) => {
    type Progress = Awaited<ReturnType<typeof apiClient.getExecutionProgress>>;
    const delayed = deferred<Progress>();
    jest
      .spyOn(apiClient, "getExecutionProgress")
      .mockImplementation(async (id) => (id === "A" ? delayed.promise : null));
    const view = mount(async (id) => execution(id));
    await shown("A");
    view.go("B");
    await shown("B");
    await act(async () => {
      if (outcome === "failure") delayed.reject(new Error("obsolete progress failure"));
      else
        delayed.resolve({
          source: "metadata",
          executionId: "A",
          workflowId: "A",
          workflowName: "Flow A",
          workflowVersion: "1.0.0",
          executionWorkflowVersion: null,
          executionRevision: 9,
          executionStatus: "running",
          taskTitle: "Task A 9",
          taskIdentity: null,
          taskIdentityRevision: "identity",
        });
    });
    await shown("B");
    expect(screen.queryByText(i18n.t("pages.executionInspector.progress.error"))).toBeNull();
    expect(screen.queryByTestId("execution-progress-loading")).toBeNull();
  },
);

test("during B's pending load, retained A content cannot expose answer or edit controls", async () => {
  const delayed = deferred<ExecutionData>();
  const view = mount(async (id) => (id === "B" ? delayed.promise : execution(id)));
  await shown("A");
  view.go("B");
  expect(screen.queryByRole("button", { name: "Answer loaded task" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit loaded task" })).toBeNull();
  await act(async () => {
    delayed.resolve(execution("B"));
  });
  await shown("B");
});

function trace(id: string): RunProgress {
  return {
    source: "trace",
    taskTitle: `Task ${id} 1`,
    executionId: id,
    workflowId: id,
    title: null,
    goal: null,
    facts: [],
    activeNodeId: null,
    nodes: [],
    workflowVersion: "1.0.0",
    executionWorkflowVersion: null,
    executionRevision: 1,
    executionStatus: "running",
    diagnostics: [],
    process: { blocks: [], hubs: [], backEdges: [], diagnostics: [] },
    route: [0, 1].map((seq) => ({
      seq,
      nodeId: "work",
      blockId: null,
      exitKey: null,
      changed: [],
    })),
    variables: [],
    routeRecorded: true,
    cursor: null,
    projectedAt: 1,
    waitingFor: null,
    waitingForUser: null,
  };
}
test("a deferred cursor response cannot restore a cut after the reader clears the cursor", async () => {
  const delayed = deferred<Awaited<ReturnType<typeof apiClient.getExecutionProgress>>>();
  jest
    .spyOn(apiClient, "getExecutionProgress")
    .mockImplementation(async (id, at) => (at === 0 ? delayed.promise : trace(id)));
  mount(async (id) => execution(id));
  await waitFor(() => expect(screen.getByTestId("run-task-title")).toHaveTextContent("Task A 1"));
  fireEvent.mouseDown(await screen.findByRole("tab", { name: /^Variables/ }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByTestId("loaded-progress");
  fireEvent.click(screen.getByTestId("cursor-prev"));
  await waitFor(() => expect(apiClient.getExecutionProgress).toHaveBeenCalledWith("A", 0));
  fireEvent.click(screen.getByTestId("cursor-clear"));
  await act(async () => {
    delayed.resolve({ ...trace("A"), taskTitle: "Obsolete cursor title", cursor: 0 });
  });
  expect(screen.getByTestId("loaded-progress")).toHaveTextContent("Task A 1");
  expect(screen.queryByTestId("cursor-clear")).toBeNull();
});
