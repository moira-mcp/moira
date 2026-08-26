/** Contract and route scenarios for moira/smart-purchase-assistant v4. */
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

const entry = findSystemCatalogEntry("smart-purchase-assistant", "public")!;
const graph = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;
const workspace = (executionId: string) => `./moira-ws/smart-purchase-assistant-${executionId}`;

function node(workflow: WorkflowGraph, id: string): any {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function finalInput(status: "not_requested" | "sent" | "not_sent" | "failed"): MockInput {
  return ({ executionId }) => ({
    artifact_path: `${workspace(executionId)}/final-report.md`,
    summary: `Accepted purchase result with notification status ${status}.`,
    notification_status: status,
  });
}

function baseInputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    intake: {
      intake_outcome: "actionable",
      filesystem_available: true,
      operating_mode: "autonomous",
      publication_authorized: false,
      notification_authorized: false,
      purchase_request:
        "Choose a current evidence-backed laptop for software development in Germany under EUR 1800.",
    },
    "materialize-workspace": {},
    "frame-contract": { contract_outcome: "ready" },
    "research-evidence": { research_outcome: "ready", evidence_status: "sufficient" },
    "produce-report": {
      production_outcome: "ready",
      result_class: "complete",
      recommendation_summary: "Two current laptops fit the stated development use and budget.",
      limitations_summary: "Prices and stock remain time-sensitive until checkout.",
    },
    "semantic-review": { review_outcome: "pass" },
    "repair-evidence": {
      repair_outcome: "changed",
      changed_knowledge: "Current seller terms and observed dates now support the affected claims.",
    },
    "repair-report": {
      repair_outcome: "changed",
      changed_knowledge: "The report and HTML now match the accepted evidence and authority.",
      result_class: "complete",
      recommendation_summary: "Two reviewed laptops fit the stated use and budget.",
      limitations_summary: "Live price and availability remain time-sensitive.",
    },
    "reassess-contract": {
      reassessment_outcome: "eligible",
      changed_knowledge:
        "The corrected evidence method now distinguishes current and stale prices.",
    },
    "review-corrected-contract": { contract_review_outcome: "pass" },
    "present-result": { decision: "accept" },
    "rework-result": { rework_owner: "report" },
    "publish-artifact": {
      publication_status: "succeeded",
      public_url: "https://purchase.static.moira-mcp.com/",
    },
    "finalize-result": finalInput("not_requested"),
    "finalize-notified": finalInput("sent"),
    "finalize-notification-unsent": finalInput("not_sent"),
    "finalize-notification-error": finalInput("failed"),
    "finalize-blocked": ({ executionId }) => ({
      result_class: "blocked",
      artifact_path: `${workspace(executionId)}/final-report.md`,
      summary: "Purchase analysis is blocked by a factual evidence or repair prerequisite.",
    }),
    "finalize-aborted": ({ executionId }) => ({
      result_class: "aborted",
      artifact_path: `${workspace(executionId)}/final-report.md`,
      summary: "The interactive user explicitly aborted the purchase analysis.",
    }),
    "finalize-no-workspace": {
      result_class: "blocked",
      summary: "The required safe filesystem workspace is unavailable.",
    },
    "teleport-revise-process": {},
    ...overrides,
  };
}

type MaterializeMode = "success" | "error";
type TelegramMode = "default" | "sent" | "unsent" | "error";

function configureHandlers(
  engine: GraphExecutionEngine,
  materializeMode: MaterializeMode,
  telegramMode: TelegramMode,
): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, any> }).nodeHandlers;
  handlers.set(
    "materialize",
    materializeMode === "success"
      ? new MaterializeHandler(
          { createMaterializeToken: () => "smart-purchase-token" },
          () => "https://moira.example",
        )
      : {
          getNodeType: () => "materialize",
          execute: async (current: { id: string }) => ({
            nodeId: current.id,
            action: "continue",
            outputPath: "error",
            data: { errorMessage: "workspace unavailable" },
          }),
        },
  );
  if (telegramMode !== "default") {
    handlers.set("telegram-notification", {
      getNodeType: () => "telegram-notification",
      execute: async (current: { id: string }) =>
        telegramMode === "error"
          ? {
              nodeId: current.id,
              action: "continue",
              outputPath: "error",
              data: { errorMessage: "Telegram transport failed" },
            }
          : {
              nodeId: current.id,
              action: "continue",
              outputPath: "default",
              data: { telegramNotificationSent: telegramMode === "sent" },
            },
    });
  }
}

async function run(
  scenario: TestScenario,
  materializeMode: MaterializeMode = "success",
  telegramMode: TelegramMode = "default",
): Promise<ScenarioResult> {
  return runScenario(graph(), scenario, {
    engineSetup: (engine) => configureHandlers(engine, materializeMode, telegramMode),
  });
}

describe("smart-purchase-assistant", () => {
  test("publishes the restored detailed v4 public contract", async () => {
    const workflow = graph();
    expect(await new GraphValidator().validateWorkflow(workflow)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(workflow.id).toBe("b33e227c-cc2c-4931-ae5d-2de69932e41e");
    expect(workflow.metadata.version).toBe("4.0.0");
    expect(workflow.nodes).toHaveLength(54);
    expect(workflow.metadata.description).toContain("evidence-linked purchase decision package");
    expect(workflow.metadata.description).toContain("skipTelegramCheck: true");
    expect(workflow.metadata.description).toContain("never buys, reserves, contacts sellers");
    expect(workflow.nodes.filter((candidate) => candidate.type === "write-note")).toHaveLength(0);
    expect(Object.keys(workflow.variableRegistry!)).toHaveLength(16);
  });

  test("keeps one durable package and distinct authority-aware terminal routes", () => {
    const workflow = graph();
    expect(workflow.variableRegistry!.workspace_path).toMatchObject({
      const: "./moira-ws/smart-purchase-assistant-{{executionId}}",
      default: "./moira-ws/smart-purchase-assistant-{{executionId}}",
    });
    expect(node(workflow, "materialize-workspace").files.map((file: any) => file.path)).toEqual([
      "process-id.txt",
      "decision-contract.md",
      "source-evidence.md",
      "purchase-report.md",
      "purchase-report.html",
      "validation-observations.md",
      "review-findings.md",
      "repair-account.md",
      "final-report.md",
    ]);
    expect(node(workflow, "route-publication").connections).toEqual({
      true: "publish-artifact",
      false: "route-notification",
    });
    expect(node(workflow, "route-notification").connections).toEqual({
      true: "send-notification",
      false: "finalize-result",
    });
    expect(node(workflow, "route-notification-sent").condition.left.contextPath).toBe(
      "send-notification.telegramNotificationSent",
    );
    expect(
      node(workflow, "reassess-contract").inputSchema.properties.reassessment_outcome.enum,
    ).toEqual(["eligible", "blocked"]);
    expect(
      workflow.nodes.filter((candidate) => candidate.connections?.success === "finalize-aborted"),
    ).toHaveLength(0);
    expect(node(workflow, "route-result-rework").connections.false).toBe("finalize-aborted");
  });

  test("rejects contradictory outcome data instead of fabricating evidence", async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      [
        "blocked research with stale evidence status",
        "research-evidence",
        {
          research_outcome: "blocked",
          outcome_reason: "No authorized source is available.",
          evidence_status: "sufficient",
        },
      ],
      [
        "blocked production with accepted summaries",
        "produce-report",
        {
          production_outcome: "blocked",
          outcome_reason: "HTML cannot be produced safely.",
          result_class: "complete",
          recommendation_summary: "stale summary",
          limitations_summary: "stale limits",
        },
      ],
    ];

    for (const [name, targetNode, badInput] of cases) {
      const result = await run({
        name,
        mockInputs: baseInputs({ [targetNode]: badInput }),
        expect: { status: "failed" },
      });
      expect(result.status).toBe("failed");
      expect(result.error).toContain(`Input validation failed for node '${targetNode}'`);
    }

    const badPublication = await run({
      name: "publication not requested on the authorized effect node",
      mockInputs: baseInputs({
        intake: {
          intake_outcome: "actionable",
          filesystem_available: true,
          operating_mode: "autonomous",
          publication_authorized: true,
          notification_authorized: false,
          purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
        },
        "publish-artifact": {
          publication_status: "not_requested",
          failure_reason: "not attempted",
        },
      }),
      expect: { status: "failed" },
    });
    const badReassessment = await run({
      name: "autonomous reassessment pretending user abort",
      mockInputs: baseInputs({
        "semantic-review": { review_outcome: "reassess" },
        "reassess-contract": { reassessment_outcome: "aborted", outcome_reason: "agent stopped" },
      }),
      expect: { status: "failed" },
    });
    const badReportRepair = await run({
      name: "report repair without refreshed projections",
      mockInputs: baseInputs({
        "semantic-review": { review_outcome: "repair", repair_owner: "report" },
        "repair-report": { repair_outcome: "changed", changed_knowledge: "HTML changed." },
      }),
      expect: { status: "failed" },
    });
    expect(badPublication.error).toContain("Input validation failed for node 'publish-artifact'");
    expect(badReassessment.error).toContain("Input validation failed for node 'reassess-contract'");
    expect(badReportRepair.error).toContain("Input validation failed for node 'repair-report'");
  });

  test("preserves complete and limited local results while blocking real prerequisites", async () => {
    const complete = await run({
      name: "autonomous complete local result",
      mockInputs: baseInputs(),
      expect: {
        status: "completed",
        reaches: ["semantic-review", "finalize-result", "end-success"],
        avoids: ["present-result", "publish-artifact", "send-notification"],
        contextContains: { result_class: "complete", notification_status: "not_requested" },
      },
    });
    const limited = await run({
      name: "reviewed limited local result",
      mockInputs: baseInputs({
        "research-evidence": { research_outcome: "ready", evidence_status: "limited" },
        "produce-report": {
          production_outcome: "ready",
          result_class: "limited",
          recommendation_summary: "Available evidence supports only a bounded shortlist.",
          limitations_summary: "Current seller terms could not all be verified.",
        },
      }),
      expect: { status: "completed", contextContains: { result_class: "limited" } },
    });
    const noFilesystem = await run({
      name: "known filesystem prerequisite missing",
      mockInputs: baseInputs({
        intake: {
          intake_outcome: "actionable",
          filesystem_available: false,
          operating_mode: "autonomous",
          publication_authorized: false,
          notification_authorized: false,
          purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
        },
      }),
      expect: {
        status: "completed",
        reaches: ["finalize-no-workspace", "end-no-workspace"],
        avoids: ["materialize-workspace", "research-evidence"],
      },
    });
    const materializeError = await run(
      {
        name: "server-observed materialize error",
        mockInputs: baseInputs(),
        expect: {
          status: "completed",
          reaches: ["materialize-workspace", "finalize-no-workspace", "end-no-workspace"],
          avoids: ["frame-contract"],
        },
      },
      "error",
    );
    expect(
      [complete, limited, noFilesystem, materializeError].every((result) => result.passed),
    ).toBe(true);
  });

  test("routes review repair and reassessment through the earliest stale owner", async () => {
    const reportRepair = await run({
      name: "report repair and rereview",
      mockInputs: baseInputs({
        "semantic-review": [
          { review_outcome: "repair", repair_owner: "report" },
          { review_outcome: "pass" },
        ],
      }),
      expect: {
        status: "completed",
        reaches: ["repair-report", "semantic-review", "end-success"],
        avoids: ["reassess-contract"],
      },
    });
    const evidenceRepair = await run({
      name: "evidence repair recomputes dependents",
      mockInputs: baseInputs({
        "semantic-review": [
          { review_outcome: "repair", repair_owner: "evidence" },
          { review_outcome: "pass" },
        ],
        "research-evidence": [
          { research_outcome: "ready", evidence_status: "sufficient" },
          { research_outcome: "ready", evidence_status: "sufficient" },
        ],
        "produce-report": [
          baseInputs()["produce-report"] as Record<string, unknown>,
          baseInputs()["produce-report"] as Record<string, unknown>,
        ],
      }),
      expect: { status: "completed", reaches: ["repair-evidence", "research-evidence"] },
    });
    const reassessment = await run({
      name: "invalid criterion gets independently reviewed reassessment",
      mockInputs: baseInputs({
        "semantic-review": [{ review_outcome: "reassess" }, { review_outcome: "pass" }],
        "research-evidence": [
          { research_outcome: "ready", evidence_status: "sufficient" },
          { research_outcome: "ready", evidence_status: "sufficient" },
        ],
        "produce-report": [
          baseInputs()["produce-report"] as Record<string, unknown>,
          baseInputs()["produce-report"] as Record<string, unknown>,
        ],
      }),
      expect: {
        status: "completed",
        reaches: ["reassess-contract", "review-corrected-contract", "end-success"],
      },
    });
    expect(
      [reportRepair, evidenceRepair, reassessment]
        .filter((result) => !result.passed)
        .map((result) => ({
          scenario: result.scenario,
          error: result.error,
          visited: result.visitedNodes,
        })),
    ).toEqual([]);
  });

  test("keeps publication and Telegram optional with observed transport outcomes", async () => {
    const sent = await run(
      {
        name: "authorized publish and notification sent",
        mockInputs: baseInputs({
          intake: {
            intake_outcome: "actionable",
            filesystem_available: true,
            operating_mode: "autonomous",
            publication_authorized: true,
            notification_authorized: true,
            purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
          },
        }),
        expect: {
          status: "completed",
          reaches: ["publish-artifact", "send-notification", "finalize-notified", "end-success"],
          contextContains: { publication_status: "succeeded", notification_status: "sent" },
        },
      },
      "success",
      "sent",
    );
    const unsent = await run(
      {
        name: "authorized notification default false",
        mockInputs: baseInputs({
          intake: {
            intake_outcome: "actionable",
            filesystem_available: true,
            operating_mode: "autonomous",
            publication_authorized: false,
            notification_authorized: true,
            purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
          },
        }),
        expect: {
          status: "completed",
          reaches: ["finalize-notification-unsent", "end-success"],
          avoids: ["publish-artifact", "finalize-notified"],
          contextContains: { notification_status: "not_sent" },
        },
      },
      "success",
      "unsent",
    );
    const error = await run(
      {
        name: "authorized notification error",
        mockInputs: baseInputs({
          intake: {
            intake_outcome: "actionable",
            filesystem_available: true,
            operating_mode: "autonomous",
            publication_authorized: false,
            notification_authorized: true,
            purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
          },
        }),
        expect: { status: "completed", reaches: ["finalize-notification-error", "end-success"] },
      },
      "success",
      "error",
    );
    const uploadFailure = await run({
      name: "upload failure preserves local result",
      mockInputs: baseInputs({
        intake: {
          intake_outcome: "actionable",
          filesystem_available: true,
          operating_mode: "autonomous",
          publication_authorized: true,
          notification_authorized: false,
          purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
        },
        "publish-artifact": {
          publication_status: "failed",
          failure_reason: "Artifact quota is unavailable.",
        },
      }),
      expect: {
        status: "completed",
        reaches: ["publish-artifact", "finalize-result", "end-success"],
        contextContains: { publication_status: "failed", result_class: "complete" },
      },
    });
    expect([sent, unsent, error, uploadFailure].every((result) => result.passed)).toBe(true);
  });

  test("covers every node and branch including interactive rework, abort and blockers", async () => {
    const scenarios: Array<[TestScenario, MaterializeMode?, TelegramMode?]> = [
      [
        {
          name: "coverage intake blocked",
          mockInputs: baseInputs({
            intake: {
              intake_outcome: "blocked",
              outcome_reason: "The product need is not identifiable.",
              filesystem_available: true,
              operating_mode: "autonomous",
              publication_authorized: false,
              notification_authorized: false,
              purchase_request: "Help with an unspecified purchase that lacks a product category.",
            },
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage filesystem false",
          mockInputs: baseInputs({
            intake: {
              intake_outcome: "actionable",
              filesystem_available: false,
              operating_mode: "autonomous",
              publication_authorized: false,
              notification_authorized: false,
              purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
            },
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage materialize error",
          mockInputs: baseInputs(),
          expect: { status: "completed" },
        },
        "error",
      ],
      [
        {
          name: "coverage frame blocked",
          mockInputs: baseInputs({
            "frame-contract": {
              contract_outcome: "blocked",
              outcome_reason: "A material product category is missing.",
            },
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage frame reassessment",
          mockInputs: baseInputs({
            "frame-contract": {
              contract_outcome: "reassess",
              outcome_reason: "The initial market boundary is not evidence-capable.",
            },
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage research blocked",
          mockInputs: baseInputs({
            "research-evidence": {
              research_outcome: "blocked",
              outcome_reason: "No responsible comparison is possible.",
            },
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage research reassessment",
          mockInputs: baseInputs({
            "research-evidence": [
              {
                research_outcome: "reassess",
                outcome_reason: "The evidence geography conflicts with the contract.",
              },
              { research_outcome: "ready", evidence_status: "sufficient" },
            ],
            "produce-report": [
              baseInputs()["produce-report"] as Record<string, unknown>,
              baseInputs()["produce-report"] as Record<string, unknown>,
            ],
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage production blocked",
          mockInputs: baseInputs({
            "produce-report": {
              production_outcome: "blocked",
              outcome_reason: "A safe self-contained report cannot be produced.",
            },
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage production reassessment",
          mockInputs: baseInputs({
            "produce-report": [
              {
                production_outcome: "reassess",
                outcome_reason: "The HTML criterion cannot distinguish a stale report.",
              },
              baseInputs()["produce-report"] as Record<string, unknown>,
            ],
            "research-evidence": [
              { research_outcome: "ready", evidence_status: "sufficient" },
              { research_outcome: "ready", evidence_status: "sufficient" },
            ],
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage semantic blocked",
          mockInputs: baseInputs({ "semantic-review": { review_outcome: "blocked" } }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage evidence repair changed",
          mockInputs: baseInputs({
            "semantic-review": [
              { review_outcome: "repair", repair_owner: "evidence" },
              { review_outcome: "pass" },
            ],
            "research-evidence": [
              { research_outcome: "ready", evidence_status: "sufficient" },
              { research_outcome: "ready", evidence_status: "sufficient" },
            ],
            "produce-report": [
              baseInputs()["produce-report"] as Record<string, unknown>,
              baseInputs()["produce-report"] as Record<string, unknown>,
            ],
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage evidence repair reassess",
          mockInputs: baseInputs({
            "semantic-review": [
              { review_outcome: "repair", repair_owner: "evidence" },
              { review_outcome: "pass" },
            ],
            "repair-evidence": { repair_outcome: "reassess" },
            "research-evidence": [
              { research_outcome: "ready", evidence_status: "sufficient" },
              { research_outcome: "ready", evidence_status: "sufficient" },
            ],
            "produce-report": [
              baseInputs()["produce-report"] as Record<string, unknown>,
              baseInputs()["produce-report"] as Record<string, unknown>,
            ],
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage report repair changed",
          mockInputs: baseInputs({
            "semantic-review": [
              { review_outcome: "repair", repair_owner: "report" },
              { review_outcome: "pass" },
            ],
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage report repair blocked",
          mockInputs: baseInputs({
            "semantic-review": { review_outcome: "repair", repair_owner: "report" },
            "repair-report": {
              repair_outcome: "blocked",
              blocker_reason: "The accepted HTML cannot be rendered in this environment.",
            },
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage evidence repair blocked",
          mockInputs: baseInputs({
            "semantic-review": { review_outcome: "repair", repair_owner: "evidence" },
            "repair-evidence": {
              repair_outcome: "blocked",
              blocker_reason: "Required source access is irreducible.",
            },
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage corrected contract reassess then block",
          mockInputs: baseInputs({
            "semantic-review": { review_outcome: "reassess" },
            "reassess-contract": [
              {
                reassessment_outcome: "eligible",
                changed_knowledge: "A corrected criterion distinguishes current seller terms.",
              },
              {
                reassessment_outcome: "blocked",
                outcome_reason: "No lawful evidence source remains available.",
              },
            ],
            "review-corrected-contract": { contract_review_outcome: "reassess" },
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage report repair reassess",
          mockInputs: baseInputs({
            "semantic-review": [
              { review_outcome: "repair", repair_owner: "report" },
              { review_outcome: "pass" },
            ],
            "repair-report": { repair_outcome: "reassess" },
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage interactive contract rework",
          mockInputs: baseInputs({
            intake: {
              intake_outcome: "actionable",
              filesystem_available: true,
              operating_mode: "interactive",
              publication_authorized: false,
              notification_authorized: false,
              purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
            },
            "present-result": [
              { decision: "rework", feedback: "Change the valid decision boundary." },
              { decision: "accept" },
            ],
            "rework-result": { rework_owner: "contract" },
            "research-evidence": [
              { research_outcome: "ready", evidence_status: "sufficient" },
              { research_outcome: "ready", evidence_status: "sufficient" },
            ],
            "produce-report": [
              baseInputs()["produce-report"] as Record<string, unknown>,
              baseInputs()["produce-report"] as Record<string, unknown>,
            ],
            "semantic-review": [{ review_outcome: "pass" }, { review_outcome: "pass" }],
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage interactive evidence rework",
          mockInputs: baseInputs({
            intake: {
              intake_outcome: "actionable",
              filesystem_available: true,
              operating_mode: "interactive",
              publication_authorized: false,
              notification_authorized: false,
              purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
            },
            "present-result": [
              { decision: "rework", feedback: "Refresh one time-sensitive seller term." },
              { decision: "accept" },
            ],
            "rework-result": { rework_owner: "evidence" },
            "research-evidence": [
              { research_outcome: "ready", evidence_status: "sufficient" },
              { research_outcome: "ready", evidence_status: "sufficient" },
            ],
            "produce-report": [
              baseInputs()["produce-report"] as Record<string, unknown>,
              baseInputs()["produce-report"] as Record<string, unknown>,
            ],
            "semantic-review": [{ review_outcome: "pass" }, { review_outcome: "pass" }],
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage corrected contract blocked",
          mockInputs: baseInputs({
            "semantic-review": { review_outcome: "reassess" },
            "review-corrected-contract": { contract_review_outcome: "blocked" },
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage notification unsent",
          mockInputs: baseInputs({
            intake: {
              intake_outcome: "actionable",
              filesystem_available: true,
              operating_mode: "autonomous",
              publication_authorized: false,
              notification_authorized: true,
              purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
            },
          }),
          expect: { status: "completed" },
        },
        "success",
        "unsent",
      ],
      [
        {
          name: "coverage notification error",
          mockInputs: baseInputs({
            intake: {
              intake_outcome: "actionable",
              filesystem_available: true,
              operating_mode: "autonomous",
              publication_authorized: false,
              notification_authorized: true,
              purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
            },
          }),
          expect: { status: "completed" },
        },
        "success",
        "error",
      ],
      [
        {
          name: "coverage process teleport",
          mockInputs: baseInputs({
            "research-evidence": [
              { research_outcome: "ready", evidence_status: "sufficient" },
              { research_outcome: "ready", evidence_status: "sufficient" },
            ],
            "produce-report": [
              baseInputs()["produce-report"] as Record<string, unknown>,
              baseInputs()["produce-report"] as Record<string, unknown>,
            ],
          }),
          teleportAfter: {
            afterNode: "frame-contract",
            teleportTo: "teleport-revise-process",
          },
          expect: { status: "completed", reaches: ["teleport-revise-process"] },
        },
      ],
      [
        {
          name: "coverage interactive report rework",
          mockInputs: baseInputs({
            intake: {
              intake_outcome: "actionable",
              filesystem_available: true,
              operating_mode: "interactive",
              publication_authorized: false,
              notification_authorized: false,
              purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
            },
            "present-result": [
              { decision: "rework", feedback: "Clarify the display trade-off." },
              { decision: "accept" },
            ],
            "rework-result": { rework_owner: "report" },
            "produce-report": [
              baseInputs()["produce-report"] as Record<string, unknown>,
              baseInputs()["produce-report"] as Record<string, unknown>,
            ],
            "semantic-review": [{ review_outcome: "pass" }, { review_outcome: "pass" }],
          }),
          expect: { status: "completed" },
        },
      ],
      [
        {
          name: "coverage interactive abort",
          mockInputs: baseInputs({
            intake: {
              intake_outcome: "actionable",
              filesystem_available: true,
              operating_mode: "interactive",
              publication_authorized: false,
              notification_authorized: false,
              purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
            },
            "present-result": { decision: "abort" },
          }),
          expect: { status: "completed", reaches: ["finalize-aborted", "end-aborted"] },
        },
      ],
      [
        {
          name: "coverage notification sent",
          mockInputs: baseInputs({
            intake: {
              intake_outcome: "actionable",
              filesystem_available: true,
              operating_mode: "autonomous",
              publication_authorized: true,
              notification_authorized: true,
              purchase_request: "Choose an evidence-backed laptop under EUR 1800 in Germany.",
            },
          }),
          expect: { status: "completed" },
        },
        "success",
        "sent",
      ],
    ];

    const results: ScenarioResult[] = [];
    for (const [scenario, materializeMode = "success", telegramMode = "default"] of scenarios) {
      results.push(await run(scenario, materializeMode, telegramMode));
    }
    expect(results.filter((result) => !result.passed)).toEqual([]);
    const coverage = calculateCoverage(graph(), results, { includeGapAnalysis: true });
    expect({
      nodeCoverage: coverage.nodeCoverage,
      branchCoverage: coverage.branchCoverage,
      unvisitedNodes: coverage.unvisitedNodes,
      uncoveredBranches: coverage.uncoveredBranches,
    }).toEqual({
      nodeCoverage: 100,
      branchCoverage: 100,
      unvisitedNodes: [],
      uncoveredBranches: [],
    });
  });
});
