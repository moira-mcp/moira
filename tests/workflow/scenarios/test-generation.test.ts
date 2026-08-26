/** Behavioral contracts for moira/test-generation v2.0.3. */
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  GraphValidator,
  MaterializeHandler,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import {
  runScenario,
  type MockInput,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

const entry = findSystemCatalogEntry("test-generation", "public")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;
const workspace = (id: string) => `./moira-ws/test-generation-${id}`;

function terminal(
  status: "handoff" | "blocked" | "aborted",
  suffix: "/handoff.md" | "/final-report.md",
): MockInput {
  return ({ executionId }) => ({
    delivery_status: status,
    artifact_path: `${workspace(executionId)}${suffix}`,
    summary: `${status} result`,
    vcs_status: "not_applicable",
  });
}

function inputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    intake: {
      operating_mode: "autonomous",
      commit_authorized: false,
      push_authorized: false,
      task_summary: "Add tests for one authorized target.",
      preliminary_outcome: "eligible",
    },
    "materialize-workspace": {},
    "plan-change": { planning_outcome: "eligible" },
    "review-plan": { design_review_outcome: "pass" },
    "repair-plan": { repair_outcome: "changed", changed_knowledge: "Plan evidence changed." },
    "reassess-contract": {
      reassessment_outcome: "corrected",
      changed_knowledge: "Criterion corrected.",
      reentry_owner: "completion",
    },
    "corrected-contract-review": { review_outcome: "pass" },
    "reanalyze-target": { analysis_outcome: "ready" },
    "implement-change": { implementation_outcome: "ready" },
    "producer-completion": { completion_outcome: "ready" },
    "validate-change": { validation_outcome: "pass" },
    "repair-tests": { repair_outcome: "changed", changed_knowledge: "Test-side defect changed." },
    "repair-verification": {
      repair_outcome: "changed",
      changed_knowledge: "Evidence defect changed.",
    },
    "semantic-review": { review_outcome: "pass" },
    "present-result": { decision: "accept" },
    "rework-result": { rework_outcome: "tests_changed" },
    "close-result": ({ executionId }) => ({
      closure_outcome: "complete",
      delivery_status: "complete",
      artifact_path: `${workspace(executionId)}/final-report.md`,
      summary: "Accepted tests.",
      commit_status: "not_authorized",
      push_status: "not_authorized",
    }),
    "finalize-handoff": terminal("handoff", "/handoff.md"),
    "finalize-blocked": terminal("blocked", "/final-report.md"),
    "finalize-workspace-blocked": {
      delivery_status: "materialization_failed",
      summary: "Workspace unavailable.",
      vcs_status: "not_applicable",
    },
    "finalize-aborted": terminal("aborted", "/final-report.md"),
    "teleport-revise-process": {},
    ...overrides,
  };
}

function configureMaterialize(engine: GraphExecutionEngine, error = false): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, any> }).nodeHandlers;
  if (error)
    handlers.set("materialize", {
      getNodeType: () => "materialize",
      execute: async (current: { id: string }) => ({
        nodeId: current.id,
        action: "continue",
        outputPath: "error",
        data: {},
      }),
    });
  else
    handlers.set(
      "materialize",
      new MaterializeHandler(
        { createMaterializeToken: () => "token" },
        () => "https://moira.example",
      ),
    );
}

async function run(scenario: TestScenario, materializeError = false): Promise<ScenarioResult> {
  return runScenario(workflow(), scenario, {
    engineSetup: (engine) => configureMaterialize(engine, materializeError),
  });
}

describe("test-generation", () => {
  test("publishes the test-only v2 contract", async () => {
    const graph = workflow();
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(graph.metadata.version).toBe("2.0.3");
    expect(graph.metadata.description).toContain("executable test code");
    expect(graph.metadata.description).toContain("never modifies production code");
    expect(graph.nodes.some((node) => node.type === "telegram-notification")).toBe(false);
  });

  test("orders completion before gates and keeps proof-only work out", () => {
    const graph = workflow();
    const byId = (id: string): any => graph.nodes.find((node) => node.id === id);
    expect(byId("implement-change").connections.success).toBe("route-implementation-ready");
    expect(byId("route-implementation-ready").connections.true).toBe("producer-completion");
    expect(byId("route-completion-ready").connections.true).toBe("validate-change");
    expect(byId("producer-completion").directive).toContain("proof-only");
    expect(byId("producer-completion").directive).toContain("replan");
    expect(byId("repair-plan").directive).toContain("accepted corrected-contract.md");
    expect(byId("corrected-contract-review").directive).toContain("{{reentry_owner}}");
  });

  test.each([
    [
      "handoff intake needs reason",
      "intake",
      {
        operating_mode: "autonomous",
        commit_authorized: false,
        push_authorized: false,
        task_summary: "Task",
        preliminary_outcome: "handoff",
      },
      {},
    ],
    ["semantic repair needs owner", "semantic-review", { review_outcome: "repair" }, {}],
    [
      "changed plan repair needs knowledge",
      "repair-plan",
      { repair_outcome: "changed" },
      { "review-plan": { design_review_outcome: "repair" } },
    ],
    [
      "tests rework uses test-specific outcome",
      "rework-result",
      { rework_outcome: "product_changed" },
      {
        intake: {
          operating_mode: "interactive",
          commit_authorized: false,
          push_authorized: false,
          task_summary: "Task",
          preliminary_outcome: "eligible",
        },
        "present-result": { decision: "rework", feedback: "Change tests." },
      },
    ],
  ])("rejects contradictory response: %s", async (_name, target, invalid, setup) => {
    const result = await run({
      name: String(_name),
      mockInputs: inputs({ ...(setup as Record<string, MockInput>), [String(target)]: invalid }),
      expect: { status: "failed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain(`Input validation failed for node '${String(target)}'`);
  });

  test("executes clean, repair, handoff, revision, VCS and failure routes", async () => {
    const cases: Array<{ scenario: TestScenario; materializeError?: boolean }> = [
      {
        scenario: {
          name: "clean",
          mockInputs: inputs(),
          expect: { status: "completed", reaches: ["end"], avoids: ["present-result"] },
        },
      },
      {
        materializeError: true,
        scenario: {
          name: "materialize failed",
          mockInputs: inputs(),
          expect: {
            status: "completed",
            reaches: ["end-workspace-blocked"],
            avoids: ["end-blocked"],
          },
        },
      },
      {
        scenario: {
          name: "product handoff",
          mockInputs: inputs({
            "implement-change": {
              implementation_outcome: "handoff",
              outcome_reason: "Production seam required.",
            },
          }),
          expect: { status: "completed", reaches: ["end-handoff"] },
        },
      },
      {
        scenario: {
          name: "test repair",
          mockInputs: inputs({
            "producer-completion": [
              { completion_outcome: "ready" },
              { completion_outcome: "ready" },
            ],
            "validate-change": [
              { validation_outcome: "test_repair", cause_summary: "Assertion defect." },
              { validation_outcome: "pass" },
            ],
          }),
          expect: { status: "completed", reaches: ["repair-tests", "producer-completion", "end"] },
        },
      },
      {
        scenario: {
          name: "evidence repair",
          mockInputs: inputs({
            "validate-change": [
              {
                validation_outcome: "verification_repair",
                cause_summary: "Command evidence stale.",
              },
              { validation_outcome: "pass" },
            ],
          }),
          expect: { status: "completed", reaches: ["repair-verification", "end"] },
        },
      },
      {
        scenario: {
          name: "corrected target reentry",
          mockInputs: inputs({
            "producer-completion": [
              { completion_outcome: "replan", outcome_reason: "Target criterion invalid." },
              { completion_outcome: "ready" },
            ],
            "reassess-contract": {
              reassessment_outcome: "corrected",
              changed_knowledge: "Target interpretation changed.",
              reentry_owner: "target",
            },
          }),
          expect: { status: "completed", reaches: ["reanalyze-target", "review-plan", "end"] },
        },
      },
      {
        scenario: {
          name: "interactive rework",
          mockInputs: inputs({
            intake: {
              operating_mode: "interactive",
              commit_authorized: false,
              push_authorized: false,
              task_summary: "Task",
              preliminary_outcome: "eligible",
            },
            "present-result": [
              { decision: "rework", feedback: "Improve assertion." },
              { decision: "accept" },
            ],
            "rework-result": { rework_outcome: "tests_changed" },
            "producer-completion": [
              { completion_outcome: "ready" },
              { completion_outcome: "ready" },
            ],
            "validate-change": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
            "semantic-review": [{ review_outcome: "pass" }, { review_outcome: "pass" }],
          }),
          expect: { status: "completed", reaches: ["rework-result", "producer-completion", "end"] },
        },
      },
      {
        scenario: {
          name: "authorized VCS",
          mockInputs: inputs({
            intake: {
              operating_mode: "autonomous",
              commit_authorized: true,
              push_authorized: true,
              task_summary: "Task",
              preliminary_outcome: "eligible",
            },
            "close-result": ({ executionId }) => ({
              closure_outcome: "complete",
              delivery_status: "complete",
              artifact_path: `${workspace(executionId)}/final-report.md`,
              summary: "Accepted tests pushed.",
              commit_status: "committed",
              push_status: "pushed",
            }),
          }),
          expect: { status: "completed", reaches: ["end"] },
        },
      },
      {
        scenario: {
          name: "VCS blocked",
          mockInputs: inputs({
            "close-result": ({ executionId }) => ({
              closure_outcome: "blocked",
              delivery_status: "blocked",
              artifact_path: `${workspace(executionId)}/final-report.md`,
              summary: "Commit failed.",
              commit_status: "failed",
              push_status: "not_applicable",
            }),
          }),
          expect: { status: "completed", reaches: ["end-vcs-blocked"] },
        },
      },
      {
        scenario: {
          name: "process revision",
          mockInputs: inputs({
            "reassess-contract": {
              reassessment_outcome: "corrected",
              changed_knowledge: "Evidence model changed.",
              reentry_owner: "evidence",
            },
          }),
          teleportAfter: { afterNode: "review-plan", teleportTo: "teleport-revise-process" },
          expect: {
            status: "completed",
            reaches: [
              "teleport-revise-process",
              "corrected-contract-review",
              "validate-change",
              "end",
            ],
          },
        },
      },
    ];
    for (const current of cases) {
      const result = await run(current.scenario, current.materializeError);
      if (!result.passed) throw new Error(`${current.scenario.name}: ${JSON.stringify(result)}`);
    }
  });
});
