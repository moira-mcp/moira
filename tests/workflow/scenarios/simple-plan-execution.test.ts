/**
 * Contract and behavioral scenarios for moira/simple-plan-execution.
 *
 * The workflow owns one strict current plan, sequential evidence-backed execution, guarded
 * process revision, independent zero-only review, and source-aware changed repair.
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { GraphValidator, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import {
  runScenario,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

type PlanItem = { id: string; action: string; expected_result: string };

const catalogEntry = findSystemCatalogEntry("simple-plan-execution", "public")!;
const workspace = "./moira-ws/simple-plan-execution-checkout_20260820";
const taskDescription = "Prepare a verified checkout readiness result";
const expectedResult = "A concrete readiness result exists with observable verification";

function loadWorkflow(): WorkflowGraph {
  return structuredClone(catalogEntry.graph) as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): any {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function item(id: string, action = `Perform ${id}`): PlanItem {
  return { id, action, expected_result: `Observable result for ${id}` };
}

function capture(operatingMode: "autonomous" | "interactive" = "autonomous") {
  return {
    workspace_path: workspace,
    operating_mode: operatingMode,
    task_description: taskDescription,
    expected_result: expectedResult,
  };
}

function cleanInputs(
  steps: PlanItem[] = [item("S1")],
  operatingMode: "autonomous" | "interactive" = "autonomous",
) {
  return {
    capture_task: capture(operatingMode),
    create_plan: { steps },
    execute_step: steps.map(() => ({})),
    review: { issues_count: 0 },
    report: { result_summary: `Accepted result in ${workspace}/final-report.md` },
    ...(operatingMode === "interactive"
      ? {
          present_plan: { decision: "accept" },
          present_result: { decision: "accept" },
        }
      : {}),
  };
}

function compactRoute(result: ScenarioResult): string[] {
  return result.visitedNodes.filter((id, index, all) => id !== all[index - 1]);
}

async function invalidAt(nodeId: string, input: Record<string, unknown>, before = {}) {
  return runScenario(loadWorkflow(), {
    name: `invalid response at ${nodeId}`,
    mockInputs: { ...before, [nodeId]: input },
    expect: { status: "completed" },
  });
}

describe("simple-plan-execution", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("preserves public identity and implements the accepted 27-node graph", async () => {
    expect(catalogEntry.owner).toBe("system-moira");
    expect(catalogEntry.slug).toBe("simple-plan-execution");
    expect(catalogEntry.visibility).toBe("public");
    expect(workflow.id).toBe("278a35a9-c73e-4e2a-a781-32d92ac5cb80");
    expect(workflow.metadata.version).toBe("2.0.0");

    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(workflow.nodes).toHaveLength(27);
    expect(node(workflow, "end").finalOutput).toEqual(["workspace_path", "result_summary"]);
    expect(node(workflow, "route_review").connections).toEqual({
      true: "report",
      false: "classify_repair",
    });
  });

  test("publishes a truthful decision-useful description and neighboring-flow boundaries", () => {
    const description = workflow.metadata.description;
    for (const claim of [
      "one strict current plan",
      "task.md",
      "plan.json",
      "execution-evidence.md",
      "review.md",
      "final-report.md",
      "independent primary-source reviewer",
      "zero findings",
      "Authority is inherited",
      "Todo List",
      "Quick Task",
      "Robust Task",
      "development workflow",
    ]) {
      expect(description).toContain(claim);
    }
  });

  test("keeps exactly nine bounded globals and derives count in engine expressions", () => {
    const registry = workflow.variableRegistry!;
    expect(Object.keys(registry).sort()).toEqual([
      "current_step",
      "expected_result",
      "issues_count",
      "operating_mode",
      "result_summary",
      "steps",
      "task_description",
      "total_steps",
      "workspace_path",
    ]);
    expect(registry.workspace_path.pattern).toBe(
      "^\\./moira-ws/simple-plan-execution-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    );
    expect(registry.steps.minItems).toBe(1);
    expect(registry.steps.maxItems).toBe(100);
    expect(registry.steps.items.additionalProperties).toBe(false);
    expect(node(workflow, "derive_plan_count").expressions).toEqual(["total_steps = steps.length"]);
    expect(node(workflow, "increment_step").expressions).toEqual([
      "current_step = current_step + 1",
    ]);
  });

  test("makes unique IDs a semantic invariant at every writer and at review", () => {
    for (const id of ["create_plan", "revise_plan", "classify_repair", "teleport_revise_process"]) {
      expect(node(workflow, id).directive).toMatch(/pairwise.unique/i);
    }
    expect(node(workflow, "review").directive).toMatch(/pairwise unique/i);
    expect(node(workflow, "review").directive).toContain("Duplicate IDs");
    expect(node(workflow, "review").directive).toContain("exactly one unambiguous");
  });

  test("uses conditional local feedback and conditional changed-repair outputs", () => {
    for (const id of ["present_plan", "present_result"]) {
      const schema = node(workflow, id).inputSchema;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.allOf[0].then.required).toEqual(["feedback"]);
    }
    const repairSchema = node(workflow, "classify_repair").inputSchema;
    expect(repairSchema.globalInputs).toEqual(["task_description", "expected_result", "steps"]);
    expect(repairSchema.required).toEqual(["repair_reach"]);
    expect(repairSchema.allOf[0].then.required).toEqual([
      "repair_from",
      "task_description",
      "expected_result",
      "steps",
    ]);
    expect(repairSchema.allOf[1].then.required).toEqual(["repair_from", "steps"]);
  });

  test("rejects an empty plan at the actual create-plan response boundary", async () => {
    const result = await invalidAt("create_plan", { steps: [] }, { capture_task: capture() });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'create_plan'");
    expect(result.visitedNodes).not.toContain("execute_step");
  });

  test.each(["id", "action", "expected_result"])(
    "rejects a plan item missing required field %s",
    async (field) => {
      const malformed = item("S1") as unknown as Record<string, unknown>;
      delete malformed[field];
      const result = await invalidAt(
        "create_plan",
        { steps: [malformed] },
        { capture_task: capture() },
      );
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Input validation failed for node 'create_plan'");
    },
  );

  test.each([
    "./moira-ws/simple-plan-execution-../../tmp",
    "./moira-ws/simple-plan-execution-.",
    "./moira-ws/simple-plan-execution-a//b",
    "./moira-ws/simple-plan-execution-a/other",
  ])("rejects unsafe or nested workspace %s", async (workspacePath) => {
    const result = await invalidAt("capture_task", {
      ...capture(),
      workspace_path: workspacePath,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'capture_task'");
    expect(result.visitedNodes).not.toContain("create_plan");
  });

  test("rejects plan revision without feedback before the revision owner", async () => {
    const result = await runScenario(workflow, {
      name: "missing plan feedback",
      mockInputs: {
        capture_task: capture("interactive"),
        create_plan: { steps: [item("S1")] },
        present_plan: { decision: "revise" },
      },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'present_plan'");
    expect(result.visitedNodes).not.toContain("revise_plan");
  });

  test("rejects final rework without feedback before changing accepted work", async () => {
    const result = await runScenario(workflow, {
      name: "missing final feedback",
      mockInputs: {
        ...cleanInputs([item("S1")], "interactive"),
        present_result: { decision: "rework" },
      },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'present_result'");
    expect(result.visitedNodes).not.toContain("rework");
  });

  test("autonomous mode executes every item and bypasses only the two user waits", async () => {
    const steps = [item("S1"), item("S2")];
    const result = await runScenario(workflow, {
      name: "autonomous clean execution",
      mockInputs: cleanInputs(steps),
      expect: {
        status: "completed",
        avoids: ["present_plan", "present_result", "classify_repair"],
        contextContains: { steps, total_steps: 2, current_step: 2, workspace_path: workspace },
      },
    });
    expect(result.passed).toBe(true);
    expect(compactRoute(result)).toEqual([
      "start",
      "capture_task",
      "create_plan",
      "derive_plan_count",
      "route_plan_mode",
      "check_steps_remaining",
      "execute_step",
      "increment_step",
      "check_steps_remaining",
      "execute_step",
      "increment_step",
      "check_steps_remaining",
      "review",
      "route_review",
      "report",
      "route_result_mode",
      "end",
    ]);
  });

  test("interactive rejection revises the plan and final rework repeats review and report", async () => {
    const first = [item("S1")];
    const revised = [item("S1", "Perform corrected S1"), item("S2")];
    const result = await runScenario(workflow, {
      name: "interactive revision and rework",
      mockInputs: {
        capture_task: capture("interactive"),
        create_plan: { steps: first },
        present_plan: [
          { decision: "revise", feedback: "Add the missing observable check" },
          { decision: "accept" },
        ],
        revise_plan: { steps: revised },
        execute_step: [{}, {}],
        review: [{ issues_count: 0 }, { issues_count: 0 }],
        report: [
          { result_summary: "First reviewed result" },
          { result_summary: "Reworked reviewed result" },
        ],
        present_result: [
          { decision: "rework", feedback: "Correct the final wording" },
          { decision: "accept" },
        ],
        rework: {},
      },
      expect: { status: "completed", reaches: ["revise_plan", "rework", "end"] },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts.review).toBe(2);
    expect(result.inputSubmissionCounts.report).toBe(2);
    expect(result.finalContext.steps).toEqual(revised);
  });

  test("a projection-only finding changes no canonical state and returns to the same reviewer", async () => {
    const steps = [item("S1")];
    const result = await runScenario(workflow, {
      name: "projection repair",
      mockInputs: {
        ...cleanInputs(steps),
        review: [{ issues_count: 1 }, { issues_count: 0 }],
        classify_repair: { repair_reach: "projection" },
      },
      expect: { status: "completed", reaches: ["classify_repair"] },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts.review).toBe(2);
    expect(result.finalContext.steps).toEqual(steps);
    expect(result.finalContext.current_step).toBe(1);
  });

  test("a combined plan and projection finding appends omitted work and re-executes before rereview", async () => {
    const initial = [item("S1")];
    const repaired = [item("S1"), item("S2", "Perform omitted S2")];
    const result = await runScenario(workflow, {
      name: "combined plan and projection repair",
      mockInputs: {
        ...cleanInputs(initial),
        execute_step: [{}, {}],
        review: [{ issues_count: 2 }, { issues_count: 0 }],
        classify_repair: { repair_reach: "plan", repair_from: 1, steps: repaired },
      },
      expect: {
        status: "completed",
        reaches: ["apply_plan_repair", "execute_step"],
        contextContains: { steps: repaired, total_steps: 2, current_step: 2 },
      },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts.review).toBe(2);
    expect(result.inputSubmissionCounts.classify_repair).toBe(1);
  });

  test("canonical task repair resets an old end cursor and cannot skip a shorter replacement", async () => {
    const initial = [item("S1"), item("S2")];
    const replacement = [item("R1", "Execute corrected canonical task")];
    const result = await runScenario(workflow, {
      name: "task repair resets end cursor",
      mockInputs: {
        ...cleanInputs(initial),
        execute_step: [{}, {}, {}],
        review: [{ issues_count: 1 }, { issues_count: 0 }],
        classify_repair: {
          repair_reach: "task",
          repair_from: 0,
          task_description: "Corrected capture of the same originating request",
          expected_result: "Corrected observable result",
          steps: replacement,
        },
      },
      expect: {
        status: "completed",
        reaches: ["apply_task_repair"],
        contextContains: { steps: replacement, total_steps: 1, current_step: 1 },
      },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts.review).toBe(2);
  });

  test("work reach changes evidence and returns directly to the same reviewer", async () => {
    const result = await runScenario(workflow, {
      name: "work repair",
      mockInputs: {
        ...cleanInputs(),
        review: [{ issues_count: 1 }, { issues_count: 0 }],
        classify_repair: { repair_reach: "work" },
      },
      expect: { status: "completed", avoids: ["apply_task_repair", "apply_plan_repair"] },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts.review).toBe(2);
  });

  test("duplicate IDs are blocked, changed to unique IDs, re-executed, and rereviewed", async () => {
    const duplicate = [item("S1", "First action"), item("S1", "Different second action")];
    const unique = [item("S1", "First action"), item("S2", "Different second action")];
    const result = await runScenario(workflow, {
      name: "duplicate identity semantic repair",
      mockInputs: {
        ...cleanInputs(duplicate),
        execute_step: [{}, {}, {}, {}],
        review: [{ issues_count: 1 }, { issues_count: 0 }],
        classify_repair: { repair_reach: "plan", repair_from: 0, steps: unique },
      },
      expect: {
        status: "completed",
        reaches: ["classify_repair", "apply_plan_repair"],
        contextContains: { steps: unique, total_steps: 2, current_step: 2 },
      },
    });
    expect(result.passed).toBe(true);
    expect(result.visitedNodes.indexOf("report")).toBeGreaterThan(
      result.visitedNodes.lastIndexOf("classify_repair"),
    );
    expect(result.inputSubmissionCounts.review).toBe(2);
  });

  test("mid-run teleport plus interactive rejection preserves the resume cursor", async () => {
    const initial = [item("S1"), item("S2")];
    const teleported = [item("S1"), item("T2", "Replacement remaining action")];
    const revised = [item("S1"), item("R2", "User-revised remaining action")];
    const result = await runScenario(workflow, {
      name: "teleport then interactive rejection",
      mockInputs: {
        capture_task: capture("interactive"),
        create_plan: { steps: initial },
        present_plan: [
          { decision: "accept" },
          { decision: "revise", feedback: "Adjust only the remaining action" },
          { decision: "accept" },
        ],
        execute_step: [{}, {}],
        teleport_revise_process: { steps: teleported, resume_cursor: 1 },
        revise_plan: { steps: revised },
        review: { issues_count: 0 },
        report: { result_summary: "Reviewed resumed result" },
        present_result: { decision: "accept" },
      },
      teleportAfter: {
        afterNode: "execute_step",
        visitNumber: 2,
        teleportTo: "teleport_revise_process",
      },
      expect: {
        status: "completed",
        reaches: ["teleport_revise_process", "apply_teleport_revision", "revise_plan"],
        contextContains: { steps: revised, total_steps: 2, current_step: 2 },
      },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts.present_plan).toBe(3);
    expect(result.finalContext.steps).toEqual(revised);
  });

  test("combined scenarios cover every ordinary node and branch", async () => {
    const scenarios: TestScenario[] = [
      {
        name: "coverage autonomous clean",
        mockInputs: cleanInputs([item("S1")]),
        expect: { status: "completed" },
      },
      {
        name: "coverage interactive revision and rework",
        mockInputs: {
          capture_task: capture("interactive"),
          create_plan: { steps: [item("S1")] },
          present_plan: [{ decision: "revise", feedback: "Revise" }, { decision: "accept" }],
          revise_plan: { steps: [item("S1", "Revised")] },
          execute_step: {},
          review: [{ issues_count: 0 }, { issues_count: 0 }],
          report: [{ result_summary: "First" }, { result_summary: "Second" }],
          present_result: [{ decision: "rework", feedback: "Rework" }, { decision: "accept" }],
          rework: {},
        },
        expect: { status: "completed" },
      },
      ...(["projection", "task", "plan", "work"] as const).map((reach) => ({
        name: `coverage repair ${reach}`,
        mockInputs: {
          ...cleanInputs([item("S1")]),
          execute_step: [{}, {}],
          review: [{ issues_count: 1 }, { issues_count: 0 }],
          classify_repair:
            reach === "task"
              ? {
                  repair_reach: reach,
                  repair_from: 0,
                  task_description: "Corrected task",
                  expected_result: "Corrected result",
                  steps: [item("R1")],
                }
              : reach === "plan"
                ? { repair_reach: reach, repair_from: 0, steps: [item("R1")] }
                : { repair_reach: reach },
        },
        expect: { status: "completed" as const },
      })),
      {
        name: "coverage teleport",
        mockInputs: {
          ...cleanInputs([item("S1"), item("S2")]),
          execute_step: [{}, {}],
          teleport_revise_process: { steps: [item("S1"), item("R2")], resume_cursor: 1 },
        },
        teleportAfter: {
          afterNode: "execute_step",
          visitNumber: 2,
          teleportTo: "teleport_revise_process",
        },
        expect: { status: "completed" },
      },
    ];
    const results = await Promise.all(scenarios.map((scenario) => runScenario(workflow, scenario)));
    expect(results.filter((result) => !result.passed)).toEqual([]);
    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
  });
});
