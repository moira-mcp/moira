/** Contract and behavioral scenarios for moira/iterative-research. */
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  GraphTemplateProcessor,
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

const entry = findSystemCatalogEntry("iterative-research", "public")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;
function node(graph: WorkflowGraph, id: string): any {
  const found = graph.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}
function frame(overrides: Record<string, unknown> = {}): MockInput {
  return ({ executionId }) => ({
    execution_id: executionId,
    operating_mode: "autonomous",
    research_topic: "How can bounded independent critique improve agent workflow reliability?",
    target_audience: "Agent-system maintainers",
    output_language: "English",
    depth_level: "deep",
    delivery_intent: "local",
    ...overrides,
  });
}
const limited = {
  "limited-insufficient": { outcome: "limited", reason: "insufficient_evidence" },
  "limited-exhausted": { outcome: "limited", reason: "review_exhausted" },
  "limited-repair-blocked": { outcome: "limited", reason: "repair_blocked" },
  "workspace-failure": { outcome: "limited", reason: "workspace_unavailable" },
  "identity-failure": { outcome: "limited", reason: "execution_identity_mismatch" },
};
function inputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    "materialize-workspace": {},
    "frame-contract": frame(),
    "conduct-research": { evidence_status: "sufficient" },
    "review-research": { issues_count: 0 },
    "repair-research": { repair_outcome: "changed", repair_reach: "analysis" },
    "limit-decision": { decision: "limited" },
    "choose-delivery": { decision: "local" },
    "deliver-local": { outcome: "clean_local" },
    "publish-result": {
      publication_status: "published",
      outcome: "published",
      publication_url: "https://research.example/result",
    },
    ...limited,
    ...overrides,
  };
}
type HandlerMode = "success" | "error";
type NotificationMode = "default" | "sent" | "error";
function configureHandlers(
  engine: GraphExecutionEngine,
  materialize: HandlerMode,
  notification: NotificationMode,
): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, any> }).nodeHandlers;
  if (materialize === "success") {
    handlers.set(
      "materialize",
      new MaterializeHandler(
        { createMaterializeToken: () => "scenario-token" },
        () => "https://moira.example",
      ),
    );
  } else {
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
  if (notification !== "default") {
    handlers.set("telegram-notification", {
      getNodeType: () => "telegram-notification",
      execute: async (current: { id: string }) =>
        notification === "sent"
          ? {
              nodeId: current.id,
              action: "continue",
              outputPath: "default",
              data: { telegramNotificationSent: true },
            }
          : {
              nodeId: current.id,
              action: "continue",
              outputPath: "error",
              data: { telegramNotificationFailed: true },
            },
    });
  }
}
async function run(
  scenario: TestScenario,
  materialize: HandlerMode = "success",
  notification: NotificationMode = "default",
): Promise<ScenarioResult> {
  return runScenario(workflow(), scenario, {
    engineSetup: (engine) => configureHandlers(engine, materialize, notification),
  });
}

describe("iterative-research", () => {
  test("publishes the v3 contract as a valid 49-node public workflow", async () => {
    const graph = workflow();
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(graph.metadata.version).toBe("3.0.0");
    expect(graph.nodes).toHaveLength(49);
    expect(graph.metadata.description).toContain("repeated independent critique");
    expect(graph.metadata.description).toContain("Local delivery has no external side effect");
    expect(JSON.stringify(graph)).not.toMatch(/"formatting_score"|"word_count"|"source_quota"/i);
  });

  test("materializes six execution-bound skeletons and renders the canonical workspace", async () => {
    const graph = workflow();
    const materialize = node(graph, "materialize-workspace");
    const registry = graph.variableRegistry!;
    expect(materialize.files.map((file: { path: string }) => file.path)).toEqual([
      "research-contract.md",
      "source-evidence.md",
      "research-report.md",
      "research-review.md",
      "repair-account.md",
      "delivery.html",
    ]);
    expect(materialize.files.every((file: { content: string }) => file.content === "")).toBe(true);
    expect(Object.keys(registry)).toEqual(
      expect.arrayContaining([
        "execution_id",
        "artifact_locator",
        "publication_url",
        "terminal_notified",
        "terminal_notification_failed",
      ]),
    );
    expect(node(graph, "execution-id-matches").condition.right).toEqual({
      contextPath: "executionId",
    });
    const rendered = new GraphTemplateProcessor().processDirective(
      node(graph, "conduct-research").directive,
      {
        variables: {
          research_topic: "Topic",
          target_audience: "Maintainers",
          output_language: "English",
          depth_level: "deep",
        },
        executionId: "123e4567-e89b-42d3-a456-426614174000",
        workflowId: graph.id,
        userId: "test-user",
        nodeStates: {},
      },
    );
    expect(rendered).toContain(
      "./moira-ws/iterative-research-123e4567-e89b-42d3-a456-426614174000/research-contract.md",
    );
  });

  test("bounds review and repair data and projects explicit terminal results", () => {
    const graph = workflow();
    expect(node(graph, "review-research").inputSchema.properties.issues_count).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 1000,
    });
    expect(node(graph, "repair-research").inputSchema.properties.repair_reach.enum).toEqual([
      "presentation",
      "analysis",
      "sources",
      "contract",
    ]);
    expect(node(graph, "publish-result").inputSchema.globalInputs).toEqual(["publication_url"]);
    for (const end of graph.nodes.filter((candidate) => candidate.type === "end")) {
      expect(end.finalOutput).toBeDefined();
      expect(end.finalOutput).not.toContain("send-notification");
    }
  });

  test("rejects a different schema-valid execution UUID before research", async () => {
    const result = await run({
      name: "wrong execution identity",
      mockInputs: inputs({
        "frame-contract": frame({ execution_id: "123e4567-e89b-42d3-a456-426614174000" }),
      }),
      expect: {
        status: "completed",
        reaches: ["identity-failure", "end-identity-failure"],
        avoids: ["conduct-research"],
      },
    });
    expect(result.passed).toBe(true);
  });

  test("rejects an out-of-range independent-review count", async () => {
    const result = await run({
      name: "unbounded review count",
      mockInputs: inputs({ "review-research": { issues_count: 1001 } }),
      expect: { status: "failed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'review-research'");
  });

  test.each([
    ["published without observed URL", { publication_status: "published", outcome: "published" }],
    [
      "failed publication with a URL",
      {
        publication_status: "failed",
        outcome: "delivery_failed",
        failure_reason: "Upload rejected",
        publication_url: "https://research.example/invalid",
      },
    ],
  ])("rejects invalid publication coupling: %s", async (name, publication) => {
    const result = await run({
      name: String(name),
      mockInputs: inputs({
        "frame-contract": frame({ delivery_intent: "publish" }),
        "publish-result": publication,
      }),
      expect: { status: "failed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'publish-result'");
  });

  test("covers every node and connection with authoritative and limited outcomes", async () => {
    const changed = (repair_reach: "presentation" | "analysis" | "sources" | "contract") => ({
      repair_outcome: "changed",
      repair_reach,
    });
    const nonzeroThenZero = [{ issues_count: 1 }, { issues_count: 0 }];
    const exhausted = [{ issues_count: 1 }, { issues_count: 1 }, { issues_count: 1 }];
    const cases: Array<{
      scenario: TestScenario;
      materialize?: HandlerMode;
      notification?: NotificationMode;
    }> = [
      {
        scenario: {
          name: "clean local",
          mockInputs: inputs(),
          expect: { status: "completed", reaches: ["end"] },
        },
      },
      {
        scenario: {
          name: "insufficient evidence",
          mockInputs: inputs({ "conduct-research": { evidence_status: "insufficient" } }),
          expect: { status: "completed", reaches: ["end-limited-insufficient"] },
        },
      },
      ...(["presentation", "analysis", "sources", "contract"] as const).map((reach) => ({
        scenario: {
          name: `${reach} repair`,
          mockInputs: inputs({
            "review-research": nonzeroThenZero,
            "repair-research": changed(reach),
          }),
          expect: { status: "completed" as const, reaches: ["repair-research", "end"] },
        },
      })),
      {
        scenario: {
          name: "blocked repair",
          mockInputs: inputs({
            "review-research": { issues_count: 1 },
            "repair-research": {
              repair_outcome: "blocked",
              blocked_reason: "Authorized evidence needed for the requested claim is unavailable.",
            },
          }),
          expect: { status: "completed", reaches: ["end-limited-blocked"] },
        },
      },
      {
        scenario: {
          name: "autonomous review exhaustion",
          mockInputs: inputs({
            "review-research": exhausted,
            "repair-research": changed("presentation"),
          }),
          expect: { status: "completed", reaches: ["end-limited-exhausted"] },
        },
      },
      ...(["limited", "abort"] as const).map((decision) => ({
        scenario: {
          name: `interactive review exhaustion ${decision}`,
          mockInputs: inputs({
            "frame-contract": frame({ operating_mode: "interactive" }),
            "review-research": exhausted,
            "repair-research": changed("presentation"),
            "limit-decision":
              decision === "limited" ? { decision } : { decision, outcome: "aborted" },
          }),
          expect: {
            status: "completed" as const,
            reaches: [decision === "limited" ? "end-limited-exhausted" : "end-aborted-limit"],
          },
        },
      })),
      {
        scenario: {
          name: "interactive undecided abort",
          mockInputs: inputs({
            "frame-contract": frame({
              operating_mode: "interactive",
              delivery_intent: "undecided",
            }),
            "choose-delivery": { decision: "abort", outcome: "aborted" },
          }),
          expect: { status: "completed", reaches: ["end-aborted-choice"] },
        },
      },
      {
        scenario: {
          name: "interactive undecided local",
          mockInputs: inputs({
            "frame-contract": frame({
              operating_mode: "interactive",
              delivery_intent: "undecided",
            }),
            "choose-delivery": { decision: "local" },
          }),
          expect: { status: "completed", reaches: ["choose-delivery", "end"] },
        },
      },
      {
        scenario: {
          name: "interactive undecided publish",
          mockInputs: inputs({
            "frame-contract": frame({
              operating_mode: "interactive",
              delivery_intent: "undecided",
            }),
            "choose-delivery": { decision: "publish" },
          }),
          expect: { status: "completed", reaches: ["choice-is-local", "end-published"] },
        },
      },
      {
        scenario: {
          name: "autonomous undecided defaults local",
          mockInputs: inputs({ "frame-contract": frame({ delivery_intent: "undecided" }) }),
          expect: { status: "completed", reaches: ["delivery-mode-autonomous", "end"] },
        },
      },
      {
        scenario: {
          name: "published",
          mockInputs: inputs({ "frame-contract": frame({ delivery_intent: "publish" }) }),
          expect: { status: "completed", reaches: ["end-published"] },
        },
      },
      {
        scenario: {
          name: "publication failure",
          mockInputs: inputs({
            "frame-contract": frame({ delivery_intent: "publish" }),
            "publish-result": {
              publication_status: "failed",
              outcome: "delivery_failed",
              failure_reason: "Authorized uploader returned a failure response.",
            },
          }),
          expect: { status: "completed", reaches: ["end-delivery-failed"] },
        },
      },
      {
        scenario: {
          name: "published and notified",
          mockInputs: inputs({
            "frame-contract": frame({ delivery_intent: "publish_and_notify" }),
          }),
          expect: { status: "completed", reaches: ["end-notified"] },
        },
        notification: "sent",
      },
      {
        scenario: {
          name: "notification unavailable",
          mockInputs: inputs({
            "frame-contract": frame({ delivery_intent: "publish_and_notify" }),
          }),
          expect: { status: "completed", reaches: ["end-notification-unsent"] },
        },
      },
      {
        scenario: {
          name: "notification API error",
          mockInputs: inputs({
            "frame-contract": frame({ delivery_intent: "publish_and_notify" }),
          }),
          expect: { status: "completed", reaches: ["end-notification-error"] },
        },
        notification: "error",
      },
      {
        scenario: {
          name: "workspace materialization failure",
          mockInputs: inputs(),
          expect: { status: "completed", reaches: ["end-workspace-failure"] },
        },
        materialize: "error",
      },
      {
        scenario: {
          name: "wrong execution identity coverage",
          mockInputs: inputs({
            "frame-contract": frame({ execution_id: "123e4567-e89b-42d3-a456-426614174000" }),
          }),
          expect: {
            status: "completed",
            reaches: ["identity-failure", "end-identity-failure"],
            avoids: ["conduct-research"],
          },
        },
      },
      {
        scenario: {
          name: "teleport revision",
          mockInputs: inputs({
            "revise-process": ({ executionId }) => ({
              revision_reason: "The caller narrowed the research scope after reviewing evidence.",
              execution_id: executionId,
              operating_mode: "autonomous",
              research_topic: "How should bounded reflection improve workflow reliability?",
              target_audience: "Agent-system maintainers",
              output_language: "English",
              depth_level: "deep",
              delivery_intent: "local",
            }),
          }),
          teleportAfter: { afterNode: "review-research", teleportTo: "revise-process" },
          expect: { status: "completed", reaches: ["revise-process", "end"] },
        },
      },
    ];
    const results: ScenarioResult[] = [];
    for (const current of cases)
      results.push(
        await run(
          current.scenario,
          current.materialize ?? "success",
          current.notification ?? "default",
        ),
      );
    expect(results.filter((result) => !result.passed)).toEqual([]);
    const coverage = calculateCoverage(workflow(), results, { includeGapAnalysis: true });
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
  });
});
