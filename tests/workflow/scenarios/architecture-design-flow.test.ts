/** Behavioral contracts for moira/architecture-design-flow v2.0.5. */
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

const entry = findSystemCatalogEntry("architecture-design-flow", "public")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;
const sentinel = "No active revision request.";
const changed = {
  repair_outcome: "changed",
  changed_knowledge: "The reproduced owner-local class changed.",
  revision_request: sentinel,
};
const completion = {
  completion_outcome: "ready",
  result_status: "complete",
  architecture_summary: "The accepted package supports the stated architecture decision.",
  limitation_summary: "No material limitations remain beyond those stated in the package.",
  revision_request: sentinel,
};

function terminal(
  status: "complete" | "limited" | "blocked" | "aborted",
  deliveryStatus: "workspace" | "delivered" = "workspace",
): MockInput {
  return ({ executionId }) => ({
    artifact_path: `./moira-ws/architecture-design-flow-${executionId}/final-report.md`,
    terminal_status: status,
    delivery_status: deliveryStatus,
  });
}

function deliveredTerminal(status: "complete" | "limited"): MockInput {
  return ({ executionId }) => ({
    artifact_path: `./moira-ws/architecture-design-flow-${executionId}/final-report.md`,
    terminal_status: status,
  });
}

function inputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    intake: {
      intake_outcome: "ready",
      operating_mode: "autonomous",
      scenario_type: "new",
      architecture_goal: "Design a maintainable order-tracking architecture.",
      decision_use: "Approve system boundaries and significant decisions.",
      architecture_scope: ["Order tracking", "Operational reliability"],
      delivery_scope: "workspace",
    },
    "initialize-contract": { contract_outcome: "ready" },
    "discover-new-system": {
      discovery_outcome: "ready",
      discovery_status: "ready",
      revision_request: sentinel,
    },
    "discover-existing-system": {
      discovery_outcome: "ready",
      discovery_status: "ready",
      revision_request: sentinel,
    },
    "design-architecture": { architecture_outcome: "ready", revision_request: sentinel },
    "create-architecture-package": { package_outcome: "ready", revision_request: sentinel },
    "complete-architecture-package": completion,
    "validate-architecture-package": { validation_outcome: "pass", revision_request: sentinel },
    "architecture-review": { review_outcome: "pass" },
    "repair-package-validation": changed,
    "repair-package-semantic": changed,
    "repair-architecture-validation": changed,
    "repair-architecture-semantic": changed,
    "repair-discovery-validation": changed,
    "repair-discovery-semantic": changed,
    "repair-validation-mechanical": changed,
    "repair-validation-semantic": changed,
    "reassess-contract": {
      reassessment_outcome: "corrected",
      changed_knowledge: "The bounded cumulative correction preserves originating authority.",
      reentry_owner: "completion",
    },
    "corrected-contract-review": { contract_review_outcome: "pass" },
    "interactive-acceptance": { user_decision: "accept" },
    "deliver-package": { delivery_outcome: "delivered", delivery_status: "delivered" },
    "finalize-complete": terminal("complete"),
    "finalize-limited": terminal("limited"),
    "finalize-complete-delivered": deliveredTerminal("complete"),
    "finalize-limited-delivered": deliveredTerminal("limited"),
    "finalize-blocked": terminal("blocked"),
    "finalize-aborted": terminal("aborted"),
    "finalize-workspace-blocked": {
      terminal_reason: "Workspace unavailable.",
      terminal_status: "blocked",
    },
    "finalize-intake-blocked": { terminal_status: "blocked" },
    "revise-process": { revision_request: "The architecture evidence criterion is invalid." },
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

describe("architecture-design-flow", () => {
  test("publishes the universal authority-bound v2 architecture contract", async () => {
    const graph = workflow();
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(graph.metadata.version).toBe("2.0.5");
    expect(graph.metadata.description).toContain("decision-ready, maintained architecture package");
    expect(graph.metadata.description).toContain("never changes product code");
    expect(graph.nodes.some((node) => node.type === "telegram-notification")).toBe(false);
    expect(JSON.stringify(graph)).not.toContain("campaign method");
    expect(JSON.stringify(graph)).not.toContain("issues_count");
    expect(JSON.stringify(graph)).not.toContain("max_fix_iterations");
  });

  test("materializes one durable package and separates evidence modalities", () => {
    const byId = (id: string): any => workflow().nodes.find((node) => node.id === id);
    const files = byId("materialize-workspace").files.map((file: { path: string }) => file.path);
    expect(files).toEqual(
      expect.arrayContaining([
        "architecture-contract.md",
        "source-evidence.md",
        "architecture.md",
        "package/INDEX.md",
        "completion.md",
        "package-validation.md",
        "semantic-review.md",
        "repair-account.md",
      ]),
    );
    expect(byId("validate-architecture-package").directive).toContain(
      "deterministic observations only",
    );
    expect(byId("architecture-review").directive).toContain("genuinely independent");
    expect(byId("complete-architecture-package").directive).toContain(
      "Atomically write completion.md",
    );
    expect(byId("revise-process").hint).toContain("architecture method");
    for (const id of [
      "finalize-complete",
      "finalize-limited",
      "finalize-blocked",
      "finalize-aborted",
    ]) {
      expect(JSON.stringify(byId(id).inputSchema)).toContain(
        '"delivery_status":{"const":"workspace"}',
      );
    }
    expect(byId("finalize-complete-delivered").inputSchema.globalInputs).not.toContain(
      "delivery_status",
    );
  });

  test.each([
    [
      "existing scenario without source",
      "intake",
      {
        intake_outcome: "ready",
        operating_mode: "autonomous",
        scenario_type: "existing",
        architecture_goal: "Analyze",
        decision_use: "Decide",
        architecture_scope: ["Boundaries"],
        delivery_scope: "workspace",
      },
    ],
    [
      "project delivery without target",
      "intake",
      {
        intake_outcome: "ready",
        operating_mode: "autonomous",
        scenario_type: "new",
        architecture_goal: "Design",
        decision_use: "Decide",
        architecture_scope: ["Boundaries"],
        delivery_scope: "project",
      },
    ],
    [
      "ready discovery without clearing active request",
      "discover-new-system",
      {
        discovery_outcome: "ready",
        discovery_status: "ready",
      },
    ],
    [
      "validation repair without owner",
      "validate-architecture-package",
      {
        validation_outcome: "repair",
      },
    ],
    [
      "completion without summaries",
      "complete-architecture-package",
      {
        completion_outcome: "ready",
        result_status: "complete",
        revision_request: sentinel,
      },
    ],
    [
      "delivery success without observed status",
      "deliver-package",
      { delivery_outcome: "delivered" },
    ],
    [
      "workspace finalizer invents project delivery",
      "finalize-complete",
      {
        artifact_path: "./moira-ws/architecture-design-flow-test/final-report.md",
        terminal_status: "complete",
        delivery_status: "delivered",
      },
    ],
    [
      "project finalizer erases observed delivery",
      "finalize-complete-delivered",
      {
        artifact_path: "./moira-ws/architecture-design-flow-test/final-report.md",
        terminal_status: "complete",
        delivery_status: "workspace",
      },
    ],
  ])("rejects contradictory response: %s", async (_name, target, invalid) => {
    const routeSetup: Record<string, MockInput> =
      target === "deliver-package" || target === "finalize-complete-delivered"
        ? {
            intake: {
              intake_outcome: "ready",
              operating_mode: "autonomous",
              scenario_type: "new",
              architecture_goal: "Design",
              decision_use: "Decide",
              architecture_scope: ["Boundaries"],
              delivery_scope: "project",
              delivery_target: "/workspace/project/docs/architecture",
            },
          }
        : {};
    const result = await run({
      name: String(_name),
      mockInputs: inputs({ ...routeSetup, [String(target)]: invalid as MockInput }),
      expect: { status: "failed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain(`Input validation failed for node '${String(target)}'`);
  });

  test("rejects rework and teleport without an active cause", async () => {
    const rework = await run({
      name: "rework without request",
      mockInputs: inputs({
        intake: {
          intake_outcome: "ready",
          operating_mode: "interactive",
          scenario_type: "new",
          architecture_goal: "Design",
          decision_use: "Decide",
          architecture_scope: ["Boundaries"],
          delivery_scope: "workspace",
        },
        "interactive-acceptance": { user_decision: "rework", rework_owner: "completion" },
      }),
      expect: { status: "failed" },
    });
    expect(rework.error).toContain("Input validation failed for node 'interactive-acceptance'");

    const teleport = await run({
      name: "teleport sentinel",
      mockInputs: inputs({ "revise-process": { revision_request: sentinel } }),
      teleportAfter: { afterNode: "discover-new-system", teleportTo: "revise-process" },
      expect: { status: "failed" },
    });
    expect(teleport.error).toContain("Input validation failed for node 'revise-process'");
  });

  test("executes scenario, outcome, delivery, rework, and revision routes", async () => {
    const cases: Array<{ scenario: TestScenario; materializeError?: boolean }> = [
      {
        scenario: {
          name: "new system complete in workspace",
          mockInputs: inputs(),
          expect: { status: "completed", reaches: ["discover-new-system", "end"] },
        },
      },
      {
        scenario: {
          name: "existing system complete",
          mockInputs: inputs({
            intake: {
              intake_outcome: "ready",
              operating_mode: "autonomous",
              scenario_type: "existing",
              architecture_goal: "Analyze the billing architecture.",
              decision_use: "Prioritize incremental improvements.",
              architecture_scope: ["Current boundaries", "Operational risks"],
              source_path: "/workspace/billing",
              delivery_scope: "workspace",
            },
          }),
          expect: { status: "completed", reaches: ["discover-existing-system", "end"] },
        },
      },
      {
        scenario: {
          name: "reviewed limited",
          mockInputs: inputs({
            "discover-new-system": {
              discovery_outcome: "ready",
              discovery_status: "limited",
              revision_request: sentinel,
            },
            "complete-architecture-package": { ...completion, result_status: "limited" },
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
              terminal_reason: "Required source authority is missing.",
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
          name: "authorized project delivery",
          mockInputs: inputs({
            intake: {
              intake_outcome: "ready",
              operating_mode: "autonomous",
              scenario_type: "new",
              architecture_goal: "Design",
              decision_use: "Decide",
              architecture_scope: ["Boundaries"],
              delivery_scope: "project",
              delivery_target: "/workspace/project/docs/architecture",
            },
          }),
          expect: { status: "completed", reaches: ["deliver-package", "end"] },
        },
      },
      {
        scenario: {
          name: "project delivery blocked",
          mockInputs: inputs({
            intake: {
              intake_outcome: "ready",
              operating_mode: "autonomous",
              scenario_type: "new",
              architecture_goal: "Design",
              decision_use: "Decide",
              architecture_scope: ["Boundaries"],
              delivery_scope: "project",
              delivery_target: "/workspace/project/docs/architecture",
            },
            "deliver-package": {
              delivery_outcome: "blocked",
              terminal_reason: "Destination is not writable.",
            },
          }),
          expect: { status: "completed", reaches: ["deliver-package", "end-blocked"] },
        },
      },
      {
        scenario: {
          name: "interactive completion rework",
          mockInputs: inputs({
            intake: {
              intake_outcome: "ready",
              operating_mode: "interactive",
              scenario_type: "new",
              architecture_goal: "Design",
              decision_use: "Decide",
              architecture_scope: ["Boundaries"],
              delivery_scope: "workspace",
            },
            "complete-architecture-package": [completion, completion],
            "validate-architecture-package": [
              { validation_outcome: "pass", revision_request: sentinel },
              { validation_outcome: "pass", revision_request: sentinel },
            ],
            "architecture-review": [{ review_outcome: "pass" }, { review_outcome: "pass" }],
            "interactive-acceptance": [
              {
                user_decision: "rework",
                rework_owner: "completion",
                revision_request: "Clarify the limitation summary.",
              },
              { user_decision: "accept" },
            ],
          }),
          expect: {
            status: "completed",
            reaches: ["route-rework-completion", "complete-architecture-package", "end"],
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
              scenario_type: "new",
              architecture_goal: "Design",
              decision_use: "Decide",
              architecture_scope: ["Boundaries"],
              delivery_scope: "workspace",
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
              changed_knowledge: "The architecture evidence method changed.",
              reentry_owner: "discovery",
            },
          }),
          teleportAfter: { afterNode: "discover-new-system", teleportTo: "revise-process" },
          expect: {
            status: "completed",
            reaches: ["revise-process", "corrected-contract-review", "route-scenario", "end"],
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
    const owners = ["package", "architecture", "discovery", "validation", "completion"] as const;
    for (const owner of owners) {
      for (const source of ["validation", "semantic"] as const) {
        const repairNode =
          owner === "completion"
            ? "complete-architecture-package"
            : owner === "validation"
              ? `repair-validation-${source === "validation" ? "mechanical" : "semantic"}`
              : `repair-${owner}-${source}`;
        const overrides: Record<string, MockInput> = {};
        if (source === "validation") {
          overrides["validate-architecture-package"] = [
            { validation_outcome: "repair", repair_owner: owner },
            { validation_outcome: "pass", revision_request: sentinel },
          ];
        } else {
          overrides["validate-architecture-package"] = [
            { validation_outcome: "pass", revision_request: sentinel },
            { validation_outcome: "pass", revision_request: sentinel },
          ];
          overrides["architecture-review"] = [
            { review_outcome: "repair", repair_owner: owner },
            { review_outcome: "pass" },
          ];
        }
        if (owner === "completion")
          overrides["complete-architecture-package"] = [completion, completion];
        const result = await run({
          name: `${source} repair owned by ${owner}`,
          mockInputs: inputs(overrides),
          expect: {
            status: "completed",
            reaches: [repairNode, "validate-architecture-package", "end"],
          },
        });
        if (!result.passed) throw new Error(`${source}/${owner}: ${JSON.stringify(result)}`);
      }
    }
  });
});
