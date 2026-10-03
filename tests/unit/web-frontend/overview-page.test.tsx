/** @jest-environment jsdom */
/**
 * The overview's interactive parts in the DOM: the detail is a modal dialog that closes on Esc
 * and gives focus back, says what the person is waited for and that the answer goes to the agent,
 * and offers no answer form; a card's hint opens from the keyboard; and the live hook turns a burst
 * of changes into one refresh request, while a change of status refetches the page instead.
 */

import React, { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { Overview } from "../../../packages/web-frontend/src/pages/Overview";
import { GuideProvider } from "../../../packages/web-frontend/src/guides/GuideContext";
import { FeaturesProvider } from "../../../packages/web-frontend/src/hooks/useFeatures";
import {
  observeReadSession,
  suspendReadSession,
} from "../../../packages/web-frontend/src/services/read-scope";
import i18n from "../../../packages/web-frontend/src/i18n";
import {
  apiClient,
  type OverviewRun,
} from "../../../packages/web-frontend/src/services/api-client";
import { OverviewPanel } from "../../../packages/web-frontend/src/components/overview/OverviewPanel";
import { OverviewCard } from "../../../packages/web-frontend/src/components/overview/OverviewCard";
import {
  useLiveOverview,
  PAGE_REFETCH_MS,
} from "../../../packages/web-frontend/src/components/overview/useLiveOverview";
import { useOverviewRows } from "../../../packages/web-frontend/src/components/overview/useOverviewRows";
import type {
  LiveDependencies,
  StreamLike,
} from "../../../packages/web-frontend/src/components/overview/liveConnection";

const NOW = 1_800_000_000_000;
const originalReact = globalThis.React;

beforeEach(() => {
  globalThis.React = React;
  observeReadSession("reader", "reader-session");
});

function run(overrides: Partial<OverviewRun> = {}): OverviewRun {
  return {
    executionId: "run-1",
    workflowId: "wf",
    workflowName: "Order import",
    workflowVersion: "1.0.0",
    title: "Import March orders",
    status: "waiting-user",
    revision: 1,
    stopCapability: { available: true, revision: 1 },
    stopReason: null,
    matches: true,
    waitingForUser: {
      source: "agent",
      question: "Which currency should the prices use?",
      options: ["EUR", "USD"],
      since: NOW - 60 * 60_000,
      notification: null,
    },
    refusalCount: 0,
    note: null,
    current: { stepName: "Map the columns", directiveShownAt: NOW - 60 * 60_000 },
    stages: null,
    list: null,
    lastActivityAt: NOW - 60 * 60_000,
    subtreeActivityAt: NOW - 60 * 60_000,
    idleActivityAt: NOW - 60 * 60_000,
    createdAt: NOW - 2 * 60 * 60_000,
    completedAt: null,
    parentExecutionId: null,
    parent: null,
    children: { total: 0, unfinished: 0 },
    childrenTotal: { total: 0, unfinished: 0 },
    childRuns: [],
    ...overrides,
  };
}

function wrap(node: React.ReactNode) {
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </MemoryRouter>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
  observeReadSession(null, null);
  globalThis.React = originalReact;
});

describe("the overview's detail dialog", () => {
  function Harness({ shown }: { shown: OverviewRun }) {
    const [open, setOpen] = useState<string | null>(null);
    return (
      <>
        <button type="button" onClick={() => setOpen(shown.executionId)}>
          Open the card
        </button>
        <OverviewPanel
          runId={open}
          run={open ? shown : null}
          ancestors={[]}
          now={NOW}
          onOpen={setOpen}
          onClose={() => setOpen(null)}
        />
      </>
    );
  }

  test("is a modal dialog that closes on Esc and gives focus back to what opened it", async () => {
    jest.spyOn(apiClient, "getExecutionProgress").mockResolvedValue(null);
    wrap(<Harness shown={run()} />);
    const opener = screen.getByRole("button", { name: "Open the card" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Import March orders");
    // What the person is waited for, and where the answer goes — but nothing to answer with here.
    expect(dialog).toHaveTextContent("Which currency should the prices use?");
    expect(dialog).toHaveTextContent("EUR");
    expect(dialog).toHaveTextContent("Answer the agent in the chat");
    // What a card says only in hints is in the panel too: the status's meaning.
    expect(dialog).toHaveTextContent("The move is yours");
    expect(dialog.querySelector("textarea, input")).toBeNull();
    expect(screen.getByTestId("overview-panel-open-run")).toHaveAttribute(
      "href",
      "/executions/run-1",
    );

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  test("a metadata-only result keeps task, flow and note visible without inventing stages", async () => {
    jest.spyOn(apiClient, "getExecutionProgress").mockResolvedValue({
      source: "metadata",
      executionId: "run-1",
      workflowId: "wf",
      workflowName: "Order import",
      workflowVersion: "1.0.0",
      executionWorkflowVersion: "1.0.0",
      executionRevision: 2,
      executionStatus: "running",
      taskTitle: "Import March orders",
      taskIdentity: { title: "Import March orders", changedAt: NOW, changeId: "named" },
      taskIdentityRevision: "named-revision",
    });
    wrap(<Harness shown={run({ note: "Waiting for delimiter verification" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Open the card" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(screen.queryByText("Loading the full plan…")).toBeNull());
    expect(dialog).toHaveAccessibleName("Import March orders");
    expect(dialog).toHaveTextContent("Order import");
    expect(dialog).toHaveTextContent("Waiting for delimiter verification");
    expect(screen.queryByTestId("overview-panel-stages")).toBeNull();
    expect(screen.queryByTestId("overview-panel-list")).toBeNull();
  });

  test("a note matching the task title remains separately available on the card and in full detail", async () => {
    jest.spyOn(apiClient, "getExecutionProgress").mockResolvedValue(null);
    const shown = run({ note: "Import March orders" });
    wrap(
      <>
        <OverviewCard run={shown} parentTitle={null} now={NOW} onOpen={() => undefined} />
        <Harness shown={shown} />
      </>,
    );
    const noteFlag = screen.getByTestId("overview-flag-note");
    expect(noteFlag).toBeVisible();
    act(() => noteFlag.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Import March orders");
    fireEvent.click(screen.getByRole("button", { name: "Open the card" }));
    await screen.findByRole("dialog");
    expect(screen.getByTestId("overview-panel-title")).toHaveTextContent("Import March orders");
    expect(screen.getByTestId("overview-panel-note")).toHaveTextContent(
      "Note: Import March orders",
    );
  });
});

describe("the panel when its run leaves the page", () => {
  test("an open portal is concealed during authority uncertainty and restored for the same owner", async () => {
    jest.spyOn(apiClient, "getExecutionProgress").mockResolvedValue(null);
    const close = jest.fn();
    wrap(
      <OverviewPanel
        runId="run-1"
        run={run()}
        ancestors={[]}
        now={NOW}
        onOpen={() => undefined}
        onClose={close}
      />,
    );
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("Import March orders");
    act(() => suspendReadSession());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => observeReadSession("reader", "renewed-session"));
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("Import March orders");
    expect(close).not.toHaveBeenCalled();
  });
  test("keeps showing the run it had instead of going blank", async () => {
    jest.spyOn(apiClient, "getExecutionProgress").mockResolvedValue(null);
    jest.spyOn(apiClient, "getOverviewRows").mockReturnValue(new Promise(() => undefined));
    const shown = run();
    const view = wrap(
      <OverviewPanel
        runId="run-1"
        run={shown}
        ancestors={[]}
        now={NOW}
        onOpen={() => undefined}
        onClose={() => undefined}
      />,
    );
    await screen.findByRole("dialog");
    // A live refetch dropped the run from the page; its own row is still on its way.
    view.rerender(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <OverviewPanel
            runId="run-1"
            run={null}
            ancestors={[]}
            now={NOW}
            onOpen={() => undefined}
            onClose={() => undefined}
          />
        </I18nextProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Import March orders");
  });

  test("its close button speaks the interface language", async () => {
    jest.spyOn(apiClient, "getExecutionProgress").mockResolvedValue(null);
    await i18n.changeLanguage("ru");
    try {
      wrap(
        <OverviewPanel
          runId="run-1"
          run={run()}
          ancestors={[]}
          now={NOW}
          onOpen={() => undefined}
          onClose={() => undefined}
        />,
      );
      await screen.findByRole("dialog");
      expect(screen.getByRole("button", { name: "Закрыть" })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

test("the mounted overview keeps controls, accepted page and focus through a refused query and local retry", async () => {
  const originalEventSource = globalThis.EventSource;
  globalThis.EventSource = class {
    onopen = null;
    onerror = null;
    addEventListener() {}
    close() {}
  } as unknown as typeof EventSource;
  jest.spyOn(apiClient, "getUserSettings").mockResolvedValue({});
  jest
    .spyOn(apiClient, "getFeatures")
    .mockResolvedValue({ deploymentMode: "self-host", features: {} } as never);
  jest
    .spyOn(apiClient, "getWorkflows")
    .mockResolvedValue({ workflows: [], totalWorkflows: 0 } as never);
  let initial!: (value: {
    runs: OverviewRun[];
    total: number;
    offset: number;
    limit: number;
  }) => void;
  let refuse!: (error: unknown) => void;
  const query = jest
    .spyOn(apiClient, "getOverview")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          initial = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    )
    .mockResolvedValue({ runs: [], total: 0, limit: 50, offset: 0 });
  try {
    render(
      <MemoryRouter initialEntries={["/overview?page=2"]}>
        <I18nextProvider i18n={i18n}>
          <FeaturesProvider>
            <GuideProvider>
              <Overview />
            </GuideProvider>
          </FeaturesProvider>
        </I18nextProvider>
      </MemoryRouter>,
    );
    const input = screen.getByRole("searchbox");
    expect(input).toBeInTheDocument();
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    await act(async () => {
      initial({ runs: [run()], total: 75, limit: 50, offset: 50 });
    });
    expect(await screen.findByTestId("overview-card")).toHaveTextContent("Import March orders");
    input.focus();
    fireEvent.click(screen.getByTestId("overview-status-completed"));
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    const region = screen.getByTestId("overview-results-region");
    expect(region).toHaveTextContent("2 / 2");
    expect(region).toHaveTextContent("In progress");
    expect(region).not.toHaveTextContent("Nothing matches the filters");
    expect(screen.getByRole("searchbox")).toBe(input);
    expect(input).toHaveFocus();
    await act(async () => {
      refuse(new Error("Source refused query"));
    });
    expect(within(region).getByRole("alert")).toHaveTextContent("The overview could not be loaded");
    expect(screen.getByTestId("overview-card")).toHaveTextContent("Import March orders");
    expect(region).toHaveTextContent("2 / 2");
    fireEvent.click(within(region).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Nothing matches the filters")).toBeInTheDocument();
    expect(region).toHaveTextContent("Completed");
    expect(region).toHaveTextContent("1 / 1");
    expect(screen.queryByTestId("overview-card")).toBeNull();
    expect(query.mock.calls[2][0]).toMatchObject({ status: "completed", offset: 0 });
  } finally {
    globalThis.EventSource = originalEventSource;
  }
});

describe("a dimmed run in the panel", () => {
  test("the panel says why it is shown, as the card's hint does", async () => {
    jest.spyOn(apiClient, "getExecutionProgress").mockResolvedValue(null);
    wrap(
      <OverviewPanel
        runId="run-1"
        run={run({ matches: false })}
        ancestors={[]}
        now={NOW}
        onOpen={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Shown because another run of this group matches the filters",
    );
  });
});

describe("a dimmed card", () => {
  test("says in words why it is shown", () => {
    wrap(
      <OverviewCard
        run={run({ matches: false })}
        parentTitle={null}
        now={NOW}
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByTestId("overview-card")).toHaveTextContent(
      "Shown because another run of this group matches the filters",
    );
  });
});

describe("wire child-count objects", () => {
  test.each([0, 1])(
    "a card shows %i selected children against the actual global count object",
    async (visible) => {
      const shown = run({
        children: { total: visible, unfinished: visible },
        childrenTotal: { total: 2, unfinished: 1 },
      });
      wrap(<OverviewCard run={shown} parentTitle={null} now={NOW} onOpen={() => undefined} />);
      const flag = screen.getByTestId("overview-flag-children");
      expect(flag).toHaveTextContent(`${visible}/2`);
      act(() => flag.focus());
      const hint = await screen.findByRole("tooltip");
      expect(hint).toHaveTextContent(`Showing ${visible} of 2 child runs`);
      expect(hint).toHaveTextContent("All child runs in progress: 1");
    },
  );

  test.each([0, 1])(
    "the detail explains %i shown children and preserves the complete count object",
    async (visible) => {
      jest.spyOn(apiClient, "getExecutionProgress").mockResolvedValue(null);
      const child = run({
        executionId: "child",
        title: "Child task",
        workflowName: "Child own flow",
        childrenTotal: { total: 0, unfinished: 0 },
      });
      const shown = run({
        children: { total: visible, unfinished: visible },
        childrenTotal: { total: 2, unfinished: 1 },
        childRuns: visible ? [child] : [],
      });
      wrap(
        <OverviewPanel
          runId={shown.executionId}
          run={shown}
          ancestors={[]}
          now={NOW}
          onOpen={() => undefined}
          onClose={() => undefined}
        />,
      );
      const section = await screen.findByTestId("overview-panel-children");
      expect(section).toHaveTextContent(`Showing ${visible} of 2 child runs`);
      expect(section).toHaveTextContent("All child runs in progress: 1");
      expect(section).not.toHaveTextContent("[object Object]");
      if (visible) expect(section).toHaveTextContent("Child own flow");
    },
  );
});

describe("a card's hints", () => {
  test("the status hint opens from the keyboard", async () => {
    wrap(<OverviewCard run={run()} parentTitle={null} now={NOW} onOpen={() => undefined} />);
    const status = screen.getByTestId("overview-status");
    act(() => status.focus());
    const tooltip = await screen.findByRole("tooltip", {}, { timeout: 3000 });
    expect(tooltip).toHaveTextContent("The move is yours");
  });
});

describe("stopped runs in the overview", () => {
  const reason = "The user cancelled the import and asked for a different task.";
  const stopped = () =>
    run({
      status: "stopped",
      stopReason: reason,
      completedAt: NOW - 60_000,
      lastActivityAt: NOW - 30 * 24 * 60 * 60_000,
      subtreeActivityAt: NOW - 30 * 24 * 60 * 60_000,
      stages: {
        entries: [
          { id: "plan", label: "Plan", status: "done" },
          { id: "work", label: "Work", status: "active" },
          { id: "check", label: "Check", status: "pending" },
        ],
        labels: ["Plan", "Work", "Check"],
        activeIndex: 1,
        doneCount: 1,
      },
    });

  test("the card identifies a stopped run, shows its reason and preserves unfinished stages", () => {
    wrap(<OverviewCard run={stopped()} parentTitle={null} now={NOW} onOpen={() => undefined} />);
    expect(screen.getByTestId("overview-status")).toHaveTextContent("Stopped");
    expect(screen.getByTestId("overview-stop-reason")).toHaveTextContent(reason);
    expect(screen.getByTestId("overview-footer")).toHaveTextContent("stopped");
    expect(screen.getByTestId("overview-age")).not.toHaveAttribute("data-stale");
    expect(
      screen.getAllByTestId("overview-plan-item").map((item) => item.getAttribute("data-done")),
    ).toEqual(["true", null, null]);
    expect(
      screen
        .getAllByTestId("overview-plan-item")
        .every((item) => !item.hasAttribute("data-current")),
    ).toBe(true);
    expect(screen.queryByTestId("overview-waiting")).toBeNull();
  });

  test.each([
    ["en", "Reason for stopping", "Stopped", "Completed", "Now"],
    ["ru", "Причина остановки", "Остановлен", "Завершён", "Сейчас"],
  ])(
    "the %s panel shows the full reason and stop time without claiming completion",
    async (language, label, status, completed, nowLabel) => {
      jest.spyOn(apiClient, "getExecutionProgress").mockResolvedValue(null);
      await i18n.changeLanguage(language);
      try {
        wrap(
          <OverviewPanel
            runId="run-1"
            run={stopped()}
            ancestors={[]}
            now={NOW}
            onOpen={() => undefined}
            onClose={() => undefined}
          />,
        );
        const dialog = await screen.findByRole("dialog");
        expect(screen.getByTestId("overview-panel-stop-reason")).toHaveTextContent(label);
        expect(screen.getByTestId("overview-panel-stop-reason")).toHaveTextContent(reason);
        expect(screen.getByTestId("overview-panel-facts")).toHaveTextContent(status);
        expect(screen.getByTestId("overview-panel-facts")).not.toHaveTextContent(completed);
        expect(screen.queryByTestId("overview-panel-step")).toBeNull();
        expect(dialog.querySelector("h3")?.textContent).not.toBe(nowLabel);
        expect(screen.queryByTestId("overview-panel-waiting")).toBeNull();
      } finally {
        await i18n.changeLanguage("en");
      }
    },
  );
});

describe("the live hook", () => {
  /** A stream the test feeds, in a tab that leads alone. */
  function dependencies(): { deps: LiveDependencies; stream: () => FakeStream } {
    let current: FakeStream | null = null;
    return {
      stream: () => current!,
      deps: {
        openStream: () => {
          current = new FakeStream();
          return current;
        },
        pollChanges: async () => ({ reset: false, events: [], lastSeq: 0 }),
        locks: null,
        channel: null,
        isVisible: () => true,
        onVisibilityChange: () => () => undefined,
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
        tabId: "only",
      },
    };
  }

  class FakeStream implements StreamLike {
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private readonly listeners = new Map<string, (event: MessageEvent) => void>();
    addEventListener(type: string, listener: (event: MessageEvent) => void): void {
      this.listeners.set(type, listener);
    }
    close(): void {}
    change(seq: number, executionId: string, kind: string): void {
      this.listeners.get("change")?.({
        lastEventId: String(seq),
        data: JSON.stringify({ executionId, kind }),
      } as MessageEvent);
    }
  }

  function hook() {
    const calls = { refetches: 0 };
    const { deps, stream } = dependencies();
    renderHook(() =>
      useLiveOverview(
        {
          refetchPage: () => {
            calls.refetches += 1;
            return Promise.resolve();
          },
          removeRun: () => undefined,
        },
        () => deps,
      ),
    );
    return { calls, stream };
  }

  test("a page restored from the back-forward cache is live again", () => {
    const opened: number[] = [];
    const { deps } = dependencies();
    const counted: LiveDependencies = {
      ...deps,
      openStream: (after) => {
        opened.push(1);
        return deps.openStream(after);
      },
    };
    renderHook(() =>
      useLiveOverview(
        {
          refetchPage: () => Promise.resolve(),
          removeRun: () => undefined,
        },
        () => counted,
      ),
    );
    expect(opened).toHaveLength(1);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
      const shown = new Event("pageshow") as Event & { persisted?: boolean };
      Object.defineProperty(shown, "persisted", { value: true });
      window.dispatchEvent(shown);
    });
    expect(opened).toHaveLength(2);
  });

  test("authority suspension closes the stream and retires queued changes before a new owner joins", () => {
    jest.useFakeTimers();
    const { deps, stream } = dependencies();
    const refetchPage = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const removeRun = jest.fn<(id: string) => void>();
    renderHook(() => useLiveOverview({ refetchPage, removeRun }, () => deps));
    const former = stream();
    const close = jest.spyOn(former, "close");
    act(() => former.change(1, "former-run", "activity"));
    act(() => suspendReadSession());
    expect(close).toHaveBeenCalledTimes(1);
    act(() => {
      former.change(2, "former-run", "deleted");
      jest.advanceTimersByTime(PAGE_REFETCH_MS);
    });
    expect(removeRun).not.toHaveBeenCalled();
    expect(refetchPage).not.toHaveBeenCalled();
    act(() => observeReadSession("replacement", "replacement-session"));
    expect(stream()).not.toBe(former);
    act(() => stream().change(1, "replacement-run", "deleted"));
    expect(removeRun).toHaveBeenCalledWith("replacement-run");
    act(() => jest.advanceTimersByTime(PAGE_REFETCH_MS));
    expect(refetchPage).toHaveBeenCalledTimes(1);
  });

  test("a burst of activity refreshes the ordered page in one request", () => {
    jest.useFakeTimers();
    const { calls, stream } = hook();
    act(() => {
      stream().change(1, "child-1", "activity");
      stream().change(2, "child-2", "meta");
      stream().change(3, "child-1", "activity");
    });
    expect(calls.refetches).toBe(0);
    act(() => jest.advanceTimersByTime(PAGE_REFETCH_MS));
    expect(calls.refetches).toBe(1);
  });

  test("a change of status refetches the page once instead of refreshing rows", () => {
    jest.useFakeTimers();
    const { calls, stream } = hook();
    act(() => {
      stream().change(1, "child-1", "activity");
      stream().change(2, "child-2", "status");
      stream().change(3, "child-1", "activity");
    });
    act(() => jest.advanceTimersByTime(PAGE_REFETCH_MS));
    expect(calls.refetches).toBe(1);
  });

  test("a detail consumer ignores other runs and refreshes its own renamed heading", () => {
    jest.useFakeTimers();
    const { deps, stream } = dependencies();
    const refresh = jest.fn<() => Promise<void>>().mockResolvedValue();
    renderHook(() =>
      useLiveOverview(
        { executionId: "own-run", refetchPage: refresh, removeRun: () => undefined },
        () => deps,
      ),
    );
    act(() => {
      stream().change(1, "other-run", "activity");
      jest.advanceTimersByTime(PAGE_REFETCH_MS);
    });
    expect(refresh).not.toHaveBeenCalled();
    act(() => {
      stream().change(2, "own-run", "activity");
      jest.advanceTimersByTime(PAGE_REFETCH_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the rows on the page", () => {
  test("a former credential's row answer cannot replace the held row", async () => {
    let answer!: (rows: OverviewRun[]) => void;
    const page = [run()];
    const { result } = renderHook(() =>
      useOverviewRows(
        page,
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refreshRows(["run-1"]);
    });
    act(() => observeReadSession("reader", "renewed-session"));
    await act(async () => {
      answer([run({ title: "Retired credential response" })]);
      await pending;
    });
    expect(result.current.runs[0].title).toBe("Import March orders");
  });
  test("a row refresh that began before a newer page arrives is dropped", async () => {
    let answer!: (rows: OverviewRun[]) => void;
    const fetchRows = () => new Promise<OverviewRun[]>((resolve) => (answer = resolve));
    const first = [run({ title: "Import March orders" })];
    const { result, rerender } = renderHook(
      ({ page }: { page: OverviewRun[] }) => useOverviewRows(page, fetchRows),
      { initialProps: { page: first } },
    );
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refreshRows(["run-1"]);
    });
    // The page is fetched again while the refresh is on its way, with a newer state of the run.
    const newer = [run({ title: "Import March orders", status: "completed" })];
    rerender({ page: newer });
    await act(async () => {
      answer([run({ title: "Import March orders", status: "waiting-agent" })]);
      await refresh;
    });
    expect(result.current.runs[0].status).toBe("completed");
  });

  test("a row refresh after the page replaces the row in place", async () => {
    const fetchRows = async () => [run({ status: "locked" })];
    // The page's rows keep their identity between renders, as a fetched page does.
    const page = [run()];
    const { result } = renderHook(() => useOverviewRows(page, fetchRows));
    await act(async () => {
      await result.current.refreshRows(["run-1"]);
    });
    expect(result.current.runs[0].status).toBe("locked");
  });
});
