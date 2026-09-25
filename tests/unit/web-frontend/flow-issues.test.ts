/** @jest-environment jsdom */
/**
 * Where the flow page shows a definition's problems and when it lets the draft be saved: the
 * browser's process diagnostics and the server's located validation issues placed on an edge, a
 * node, a block or the page; the save gate over every combination of a changed draft, process
 * diagnostics and the state of the server's dry run; and the dry run itself, whose answer for an
 * earlier draft never becomes the answer for the current one.
 */

import { describe, expect, test } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react";
import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import {
  processDiagnosticMessage,
  type ProcessDiagnostic,
} from "@mcp-moira/workflow-engine/process";
import {
  issuesOfNode,
  placeIssues,
  saveGate,
  type DryRun,
} from "../../../packages/web-frontend/src/components/flow/issues.js";
import { useDraftValidation } from "../../../packages/web-frontend/src/components/flow/useDraftValidation.js";
import type { WorkflowValidationStatus } from "../../../packages/web-frontend/src/types/react-flow-types.js";
import type { WorkflowGraph } from "../../../packages/web-frontend/src/types/workflow-types.js";

const quickTask = (): WorkflowGraph =>
  JSON.parse(JSON.stringify(findCatalogEntryBySlug("quick-task")!.graph)) as WorkflowGraph;

function status(issues: WorkflowValidationStatus["issues"]): WorkflowValidationStatus {
  const errors = (issues ?? []).filter((i) => i.severity === "error");
  return {
    isValid: errors.length === 0,
    nodeValidation: {},
    globalErrors: [],
    globalWarnings: [],
    issues,
  };
}

const CLEAN = status([]);
const INVALID = status([
  { type: "node", severity: "error", nodeId: "create-plan", field: "directive", message: "bad" },
]);

describe("issue placement", () => {
  test("a connection's issue sits on its edge, a node's on the node, the rest on the block or page", () => {
    const graph = quickTask();
    const diagnostics: ProcessDiagnostic[] = [
      {
        code: "unlabeled-edge",
        nodeId: "plan-review",
        edge: "plan-review.success",
        message: "Edge crosses",
      },
      { code: "empty-description", blockId: "plan", message: "Block has no description" },
    ];
    const validation = status([
      {
        type: "connection",
        severity: "error",
        nodeId: "plan-review",
        field: "connections.route-operating-mode-plan-approval",
        message: "Dangling",
      },
      {
        type: "node",
        severity: "warning",
        nodeId: "repair-plan",
        field: "connectionLabels.success",
        message: "Label",
      },
      {
        type: "node",
        severity: "error",
        nodeId: "create-plan",
        field: "directive",
        message: "Undeclared",
      },
      // A case output that names no connection has no edge to sit on: it stays on the node.
      {
        type: "node",
        severity: "error",
        nodeId: "check-steps-remaining",
        field: "connections.missing",
        message: "Unknown output",
      },
      { type: "node", severity: "error", nodeId: "gone", field: "directive", message: "Removed" },
      { type: "schema", severity: "error", message: "Registry default is not a number" },
      // The server's restatement of a process diagnostic is shown once, from the browser's layer;
      // a bracketed node type is not such a restatement.
      {
        type: "structure",
        severity: "error",
        nodeId: "plan-review",
        field: "connectionLabels.success",
        message: processDiagnosticMessage(diagnostics[0]),
      },
      {
        type: "node",
        severity: "error",
        nodeId: "get-task",
        message: "[agent-directive] Missing completion condition",
      },
    ]);

    const placed = placeIssues(graph, diagnostics, validation);

    const messages = (list: { message: string }[] | undefined) =>
      (list ?? []).map((i) => i.message);
    expect(messages(placed.edges.get("plan-review.success"))).toEqual(["Edge crosses"]);
    expect(messages(placed.edges.get("plan-review.route-operating-mode-plan-approval"))).toEqual([
      "Dangling",
    ]);
    expect(messages(placed.edges.get("repair-plan.success"))).toEqual(["Label"]);
    expect(messages(placed.nodes.get("create-plan"))).toEqual(["Undeclared"]);
    expect(messages(placed.nodes.get("check-steps-remaining"))).toEqual(["Unknown output"]);
    expect(messages(placed.blocks.get("plan"))).toEqual(["Block has no description"]);
    expect(messages(placed.page)).toEqual(["Removed", "Registry default is not a number"]);
    // A step card shows its own problems and its connections'.
    expect(messages(issuesOfNode(placed, "plan-review"))).toEqual(["Edge crosses", "Dangling"]);
    expect(messages(placed.nodes.get("get-task"))).toEqual([
      "[agent-directive] Missing completion condition",
    ]);
    expect(placed.all).toHaveLength(9);
  });

  test("a status without located issues is read from its per-node and global lists", () => {
    const graph = quickTask();
    const placed = placeIssues(graph, [], {
      isValid: false,
      nodeValidation: { "get-task": { isValid: false, errors: ["broken"], warnings: ["odd"] } },
      globalErrors: ["global"],
      globalWarnings: [],
    });
    expect(placed.nodes.get("get-task")!.map((i) => [i.severity, i.message])).toEqual([
      ["error", "broken"],
      ["warning", "odd"],
    ]);
    expect(placed.page.map((i) => i.message)).toEqual(["global"]);
  });
});

describe("save gate", () => {
  const draft = quickTask();
  const earlier = quickTask();
  const states: Record<string, DryRun> = {
    pending: { status: "pending" },
    stale: { status: "done", draft: earlier, validation: CLEAN },
    "current with errors": { status: "done", draft, validation: INVALID },
    "current, check failed": { status: "failed", draft, message: "offline" },
    "current clean": { status: "done", draft, validation: CLEAN },
  };
  const cases = [true, false].flatMap((changed) =>
    [0, 2].flatMap((diagnostics) =>
      Object.keys(states).map((dryRun) => [changed, diagnostics, dryRun] as const),
    ),
  );

  test.each(cases)(
    "changed=%s, process diagnostics=%s, dry run %s",
    (changed, diagnostics, dryRun) => {
      const gate = saveGate({ changed, diagnostics, draft, dryRun: states[dryRun] });
      const expected = changed && diagnostics === 0 && dryRun === "current clean";
      expect(gate.enabled).toBe(expected);
      if (changed && diagnostics === 0) {
        expect(gate.reason).toBe(
          {
            pending: "checking",
            stale: "stale",
            "current with errors": "invalid",
            "current, check failed": "check-failed",
            "current clean": "ready",
          }[dryRun],
        );
      }
    },
  );
});

describe("the draft's dry run", () => {
  function deferred() {
    let resolve!: (value: WorkflowValidationStatus) => void;
    const promise = new Promise<WorkflowValidationStatus>((res) => (resolve = res));
    return { promise, resolve };
  }

  test("an answer for an earlier draft never becomes the answer for the current one", async () => {
    const calls: Array<{ draft: WorkflowGraph; answer: ReturnType<typeof deferred> }> = [];
    const validate = (draft: WorkflowGraph) => {
      const answer = deferred();
      calls.push({ draft, answer });
      return answer.promise;
    };
    const first = quickTask();
    const second = quickTask();
    const { result, rerender } = renderHook(
      ({ draft }: { draft?: WorkflowGraph }) => useDraftValidation(validate, draft, 0),
      { initialProps: { draft: first } as { draft?: WorkflowGraph } },
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    rerender({ draft: second });
    expect(result.current.dryRun.status).toBe("pending");
    await waitFor(() => expect(calls).toHaveLength(2));

    await act(async () => calls[0].answer.resolve(CLEAN));
    expect(result.current.dryRun.status).toBe("pending");
    await act(async () => calls[1].answer.resolve(INVALID));
    expect(result.current.dryRun).toEqual({ status: "done", draft: second, validation: INVALID });
    expect(result.current.latest).toBe(INVALID);

    // A refused save's answer is accepted for the draft on the page, and only for it.
    act(() => result.current.accept(first, CLEAN));
    expect(result.current.dryRun).toEqual({ status: "done", draft: second, validation: INVALID });
    act(() => result.current.accept(second, CLEAN));
    expect(result.current.dryRun).toEqual({ status: "done", draft: second, validation: CLEAN });

    // The next draft is pending; the session's latest answer stays for the page to show.
    const third = quickTask();
    rerender({ draft: third });
    expect(result.current.dryRun.status).toBe("pending");
    expect(result.current.latest).toBe(CLEAN);

    rerender({ draft: undefined });
    expect(result.current.dryRun).toEqual({ status: "idle" });
    expect(result.current.latest).toBeNull();
  });
});
