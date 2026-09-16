/**
 * Pure helpers of the run page: the projection joined into blocks, the route grouped into
 * stretches with loop markers, per-block visit counts under a cursor, the cursor clamp, and the
 * step descriptions read from a workflow definition.
 */

import { describe, expect, test } from "@jest/globals";
import type { ExecutionProgress } from "@mcp-moira/workflow-engine/progress-visual";
import {
  blockWrites,
  currentBlockId,
  evidenceFields,
  firstSentence,
  runBlocks,
  stepsOf,
} from "../../../packages/web-frontend/src/components/run/model.js";
import {
  blockRouteStats,
  changesText,
  clampCursor,
  exitLabel,
  segmentsOf,
} from "../../../packages/web-frontend/src/components/run/route.js";
import type { WorkflowGraph } from "../../../packages/web-frontend/src/types/workflow-types.js";

function progress(): ExecutionProgress {
  const node = (
    id: string,
    label: string,
    status: ExecutionProgress["nodes"][number]["status"],
    iterations = 1,
  ) => ({
    id,
    label,
    state:
      status === "pending"
        ? ("pending" as const)
        : status === "active" || status === "waiting"
          ? ("current" as const)
          : ("completed" as const),
    status,
    iterations,
    visits: iterations,
    currentNodeId: status === "waiting" ? "review-step" : null,
    connections: {},
    primaryNodeIds: [],
    focusNodeId: null,
    content: { summary: null, details: [], outcome: null, next: null },
    timing: { passes: [], totalMs: null, currentMs: null, recorded: false },
    list: null,
  });
  return {
    taskTitle: "Task",
    title: null,
    goal: null,
    facts: [],
    activeNodeId: "review",
    nodes: [
      node("plan", "Plan", "done"),
      node("review", "Independent review", "waiting", 2),
      node("repair", "Repair", "done"),
      node("deliver", "Deliver", "pending", 0),
    ],
    workflowVersion: "1.0.0",
    executionWorkflowVersion: "1.0.0",
    projectedAt: 0,
    waitingFor: null,
    executionRevision: 7,
    executionStatus: "running",
    diagnostics: [],
    process: {
      blocks: [
        {
          id: "plan",
          label: "Plan",
          description: "Write the plan.",
          outcome: null,
          nodeIds: ["start", "plan-step"],
          transitions: [{ to: "review", label: "plan written", edges: ["plan-step.success"] }],
        },
        {
          id: "review",
          label: "Independent review",
          description: "Review the plan.",
          outcome: null,
          nodeIds: ["review-step", "check"],
          transitions: [
            { to: "repair", label: "defects found", edges: ["check.false"] },
            { to: "deliver", label: "review clean", edges: ["check.true"] },
          ],
        },
        {
          id: "repair",
          label: "Repair",
          description: "Fix the plan.",
          outcome: null,
          nodeIds: ["repair-step"],
          transitions: [
            {
              to: "review",
              label: "repaired",
              cycle: { cause: "defects", exit: "clean review" },
              edges: ["repair-step.success"],
            },
          ],
        },
        {
          id: "deliver",
          label: "Deliver",
          description: "Ship it.",
          outcome: null,
          nodeIds: ["deliver-step", "end"],
          transitions: [],
        },
      ],
      hubs: [],
      backEdges: ["repair-step.success"],
      diagnostics: [],
    },
    route: [
      { seq: 0, nodeId: "start", blockId: "plan", exitKey: "default", changed: ["unit"] },
      {
        seq: 1,
        nodeId: "plan-step",
        blockId: "plan",
        exitKey: "success",
        changed: ["plan"],
        waited: true,
      },
      {
        seq: 2,
        nodeId: "review-step",
        blockId: "review",
        exitKey: "success",
        changed: [],
        waited: true,
      },
      { seq: 3, nodeId: "check", blockId: "review", exitKey: "false", changed: [] },
      {
        seq: 4,
        nodeId: "repair-step",
        blockId: "repair",
        exitKey: "success",
        changed: ["plan"],
        waited: true,
      },
      {
        seq: 5,
        nodeId: "repair-step",
        blockId: "repair",
        exitKey: null,
        changed: ["plan"],
        adjusted: true,
        actor: { role: "user", userId: "u" },
      },
      {
        seq: 6,
        nodeId: "review-step",
        blockId: "review",
        exitKey: null,
        changed: [],
        waited: true,
        loop: true,
      },
    ],
    variables: [
      {
        name: "plan",
        kind: "variable",
        current: "v2",
        adjusted: true,
        history: [
          { seq: 1, nodeId: "plan-step", value: "v1" },
          { seq: 4, nodeId: "repair-step", value: "v2" },
          { seq: 5, nodeId: "repair-step", value: "v2", adjusted: true },
        ],
      },
      {
        name: "unit",
        kind: "variable",
        current: 1,
        adjusted: false,
        history: [{ seq: 0, nodeId: "start", value: 1 }],
      },
    ],
    routeRecorded: true,
    cursor: null,
    source: "trace",
  };
}

describe("run blocks from the projection", () => {
  test("joins process blocks with their run state in process order", () => {
    const blocks = runBlocks(progress());
    expect(
      blocks.map((b) => [b.index, b.id, b.status, b.iterations, b.transitions.length]),
    ).toEqual([
      [0, "plan", "done", 1, 1],
      [1, "review", "waiting", 2, 2],
      [2, "repair", "done", 1, 1],
      [3, "deliver", "pending", 0, 0],
    ]);
    expect(blocks[1].currentNodeId).toBe("review-step");
    expect(currentBlockId(blocks)).toBe("review");
  });

  test("a rendered summary that repeats the block's description or name is dropped, a templated one kept", () => {
    const base = progress();
    const withSummary = (summary: string): ExecutionProgress => ({
      ...base,
      nodes: base.nodes.map((node) =>
        node.id === "plan" ? { ...node, content: { ...node.content, summary } } : node,
      ),
    });
    expect(runBlocks(withSummary("Write the plan. "))[0].content.summary).toBeNull();
    expect(runBlocks(withSummary(runBlocks(base)[0].name))[0].content.summary).toBeNull();
    expect(runBlocks(withSummary("Plan r3 written."))[0].content.summary).toBe("Plan r3 written.");
  });

  test("carries each block's timings and bound list from the projection", () => {
    const base = progress();
    const timed: ExecutionProgress = {
      ...base,
      nodes: base.nodes.map((node) =>
        node.id === "review"
          ? {
              ...node,
              timing: {
                passes: [
                  {
                    seq: 2,
                    nodeId: "review-step",
                    enteredAt: 1_000,
                    leftAt: 13_000,
                    durationMs: 12_000,
                    open: false,
                    itemIndex: 0,
                  },
                  {
                    seq: 6,
                    nodeId: "review-step",
                    enteredAt: 20_000,
                    leftAt: null,
                    durationMs: 5_000,
                    open: true,
                    itemIndex: 1,
                  },
                ],
                totalMs: 17_000,
                currentMs: 5_000,
                recorded: true,
              },
              list: {
                items: [
                  { index: 0, title: "unit one", done: true, current: false, durationMs: 12_000 },
                  { index: 1, title: "unit two", done: false, current: true, durationMs: 5_000 },
                ],
                done: 1,
                total: 2,
                current: 1,
                currentTitle: "unit two",
              },
            }
          : node,
      ),
    };
    const blocks = runBlocks(timed);
    const review = blocks.find((b) => b.id === "review")!;
    expect(review.timing.totalMs).toBe(17_000);
    expect(review.timing.currentMs).toBe(5_000);
    expect(review.timing.passes.map((pass) => pass.seq)).toEqual([2, 6]);
    expect(review.list).toMatchObject({ done: 1, total: 2, currentTitle: "unit two" });
    // A block the projection says nothing about keeps the empty timing and no list, never a zero.
    const plan = blocks.find((b) => b.id === "plan")!;
    expect(plan.timing).toEqual({ passes: [], totalMs: null, currentMs: null, recorded: false });
    expect(plan.list).toBeNull();
    expect(blocks.every((b) => b.stats === undefined)).toBe(true);
  });

  test("attaches the statistics entry of each block when statistics are given", () => {
    const statistics = {
      workflowId: "w",
      workflowVersion: "1.0.0",
      sampledRuns: 4,
      versionNotRecorded: 0,
      computedAt: 0,
      blocks: [
        {
          blockId: "review",
          pass: {
            sampleCount: 4,
            medianMs: 9_000,
            p25Ms: 7_000,
            p75Ms: 11_000,
            minMs: 5_000,
            maxMs: 12_000,
          },
          run: {
            sampleCount: 4,
            medianMs: 18_000,
            p25Ms: 14_000,
            p75Ms: 22_000,
            minMs: 12_000,
            maxMs: 25_000,
          },
          typicalPasses: 2,
          items: [],
        },
      ],
    };
    const blocks = runBlocks(progress(), statistics);
    expect(blocks.find((b) => b.id === "review")!.stats).toBe(statistics.blocks[0]);
    // Only the blocks the sample covers carry statistics; the rest carry none at all.
    expect(blocks.filter((b) => b.stats !== undefined)).toHaveLength(1);
  });

  test("a block's writes are the latest value per name up to the cursor, with adjustment marks", () => {
    expect(blockWrites(progress(), "repair", null)).toEqual([
      { name: "plan", value: "v2", seq: 5, adjusted: true },
    ]);
    expect(blockWrites(progress(), "repair", 4)).toEqual([
      { name: "plan", value: "v2", seq: 4, adjusted: false },
    ]);
    expect(blockWrites(progress(), "deliver", null)).toEqual([]);
  });
});

describe("route stretches and counts", () => {
  test("consecutive visits in one block form a stretch and a return is marked where it happens", () => {
    const segments = segmentsOf(progress().route, runBlocks(progress()));
    expect(
      segments.map((s) => [s.blockId, s.entry, s.visits.map((v) => v.seq), s.loopsBackTo ?? null]),
    ).toEqual([
      ["plan", 1, [0, 1], null],
      ["review", 1, [2, 3], null],
      ["repair", 1, [4, 5], "review"],
      ["review", 2, [6], null],
    ]);
  });

  test("per-block counts stop at the cursor", () => {
    const blocks = runBlocks(progress());
    const whole = blockRouteStats(progress().route, blocks, null);
    expect(whole.get("review")).toEqual({ entries: 2, visits: 3, firstSeq: 2, lastSeq: 6 });
    const cut = blockRouteStats(progress().route, blocks, 3);
    expect(cut.get("review")).toEqual({ entries: 1, visits: 2, firstSeq: 2, lastSeq: 3 });
    expect(cut.get("repair")).toEqual({ entries: 0, visits: 0 });
  });

  test("the cursor is clamped to the route and the last visit means the whole run", () => {
    const route = progress().route;
    expect(clampCursor(null, route)).toBeNull();
    expect(clampCursor("3", route)).toBe(3);
    expect(clampCursor("-2", route)).toBe(0);
    expect(clampCursor("6", route)).toBeNull();
    expect(clampCursor("99", route)).toBeNull();
    expect(clampCursor("abc", route)).toBeNull();
    expect(clampCursor("2", [])).toBeNull();
  });

  test("an exit is labelled from the transition its edge belongs to", () => {
    const blocks = runBlocks(progress());
    expect(exitLabel(progress().route[3], blocks)).toEqual({
      label: "defects found",
      to: "repair",
      cycle: false,
    });
    expect(exitLabel(progress().route[4], blocks)).toEqual({
      label: "repaired",
      to: "review",
      cycle: true,
    });
    expect(exitLabel(progress().route[6], blocks)).toBeNull();
  });

  test("changes text shows three names and counts the rest", () => {
    expect(changesText([])).toBe("");
    expect(changesText(["a", "b"])).toBe("a · b");
    expect(changesText(["a", "b", "c", "d", "e"])).toBe("a · b · c · +2");
  });
});

describe("steps from the definition", () => {
  const workflow = {
    id: "w",
    metadata: { name: "W", version: "1.0.0", description: "" },
    nodes: [
      { id: "start", type: "start", connections: { default: "plan-step" } },
      {
        id: "plan-step",
        type: "agent-directive",
        metadata: { displayName: "Write plan" },
        directive: "Write the plan file. Then list its units.\nMore text.",
        completionCondition: "Plan exists",
        inputSchema: {
          type: "object",
          properties: {
            plan_file: { type: "string", description: "Path to the plan" },
            total_steps: { type: "number" },
            approval: { type: "string", enum: ["yes", "no"] },
          },
          required: ["plan_file"],
        },
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  } as unknown as WorkflowGraph;

  test("first sentence stops at a sentence end and is bounded", () => {
    expect(firstSentence("Write the plan file. Then list.")).toBe("Write the plan file.");
    expect(firstSentence("No end here")).toBe("No end here");
    expect(firstSentence(`${"x".repeat(200)}. tail`).length).toBe(180);
  });

  test("evidence fields carry type, description, requirement and enum", () => {
    expect(evidenceFields((workflow.nodes[1] as { inputSchema?: unknown }).inputSchema)).toEqual([
      {
        name: "plan_file",
        type: "string",
        description: "Path to the plan",
        required: true,
        enum: null,
      },
      { name: "total_steps", type: "number", description: null, required: false, enum: null },
      { name: "approval", type: "string", description: null, required: false, enum: ["yes", "no"] },
    ]);
    expect(evidenceFields(undefined)).toEqual([]);
  });

  test("declared global inputs are evidence too, described by the variable registry", () => {
    const schema = {
      type: "object",
      properties: { plan_file: { type: "string" } },
      required: ["plan_file", "operating_mode", "outcome"],
      globalInputs: ["operating_mode", "outcome", "plan_file"],
    };
    const registry = {
      operating_mode: {
        type: "string",
        description: "How the run proceeds",
        enum: ["interactive", "autonomous"],
      },
      outcome: { type: "string", description: "Outcome text" },
    };
    expect(evidenceFields(schema, registry)).toEqual([
      { name: "plan_file", type: "string", description: null, required: true, enum: null },
      {
        name: "operating_mode",
        type: "string",
        description: "How the run proceeds",
        required: true,
        enum: ["interactive", "autonomous"],
      },
      { name: "outcome", type: "string", description: "Outcome text", required: true, enum: null },
    ]);
  });

  test("steps describe routing nodes without a summary and unknown nodes by id", () => {
    const steps = stepsOf(workflow, ["start", "plan-step", "missing"]);
    expect(steps.map((s) => [s.id, s.type, s.routing, s.summary, s.displayName])).toEqual([
      ["start", "start", true, "", null],
      ["plan-step", "agent-directive", false, "Write the plan file.", "Write plan"],
      ["missing", "unknown", false, "", null],
    ]);
    expect(steps[1].evidence.map((f) => f.name)).toEqual(["plan_file", "total_steps", "approval"]);
  });
});
