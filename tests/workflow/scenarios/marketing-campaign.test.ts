/** Behavioral contracts for moira/marketing-campaign v2.0.2. */
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

const entry = findSystemCatalogEntry("marketing-campaign", "public")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;
const sentinel = "No active revision request.";
const changed = { repair_outcome: "changed", changed_knowledge: "The reproduced class changed." };
const completion = {
  completion_outcome: "ready",
  result_status: "complete",
  campaign_summary: "A channel-ready campaign package supports the stated objective.",
  limitation_summary: "Evidence and applicability limits remain explicit.",
  revision_request: sentinel,
};

function terminal(status: "complete" | "limited" | "blocked" | "aborted"): MockInput {
  return ({ executionId }) => ({
    artifact_path: `./moira-ws/marketing-campaign-${executionId}/final-report.md`,
    terminal_status: status,
  });
}

function inputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    intake: {
      intake_outcome: "ready",
      operating_mode: "autonomous",
      campaign_goal: "Launch the authorized offer to the stated audience.",
      campaign_use: "Generate qualified demo requests.",
      campaign_scope: ["Landing page", "Email"],
    },
    "initialize-contract": { contract_outcome: "ready" },
    "frame-strategy": { strategy_outcome: "ready", revision_request: sentinel },
    "build-evidence": { evidence_status: "ready", revision_request: sentinel },
    "create-package": { package_outcome: "ready", revision_request: sentinel },
    "complete-package": completion,
    "validate-package": { validation_outcome: "pass" },
    "semantic-review": { review_outcome: "pass" },
    "repair-package-validation": changed,
    "repair-package-semantic": changed,
    "repair-evidence-validation": changed,
    "repair-evidence-semantic": changed,
    "repair-strategy-validation": changed,
    "repair-strategy-semantic": changed,
    "reassess-contract": {
      reassessment_outcome: "corrected",
      changed_knowledge: "The cumulative supplement preserves prior accepted corrections.",
      reentry_owner: "completion",
    },
    "corrected-contract-review": { contract_review_outcome: "pass", revision_request: sentinel },
    "interactive-acceptance": { user_decision: "accept" },
    "finalize-complete": terminal("complete"),
    "finalize-limited": terminal("limited"),
    "finalize-blocked": terminal("blocked"),
    "finalize-aborted": terminal("aborted"),
    "finalize-workspace-blocked": {
      terminal_reason: "Workspace unavailable.",
      terminal_status: "blocked",
    },
    "finalize-intake-blocked": { terminal_status: "blocked" },
    "revise-process": { revision_request: "The campaign criterion cannot distinguish states." },
    ...overrides,
  };
}

function configureMaterialize(engine: GraphExecutionEngine, error = false): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, any> }).nodeHandlers;
  if (error) {
    handlers.set("materialize", {
      getNodeType: () => "materialize",
      execute: async (current: { id: string }) => ({
        nodeId: current.id,
        action: "continue",
        outputPath: "error",
        data: {},
      }),
    });
    return;
  }
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

describe("marketing-campaign", () => {
  test("publishes the evidence-aware local-only v2 contract", async () => {
    const graph = workflow();
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(graph.metadata.version).toBe("2.0.2");
    expect(graph.metadata.description).toContain("channel-ready marketing campaign package");
    expect(graph.metadata.description).toContain("does not publish, notify, spend budget");
    expect(graph.nodes.some((node) => node.type === "telegram-notification")).toBe(false);
  });

  test("separates mechanical validation, semantic judgment, and source-specific repair", () => {
    const byId = (id: string): any => workflow().nodes.find((node) => node.id === id);
    expect(byId("validate-package").directive).toContain("deterministic");
    expect(byId("semantic-review").directive).toContain("genuinely independent");
    expect(byId("repair-package-validation").directive).toContain("package-validation.md");
    expect(byId("repair-package-semantic").directive).toContain("semantic-review.md");
    expect(byId("corrected-contract-review").directive).toContain(
      "complete current cumulative supplement",
    );
  });

  test.each([
    ["strategy replan without active cause", "frame-strategy", { strategy_outcome: "replan" }, {}],
    ["evidence success without reset", "build-evidence", { evidence_status: "ready" }, {}],
    ["semantic repair without owner", "semantic-review", { review_outcome: "repair" }, {}],
    [
      "interactive rework without active request",
      "interactive-acceptance",
      { user_decision: "rework", rework_owner: "evidence" },
      {
        intake: {
          intake_outcome: "ready",
          operating_mode: "interactive",
          campaign_goal: "Goal",
          campaign_use: "Use",
          campaign_scope: ["Email"],
        },
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

  test("rejects the neutral sentinel as a teleport cause", async () => {
    const result = await run({
      name: "teleport sentinel",
      mockInputs: inputs({ "revise-process": { revision_request: sentinel } }),
      teleportAfter: { afterNode: "frame-strategy", teleportTo: "revise-process" },
      expect: { status: "failed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'revise-process'");
  });

  test("executes principal outcomes and repair cones", async () => {
    const cases: Array<{ scenario: TestScenario; materializeError?: boolean }> = [
      {
        scenario: {
          name: "complete",
          mockInputs: inputs(),
          expect: { status: "completed", reaches: ["end"] },
        },
      },
      {
        scenario: {
          name: "limited",
          mockInputs: inputs({
            "build-evidence": { evidence_status: "limited", revision_request: sentinel },
            "complete-package": { ...completion, result_status: "limited" },
          }),
          expect: { status: "completed", reaches: ["end-limited"] },
        },
      },
      {
        scenario: {
          name: "pre-workspace blocked",
          mockInputs: inputs({
            intake: {
              intake_outcome: "blocked",
              operating_mode: "autonomous",
              terminal_reason: "Authority missing.",
            },
          }),
          expect: {
            status: "completed",
            reaches: ["end-intake-blocked"],
            avoids: ["materialize-workspace", "finalize-blocked"],
          },
        },
      },
      {
        materializeError: true,
        scenario: {
          name: "workspace blocked",
          mockInputs: inputs(),
          expect: { status: "completed", reaches: ["end-workspace-blocked"] },
        },
      },
      {
        scenario: {
          name: "interactive evidence rework",
          mockInputs: inputs({
            intake: {
              intake_outcome: "ready",
              operating_mode: "interactive",
              campaign_goal: "Goal",
              campaign_use: "Use",
              campaign_scope: ["Email"],
            },
            "interactive-acceptance": [
              {
                user_decision: "rework",
                rework_owner: "evidence",
                revision_request: "Separate customer assertions.",
              },
              { user_decision: "accept" },
            ],
          }),
          expect: {
            status: "completed",
            reaches: ["route-rework-evidence", "build-evidence", "end"],
          },
        },
      },
      {
        scenario: {
          name: "process revision",
          mockInputs: inputs({
            "reassess-contract": {
              reassessment_outcome: "corrected",
              changed_knowledge: "The cumulative method changed.",
              reentry_owner: "strategy",
            },
          }),
          teleportAfter: { afterNode: "frame-strategy", teleportTo: "revise-process" },
          expect: {
            status: "completed",
            reaches: ["revise-process", "corrected-contract-review", "end"],
          },
        },
      },
    ];

    for (const owner of ["package", "evidence", "strategy"] as const) {
      for (const source of ["validation", "semantic"] as const) {
        const repair = `repair-${owner}-${source}`;
        cases.push({
          scenario: {
            name: `${repair} changed`,
            mockInputs: inputs(
              source === "validation"
                ? {
                    "validate-package": [
                      { validation_outcome: "repair", repair_owner: owner },
                      { validation_outcome: "pass" },
                    ],
                  }
                : {
                    "validate-package": [
                      { validation_outcome: "pass" },
                      { validation_outcome: "pass" },
                    ],
                    "semantic-review": [
                      { review_outcome: "repair", repair_owner: owner },
                      { review_outcome: "pass" },
                    ],
                  },
            ),
            expect: { status: "completed", reaches: [repair, "complete-package", "end"] },
          },
        });
      }
    }

    for (const current of cases) {
      const result = await run(current.scenario, current.materializeError);
      if (!result.passed) throw new Error(`${current.scenario.name}: ${JSON.stringify(result)}`);
    }
  });
});
