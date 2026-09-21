/** Behavioral contracts for moira/workflow-presentation-generator. */
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
import { calculateCoverage } from "../../helpers/coverage-calculator.js";

const entry = findCatalogEntryBySlug("workflow-presentation-generator")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as unknown as WorkflowGraph;
const sentinel = "No active revision request.";
const eq = (path: string, right: string) => ({
  operator: "eq",
  left: { contextPath: path },
  right,
});
const ownerCase = (nodeId: string, outcome: string, owner: string) => ({
  when: {
    operator: "and",
    conditions: [
      eq(`${nodeId}.${outcome}`, nodeId === "interactive-acceptance" ? "rework" : "repair"),
      eq(
        `${nodeId}.${nodeId === "interactive-acceptance" ? "rework_owner" : "repair_owner"}`,
        owner,
      ),
    ],
  },
  output: owner,
});
const completion = {
  completion_outcome: "ready",
  result_status: "complete",
  presentation_summary: "The local self-contained presentation faithfully explains the workflow.",
  limitation_summary: "No material limitations remain beyond those stated in the presentation.",
  revision_request: sentinel,
};

function terminal(status: "complete" | "limited" | "blocked" | "aborted"): MockInput {
  return ({ executionId }) => ({
    artifact_path: `./moira-ws/workflow-presentation-generator-${executionId}/final-report.md`,
    terminal_status: status,
  });
}

function inputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    intake: {
      intake_outcome: "ready",
      operating_mode: "autonomous",
      source_type: "id",
      workflow_source: "moira/verified-research",
      target_audience: "Product stakeholders and workflow maintainers",
      presentation_use: "Explain value, behavior, and technical topology.",
      output_language: "English",
      presentation_scope: ["Local-only", "Do not expose private literals"],
    },
    "initialize-contract": { contract_outcome: "ready" },
    "prepare-source": { source_outcome: "ready", revision_request: sentinel },
    "develop-content": { content_outcome: "ready", revision_request: sentinel },
    "generate-html": { html_outcome: "ready", revision_request: sentinel },
    "complete-presentation": completion,
    "validate-presentation": { validation_outcome: "pass", revision_request: sentinel },
    "presentation-review": { review_outcome: "pass" },
    "reassess-contract": {
      reassessment_outcome: "corrected",
      changed_knowledge: "The cumulative correction preserves source and local-only authority.",
      reentry_owner: "completion",
    },
    "corrected-contract-review": { contract_review_outcome: "pass" },
    "interactive-acceptance": { user_decision: "accept" },
    "finalize-complete": terminal("complete"),
    "finalize-limited": terminal("limited"),
    "finalize-blocked": terminal("blocked"),
    "finalize-aborted": terminal("aborted"),
    "finalize-workspace-blocked": {
      terminal_reason: "Workspace materialization failed.",
      terminal_status: "blocked",
    },
    "finalize-intake-blocked": { terminal_status: "blocked" },
    "revise-process": { revision_request: "The presentation evidence criterion is invalid." },
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

describe("workflow-presentation-generator", () => {
  test("validates the executable presentation graph", async () => {
    const graph = workflow();
    expect(graph.metadata.version).toBe("2.2.0");
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    const intake = graph.nodes.find((node) => node.id === "intake") as any;
    expect(intake.directive).toContain("moira/verified-research");
    expect(intake.directive).toContain("never removed moira/research");
    expect(graph.nodes.some((node) => node.type === "telegram-notification")).toBe(false);
    expect(graph.nodes.filter((node) => node.type === "condition").map((node) => node.id)).toEqual([
      "route-reentry-source",
      "route-mode",
      "route-final-status",
    ]);
    const expectedRoutes: Array<{
      id: string;
      cases: unknown[];
      connections: Record<string, string>;
    }> = [
      {
        id: "intake",
        cases: [{ when: eq("intake.intake_outcome", "blocked"), output: "blocked" }],
        connections: { blocked: "finalize-intake-blocked", success: "materialize-workspace" },
      },
      {
        id: "initialize-contract",
        cases: [{ when: eq("initialize-contract.contract_outcome", "blocked"), output: "blocked" }],
        connections: { blocked: "finalize-blocked", success: "prepare-source" },
      },
      ...(
        [
          ["prepare-source", "source_outcome", "develop-content"],
          ["develop-content", "content_outcome", "generate-html"],
          ["generate-html", "html_outcome", "complete-presentation"],
          ["complete-presentation", "completion_outcome", "validate-presentation"],
        ] as const
      ).map(([id, field, next]) => ({
        id,
        cases: [
          { when: eq(`${id}.${field}`, "replan"), output: "replan" },
          { when: eq(`${id}.${field}`, "blocked"), output: "blocked" },
        ],
        connections: { replan: "reassess-contract", blocked: "finalize-blocked", success: next },
      })),
      ...(
        [
          ["validate-presentation", "validation_outcome", "presentation-review"],
          ["presentation-review", "review_outcome", "route-mode"],
        ] as const
      ).map(([id, field, next]) => ({
        id,
        cases: [
          ...(["source", "content", "html", "validation", "completion"] as const).map((owner) =>
            ownerCase(id, field, owner),
          ),
          { when: eq(`${id}.${field}`, "replan"), output: "replan" },
          { when: eq(`${id}.${field}`, "blocked"), output: "blocked" },
        ],
        connections: {
          source: "prepare-source",
          content: "develop-content",
          html: "generate-html",
          validation: "validate-presentation",
          completion: "complete-presentation",
          replan: "reassess-contract",
          blocked: "finalize-blocked",
          success: next,
        },
      })),
      {
        id: "reassess-contract",
        cases: [
          { when: eq("reassess-contract.reassessment_outcome", "blocked"), output: "blocked" },
        ],
        connections: { blocked: "finalize-blocked", success: "corrected-contract-review" },
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
          replan: "reassess-contract",
          blocked: "finalize-blocked",
          success: "route-reentry-source",
        },
      },
      {
        id: "interactive-acceptance",
        cases: [
          { when: eq("interactive-acceptance.user_decision", "abort"), output: "abort" },
          ...(["source", "content", "html", "validation", "completion", "contract"] as const).map(
            (owner) => ownerCase("interactive-acceptance", "user_decision", owner),
          ),
        ],
        connections: {
          abort: "finalize-aborted",
          source: "prepare-source",
          content: "develop-content",
          html: "generate-html",
          validation: "validate-presentation",
          completion: "complete-presentation",
          contract: "reassess-contract",
          success: "route-final-status",
        },
      },
      {
        id: "route-reentry-source",
        cases: [
          ...(["source", "content", "html", "validation"] as const).map((owner) => ({
            when: eq("reentry_owner", owner),
            output: owner,
          })),
        ],
        connections: {
          source: "prepare-source",
          content: "develop-content",
          html: "generate-html",
          validation: "validate-presentation",
          default: "complete-presentation",
        },
      },
    ];
    for (const expected of expectedRoutes) {
      const actual = graph.nodes.find((node) => node.id === expected.id) as any;
      expect(actual).toBeDefined();
      expect(actual.cases).toEqual(expected.cases);
      expect(actual.connections).toEqual(expected.connections);
    }
  });

  test.each([
    [
      "ready intake without complete source contract",
      "intake",
      { intake_outcome: "ready", operating_mode: "autonomous", source_type: "id" },
    ],
    ["source ready without clearing revision", "prepare-source", { source_outcome: "ready" }],
    ["validation repair without owner", "validate-presentation", { validation_outcome: "repair" }],
    [
      "completion without summaries",
      "complete-presentation",
      { completion_outcome: "ready", result_status: "complete", revision_request: sentinel },
    ],
  ])("rejects contradictory input: %s", async (_name, target, invalid) => {
    const result = await run({
      name: String(_name),
      mockInputs: inputs({ [String(target)]: invalid as MockInput }),
      expect: { status: "failed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain(`Input validation failed for node '${String(target)}'`);
  });

  test("rejects interactive rework and process revision without an active cause", async () => {
    const rework = await run({
      name: "rework without request",
      mockInputs: inputs({
        intake: {
          intake_outcome: "ready",
          operating_mode: "interactive",
          source_type: "id",
          workflow_source: "moira/verified-research",
          target_audience: "Maintainers",
          presentation_use: "Review behavior",
          output_language: "English",
          presentation_scope: ["Local-only"],
        },
        "interactive-acceptance": { user_decision: "rework", rework_owner: "html" },
      }),
      expect: { status: "failed" },
    });
    expect(rework.error).toContain("Input validation failed for node 'interactive-acceptance'");

    const teleport = await run({
      name: "neutral teleport cause",
      mockInputs: inputs({ "revise-process": { revision_request: sentinel } }),
      teleportAfter: { afterNode: "prepare-source", teleportTo: "revise-process" },
      expect: { status: "failed" },
    });
    expect(teleport.error).toContain("Input validation failed for node 'revise-process'");
  });

  test("executes source, outcome, mode, and contract-revision routes", async () => {
    const cases: Array<{ scenario: TestScenario; materializeError?: boolean }> = [
      {
        scenario: {
          name: "ID source complete",
          mockInputs: inputs(),
          expect: { status: "completed", reaches: ["prepare-source", "end-complete"] },
        },
      },
      {
        scenario: {
          name: "file source complete",
          mockInputs: inputs({
            intake: {
              intake_outcome: "ready",
              operating_mode: "autonomous",
              source_type: "file",
              workflow_source: "/workspace/workflow.json",
              target_audience: "Maintainers",
              presentation_use: "Technical onboarding",
              output_language: "English",
              presentation_scope: ["Large graph", "Local-only"],
            },
          }),
          expect: { status: "completed", reaches: ["prepare-source", "end-complete"] },
        },
      },
      {
        scenario: {
          name: "reviewed limited",
          mockInputs: inputs({
            "complete-presentation": { ...completion, result_status: "limited" },
          }),
          expect: { status: "completed", reaches: ["end-limited"] },
        },
      },
      {
        scenario: {
          name: "intake blocked",
          mockInputs: inputs({
            intake: {
              intake_outcome: "blocked",
              operating_mode: "autonomous",
              terminal_reason: "Source authority is missing.",
            },
          }),
          expect: {
            status: "completed",
            reaches: ["end-intake-blocked"],
            avoids: ["materialize-workspace"],
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
          name: "source blocked",
          mockInputs: inputs({
            "prepare-source": {
              source_outcome: "blocked",
              terminal_reason: "The complete source cannot be acquired.",
            },
          }),
          expect: { status: "completed", reaches: ["end-blocked"] },
        },
      },
      {
        scenario: {
          name: "interactive content rework",
          mockInputs: inputs({
            intake: {
              intake_outcome: "ready",
              operating_mode: "interactive",
              source_type: "id",
              workflow_source: "moira/verified-research",
              target_audience: "Maintainers",
              presentation_use: "Review behavior",
              output_language: "English",
              presentation_scope: ["Local-only"],
            },
            "develop-content": [
              { content_outcome: "ready", revision_request: sentinel },
              { content_outcome: "ready", revision_request: sentinel },
            ],
            "generate-html": [
              { html_outcome: "ready", revision_request: sentinel },
              { html_outcome: "ready", revision_request: sentinel },
            ],
            "complete-presentation": [completion, completion],
            "validate-presentation": [
              { validation_outcome: "pass", revision_request: sentinel },
              { validation_outcome: "pass", revision_request: sentinel },
            ],
            "presentation-review": [{ review_outcome: "pass" }, { review_outcome: "pass" }],
            "interactive-acceptance": [
              {
                user_decision: "rework",
                rework_owner: "content",
                revision_request: "Clarify the business inference labels.",
              },
              { user_decision: "accept" },
            ],
          }),
          expect: {
            status: "completed",
            reaches: ["interactive-acceptance", "develop-content", "end-complete"],
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
              source_type: "id",
              workflow_source: "moira/verified-research",
              target_audience: "Maintainers",
              presentation_use: "Review behavior",
              output_language: "English",
              presentation_scope: ["Local-only"],
            },
            "interactive-acceptance": { user_decision: "abort" },
          }),
          expect: { status: "completed", reaches: ["end-aborted"] },
        },
      },
      {
        scenario: {
          name: "guarded process revision",
          mockInputs: inputs({
            "reassess-contract": {
              reassessment_outcome: "corrected",
              changed_knowledge: "The large-graph criterion changed.",
              reentry_owner: "source",
            },
          }),
          teleportAfter: { afterNode: "prepare-source", teleportTo: "revise-process" },
          expect: {
            status: "completed",
            reaches: ["revise-process", "corrected-contract-review", "end-complete"],
          },
        },
      },
    ];

    for (const current of cases) {
      const result = await run(current.scenario, current.materializeError);
      if (!result.passed) throw new Error(`${current.scenario.name}: ${JSON.stringify(result)}`);
      if (current.scenario.name === "interactive content rework") {
        expect(result.inputSubmissionCounts["develop-content"]).toBe(2);
      }
    }
  });

  test("executes every deterministic and semantic repair owner", async () => {
    const owners = ["source", "content", "html", "validation", "completion"] as const;
    const targetByOwner = {
      source: "prepare-source",
      content: "develop-content",
      html: "generate-html",
      validation: "validate-presentation",
      completion: "complete-presentation",
    } as const;

    for (const owner of owners) {
      for (const source of ["validation", "review"] as const) {
        const overrides: Record<string, MockInput> = {};
        if (source === "validation") {
          overrides["validate-presentation"] = [
            { validation_outcome: "repair", repair_owner: owner },
            { validation_outcome: "pass", revision_request: sentinel },
          ];
        } else {
          overrides["validate-presentation"] = [
            { validation_outcome: "pass", revision_request: sentinel },
            { validation_outcome: "pass", revision_request: sentinel },
          ];
          overrides["presentation-review"] = [
            { review_outcome: "repair", repair_owner: owner },
            { review_outcome: "pass" },
          ];
        }
        const result = await run({
          name: `${source} repair owned by ${owner}`,
          mockInputs: inputs(overrides),
          expect: {
            status: "completed",
            reaches: [targetByOwner[owner], "validate-presentation", "end-complete"],
          },
        });
        if (!result.passed) throw new Error(`${source}/${owner}: ${JSON.stringify(result)}`);
      }
    }
  });

  test("combined scenarios cover every remaining node and branch", async () => {
    const cases: Array<{
      name: string;
      overrides?: Record<string, MockInput>;
      teleport?: boolean;
      teleportAfter?: string;
      materializeError?: boolean;
    }> = [
      { name: "complete" },
      {
        name: "limited",
        overrides: { "complete-presentation": { ...completion, result_status: "limited" } },
      },
      {
        name: "intake blocked",
        overrides: {
          intake: {
            intake_outcome: "blocked",
            operating_mode: "autonomous",
            terminal_reason: "No authorized source.",
          },
        },
      },
      { name: "workspace blocked", materializeError: true },
      {
        name: "contract blocked",
        overrides: {
          "initialize-contract": {
            contract_outcome: "blocked",
            terminal_reason: "Contract cannot be recorded.",
          },
        },
      },
      {
        name: "reassessment blocked",
        teleport: true,
        overrides: {
          "reassess-contract": {
            reassessment_outcome: "blocked",
            terminal_reason: "Correction cannot preserve source authority.",
          },
        },
      },
      {
        name: "correction review blocked",
        teleport: true,
        overrides: {
          "corrected-contract-review": {
            contract_review_outcome: "blocked",
            terminal_reason: "Correction violates the contract.",
          },
        },
      },
      {
        name: "correction review replan",
        teleport: true,
        overrides: {
          "reassess-contract": [
            {
              reassessment_outcome: "corrected",
              changed_knowledge: "First corrected criterion.",
              reentry_owner: "completion",
            },
            {
              reassessment_outcome: "corrected",
              changed_knowledge: "Revised corrected criterion.",
              reentry_owner: "completion",
            },
          ],
          "corrected-contract-review": [
            { contract_review_outcome: "replan", revision_request: "Correct the criterion again." },
            { contract_review_outcome: "pass" },
          ],
        },
      },
    ];
    for (const [id, field, owner] of [
      ["prepare-source", "source_outcome", "source"],
      ["develop-content", "content_outcome", "content"],
      ["generate-html", "html_outcome", "html"],
      ["complete-presentation", "completion_outcome", "completion"],
    ] as const) {
      cases.push({
        name: `${id} blocked`,
        overrides: {
          [id]: { [field]: "blocked", terminal_reason: `${id} is irreducibly blocked.` },
        },
      });
      cases.push({
        name: `${id} replan`,
        overrides: {
          [id]: [
            { [field]: "replan", revision_request: `Replan the ${owner} criterion.` },
            id === "complete-presentation"
              ? completion
              : { [field]: "ready", revision_request: sentinel },
          ],
          "reassess-contract": {
            reassessment_outcome: "corrected",
            changed_knowledge: `Changed ${owner} criterion.`,
            reentry_owner: owner,
          },
        },
      });
    }
    for (const [id, field] of [
      ["validate-presentation", "validation_outcome"],
      ["presentation-review", "review_outcome"],
    ] as const) {
      cases.push({
        name: `${id} blocked`,
        overrides: { [id]: { [field]: "blocked", terminal_reason: `${id} cannot complete.` } },
      });
      cases.push({
        name: `${id} replan`,
        overrides: {
          [id]: [
            { [field]: "replan", revision_request: `Replan the ${id} criterion.` },
            id === "validate-presentation"
              ? { validation_outcome: "pass", revision_request: sentinel }
              : { review_outcome: "pass" },
          ],
          "reassess-contract": {
            reassessment_outcome: "corrected",
            changed_knowledge: `Changed ${id} criterion.`,
            reentry_owner: "validation",
          },
        },
      });
      for (const owner of ["source", "content", "html", "validation", "completion"] as const) {
        cases.push({
          name: `${id} repairs ${owner}`,
          overrides: {
            [id]: [
              { [field]: "repair", repair_owner: owner },
              id === "validate-presentation"
                ? { validation_outcome: "pass", revision_request: sentinel }
                : { review_outcome: "pass" },
            ],
          },
        });
      }
    }
    for (const owner of ["source", "content", "html", "validation", "completion"] as const) {
      cases.push({
        name: `reentry ${owner}`,
        teleport: true,
        teleportAfter: owner === "validation" ? "validate-presentation" : "prepare-source",
        overrides: {
          "reassess-contract": {
            reassessment_outcome: "corrected",
            changed_knowledge: `Changed ${owner} criterion.`,
            reentry_owner: owner,
          },
        },
      });
    }
    const interactiveIntake = {
      ...(inputs().intake as Record<string, unknown>),
      operating_mode: "interactive",
    };
    cases.push({ name: "interactive accepted", overrides: { intake: interactiveIntake } });
    cases.push({
      name: "interactive aborted",
      overrides: {
        intake: interactiveIntake,
        "interactive-acceptance": { user_decision: "abort" },
      },
    });
    for (const owner of [
      "source",
      "content",
      "html",
      "validation",
      "completion",
      "contract",
    ] as const) {
      cases.push({
        name: `interactive rework ${owner}`,
        overrides: {
          intake: interactiveIntake,
          "interactive-acceptance": [
            {
              user_decision: "rework",
              rework_owner: owner,
              revision_request: `Rework the ${owner} stage.`,
            },
            { user_decision: "accept" },
          ],
          ...(owner === "contract"
            ? {
                "reassess-contract": {
                  reassessment_outcome: "corrected",
                  changed_knowledge: "Changed contract criterion.",
                  reentry_owner: "completion",
                },
              }
            : {}),
        },
      });
    }
    const results: ScenarioResult[] = [];
    for (const current of cases) {
      const result = await run(
        {
          name: current.name,
          mockInputs: inputs(current.overrides),
          ...(current.teleport
            ? {
                teleportAfter: {
                  afterNode: current.teleportAfter ?? "prepare-source",
                  teleportTo: "revise-process",
                },
              }
            : {}),
          expect: { status: "completed" },
        },
        current.materializeError,
      );
      if (!result.passed) throw new Error(`${current.name}: ${JSON.stringify(result)}`);
      results.push(result);
    }
    const coverage = calculateCoverage(workflow(), results, { includeGapAnalysis: true });
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
  });
});
