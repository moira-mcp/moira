import { describe, expect, test } from "@jest/globals";
import {
  GraphValidator,
  deriveProcess,
  type ProcessDiagnosticCode,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { systemCatalogGraph } from "../../helpers/catalog-graphs.js";

function bundled(slug: string): WorkflowGraph {
  return systemCatalogGraph(slug, "public");
}

function counts(workflow: WorkflowGraph) {
  const projection = deriveProcess(workflow)!;
  return {
    blocks: projection.blocks.length,
    transitions: projection.blocks.reduce((n, b) => n + b.transitions.length, 0),
    cycles: projection.blocks.reduce((n, b) => n + b.transitions.filter((t) => t.cycle).length, 0),
    diagnostics: projection.diagnostics.map((d) => d.code),
    order: projection.blocks.map((b) => b.id),
  };
}

function codes(workflow: WorkflowGraph): ProcessDiagnosticCode[] {
  return deriveProcess(workflow)!.diagnostics.map((d) => d.code);
}

/** A small synthetic process: two blocks, one forward edge, one explained return. */
function synthetic(): WorkflowGraph {
  return {
    metadata: { name: "Synthetic", version: "1.0.0", description: "" },
    variableRegistry: {
      progress_work_outcome: { type: "string", description: "Work outcome" },
    },
    progress: {
      nodes: [
        {
          id: "work",
          label: "Work",
          content: { summary: "Do the work", outcome: "{{progress_work_outcome}}" },
        },
        { id: "check", label: "Check", content: { summary: "Check the work" } },
      ],
    },
    nodes: [
      { id: "start", type: "start", progressNodeId: "work", connections: { default: "do" } },
      {
        id: "do",
        type: "agent-directive",
        progressNodeId: "work",
        directive: "Do",
        completionCondition: "Done",
        inputSchema: { type: "object", properties: {}, globalInputs: ["progress_work_outcome"] },
        connections: { success: "verify" },
        connectionLabels: { success: "work done" },
      },
      {
        id: "verify",
        type: "condition",
        progressNodeId: "check",
        condition: { operator: "eq", left: { contextPath: "do.ok" }, right: true },
        connections: { true: "end", false: "do" },
        connectionLabels: {
          false: {
            label: "check failed",
            cycle: { cause: "The check found a problem", exit: "The check passes" },
          },
        },
      },
      { id: "end", type: "end", progressNodeId: "check" },
    ],
  } as WorkflowGraph;
}

describe("process derivation from the authored graph", () => {
  test("derives the annotated Quick Task exactly: seven blocks, eleven transitions, five returns, no diagnostics", () => {
    expect(counts(bundled("quick-task"))).toEqual({
      blocks: 7,
      transitions: 11,
      cycles: 5,
      diagnostics: [],
      order: ["scope", "plan", "plan-review", "plan-approval", "execute", "verify", "deliver"],
    });
  });

  test("derives the annotated Software Development Flow in authored order with its hubs and no diagnostics", () => {
    const result = counts(bundled("software-development-flow"));
    expect(result.blocks).toBe(15);
    expect(result.transitions).toBe(49);
    expect(result.cycles).toBe(23);
    expect(result.diagnostics).toEqual([]);
    expect(result.order.slice(0, 4)).toEqual(["intake", "health", "plan", "plan-approval"]);
    expect(result.order.slice(-3)).toEqual(["replan", "finalize", "stopped"]);
    expect(deriveProcess(bundled("software-development-flow"))!.hubs).toEqual([
      "plan",
      "implement",
      "replan",
      "stopped",
    ]);
  });

  test.each([
    [
      "todo-list",
      { blocks: 3, transitions: 5, cycles: 2, order: ["checklist", "prepare", "work"] },
    ],
    [
      "robust-task",
      {
        blocks: 6,
        transitions: 21,
        cycles: 12,
        order: ["intake", "plan", "execute", "step-review", "final-review", "deliver"],
      },
    ],
    [
      "workflow-management-flow",
      {
        blocks: 6,
        transitions: 27,
        cycles: 12,
        order: ["source", "requirements", "design", "build", "review", "delivery"],
      },
    ],
    [
      "user-onboarding",
      { blocks: 3, transitions: 5, cycles: 1, order: ["welcome", "choose", "launch"] },
    ],
  ])("derives the annotated %s with its block structure and no diagnostics", (slug, expected) => {
    expect(counts(bundled(slug))).toEqual({ ...expected, diagnostics: [] });
  });

  test("returns null for a workflow without progress", () => {
    const workflow = synthetic();
    delete workflow.progress;
    expect(deriveProcess(workflow)).toBeNull();
  });

  test("a synthetic process derives a labelled forward transition and an explained return", () => {
    const projection = deriveProcess(synthetic())!;
    expect(projection.diagnostics).toEqual([]);
    expect(projection.blocks[0].transitions).toEqual([
      { to: "check", label: "work done", edges: ["do.success"] },
    ]);
    expect(projection.blocks[1].transitions).toEqual([
      {
        to: "work",
        label: "check failed",
        cycle: { cause: "The check found a problem", exit: "The check passes" },
        edges: ["verify.false"],
      },
    ]);
  });

  test.each<[string, (w: WorkflowGraph) => void, ProcessDiagnosticCode[]]>([
    // Detaching the only routing node of a block also leaves that block without a transition in
    // or out, and the derivation reports both facts rather than hiding the second behind the first.
    [
      "an unowned routing node",
      (w) => delete w.nodes[2].progressNodeId,
      ["unowned-node", "unconnected-block"],
    ],
    [
      "a node owned by an unknown block",
      (w) => {
        w.nodes[1].progressNodeId = "ghost";
      },
      ["unknown-block", "outcome-unowned", "unconnected-block"],
    ],
    [
      "a block without a description",
      (w) => {
        w.progress!.nodes[1].content = { next: "Finish" };
      },
      ["empty-description"],
    ],
    [
      "a boundary edge without a label",
      (w) => delete (w.nodes[1] as { connectionLabels?: unknown }).connectionLabels,
      ["unlabeled-edge"],
    ],
    [
      "a return without a cycle explanation",
      (w) => {
        (w.nodes[2] as { connectionLabels: Record<string, unknown> }).connectionLabels = {
          false: "check failed",
        };
      },
      ["unexplained-cycle"],
    ],
    [
      "an outcome template on a block owning no writer",
      (w) => {
        w.progress!.nodes[1].content = {
          summary: "Check the work",
          outcome: "{{progress_work_outcome}}",
        };
        w.progress!.nodes[0].content = { summary: "Do the work" };
      },
      ["outcome-unowned"],
    ],
    [
      "the same outcome template on two blocks",
      (w) => {
        w.progress!.nodes[1].content = {
          summary: "Check the work",
          outcome: "{{progress_work_outcome}}",
        };
      },
      ["outcome-duplicate", "outcome-duplicate"],
    ],
  ])("reports %s", (_name, mutate, expected) => {
    const workflow = synthetic();
    mutate(workflow);
    expect(codes(workflow)).toEqual(expected);
  });

  test("a transition to an earlier block is a return even when the node walk finished that block first", () => {
    const workflow = synthetic();
    // Route the check's failure through a fresh node of the first block that the walk never reached
    // from start before finishing it: still a return by process order.
    workflow.nodes.push({
      id: "redo",
      type: "agent-directive",
      progressNodeId: "work",
      directive: "Redo",
      completionCondition: "Done",
      connections: { success: "verify" },
      connectionLabels: { success: "redone" },
      // A node whose only connection is a self-retry: the derivation must report it as
      // unconnected, and an agent-directive node cannot declare that shape in the type.
    } as unknown as WorkflowGraph["nodes"][number]);
    (workflow.nodes[2] as { connections: Record<string, string> }).connections.false = "redo";
    const projection = deriveProcess(workflow)!;
    expect(projection.diagnostics).toEqual([]);
    expect(projection.blocks[1].transitions[0].cycle).toBeDefined();
  });

  test("a hub is a block that at least three blocks lead into", () => {
    expect(deriveProcess(bundled("quick-task"))!.hubs).toEqual([]);
  });

  test("a block with no transition to or from another block is reported as unconnected, even when it returns to itself", () => {
    const workflow = synthetic();
    workflow.progress!.nodes.push({
      id: "orphan",
      label: "Orphan",
      content: { summary: "Nothing leads here" },
    });
    workflow.nodes.push({
      id: "lonely",
      type: "agent-directive",
      progressNodeId: "orphan",
      directive: "Wait",
      completionCondition: "Never",
      connections: { retry: "lonely" },
      connectionLabels: {
        retry: { label: "try again", cycle: { cause: "Not done", exit: "Done" } },
      },
      // A node whose only connection is a self-retry: the derivation must report it as
      // unconnected, and an agent-directive node cannot declare that shape in the type.
    } as unknown as WorkflowGraph["nodes"][number]);
    const projection = deriveProcess(workflow)!;
    expect(projection.diagnostics).toEqual([
      {
        code: "unconnected-block",
        blockId: "orphan",
        message: expect.stringContaining("'orphan' has no transition to or from another block"),
      },
    ]);
    // The start block leads out and the terminal block is led into: neither is reported.
    expect(projection.blocks.map((b) => b.id)).toEqual(["work", "check", "orphan"]);
  });

  test.each([
    "quick-task",
    "todo-list",
    "robust-task",
    "software-development-flow",
    "workflow-management-flow",
    "user-onboarding",
  ])("the annotated %s has no unconnected block", (slug) => {
    expect(codes(bundled(slug))).not.toContain("unconnected-block");
  });
});

describe("validator enforces the block contract through the derivation", () => {
  const validator = new GraphValidator();

  test("the annotated Quick Task validates with zero errors", async () => {
    const result = await validator.validateUnified(bundled("quick-task"));
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  test("a Quick Task copy with one node unowned, one boundary label removed and one description blank fails with exactly those diagnostics", async () => {
    const workflow = bundled("quick-task");
    const check = workflow.nodes.find((n) => n.id === "check-plan-review-clean")!;
    delete check.progressNodeId;
    const approved = workflow.nodes.find((n) => n.id === "check-plan-approved")!;
    delete (approved as { connectionLabels?: Record<string, unknown> }).connectionLabels!.true;
    workflow.progress!.nodes.find((b) => b.id === "plan")!.content = {
      outcome: "{{progress_plan_outcome}}",
    };
    const result = await validator.validateUnified(workflow);
    const errors = result.issues.filter((i) => i.severity === "error").map((i) => i.message);
    expect(errors.map((m) => m.match(/^\[([a-z-]+)\]/)?.[1])).toEqual([
      "unowned-node",
      "empty-description",
      "unlabeled-edge",
    ]);
    expect(errors[0]).toContain("check-plan-review-clean");
    expect(errors[2]).toContain("check-plan-approved.true");
  });

  test("an unconnected block is a validation error on its progress entry", async () => {
    const workflow = bundled("quick-task");
    workflow.progress!.nodes.push({
      id: "orphan",
      label: "Orphan",
      content: { summary: "Nothing leads here" },
    });
    workflow.nodes.push({
      id: "lonely",
      type: "agent-directive",
      progressNodeId: "orphan",
      directive: "Wait",
      completionCondition: "Never",
      connections: { success: "lonely" },
      connectionLabels: {
        success: { label: "try again", cycle: { cause: "Not done", exit: "Done" } },
      },
      // A node whose only connection is a self-retry: the derivation must report it as
      // unconnected, and an agent-directive node cannot declare that shape in the type.
    } as unknown as WorkflowGraph["nodes"][number]);
    const result = await validator.validateUnified(workflow);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([
      expect.objectContaining({
        field: "progress.nodes[7]",
        message: expect.stringContaining("[unconnected-block] Progress block 'orphan'"),
      }),
    ]);
  });

  test("the same copy without progress passes: a workflow without progress is unaffected", async () => {
    const workflow = bundled("quick-task");
    delete workflow.nodes.find((n) => n.id === "check-plan-review-clean")!.progressNodeId;
    delete workflow.progress;
    for (const node of workflow.nodes) delete node.progressNodeId;
    for (const node of workflow.nodes) {
      delete (node as { progressActiveLabel?: string }).progressActiveLabel;
      delete (node as { progressActiveContent?: unknown }).progressActiveContent;
    }
    const result = await validator.validateUnified(workflow);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  test("outcome templates must sit on exactly one block that owns a writer", async () => {
    const moved = bundled("quick-task");
    moved.progress!.nodes.find((b) => b.id === "plan")!.content = { summary: "Draft the plan" };
    moved.progress!.nodes.find((b) => b.id === "execute")!.content = {
      summary: "Execute plan steps",
      outcome: "{{progress_plan_outcome}}",
    };
    let errors = (await validator.validateUnified(moved)).issues.filter(
      (i) => i.severity === "error",
    );
    expect(errors.map((i) => i.message)).toEqual([expect.stringContaining("[outcome-unowned]")]);

    const duplicated = bundled("quick-task");
    duplicated.progress!.nodes.find((b) => b.id === "execute")!.content = {
      summary: "Execute plan steps",
      outcome: "{{progress_plan_outcome}}",
    };
    errors = (await validator.validateUnified(duplicated)).issues.filter(
      (i) => i.severity === "error",
    );
    expect(errors.map((i) => i.message)).toEqual([
      expect.stringContaining("[outcome-duplicate]"),
      expect.stringContaining("[outcome-duplicate]"),
    ]);
  });
});
