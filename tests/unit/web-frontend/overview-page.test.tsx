/** @jest-environment jsdom */
/**
 * The overview's interactive parts in the DOM: the side panel is a modal dialog that closes on Esc
 * and gives focus back, says what the person is waited for and that the answer goes to the agent,
 * and offers no answer form; a card's hint opens from the keyboard; and the live hook turns a burst
 * of changes into one refresh request, while a change of status refetches the page instead.
 */

import React, { useState } from "react";
import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
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

function run(overrides: Partial<OverviewRun> = {}): OverviewRun {
  return {
    executionId: "run-1",
    workflowId: "wf",
    workflowName: "Order import",
    workflowVersion: "1.0.0",
    title: "Import March orders",
    status: "waiting-user",
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
    createdAt: NOW - 2 * 60 * 60_000,
    completedAt: null,
    parentExecutionId: null,
    parent: null,
    children: { total: 0, unfinished: 0 },
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
});

describe("the overview's side panel", () => {
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
      stages: { labels: ["Plan", "Work", "Check"], activeIndex: 1, doneCount: 1 },
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
