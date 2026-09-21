/** Behavioral contracts for moira/marketing-campaign. */
import { findCatalogEntryBySlug } from "@mcp-moira/shared";
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

const entry = findCatalogEntryBySlug("marketing-campaign")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as unknown as WorkflowGraph;
const sentinel = "No active revision request.";
const eq = (path: string, right: string) => ({
  operator: "eq",
  left: { contextPath: path },
  right,
});
const ownerCase = (nodeId: string, verdictField: string, ownerField: string, owner: string) => ({
  when: {
    operator: "and",
    conditions: [
      eq(`${nodeId}.${verdictField}`, nodeId === "interactive-acceptance" ? "rework" : "repair"),
      eq(`${nodeId}.${ownerField}`, owner),
    ],
  },
  output: owner,
});
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

function routeVisits(result: ScenarioResult): string[] {
  return result.visitedNodes.filter(
    (node, index, visits) => index === 0 || node !== visits[index - 1],
  );
}

describe("marketing-campaign", () => {
  test("validates the executable graph and provider-neutral notification boundary", async () => {
    const graph = workflow();
    expect(graph.metadata.version).toBe("2.2.0");
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(graph.nodes.some((node) => node.type === "telegram-notification")).toBe(false);
    expect(graph.nodes.filter((node) => node.type === "condition").map((node) => node.id)).toEqual([
      "route-reentry-strategy",
      "route-mode",
      "route-final-status",
    ]);
  });

  test("routes each validated answer directly and keeps the post-review re-entry gate", () => {
    const graph = workflow();
    const expectedRoutes: Array<{
      id: string;
      cases: unknown[];
      connections: Record<string, string>;
    }> = [
      {
        id: "intake",
        cases: [{ when: eq("intake.intake_outcome", "blocked"), output: "blocked" }],
        connections: { success: "materialize-workspace", blocked: "finalize-intake-blocked" },
      },
      {
        id: "initialize-contract",
        cases: [{ when: eq("initialize-contract.contract_outcome", "blocked"), output: "blocked" }],
        connections: { success: "frame-strategy", blocked: "finalize-blocked" },
      },
      ...(
        [
          ["frame-strategy", "strategy_outcome", "build-evidence"],
          ["build-evidence", "evidence_status", "create-package"],
          ["create-package", "package_outcome", "complete-package"],
          ["complete-package", "completion_outcome", "validate-package"],
        ] as const
      ).map(([id, field, next]) => ({
        id,
        cases: [
          { when: eq(`${id}.${field}`, "replan"), output: "replan" },
          { when: eq(`${id}.${field}`, "blocked"), output: "blocked" },
        ],
        connections: { success: next, replan: "reassess-contract", blocked: "finalize-blocked" },
      })),
      ...(
        [
          ["validate-package", "validation_outcome", "semantic-review", "validation"],
          ["semantic-review", "review_outcome", "route-mode", "semantic"],
        ] as const
      ).map(([id, field, next, source]) => ({
        id,
        cases: [
          ...(["package", "evidence", "strategy"] as const).map((owner) =>
            ownerCase(id, field, "repair_owner", owner),
          ),
          { when: eq(`${id}.${field}`, "replan"), output: "replan" },
          { when: eq(`${id}.${field}`, "blocked"), output: "blocked" },
        ],
        connections: {
          success: next,
          package: `repair-package-${source}`,
          evidence: `repair-evidence-${source}`,
          strategy: `repair-strategy-${source}`,
          replan: "reassess-contract",
          blocked: "finalize-blocked",
        },
      })),
      ...(["package", "evidence", "strategy"] as const).flatMap((owner) =>
        (["validation", "semantic"] as const).map((source) => {
          const id = `repair-${owner}-${source}`;
          return {
            id,
            cases: [
              { when: eq(`${id}.repair_outcome`, "reassess"), output: "reassess" },
              { when: eq(`${id}.repair_outcome`, "blocked"), output: "blocked" },
            ],
            connections: {
              success: {
                package: "complete-package",
                evidence: "create-package",
                strategy: "build-evidence",
              }[owner],
              reassess: "reassess-contract",
              blocked: "finalize-blocked",
            },
          };
        }),
      ),
      {
        id: "reassess-contract",
        cases: [
          { when: eq("reassess-contract.reassessment_outcome", "blocked"), output: "blocked" },
        ],
        connections: { success: "corrected-contract-review", blocked: "finalize-blocked" },
      },
      {
        id: "corrected-contract-review",
        cases: [
          {
            when: eq("corrected-contract-review.contract_review_outcome", "replan"),
            output: "replan",
          },
          {
            when: eq("corrected-contract-review.contract_review_outcome", "blocked"),
            output: "blocked",
          },
        ],
        connections: {
          success: "route-reentry-strategy",
          replan: "reassess-contract",
          blocked: "finalize-blocked",
        },
      },
      {
        id: "route-reentry-strategy",
        cases: (["strategy", "evidence", "package"] as const).map((owner) => ({
          when: eq("reentry_owner", owner),
          output: owner,
        })),
        connections: {
          strategy: "frame-strategy",
          evidence: "build-evidence",
          package: "create-package",
          default: "complete-package",
        },
      },
      {
        id: "interactive-acceptance",
        cases: [
          { when: eq("interactive-acceptance.user_decision", "abort"), output: "abort" },
          ...(["strategy", "evidence", "package", "contract"] as const).map((owner) =>
            ownerCase("interactive-acceptance", "user_decision", "rework_owner", owner),
          ),
        ],
        connections: {
          success: "route-final-status",
          abort: "finalize-aborted",
          strategy: "frame-strategy",
          evidence: "build-evidence",
          package: "create-package",
          contract: "reassess-contract",
        },
      },
    ];
    for (const expected of expectedRoutes) {
      const node = graph.nodes.find((item) => item.id === expected.id) as any;
      expect(node).toBeDefined();
      expect(node.cases).toEqual(expected.cases);
      expect(node.connections).toEqual(expected.connections);
    }
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

  test.each([
    ["strategy", "frame-strategy"],
    ["evidence", "build-evidence"],
    ["package", "create-package"],
    ["completion", "complete-package"],
  ] as const)(
    "re-enters %s only after independent corrected-contract review",
    async (owner, target) => {
      const result = await run({
        name: `${owner} corrected-contract re-entry`,
        mockInputs: inputs({
          "reassess-contract": {
            reassessment_outcome: "corrected",
            changed_knowledge: `The accepted supplement changed ${owner} knowledge.`,
            reentry_owner: owner,
          },
        }),
        teleportAfter: { afterNode: "frame-strategy", teleportTo: "revise-process" },
        expect: {
          status: "completed",
          reaches: ["corrected-contract-review", "route-reentry-strategy", "end"],
        },
      });
      expect(result.passed).toBe(true);
      const route = routeVisits(result);
      const reviewVisit = route.indexOf("corrected-contract-review");
      expect(reviewVisit).toBeGreaterThanOrEqual(0);
      expect(route[reviewVisit + 1]).toBe("route-reentry-strategy");
      expect(route[reviewVisit + 2]).toBe(target);
    },
  );

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
          name: "strategy blocked after workspace",
          mockInputs: inputs({
            "frame-strategy": {
              strategy_outcome: "blocked",
              terminal_reason: "No authorized offer.",
            },
          }),
          expect: { status: "completed", reaches: ["end-blocked"], avoids: ["build-evidence"] },
        },
      },
      {
        scenario: {
          name: "evidence blocked",
          mockInputs: inputs({
            "build-evidence": { evidence_status: "blocked", terminal_reason: "No usable proof." },
          }),
          expect: { status: "completed", reaches: ["end-blocked"], avoids: ["create-package"] },
        },
      },
      {
        scenario: {
          name: "evidence replan and replay",
          mockInputs: inputs({
            "build-evidence": [
              { evidence_status: "replan", revision_request: "Correct the proof criterion." },
              { evidence_status: "ready", revision_request: sentinel },
            ],
            "reassess-contract": {
              reassessment_outcome: "corrected",
              changed_knowledge: "The proof criterion is now usable.",
              reentry_owner: "evidence",
            },
          }),
          expect: {
            status: "completed",
            reaches: ["reassess-contract", "route-reentry-strategy", "end"],
          },
        },
      },
      {
        scenario: {
          name: "interactive abort",
          mockInputs: inputs({
            intake: {
              intake_outcome: "ready",
              operating_mode: "interactive",
              campaign_goal: "Goal",
              campaign_use: "Use",
              campaign_scope: ["Email"],
            },
            "interactive-acceptance": { user_decision: "abort" },
          }),
          expect: { status: "completed", reaches: ["end-aborted"], avoids: ["route-final-status"] },
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
            reaches: ["interactive-acceptance", "build-evidence", "end"],
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
      if (current.scenario.name === "interactive evidence rework") {
        expect(routeVisits(result).filter((node) => node === "build-evidence")).toHaveLength(2);
      }
      if (current.scenario.name === "evidence replan and replay") {
        expect(routeVisits(result).filter((node) => node === "build-evidence")).toHaveLength(2);
      }
    }
  });
});
