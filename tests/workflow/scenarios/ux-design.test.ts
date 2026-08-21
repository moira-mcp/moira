/** Contract and behavioral scenarios for moira/ux-design. */
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  GraphValidator,
  MaterializeHandler,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import {
  runScenario,
  type MockInput,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

const entry = findSystemCatalogEntry("ux-design", "public")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;

function node(graph: WorkflowGraph, id: string): any {
  const found = graph.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function intake(overrides: Record<string, unknown> = {}): MockInput {
  return ({ executionId }) => ({
    operating_mode: "autonomous",
    design_package_path: `./moira-ws/ux-design-${executionId}/design-package.md`,
    validation_plan_path: `./moira-ws/ux-design-${executionId}/validation-plan.md`,
    intake_status: "ready",
    intake_summary: "The bounded UX design contract is ready for synthesis.",
    ...overrides,
  });
}

const summary = "The local UX specification reached its truthful terminal state.";
function inputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    "materialize-workspace": {},
    "capture-design-contract": intake(),
    "create-design-package": { design_status: "reviewable", result_kind: "complete" },
    "review-design": { review_status: "completed", issues_count: 0 },
    "repair-design": {
      repair_status: "changed",
      repair_reach: "contained",
      result_kind: "complete",
    },
    "present-for-approval": { decision: "accept" },
    "apply-user-feedback": {
      feedback_status: "changed",
      repair_reach: "contained",
      result_kind: "complete",
    },
    "prepare-accepted": { outcome: "accepted", result_summary: summary },
    "prepare-limited": { outcome: "reviewed-limited", result_summary: summary },
    "prepare-feedback-blocker": { outcome: "feedback-blocked", result_summary: summary },
    "prepare-workspace-blocker": { outcome: "workspace-blocked", result_summary: summary },
    "prepare-intake-blocker": { outcome: "intake-blocked", result_summary: summary },
    "prepare-design-blocker": { outcome: "design-blocked", result_summary: summary },
    "prepare-repair-blocker": { outcome: "repair-blocked", result_summary: summary },
    "prepare-review-blocker": { outcome: "review-blocked", result_summary: summary },
    "prepare-abort": { outcome: "aborted", result_summary: summary },
    "revise-design-process": {},
    ...overrides,
  };
}

type MaterializeMode = "success" | "error";
function configureMaterialize(engine: GraphExecutionEngine, mode: MaterializeMode): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, any> }).nodeHandlers;
  if (mode === "success") {
    handlers.set(
      "materialize",
      new MaterializeHandler(
        { createMaterializeToken: () => "scenario-token" },
        () => "https://moira.example",
      ),
    );
    return;
  }
  handlers.set("materialize", {
    getNodeType: () => "materialize",
    execute: async (current: { id: string }) => ({
      nodeId: current.id,
      action: "continue",
      outputPath: "error",
      data: { error: "workspace unavailable" },
    }),
  });
}

async function run(
  scenario: TestScenario,
  materializeMode: MaterializeMode = "success",
): Promise<ScenarioResult> {
  return runScenario(workflow(), scenario, {
    engineSetup: (engine) => configureMaterialize(engine, materializeMode),
  });
}

describe("ux-design", () => {
  test("publishes the v2 public contract with detailed selection metadata", async () => {
    const graph = workflow();
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(graph.id).toBe("6266d829-11a6-4bf2-b00b-f3d230cee4c2");
    expect(graph.metadata.version).toBe("2.0.0");
    expect(graph.nodes).toHaveLength(32);
    expect(graph.metadata.description).toContain("implementation-ready UX design specification");
    expect(graph.metadata.description).toContain("genuinely independent reviewer");
    expect(graph.metadata.description).toContain("does not implement UI");
    expect(graph.metadata.description).toContain("Software Development Flow for implementation");
  });

  test("materializes the complete execution-bound artifact contract", () => {
    const graph = workflow();
    const materialize = node(graph, "materialize-workspace");
    expect(materialize.basePath).toBe("{{workspace_path}}");
    expect(materialize.files.map((file: { path: string }) => file.path)).toEqual([
      "process-id.txt",
      "design-standard.md",
      "design-contract.md",
      "design-package.md",
      "validation-plan.md",
      "design-review.md",
      "repair-account.md",
    ]);
    expect(graph.variableRegistry?.workspace_path).toMatchObject({
      const: "./moira-ws/ux-design-{{executionId}}",
      default: "./moira-ws/ux-design-{{executionId}}",
    });
    expect(node(graph, "end").finalOutput).toEqual([
      "workspace_path",
      "outcome",
      "design_package_path",
      "validation_plan_path",
      "result_summary",
    ]);
  });

  test("encodes correlated intake, review, repair, feedback, and authority contracts", () => {
    const graph = workflow();
    const intakeSchema = node(graph, "capture-design-contract").inputSchema;
    expect(intakeSchema.xContextPathSuffixes).toEqual({
      baseContextProperty: "workspace_path",
      properties: {
        design_package_path: "/design-package.md",
        validation_plan_path: "/validation-plan.md",
      },
    });
    expect(node(graph, "review-design").inputSchema.properties.review_status.enum).toEqual([
      "completed",
      "blocked",
    ]);
    expect(node(graph, "review-design").completionCondition).toContain("review_status=blocked");
    expect(node(graph, "repair-design").inputSchema.properties.repair_reach.enum).toEqual([
      "contained",
      "contract",
    ]);
    expect(node(graph, "apply-user-feedback").inputSchema.properties.feedback_status.enum).toEqual([
      "changed",
      "blocked",
    ]);
    expect(node(graph, "review-design").directive).toContain(
      "reuse exactly that recorded reviewer context",
    );
    expect(node(graph, "revise-design-process").connections.success).toBe("create-design-package");
    expect(graph.metadata.description).toContain("does not implement UI");
    expect(graph.variableRegistry?.design_standard.default).toContain(
      "does not implement product UI",
    );
    expect(graph.nodes.some((candidate) => candidate.type === "telegram-notification")).toBe(false);
  });

  test("rejects artifact paths from another otherwise valid execution", async () => {
    const result = await run({
      name: "foreign artifact paths",
      mockInputs: inputs({
        "capture-design-contract": intake({
          design_package_path: "./moira-ws/ux-design-deadbeef/design-package.md",
          validation_plan_path: "./moira-ws/ux-design-deadbeef/validation-plan.md",
        }),
      }),
      expect: { status: "failed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("must equal the current execution path");
  });

  test.each([
    [
      "completed review with blocker",
      { review_status: "completed", issues_count: 0, blocker_summary: "Impossible combination" },
    ],
    [
      "blocked review with count",
      { review_status: "blocked", issues_count: 1, blocker_summary: "Reviewer unavailable" },
    ],
    ["changed repair without reach", { repair_status: "changed", result_kind: "complete" }],
    [
      "blocked feedback with result kind",
      {
        feedback_status: "blocked",
        blocker_summary: "No authorized change",
        result_kind: "complete",
      },
    ],
  ])("rejects an invalid correlated response: %s", async (name, invalid) => {
    const target = String(name).includes("review")
      ? "review-design"
      : String(name).includes("repair")
        ? "repair-design"
        : "apply-user-feedback";
    const scenarioInputs: Record<string, MockInput> = { [target]: invalid };
    if (target === "repair-design") {
      scenarioInputs["review-design"] = { review_status: "completed", issues_count: 1 };
    }
    if (target === "apply-user-feedback") {
      scenarioInputs["capture-design-contract"] = intake({ operating_mode: "interactive" });
      scenarioInputs["present-for-approval"] = {
        decision: "revise",
        feedback: "Clarify the recovery-state behavior.",
      };
    }
    const result = await run({
      name: String(name),
      mockInputs: inputs(scenarioInputs),
      expect: { status: "failed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain(`Input validation failed for node '${target}'`);
  });

  test("covers every ordinary node and connection with truthful terminal outcomes", async () => {
    const nonzeroThenZero = [
      { review_status: "completed", issues_count: 1 },
      { review_status: "completed", issues_count: 0 },
    ];
    const cases: Array<{ scenario: TestScenario; materialize?: MaterializeMode }> = [
      {
        scenario: {
          name: "autonomous accepted",
          mockInputs: inputs(),
          expect: { status: "completed", reaches: ["prepare-accepted", "end"] },
        },
      },
      {
        scenario: {
          name: "autonomous reviewed limited",
          mockInputs: inputs({
            "create-design-package": { design_status: "reviewable", result_kind: "limited" },
          }),
          expect: { status: "completed", reaches: ["prepare-limited"] },
        },
      },
      {
        scenario: {
          name: "workspace blocked",
          mockInputs: inputs(),
          expect: { status: "completed", reaches: ["prepare-workspace-blocker"] },
        },
        materialize: "error",
      },
      {
        scenario: {
          name: "intake abort",
          mockInputs: inputs({
            "capture-design-contract": intake({ intake_status: "abort" }),
          }),
          expect: { status: "completed", reaches: ["prepare-abort"] },
        },
      },
      {
        scenario: {
          name: "intake blocked",
          mockInputs: inputs({
            "capture-design-contract": intake({
              intake_status: "blocked",
              blocker_summary: "Required primary evidence is unavailable.",
            }),
          }),
          expect: { status: "completed", reaches: ["prepare-intake-blocker"] },
        },
      },
      {
        scenario: {
          name: "design blocked",
          mockInputs: inputs({
            "create-design-package": {
              design_status: "blocked",
              blocker_summary: "The authorized evidence cannot support a reviewable package.",
            },
          }),
          expect: { status: "completed", reaches: ["prepare-design-blocker"] },
        },
      },
      {
        scenario: {
          name: "review context blocked",
          mockInputs: inputs({
            "review-design": {
              review_status: "blocked",
              blocker_summary: "The recorded reviewer context cannot be resumed.",
            },
          }),
          expect: { status: "completed", reaches: ["prepare-review-blocker"] },
        },
      },
      {
        scenario: {
          name: "repair blocked",
          mockInputs: inputs({
            "review-design": { review_status: "completed", issues_count: 1 },
            "repair-design": {
              repair_status: "blocked",
              blocker_summary: "The finding requires unavailable authority.",
            },
          }),
          expect: { status: "completed", reaches: ["prepare-repair-blocker"] },
        },
      },
      ...(["contained", "contract"] as const).map((repairReach) => ({
        scenario: {
          name: `${repairReach} review repair`,
          mockInputs: inputs({
            "review-design": nonzeroThenZero,
            "repair-design": {
              repair_status: "changed",
              repair_reach: repairReach,
              result_kind: "complete",
            },
          }),
          expect: { status: "completed" as const, reaches: ["repair-design", "prepare-accepted"] },
        },
      })),
      {
        scenario: {
          name: "interactive accept",
          mockInputs: inputs({
            "capture-design-contract": intake({ operating_mode: "interactive" }),
          }),
          expect: { status: "completed", reaches: ["present-for-approval", "prepare-accepted"] },
        },
      },
      {
        scenario: {
          name: "interactive abort",
          mockInputs: inputs({
            "capture-design-contract": intake({ operating_mode: "interactive" }),
            "present-for-approval": { decision: "abort" },
          }),
          expect: { status: "completed", reaches: ["prepare-abort"] },
        },
      },
      {
        scenario: {
          name: "interactive feedback blocked",
          mockInputs: inputs({
            "capture-design-contract": intake({ operating_mode: "interactive" }),
            "present-for-approval": {
              decision: "revise",
              feedback: "Request an external implementation outside this flow.",
            },
            "apply-user-feedback": {
              feedback_status: "blocked",
              blocker_summary: "Implementation is outside the UX specification authority.",
            },
          }),
          expect: { status: "completed", reaches: ["prepare-feedback-blocker"] },
        },
      },
      ...(["contained", "contract"] as const).map((repairReach) => ({
        scenario: {
          name: `interactive ${repairReach} feedback`,
          mockInputs: inputs({
            "capture-design-contract": intake({ operating_mode: "interactive" }),
            "present-for-approval": [
              { decision: "revise", feedback: "Clarify the recovery-state behavior." },
              { decision: "accept" },
            ],
            "apply-user-feedback": {
              feedback_status: "changed",
              repair_reach: repairReach,
              result_kind: "complete",
            },
          }),
          expect: {
            status: "completed" as const,
            reaches: ["apply-user-feedback", "prepare-accepted"],
          },
        },
      })),
      {
        scenario: {
          name: "guarded process revision",
          mockInputs: inputs(),
          teleportAfter: {
            afterNode: "review-design",
            teleportTo: "revise-design-process",
          },
          expect: { status: "completed", reaches: ["revise-design-process", "prepare-accepted"] },
        },
      },
    ];

    const results: ScenarioResult[] = [];
    for (const current of cases) {
      results.push(await run(current.scenario, current.materialize ?? "success"));
    }
    expect(results.filter((result) => !result.passed)).toEqual([]);
    const coverage = calculateCoverage(workflow(), results, { includeGapAnalysis: true });
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
  });
});
