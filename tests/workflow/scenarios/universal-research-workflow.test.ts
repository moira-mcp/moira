/** Contract and behavioral scenarios for moira/universal-research-workflow. */
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

type StorageMode = "filesystem" | "memory";
type OperatingMode = "autonomous" | "interactive";
type DeliveryIntent = "local" | "publish" | "publish_and_notify" | "undecided";

const entry = findSystemCatalogEntry("universal-research-workflow", "public")!;
const graph = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;
const summary =
  "The current authorized evidence supports a bounded decision while preserving explicit uncertainty and limitations.";
const readiness =
  "The current evidence was checked against scope, provenance, access authority, relevance, contradiction, currency, and reproducibility. It is fit for the bounded question with the recorded limitations.";

function node(workflow: WorkflowGraph, id: string): any {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function sourcePolicy() {
  return [
    {
      id: "reflection-paper",
      type: "public_discovery",
      locator: "A public paper selected for the bounded research question",
      authorization: "authorized",
      relation_to_authority_ceiling: "equal",
      availability: "unknown",
      data_classification: "public",
      limitation: "Publication-level evidence cannot establish every production effect.",
    },
  ];
}

function evidence() {
  return [
    {
      id: "reflection-paper",
      type: "paper",
      locator: "doi:10.0000/example-reflection",
      authorization: "authorized",
      data_classification: "public",
      initial_availability: "unknown",
      actual_availability: "available",
      access_outcome: "usable",
      sanitized_provenance: "Public paper accessed through an authorized scholarly index.",
      relevance: "Directly evaluates bounded reflection in agent systems.",
      claims_supported: ["Independent critique can expose otherwise missed workflow defects."],
      contradictions: [],
      uncertainty: "The study does not cover every production environment.",
      currency: "Published in 2026; accessed during the current execution.",
      limitation: "The reported evaluation is bounded to the study setup.",
    },
  ];
}

function result(
  storageMode: StorageMode = "memory",
  status: "complete" | "limited" = "complete",
  executionId = "123e4567-e89b-42d3-a456-426614174000",
) {
  const common = {
    status,
    storage_mode: storageMode,
    decision_context:
      "Decide how to improve reusable agent workflows without weakening authority boundaries.",
    sources:
      status === "complete"
        ? evidence().map(
            ({
              relevance: _r,
              claims_supported: _c,
              contradictions: _x,
              uncertainty: _u,
              currency: _d,
              ...item
            }) => item,
          )
        : [],
    executive_summary:
      status === "complete"
        ? summary
        : "The available authorized evidence is insufficient for an authoritative answer.",
    evidence_summary:
      status === "complete"
        ? "One authorized public source supports the bounded recommendation."
        : "No usable authorized evidence supports the requested conclusion.",
    limitations: [
      "The result remains bounded by the declared source policy and observed access outcomes.",
    ],
    recommendations:
      status === "complete"
        ? [
            "Adopt independent zero-blocker review with changed repair and explicit authority gates.",
          ]
        : [],
    visualization_summary: "No visualization is needed for this bounded comparison.",
    reproducibility:
      "Use the recorded source identity, access outcome, and limitations to reproduce the assessment.",
  };
  return storageMode === "filesystem"
    ? {
        ...common,
        report_path: `./moira-ws/universal-research-${executionId}/research-report.md`,
        artifact_paths: [
          `./moira-ws/universal-research-${executionId}/research-contract.md`,
          `./moira-ws/universal-research-${executionId}/source-evidence.json`,
          `./moira-ws/universal-research-${executionId}/research-report.md`,
          `./moira-ws/universal-research-${executionId}/research-review.md`,
          `./moira-ws/universal-research-${executionId}/repair-account.md`,
          `./moira-ws/universal-research-${executionId}/delivery.html`,
        ],
      }
    : { ...common, memory_report: `${summary} `.repeat(3) };
}

function capture(
  storageMode: StorageMode = "memory",
  operatingMode: OperatingMode = "autonomous",
  deliveryIntent: DeliveryIntent = "local",
  overrides: Record<string, unknown> = {},
): MockInput {
  return ({ executionId }) => ({
    operating_mode: operatingMode,
    storage_mode: storageMode,
    execution_id: executionId,
    question: "Which evidence-backed reflection mechanisms improve reusable agent workflows?",
    decision_context:
      "Decide how to improve reusable agent workflows without weakening authority boundaries.",
    scope:
      "Authorized public and supplied evidence about reflection mechanisms; production mutation is excluded.",
    audience: "Agent-system maintainers",
    output_language: "English",
    depth_level: "deep",
    constraints:
      "Use only authorized sources and preserve uncertainty, privacy, licensing, and retention limits.",
    success_criteria:
      "Every material claim is traceable and the result passes an independent exact-zero review.",
    deliverables:
      "A reviewed research report with evidence, limitations, recommendations, and reproducibility notes.",
    confidentiality_policy:
      "Only public discovery and explicitly supplied data are authorized; do not retain secrets or personal data.",
    current_data_policy: {
      relation_to_ceiling: "equal",
      policy: "Use only public discovery and explicitly supplied data; minimize retained content.",
    },
    source_policy: sourcePolicy(),
    delivery_intent: deliveryIntent,
    publication_authorized: deliveryIntent === "publish" || deliveryIntent === "publish_and_notify",
    notification_authorized: deliveryIntent === "publish_and_notify",
    ...overrides,
  });
}

function baseInputs(
  storageMode: StorageMode = "memory",
  operatingMode: OperatingMode = "autonomous",
  deliveryIntent: DeliveryIntent = "local",
): Record<string, MockInput> {
  const researchResult: MockInput = ({ executionId }) => ({
    research_result: result(storageMode, "complete", executionId),
  });
  return {
    "capture-context": capture(storageMode, operatingMode, deliveryIntent),
    "identity-failure": {
      reason: "The supplied execution ID does not match the engine-owned current execution.",
    },
    "materialize-workspace": {},
    "frame-problem": {
      problem_summary: `${summary} The contract fixes the decision, scope, evidence authority, success criteria, and delivery boundary before access.`,
    },
    "approve-problem": { decision: "accepted" },
    "review-policy-authority": { issues_count: 0 },
    "acquire-sources": {
      usable_evidence_count: 1,
      acquisition_summary:
        "One authorized public source was accessed and recorded with truthful provenance, support, uncertainty, currency, and limitations.",
    },
    "acquire-sources-memory": {
      source_evidence: evidence(),
      usable_evidence_count: 1,
      acquisition_summary:
        "One authorized public source was accessed and recorded with truthful provenance, support, uncertainty, currency, and limitations.",
    },
    "prepare-data": { evidence_status: "sufficient", current_readiness_record: readiness },
    "review-data-file": { issues_count: 0 },
    "review-data-inline": { issues_count: 0 },
    "analyze-and-synthesize": researchResult,
    "produce-limited-result": ({ executionId }) => ({
      research_result: result(storageMode, "limited", executionId),
    }),
    "review-result-file": { issues_count: 0 },
    "review-result-inline": { issues_count: 0 },
    "approve-final": { decision: "accepted" },
    "prepare-delivery-summary": ({ executionId }) => ({
      result_status: "complete",
      result_summary: summary,
      result_location:
        storageMode === "filesystem"
          ? `./moira-ws/universal-research-${executionId}/research-report.md`
          : "memory",
    }),
    "deliver-reviewed-limited": ({ executionId }) => ({
      outcome: "limited",
      result_status: "limited",
      result_summary:
        "The independently reviewed result is limited because authorized usable evidence was insufficient.",
      result_location:
        storageMode === "filesystem"
          ? `./moira-ws/universal-research-${executionId}/research-report.md`
          : "memory",
    }),
    "deliver-local": { outcome: "accepted_local" },
    "choose-delivery": { decision: "local" },
    "external-delivery-unavailable": {
      outcome: "delivery_failed",
      reason: "Static publication requires filesystem mode.",
    },
    "publication-not-authorized": {
      outcome: "delivery_failed",
      reason: "Publication was not explicitly authorized.",
    },
    "publish-result": {
      publication_status: "published",
      publication_url: "https://research.example/result",
    },
    "notification-not-authorized": {
      outcome: "notification_failed",
      reason: "notification_not_authorized",
    },
    "record-notified": { outcome: "published_and_notified" },
    "record-notification-unsent": { outcome: "notification_failed", reason: "telegram_unsent" },
    "record-notification-error": {
      outcome: "notification_failed",
      reason: "Telegram returned an error.",
    },
    "repair-blocked": {
      outcome: "recovery_blocker",
      reason: "The required authority or evidence cannot be obtained in this execution.",
    },
    "record-final-abort": {
      outcome: "aborted",
      stage: "final_acceptance",
      reason: "user_requested_abort",
    },
    "record-delivery-abort": {
      outcome: "aborted",
      stage: "delivery_choice",
      reason: "user_requested_abort",
    },
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
          { createMaterializeToken: () => "universal-research-token" },
          () => "https://moira.example",
        )
      : {
          getNodeType: () => "materialize",
          execute: async (current: { id: string }) => ({
            nodeId: current.id,
            action: "continue",
            outputPath: "error",
            data: { error: "workspace unavailable" },
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
              data: { telegramNotificationFailed: true },
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

describe("universal-research-workflow", () => {
  test("publishes a valid detailed v3 public contract with fixed execution-bound artifacts", async () => {
    const workflow = graph();
    expect(await new GraphValidator().validateWorkflow(workflow)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(workflow.metadata.version).toBe("3.0.2");
    expect(workflow.nodes).toHaveLength(92);
    expect(workflow.metadata.description).toContain(
      "filesystem artifacts or a bounded self-contained memory result",
    );
    expect(workflow.metadata.description).toContain(
      "independent reviewer must report exactly zero",
    );
    expect(workflow.metadata.description).toContain("separate explicit authority");
    expect(
      node(workflow, "materialize-workspace").files.map((file: { path: string }) => file.path),
    ).toEqual([
      "research-contract.md",
      "source-evidence.json",
      "research-report.md",
      "research-review.md",
      "repair-account.md",
      "delivery.html",
    ]);
    expect(node(workflow, "execution-id-matches").condition.right).toEqual({
      contextPath: "executionId",
    });
  });

  test("renders the current execution workspace and gives final reviewers the exact current result", () => {
    const workflow = graph();
    const rendered = new GraphTemplateProcessor().processDirective(
      node(workflow, "review-result-file").directive,
      {
        variables: {
          research_result: result("filesystem"),
          question: "Question",
          decision_context: "Decision",
          scope: "Scope",
          audience: "Audience",
          output_language: "English",
          depth_level: "deep",
          constraints: "None",
          success_criteria: "Traceable",
          deliverables: "Report",
          confidentiality_policy: "Public only",
          current_data_policy: { relation_to_ceiling: "equal", policy: "Public only" },
          source_policy: sourcePolicy(),
          current_readiness_record: readiness,
          current_repair_account: "No repair or revision has occurred for the current candidate.",
        },
        executionId: "123e4567-e89b-42d3-a456-426614174000",
        workflowId: workflow.id,
        userId: "test-user",
        nodeStates: {},
      },
    );
    expect(rendered).toContain(
      "./moira-ws/universal-research-123e4567-e89b-42d3-a456-426614174000/research-report.md",
    );
    expect(rendered).toContain(summary);
    expect(node(workflow, "review-result-inline").directive).toContain("{{research_result}}");
  });

  test("rejects invented availability and contradictory external outcomes", async () => {
    const invented = evidence();
    invented[0] = {
      ...invented[0],
      authorization: "not_authorized",
      access_outcome: "not_authorized",
      actual_availability: "available",
    };
    const invalidEvidence = await run({
      name: "invented availability",
      mockInputs: {
        ...baseInputs(),
        "acquire-sources-memory": {
          source_evidence: invented,
          usable_evidence_count: 0,
          acquisition_summary:
            "The source was not authorized, so availability remains unknown and no content was accessed or retained.",
        },
      },
      expect: { status: "failed" },
    });
    const invalidPublication = await run({
      name: "published without URL",
      mockInputs: {
        ...baseInputs("filesystem", "autonomous", "publish"),
        "publish-result": { publication_status: "published" },
      },
      expect: { status: "failed" },
    });
    expect(invalidEvidence.status).toBe("failed");
    expect(invalidPublication.status).toBe("failed");
  });

  test("covers autonomous memory and filesystem success plus reviewed limited evidence", async () => {
    const memory = await run({
      name: "memory local",
      mockInputs: baseInputs(),
      expect: {
        status: "completed",
        reaches: ["end-local"],
        avoids: ["materialize-workspace", "approve-problem", "approve-final"],
      },
    });
    const filesystem = await run({
      name: "filesystem local",
      mockInputs: baseInputs("filesystem"),
      expect: {
        status: "completed",
        reaches: ["materialize-workspace", "review-data-file", "review-result-file", "end-local"],
      },
    });
    const limited = await run({
      name: "zero evidence limited",
      mockInputs: {
        ...baseInputs(),
        "acquire-sources-memory": {
          source_evidence: [],
          usable_evidence_count: 0,
          acquisition_summary:
            "No authorized source was usable; access outcomes and limitations were recorded without inventing availability or source content.",
        },
        "prepare-data": {
          evidence_status: "limited",
          current_readiness_record: `${readiness} No usable evidence supports an authoritative conclusion.`,
        },
      },
      expect: {
        status: "completed",
        reaches: [
          "prepare-data",
          "produce-limited-result",
          "deliver-reviewed-limited",
          "end-reviewed-limited",
        ],
        avoids: ["analyze-and-synthesize", "publish-result"],
      },
    });
    expect([memory, filesystem, limited].filter((item) => !item.passed)).toEqual([]);
  });

  test("routes nonzero policy, readiness, and final findings only through changed repair or a blocker", async () => {
    const policy = await run({
      name: "policy changed",
      mockInputs: {
        ...baseInputs(),
        "review-policy-authority": [
          {
            issues_count: 1,
            findings: "The current policy must be narrowed before source access.",
          },
          { issues_count: 0 },
        ],
        "repair-policy-authority": {
          source_policy: sourcePolicy(),
          current_data_policy: {
            relation_to_ceiling: "narrower",
            policy: "Use only the named public paper and retain only sanitized provenance.",
          },
          current_repair_account:
            "Narrowed the source and data policy before any access was attempted.",
          policy_repair_reach: "changed",
        },
      },
      expect: {
        status: "completed",
        reaches: ["repair-policy-authority", "acquire-sources-memory"],
      },
    });
    const readinessRepair = await run({
      name: "readiness contained",
      mockInputs: {
        ...baseInputs(),
        "review-data-inline": [
          { issues_count: 1, findings: "Clarify the current evidence limitation." },
          { issues_count: 0 },
        ],
        "repair-data-inline": {
          evidence_repair_reach: "contained",
          current_readiness_record: `${readiness} The evaluation boundary is now explicit.`,
          current_repair_account:
            "Reproduced and corrected the missing evidence limitation in the current readiness record.",
        },
      },
      expect: { status: "completed", reaches: ["repair-data-inline"] },
    });
    const finalRepair = await run({
      name: "result analysis repair",
      mockInputs: {
        ...baseInputs(),
        "analyze-and-synthesize": [
          { research_result: result("memory") },
          { research_result: result("memory") },
        ],
        "review-result-inline": [
          { issues_count: 1, findings: "The synthesis overstates one recommendation." },
          { issues_count: 0 },
        ],
        "repair-result-inline": {
          research_repair_reach: "analysis",
          research_result: result("memory"),
          current_repair_account:
            "Reproduced and corrected the overstated recommendation, then rebuilt the current synthesis.",
        },
      },
      expect: { status: "completed", reaches: ["repair-result-inline", "prepare-data"] },
    });
    const blocked = await run({
      name: "policy blocked",
      mockInputs: {
        ...baseInputs(),
        "review-policy-authority": {
          issues_count: 1,
          findings: "Access requires authority that was not supplied.",
        },
        "repair-policy-authority": {
          current_repair_account:
            "The requested source access exceeds the immutable authority ceiling and cannot be repaired locally.",
          policy_repair_reach: "blocked",
        },
      },
      expect: {
        status: "completed",
        reaches: ["repair-blocked", "end-repair-blocked"],
        avoids: ["acquire-sources-memory"],
      },
    });
    expect([policy, readinessRepair, finalRepair, blocked].filter((item) => !item.passed)).toEqual(
      [],
    );
  });

  test("keeps publication and notification behind separate authority and observed outcomes", async () => {
    const published = await run({
      name: "published",
      mockInputs: baseInputs("filesystem", "autonomous", "publish"),
      expect: { status: "completed", reaches: ["publish-result", "end-published"] },
    });
    const noPublicationAuthority = await run({
      name: "publication denied",
      mockInputs: {
        ...baseInputs("filesystem", "autonomous", "publish"),
        "capture-context": capture("filesystem", "autonomous", "publish", {
          publication_authorized: false,
        }),
      },
      expect: {
        status: "completed",
        reaches: ["publication-not-authorized", "end-delivery-not-authorized"],
        avoids: ["publish-result"],
      },
    });
    const notified = await run(
      {
        name: "notified",
        mockInputs: baseInputs("filesystem", "autonomous", "publish_and_notify"),
        expect: { status: "completed", reaches: ["record-notified", "end-notified"] },
      },
      "success",
      "sent",
    );
    const unsent = await run(
      {
        name: "unsent",
        mockInputs: baseInputs("filesystem", "autonomous", "publish_and_notify"),
        expect: {
          status: "completed",
          reaches: ["record-notification-unsent", "end-notification-unsent"],
        },
      },
      "success",
      "unsent",
    );
    const error = await run(
      {
        name: "notification error",
        mockInputs: baseInputs("filesystem", "autonomous", "publish_and_notify"),
        expect: {
          status: "completed",
          reaches: ["record-notification-error", "end-notification-error"],
        },
      },
      "success",
      "error",
    );
    expect(
      [published, noPublicationAuthority, notified, unsent, error].filter((item) => !item.passed),
    ).toEqual([]);
  });

  test("covers interactive correction, guarded process revision, truthful aborts, and workspace fallback", async () => {
    const interactive = await run({
      name: "interactive corrections",
      mockInputs: {
        ...baseInputs("memory", "interactive"),
        "frame-problem": [
          {
            problem_summary: `${summary} Initial contract framing remains bounded and explicit for independent review.`,
          },
          {
            problem_summary: `${summary} Revised contract framing now includes the requested audience boundary and remains independently reviewable.`,
          },
        ],
        "approve-problem": [
          { decision: "revise", feedback: "Clarify the audience boundary." },
          { decision: "accepted" },
        ],
        "revise-problem": {
          question: "Which evidence-backed reflection mechanisms improve reusable agent workflows?",
          decision_context:
            "Decide how to improve reusable agent workflows without weakening authority boundaries.",
          scope:
            "Authorized public evidence about reflection mechanisms; production mutation is excluded.",
          audience: "Agent-system maintainers and workflow authors",
          output_language: "English",
          depth_level: "deep",
          constraints: "Use only authorized sources and preserve uncertainty.",
          success_criteria: "Every claim is traceable and independently reviewed.",
          deliverables: "A reviewed research report with limitations and recommendations.",
          current_data_policy: {
            relation_to_ceiling: "narrower",
            policy: "Use only the named public source.",
          },
          source_policy: sourcePolicy(),
          delivery_intent: "local",
          resume_stage: "acquisition",
          current_repair_account:
            "Applied the explicit audience feedback to the canonical contract.",
        },
        "approve-final": { decision: "accepted" },
      },
      expect: { status: "completed", reaches: ["revise-problem", "approve-final", "end-local"] },
    });
    const abortFinal = await run({
      name: "final abort",
      mockInputs: {
        ...baseInputs("memory", "interactive"),
        "approve-final": { decision: "abort" },
      },
      expect: { status: "completed", reaches: ["record-final-abort", "end-aborted"] },
    });
    const abortDelivery = await run({
      name: "delivery abort",
      mockInputs: {
        ...baseInputs("memory", "interactive", "undecided"),
        "choose-delivery": { decision: "abort" },
      },
      expect: { status: "completed", reaches: ["record-delivery-abort", "end-aborted"] },
    });
    const fallback = await run(
      {
        name: "workspace fallback",
        mockInputs: baseInputs("filesystem"),
        expect: {
          status: "completed",
          reaches: ["fallback-to-memory", "acquire-sources-memory", "end-local"],
        },
      },
      "error",
    );
    const teleport = await run({
      name: "analysis presentation revision",
      mockInputs: {
        ...baseInputs(),
        "revise-analysis-process": ({ executionId }) => ({
          execution_id: executionId,
          resume_stage: "analysis",
          audience: "Workflow maintainers and security reviewers",
          output_language: "English",
          deliverables: "A reviewed report with an updated audience-facing explanation.",
          current_repair_account:
            "Changed only presentation fields after the current readiness review.",
        }),
      },
      teleportAfter: { afterNode: "review-data-inline", teleportTo: "revise-analysis-process" },
      expect: {
        status: "completed",
        reaches: ["revise-analysis-process", "analyze-and-synthesize"],
      },
    });
    expect(
      [interactive, abortFinal, abortDelivery, fallback, teleport].filter((item) => !item.passed),
    ).toEqual([]);
  });

  test("combined scenarios retain complete graph coverage", async () => {
    const changedResult = (
      reach: "contained" | "analysis" | "source",
      storageMode: StorageMode = "memory",
    ) => ({
      research_repair_reach: reach,
      research_result: result(storageMode),
      current_repair_account: `Reproduced the finding and changed the current ${reach} representation before re-review.`,
    });
    const contractChange = {
      research_repair_reach: "contract",
      question:
        "Which reviewed reflection mechanisms improve reusable agent workflows in bounded environments?",
      decision_context:
        "Decide how to improve reusable agent workflows without weakening authority boundaries.",
      scope:
        "Authorized public evidence about reflection mechanisms; production mutation remains excluded.",
      audience: "Agent-system maintainers",
      output_language: "English",
      depth_level: "deep",
      constraints:
        "Use authorized sources and preserve uncertainty, privacy, licensing, and retention limits.",
      success_criteria: "Every material claim is traceable and independently reviewed.",
      deliverables: "A reviewed research report with limitations and recommendations.",
      current_data_policy: {
        relation_to_ceiling: "narrower",
        policy: "Use only the named public source.",
      },
      source_policy: sourcePolicy(),
      delivery_intent: "local",
      resume_stage: "acquisition",
      current_repair_account:
        "Reproduced the contract defect and changed the bounded question before reacquisition.",
    };
    const nonzeroThenZero = [
      { issues_count: 1, findings: "A current blocking defect must be repaired." },
      { issues_count: 0 },
    ];
    const cases: Array<{
      scenario: TestScenario;
      materialize?: MaterializeMode;
      telegram?: TelegramMode;
    }> = [
      {
        scenario: {
          name: "coverage memory",
          mockInputs: baseInputs(),
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage filesystem",
          mockInputs: baseInputs("filesystem"),
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage limited",
          mockInputs: {
            ...baseInputs(),
            "prepare-data": {
              evidence_status: "limited",
              current_readiness_record: `${readiness} The usable evidence is insufficient.`,
            },
          },
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage wrong identity",
          mockInputs: {
            ...baseInputs(),
            "capture-context": capture("memory", "autonomous", "local", {
              execution_id: "123e4567-e89b-42d3-a456-426614174000",
            }),
          },
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage materialize fallback",
          mockInputs: baseInputs("filesystem"),
          expect: { status: "completed" },
        },
        materialize: "error",
      },
      {
        scenario: {
          name: "coverage problem revision",
          mockInputs: {
            ...baseInputs("memory", "interactive"),
            "frame-problem": [
              {
                problem_summary: `${summary} Initial framing has a correct authority boundary but an incomplete audience statement.`,
              },
              {
                problem_summary: `${summary} Revised framing includes the complete audience and authority boundary.`,
              },
            ],
            "approve-problem": [
              { decision: "revise", feedback: "Clarify the audience." },
              { decision: "accepted" },
            ],
            "revise-problem": {
              question: contractChange.question,
              decision_context: contractChange.decision_context,
              scope: contractChange.scope,
              audience: contractChange.audience,
              output_language: contractChange.output_language,
              depth_level: contractChange.depth_level,
              constraints: contractChange.constraints,
              success_criteria: contractChange.success_criteria,
              deliverables: contractChange.deliverables,
              current_data_policy: contractChange.current_data_policy,
              source_policy: contractChange.source_policy,
              delivery_intent: contractChange.delivery_intent,
              resume_stage: contractChange.resume_stage,
              current_repair_account:
                "Changed the audience boundary after explicit problem feedback.",
            },
          },
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage policy changed",
          mockInputs: {
            ...baseInputs(),
            "review-policy-authority": nonzeroThenZero,
            "repair-policy-authority": {
              source_policy: sourcePolicy(),
              current_data_policy: {
                relation_to_ceiling: "narrower",
                policy: "Use only the named public source.",
              },
              current_repair_account: "Narrowed policy before access.",
              policy_repair_reach: "changed",
            },
          },
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage policy blocked",
          mockInputs: {
            ...baseInputs(),
            "review-policy-authority": nonzeroThenZero[0],
            "repair-policy-authority": {
              current_repair_account: "Required authority is unavailable.",
              policy_repair_reach: "blocked",
            },
          },
          expect: { status: "completed" },
        },
      },
      ...(["contained", "source", "limited", "blocked"] as const).flatMap((reach) =>
        (["memory", "filesystem"] as const).map((storageMode) => ({
          scenario: {
            name: `coverage ${storageMode} evidence ${reach}`,
            mockInputs: {
              ...baseInputs(storageMode),
              [storageMode === "memory" ? "review-data-inline" : "review-data-file"]:
                storageMode === "memory"
                  ? nonzeroThenZero
                  : [{ issues_count: 1 }, { issues_count: 0 }],
              [storageMode === "memory" ? "repair-data-inline" : "repair-data-file"]: {
                evidence_repair_reach: reach,
                ...(reach === "contained" || reach === "limited"
                  ? { current_readiness_record: `${readiness} The repaired boundary is explicit.` }
                  : {}),
                current_repair_account: `Reproduced the evidence finding and selected ${reach} reach.`,
              },
            },
            expect: { status: "completed" as const },
          },
        })),
      ),
      ...(["contained", "analysis", "source", "contract", "blocked"] as const).flatMap((reach) =>
        (["memory", "filesystem"] as const).map((storageMode) => ({
          scenario: {
            name: `coverage ${storageMode} result ${reach}`,
            mockInputs: {
              ...baseInputs(storageMode),
              [storageMode === "memory" ? "review-result-inline" : "review-result-file"]:
                storageMode === "memory"
                  ? nonzeroThenZero
                  : [{ issues_count: 1 }, { issues_count: 0 }],
              [storageMode === "memory" ? "repair-result-inline" : "repair-result-file"]:
                reach === "contract"
                  ? contractChange
                  : reach === "blocked"
                    ? {
                        research_repair_reach: "blocked",
                        current_repair_account:
                          "The reproduced result defect cannot be repaired with current authority or evidence.",
                      }
                    : changedResult(reach, storageMode),
            },
            expect: { status: "completed" as const },
          },
        })),
      ),
      {
        scenario: {
          name: "coverage final feedback repair",
          mockInputs: {
            ...baseInputs("memory", "interactive"),
            "approve-final": [
              { decision: "revise", feedback: "Correct the synthesis." },
              { decision: "accepted" },
            ],
            "revise-final-from-feedback": changedResult("contained"),
          },
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage final abort",
          mockInputs: {
            ...baseInputs("memory", "interactive"),
            "approve-final": { decision: "abort" },
          },
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage autonomous undecided",
          mockInputs: baseInputs("memory", "autonomous", "undecided"),
          expect: { status: "completed" },
        },
      },
      ...(["local", "publish", "publish_and_notify", "abort"] as const).map((decision) => ({
        scenario: {
          name: `coverage delivery choice ${decision}`,
          mockInputs: {
            ...baseInputs(
              decision === "local" ? "memory" : "filesystem",
              "interactive",
              "undecided",
            ),
            "choose-delivery": { decision },
          },
          expect: { status: "completed" as const },
        },
        ...(decision === "publish_and_notify" ? { telegram: "sent" as const } : {}),
      })),
      {
        scenario: {
          name: "coverage external storage unavailable",
          mockInputs: baseInputs("memory", "autonomous", "publish"),
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage publication not authorized",
          mockInputs: {
            ...baseInputs("filesystem", "autonomous", "publish"),
            "capture-context": capture("filesystem", "autonomous", "publish", {
              publication_authorized: false,
            }),
          },
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage publication failed",
          mockInputs: {
            ...baseInputs("filesystem", "autonomous", "publish"),
            "publish-result": {
              publication_status: "failed",
              failure_reason: "The authorized uploader rejected the artifact.",
            },
          },
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage published",
          mockInputs: baseInputs("filesystem", "autonomous", "publish"),
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage notification not authorized",
          mockInputs: {
            ...baseInputs("filesystem", "autonomous", "publish_and_notify"),
            "capture-context": capture("filesystem", "autonomous", "publish_and_notify", {
              notification_authorized: false,
            }),
          },
          expect: { status: "completed" },
        },
      },
      {
        scenario: {
          name: "coverage notified",
          mockInputs: baseInputs("filesystem", "autonomous", "publish_and_notify"),
          expect: { status: "completed" },
        },
        telegram: "sent",
      },
      {
        scenario: {
          name: "coverage notification unsent",
          mockInputs: baseInputs("filesystem", "autonomous", "publish_and_notify"),
          expect: { status: "completed" },
        },
        telegram: "unsent",
      },
      {
        scenario: {
          name: "coverage notification error",
          mockInputs: baseInputs("filesystem", "autonomous", "publish_and_notify"),
          expect: { status: "completed" },
        },
        telegram: "error",
      },
      {
        scenario: {
          name: "coverage teleport",
          mockInputs: {
            ...baseInputs(),
            "revise-analysis-process": ({ executionId }) => ({
              execution_id: executionId,
              resume_stage: "analysis",
              audience: "Maintainers and reviewers",
              output_language: "English",
              deliverables: "A reviewed report for the corrected audience.",
              current_repair_account: "Changed only presentation fields after readiness review.",
            }),
          },
          teleportAfter: { afterNode: "review-data-inline", teleportTo: "revise-analysis-process" },
          expect: { status: "completed" },
        },
      },
    ];
    const results: ScenarioResult[] = [];
    for (const current of cases)
      results.push(
        await run(
          current.scenario,
          current.materialize ?? "success",
          current.telegram ?? "default",
        ),
      );
    expect(
      results
        .filter((item) => !item.passed)
        .map((item) => ({
          scenario: item.scenario,
          status: item.status,
          error: item.error?.split("\n")[0],
        })),
    ).toEqual([]);
    const coverage = calculateCoverage(graph(), results, { includeGapAnalysis: true });
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
  });
});
