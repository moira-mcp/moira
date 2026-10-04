/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import {
  ApiClientError,
  apiClient,
  type OverviewRun,
} from "../../../packages/web-frontend/src/services/api-client";
import {
  ExecutionStopButton,
  ExecutionStopProvider,
  type ExecutionStopTarget,
} from "../../../packages/web-frontend/src/components/execution/ExecutionStop";

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
let admittedOwner: string | null = null;
async function acceptOwner(owner: string | null) {
  admittedOwner = owner;
  await authClient.$store.atoms.session.get().refetch();
}
beforeEach(async () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  await i18n.changeLanguage("en");
  // Settle Better Auth's real session observation, which admits the existing private read scope.
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (new URL(String(input), "http://localhost").pathname !== "/api/auth/get-session")
      throw new Error("Unexpected network request in execution stop fixture");
    return Response.json(
      admittedOwner === null
        ? null
        : {
            user: {
              id: admittedOwner,
              email: `${admittedOwner}@example.test`,
              name: admittedOwner,
            },
            session: {
              id: `${admittedOwner}-session`,
              userId: admittedOwner,
              expiresAt: "2099-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              createdAt: "2026-01-01T00:00:00Z",
            },
          },
    );
  });
  await acceptOwner("owner");
});
afterEach(async () => {
  cleanup();
  await acceptOwner(null);
  jest.restoreAllMocks();
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});

const target: ExecutionStopTarget = {
  executionId: "owned-run",
  title: "Independent task title",
  stopCapability: { available: true, revision: 4 },
};
const stopped = {
  executionId: "owned-run",
  stopped: true as const,
  stopReason: "User cancelled",
  revision: 5,
  changed: true,
  displayStatus: "stopped" as const,
  stopCapability: { available: false as const, revision: 5, reason: "terminal" as const },
};

function row(title: string, revision = 9): OverviewRun {
  return {
    executionId: "owned-run",
    workflowId: "own-flow",
    workflowName: "Own flow",
    workflowVersion: "1.0.0",
    title,
    status: "waiting-agent",
    revision,
    stopCapability: { available: true, revision },
    stopReason: null,
    matches: true,
    waitingForUser: null,
    refusalCount: 0,
    note: "Arbitrary diagnostic note",
    current: null,
    stages: null,
    list: null,
    lastActivityAt: 1,
    idleActivityAt: 1,
    subtreeActivityAt: 1,
    createdAt: 1,
    completedAt: null,
    parentExecutionId: null,
    parent: null,
    children: { total: 0, unfinished: 0 },
    childrenTotal: { total: 0, unfinished: 0 },
    childRuns: [],
  };
}

function Harness({
  targets = [target],
  onStopped = async () => undefined,
  scope = "owner",
  navigate = () => undefined,
}: {
  targets?: ExecutionStopTarget[];
  onStopped?: () => Promise<void>;
  scope?: string;
  navigate?: () => void;
}) {
  return (
    <I18nextProvider i18n={i18n}>
      <ExecutionStopProvider scopeKey={scope} onStopped={onStopped}>
        <main>
          <h1 tabIndex={-1}>Current runs</h1>
          {targets.map((item) => (
            <div key={item.executionId} onClick={navigate}>
              <ExecutionStopButton target={item} />
            </div>
          ))}
        </main>
      </ExecutionStopProvider>
    </I18nextProvider>
  );
}

function openReason(value: string) {
  fireEvent.click(screen.getByTestId("execution-stop-owned-run"));
  const input = screen.getByRole("textbox", { name: "Reason for stopping" });
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("shared execution stop decisions", () => {
  test("null admission refuses an open decision and replacing the authenticated owner retires its reason", async () => {
    const stop = jest.spyOn(apiClient, "stopExecution").mockResolvedValue(stopped);
    render(<Harness />);
    await act(async () => acceptOwner(null));
    fireEvent.click(screen.getByTestId("execution-stop-owned-run"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Reason for stopping" })).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    await act(async () => acceptOwner("owner"));
    openReason("Former owner's unsent reason");
    await act(async () => acceptOwner("replacement"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    await act(async () => acceptOwner("owner"));
    fireEvent.click(screen.getByTestId("execution-stop-owned-run"));
    expect(screen.getByRole("textbox", { name: "Reason for stopping" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Stop task" })).toBeDisabled();
    expect(stop).not.toHaveBeenCalled();
  });

  test("uses authoritative capability, including disabled in-flight and hidden foreign/terminal/unavailable controls", () => {
    render(
      <Harness
        targets={[
          target,
          {
            ...target,
            executionId: "foreign",
            stopCapability: { available: false, revision: 4, reason: "not-owner" },
          },
          {
            ...target,
            executionId: "terminal",
            stopCapability: { available: false, revision: 4, reason: "terminal" },
          },
          {
            ...target,
            executionId: "missing",
            stopCapability: { available: false, revision: null, reason: "unavailable" },
          },
          {
            ...target,
            executionId: "executing",
            stopCapability: { available: false, revision: 4, reason: "in-flight" },
          },
        ]}
      />,
    );
    expect(screen.getByTestId("execution-stop-owned-run")).toBeEnabled();
    expect(screen.getByTestId("execution-stop-executing")).toBeDisabled();
    for (const id of ["foreign", "terminal", "missing"])
      expect(screen.queryByTestId(`execution-stop-${id}`)).toBeNull();
  });

  test("requires a bounded trimmed reason, submits the captured revision once and never navigates the enclosing card", async () => {
    let finish!: (value: typeof stopped) => void;
    const operation = new Promise<typeof stopped>((resolve) => {
      finish = resolve;
    });
    const stop = jest.spyOn(apiClient, "stopExecution").mockReturnValue(operation);
    const navigate = jest.fn<() => void>();
    const refresh = jest.fn<() => Promise<void>>().mockResolvedValue();
    render(<Harness navigate={navigate} onStopped={refresh} />);
    const reason = openReason("   ");
    const confirm = screen.getByRole("button", { name: "Stop task" });
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: "a".repeat(501) } });
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: "  User cancelled  " } });
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("owned-run", {
      expectedRevision: 4,
      reason: "User cancelled",
    });
    expect(reason).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => finish(stopped));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("a 409 retains the reason and requires an explicit new decision rather than retrying automatically", async () => {
    const refusal = new ApiClientError("private diagnostic", undefined, 409, {
      stopRefusal: "stale",
      currentRevision: 7,
      stopCapability: { available: true, revision: 7 },
    });
    const stop = jest
      .spyOn(apiClient, "stopExecution")
      .mockRejectedValueOnce(refusal)
      .mockResolvedValueOnce(stopped);
    const read = jest
      .spyOn(apiClient, "getOverviewRows")
      .mockResolvedValue([row("Current renamed task")]);
    render(<Harness />);
    const reason = openReason("Keep this reason");
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    const error = await screen.findByTestId("execution-stop-error");
    expect(error).toHaveTextContent("The run changed");
    expect(error).not.toHaveTextContent("private diagnostic");
    expect(reason).toHaveValue("Keep this reason");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Stop task" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Use the current state for a new decision" }),
    );
    expect(reason).toHaveValue("Keep this reason");
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop task" })).toBeEnabled());
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Current renamed task");
    expect(read).toHaveBeenCalledWith(["owned-run"]);
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(stop).toHaveBeenLastCalledWith("owned-run", {
      expectedRevision: 9,
      reason: "Keep this reason",
    });
  });

  test("live same-run naming changes the open description without replacing the captured guard or pending decision", async () => {
    let finish!: (value: typeof stopped) => void;
    const operation = new Promise<typeof stopped>((resolve) => {
      finish = resolve;
    });
    const stop = jest.spyOn(apiClient, "stopExecution").mockReturnValue(operation);
    const view = render(<Harness />);
    const reason = openReason("Preserve partial work");
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    view.rerender(
      <Harness
        targets={[
          {
            ...target,
            title: "Current live task title",
            stopCapability: { available: true, revision: 99 },
          },
        ]}
      />,
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Current live task title");
    expect(reason).toHaveValue("Preserve partial work");
    expect(reason).toBeDisabled();
    expect(stop).toHaveBeenCalledWith("owned-run", {
      expectedRevision: 4,
      reason: "Preserve partial work",
    });
    await act(async () => finish(stopped));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("in-flight refusal can be explicitly reviewed after the step finishes with the same reason", async () => {
    const stop = jest
      .spyOn(apiClient, "stopExecution")
      .mockRejectedValueOnce(
        new ApiClientError("executing", undefined, 409, { stopRefusal: "in-flight" }),
      )
      .mockResolvedValueOnce(stopped);
    const read = jest
      .spyOn(apiClient, "getOverviewRows")
      .mockResolvedValueOnce([
        {
          ...row("Still executing"),
          stopCapability: { available: false, revision: 9, reason: "in-flight" },
        },
      ])
      .mockResolvedValueOnce([row("Finished step", 10)]);
    render(<Harness />);
    const reason = openReason("Keep the user's reason");
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    await screen.findByTestId("execution-stop-error");
    fireEvent.click(
      screen.getByRole("button", { name: "Use the current state for a new decision" }),
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Stop task" })).toBeDisabled();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Use the current state for a new decision" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use the current state for a new decision" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop task" })).toBeEnabled());
    expect(reason).toHaveValue("Keep the user's reason");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Finished step");
    expect(stop).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
    expect(stop).toHaveBeenLastCalledWith("owned-run", {
      expectedRevision: 10,
      reason: "Keep the user's reason",
    });
  });

  test("a current first review error is shown, while an obsolete A review cannot affect new A after B", async () => {
    let reject!: (error: Error) => void;
    const delayed = new Promise<OverviewRun[]>((_yes, no) => {
      reject = no;
    });
    jest
      .spyOn(apiClient, "stopExecution")
      .mockRejectedValue(new ApiClientError("changed", undefined, 409, { stopRefusal: "stale" }));
    const read = jest
      .spyOn(apiClient, "getOverviewRows")
      .mockRejectedValueOnce(new Error("current read failure"))
      .mockReturnValueOnce(delayed);
    const view = render(<Harness scope="A" />);
    openReason("Original A reason");
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    await screen.findByTestId("execution-stop-error");
    fireEvent.click(
      screen.getByRole("button", { name: "Use the current state for a new decision" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("execution-stop-error")).toHaveTextContent(
        "The current task could not be loaded",
      ),
    );
    expect(screen.getByRole("textbox", { name: "Reason for stopping" })).toHaveValue(
      "Original A reason",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use the current state for a new decision" }),
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    view.rerender(<Harness scope="B" />);
    view.rerender(<Harness scope="A" />);
    const reason = openReason("Fresh A reason");
    await act(async () => reject(new Error("obsolete review failure")));
    expect(reason).toHaveValue("Fresh A reason");
    expect(screen.queryByTestId("execution-stop-error")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop task" })).toBeEnabled();
  });

  test("late A refusal cannot change a fresh A decision after switching scope A to B to A", async () => {
    let reject!: (value: Error) => void;
    const operation = new Promise<typeof stopped>((_resolve, no) => {
      reject = no;
    });
    const stop = jest.spyOn(apiClient, "stopExecution").mockReturnValueOnce(operation);
    const refresh = jest.fn<() => Promise<void>>().mockResolvedValue();
    const view = render(<Harness scope="A" onStopped={refresh} />);
    openReason("Original A reason");
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    view.rerender(<Harness scope="B" onStopped={refresh} />);
    view.rerender(<Harness scope="A" onStopped={refresh} />);
    const reason = openReason("Fresh A reason");
    await act(async () =>
      reject(new ApiClientError("old failure", undefined, 409, { stopRefusal: "terminal" })),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(reason).toHaveValue("Fresh A reason");
    expect(screen.queryByTestId("execution-stop-error")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop task" })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("focus returns to a current page target when the successful stop removes its opener", async () => {
    jest.spyOn(apiClient, "stopExecution").mockResolvedValue(stopped);
    function RemovingHarness() {
      const [targets, setTargets] = React.useState([target]);
      return <Harness targets={targets} onStopped={async () => setTargets([])} />;
    }
    render(<RemovingHarness />);
    screen.getByTestId("execution-stop-owned-run").focus();
    openReason("Remove the run");
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Current runs" })).toHaveFocus(),
    );
  });

  test("a page refresh failure does not invite a second stop after the mutation succeeded", async () => {
    const stop = jest.spyOn(apiClient, "stopExecution").mockResolvedValue(stopped);
    function RefreshFailure() {
      const [error, setError] = React.useState(false);
      return (
        <>
          <Harness
            onStopped={async () => {
              setError(true);
              throw new Error("refresh failed");
            }}
          />
          {error ? <p role="alert">Current list unavailable</p> : null}
        </>
      );
    }
    render(<RefreshFailure />);
    openReason("Committed reason");
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("alert")).toHaveTextContent("Current list unavailable");
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
