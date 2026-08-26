/** Behavioral contracts for moira/workflow-presentation-generator v2.0.0. */
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

const entry = findSystemCatalogEntry("workflow-presentation-generator", "public")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;
const sentinel = "No active revision request.";
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
  test("publishes a valid local self-contained v2 presentation contract", async () => {
    const graph = workflow();
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(graph.metadata.version).toBe("2.0.0");
    expect(graph.nodes).toHaveLength(66);
    expect(graph.metadata.description).toContain("official full structural projection");
    expect(graph.metadata.description).toContain("never mutates the source, publishes, uploads");
    const intake = graph.nodes.find((node) => node.id === "intake") as any;
    expect(intake.directive).toContain("moira/verified-research");
    expect(intake.directive).toContain("never removed moira/research");
    expect(graph.nodes.some((node) => node.type === "telegram-notification")).toBe(false);
  });

  test("materializes canonical artifacts and separates structural, deterministic, and semantic evidence", () => {
    const byId = (id: string): any => workflow().nodes.find((node) => node.id === id);
    const files = byId("materialize-workspace").files.map((file: { path: string }) => file.path);
    expect(files).toEqual(
      expect.arrayContaining([
        "workflow.json",
        "workflow-schema.txt",
        "presentation-content.md",
        "presentation.html",
        "presentation-validation.md",
        "presentation-review.md",
        "repair-account.md",
      ]),
    );
    expect(byId("prepare-source").directive).toContain(
      "complete authorized definition through a download token",
    );
    expect(byId("prepare-source").directive).toContain("official moira-workflow");
    expect(byId("develop-content").directive).toContain("searchable/collapsible topology");
    expect(byId("generate-html").directive).toContain("Do not use external scripts");
    expect(byId("validate-presentation").directive).toContain("deterministic observations only");
    expect(byId("presentation-review").directive).toContain("genuinely independent");
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
            reaches: ["route-rework-content", "develop-content", "end-complete"],
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
});
