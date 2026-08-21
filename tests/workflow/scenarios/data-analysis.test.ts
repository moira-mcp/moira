/** Contract and behavioral scenarios for moira/data-analysis. */

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
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

type Delivery = "filesystem" | "inline";
type Mode = "autonomous" | "interactive";
type Outcome = "usable" | "unavailable" | "not_authorized" | "access_error";
type Source = {
  id: string;
  type: "inline" | "file" | "api";
  locator: string;
  authorization: "authorized" | "not_authorized";
  availability: "available" | "unavailable" | "unknown";
  data_classification: "public" | "internal" | "confidential" | "restricted";
  limitation: string;
};

const catalogEntry = findSystemCatalogEntry("data-analysis", "public")!;
const workspace = "./moira-ws/data-analysis-checkout_20260820";
const initialDecision = "Decide whether the checkout change is ready for a controlled launch";
const revisedDecision = "Decide whether the checkout change is ready for a full launch";

function loadWorkflow(): WorkflowGraph {
  return structuredClone(catalogEntry.graph) as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): any {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function source(
  authorization: Source["authorization"] = "authorized",
  availability: Source["availability"] = "available",
): Source {
  return {
    id: "checkout-events",
    type: "inline",
    locator: "supplied checkout event aggregate",
    authorization,
    availability,
    data_classification: "internal",
    limitation: "One release-candidate sample without production identifiers.",
  };
}

function evidence(outcome: Outcome = "usable") {
  return {
    id: "checkout-events",
    actual_availability:
      outcome === "usable" ? "available" : outcome === "unavailable" ? "unavailable" : "unknown",
    access_outcome: outcome,
    sanitized_provenance: "Aggregate supplied by the authorized release owner.",
    limitation:
      outcome === "usable" ? "One release-candidate sample." : `Source outcome: ${outcome}.`,
  };
}

function capture(
  delivery: Delivery = "inline",
  mode: Mode = "autonomous",
  contract = source(),
  decision = initialDecision,
) {
  return {
    operating_mode: mode,
    delivery_mode: delivery,
    ...(delivery === "filesystem" ? { workspace_path: workspace } : {}),
    question: "Which checkout regressions are supported by the supplied event evidence?",
    decision_context: decision,
    scope: "The supplied checkout aggregate; production mutation is excluded.",
    audience: "Release owner and checkout engineering team",
    constraints: "Use only supplied authorized evidence; do not inspect production systems.",
    success_criteria: "Every conclusion is traceable to a source outcome and limitation.",
    deliverables: "A reviewed report with limitations and a launch recommendation.",
    confidentiality_policy: "Keep internal aggregates local and omit raw identifiers.",
    source_contract: [contract],
  };
}

function contractRevision(decision = initialDecision, contract = source()) {
  const captured = capture("inline", "autonomous", contract, decision);
  const {
    question,
    decision_context,
    scope,
    audience,
    constraints,
    success_criteria,
    deliverables,
    confidentiality_policy,
    source_contract,
  } = captured;
  return {
    question,
    decision_context,
    scope,
    audience,
    constraints,
    success_criteria,
    deliverables,
    confidentiality_policy,
    source_contract,
  };
}

function useScenarioMaterializeGrant(engine: GraphExecutionEngine): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, MaterializeHandler> })
    .nodeHandlers;
  handlers.set(
    "materialize",
    new MaterializeHandler(
      { createMaterializeToken: () => "data-analysis-scenario-token" },
      () => "https://moira.example",
    ),
  );
}

function acquisition(outcome: Outcome = "usable") {
  return {
    source_evidence: [evidence(outcome)],
    usable_source_count: outcome === "usable" ? 1 : 0,
    acquisition_summary:
      "Each source has a sanitized provenance, actual access outcome, volume summary, quality observation, lawful-use boundary, and material limitation.",
  };
}

function projectedSource(contract = source(), outcome: Outcome = "usable") {
  const acquired = evidence(outcome);
  return {
    id: contract.id,
    type: contract.type,
    locator: contract.locator,
    authorization: contract.authorization,
    initial_availability: contract.availability,
    actual_availability: acquired.actual_availability,
    access_outcome: acquired.access_outcome,
    sanitized_provenance: acquired.sanitized_provenance,
    data_classification: contract.data_classification,
    limitation: acquired.limitation,
  };
}

function analysisResult(
  delivery: Delivery = "inline",
  status: "complete" | "limited" = "complete",
  contract = source(),
  outcome: Outcome = "usable",
  decision = initialDecision,
) {
  const common = {
    status,
    delivery_mode: delivery,
    decision_context: decision,
    sources: [projectedSource(contract, outcome)],
    executive_summary:
      status === "complete"
        ? "The supplied aggregate supports a bounded checkout readiness conclusion."
        : "No authorized usable evidence supports an analytical conclusion.",
    evidence_summary: "Evidence and uncertainty are traced to the typed source outcome.",
    limitations: ["The evidence covers one release candidate and cannot establish causality."],
    recommendations: ["Use this result only for the stated launch decision."],
    visualization_summary: "No visualization is needed for this bounded decision.",
    reproducibility: "Repeat with the same aggregate, contract, and documented method.",
  };
  return delivery === "filesystem"
    ? { ...common, report_path: `${workspace}/analysis-report.md`, artifact_paths: [] }
    : {
        ...common,
        inline_report:
          "# Checkout analysis\n\nThe supplied evidence was analyzed under the stated authority and confidentiality constraints. Findings, uncertainty, limitations, and recommendations remain bounded to the release-candidate aggregate.",
      };
}

function framing(label = "Current") {
  return {
    problem_summary: `${label} framing evaluates the supplied checkout aggregate for a launch decision, preserves source authority and confidentiality, and requires evidence-traceable findings, limitations, and recommendations before delivery.`,
  };
}

function readiness() {
  return {
    readiness_record:
      "The aggregate has documented provenance, preparation choices, missing-data handling, sampling limits, lawful-use constraints, and reproducible readiness evidence for the stated decision.",
  };
}

function cleanInputs(delivery: Delivery = "inline", mode: Mode = "autonomous") {
  return {
    "capture-context": capture(delivery, mode),
    "frame-problem": framing(),
    ...(mode === "interactive"
      ? { "approve-problem": { decision: "accepted" }, "approve-final": { decision: "accepted" } }
      : {}),
    "acquire-sources": acquisition(),
    "prepare-data": readiness(),
    ...(delivery === "filesystem"
      ? { "review-data-file": { issues_count: 0 } }
      : { "review-data-inline": { issues_count: 0 } }),
    "analyze-and-synthesize": { analysis_result: analysisResult(delivery) },
    ...(delivery === "filesystem"
      ? { "review-result-file": { issues_count: 0 } }
      : { "review-result-inline": { issues_count: 0 } }),
  };
}

function compactRoute(result: ScenarioResult): string[] {
  return result.visitedNodes.filter((id, index, all) => id !== all[index - 1]);
}

describe("data-analysis", () => {
  let workflow: WorkflowGraph;
  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("preserves public identity and implements the accepted graph", async () => {
    expect(catalogEntry).toMatchObject({
      owner: "system-moira",
      slug: "data-analysis",
      visibility: "public",
    });
    expect(workflow.id).toBe("5dd9c5c3-1176-4967-9d6c-798134b769df");
    expect(workflow.metadata.version).toBe("2.0.0");
    expect(workflow.nodes).toHaveLength(40);
    expect(node(workflow, "end").finalOutput).toEqual(["analysis_result"]);
    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  test("publishes a decision-useful description and neighboring-flow boundaries", () => {
    for (const claim of [
      "one or more",
      "inline, file, or API",
      "decision context",
      "confidentiality policy",
      "Independent readiness and final-result reviews",
      "limited result",
      "never broadens access",
      "Verified Research",
      "Iterative Research",
    ])
      expect(workflow.metadata.description).toContain(claim);
  });

  test("separates authority, acquisition evidence, and owner-specific repair reach", () => {
    const registry = workflow.variableRegistry!;
    expect(Object.keys(registry).sort()).toEqual([
      "analysis_result",
      "audience",
      "confidentiality_policy",
      "constraints",
      "decision_context",
      "deliverables",
      "delivery_mode",
      "operating_mode",
      "question",
      "readiness_repair_reach",
      "result_repair_reach",
      "resume_stage",
      "scope",
      "source_contract",
      "source_evidence",
      "success_criteria",
      "usable_source_count",
      "workspace_path",
    ]);
    expect(node(workflow, "acquire-sources").inputSchema.globalInputs).toEqual([
      "source_evidence",
      "usable_source_count",
    ]);
    expect(registry.readiness_repair_reach.enum).toEqual(["contained", "source", "limited"]);
    expect(registry.result_repair_reach.enum).toEqual(["contained", "data", "source", "contract"]);
  });

  test("keeps unique source IDs and one-to-one projection as semantic invariants", () => {
    for (const id of ["capture-context", "revise-problem", "revise-analysis-process"])
      expect(node(workflow, id).directive).toMatch(/pairwise.unique/i);
    for (const id of [
      "acquire-sources",
      "review-data-inline",
      "analyze-and-synthesize",
      "review-result-inline",
    ])
      expect(node(workflow, id).directive).toMatch(/one-to-one|one matching unique/i);
  });

  test("types truthful source outcomes in the terminal projection", () => {
    const evidenceItem = workflow.variableRegistry!.source_evidence.items;
    expect(evidenceItem.properties.actual_availability.enum).toEqual([
      "available",
      "unavailable",
      "unknown",
    ]);
    const resultItem = workflow.variableRegistry!.analysis_result.properties.sources.items;
    expect(resultItem.required).toEqual(
      expect.arrayContaining([
        "initial_availability",
        "actual_availability",
        "access_outcome",
        "sanitized_provenance",
      ]),
    );
    expect(resultItem.properties).not.toHaveProperty("availability");
  });

  test("rejects invented availability for a not-authorized source", async () => {
    const invalid = acquisition("not_authorized");
    invalid.source_evidence[0].actual_availability = "available";
    const result = await runScenario(workflow, {
      name: "invented availability",
      mockInputs: {
        "capture-context": capture("inline", "autonomous", source("not_authorized", "unknown")),
        "frame-problem": framing(),
        "acquire-sources": invalid,
      },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'acquire-sources'");
  });

  test("rejects an incomplete typed source projection before final review", async () => {
    const malformed = analysisResult() as any;
    delete malformed.sources[0].access_outcome;
    const result = await runScenario(workflow, {
      name: "missing outcome",
      mockInputs: { ...cleanInputs(), "analyze-and-synthesize": { analysis_result: malformed } },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'analyze-and-synthesize'");
  });

  test("rejects hidden canonical mutation on non-contract repair", async () => {
    const result = await runScenario(workflow, {
      name: "contained mutation",
      mockInputs: {
        ...cleanInputs(),
        "review-result-inline": { issues_count: 1, findings: "Correct presentation." },
        "repair-result-inline": {
          result_repair_reach: "contained",
          repair_summary: "Corrected the presentation in the inline result.",
          analysis_result: analysisResult(),
          question: "A hidden replacement question that strict schema must reject",
        },
      },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'repair-result-inline'");
  });

  test("autonomous inline delivery retains every substantive gate", async () => {
    const result = await runScenario(workflow, {
      name: "inline clean",
      mockInputs: cleanInputs(),
      expect: {
        status: "completed",
        avoids: ["approve-problem", "approve-final", "materialize-workspace"],
      },
    });
    expect(result.passed).toBe(true);
    expect(compactRoute(result)).toEqual([
      "start",
      "capture-context",
      "delivery-mode-file",
      "frame-problem",
      "problem-approval-mode",
      "resume-stage-gate",
      "acquire-sources",
      "usable-sources-gate",
      "prepare-data",
      "readiness-review-mode",
      "review-data-inline",
      "review-data-inline-gate",
      "analyze-and-synthesize",
      "final-review-mode",
      "review-result-inline",
      "review-result-inline-gate",
      "final-approval-mode",
      "end",
    ]);
  });

  test("filesystem delivery materializes and reviews the current workspace", async () => {
    const result = await runScenario(
      workflow,
      {
        name: "filesystem clean",
        mockInputs: cleanInputs("filesystem"),
        expect: {
          status: "completed",
          reaches: ["materialize-workspace", "review-data-file", "review-result-file"],
        },
      },
      { engineSetup: useScenarioMaterializeGrant },
    );
    expect(result.passed).toBe(true);
    expect(result.finalContext.analysis_result).toMatchObject({
      delivery_mode: "filesystem",
      report_path: `${workspace}/analysis-report.md`,
    });
  });

  test("zero usable sources produce a reviewed limited result", async () => {
    const contract = source("not_authorized", "unknown");
    const result = await runScenario(workflow, {
      name: "limited result",
      mockInputs: {
        "capture-context": capture("inline", "autonomous", contract),
        "frame-problem": framing(),
        "acquire-sources": acquisition("not_authorized"),
        "produce-limited-result": {
          analysis_result: analysisResult("inline", "limited", contract, "not_authorized"),
        },
        "review-result-inline": { issues_count: 0 },
      },
      expect: { status: "completed", avoids: ["prepare-data", "analyze-and-synthesize"] },
    });
    expect(result.passed).toBe(true);
    expect(result.finalContext.analysis_result).toMatchObject({ status: "limited" });
  });

  test("readiness findings route to contained repair, reacquisition, or limited delivery", async () => {
    const contained = await runScenario(workflow, {
      name: "contained readiness",
      mockInputs: {
        ...cleanInputs(),
        "review-data-inline": [
          { issues_count: 1, findings: "Add sampling limit." },
          { issues_count: 0 },
        ],
        "repair-data-inline": {
          readiness_repair_reach: "contained",
          readiness_record: readiness().readiness_record + " Sampling limit added.",
          repair_summary: "Added the reproduced sampling limitation.",
        },
      },
      expect: { status: "completed" },
    });
    const reacquired = await runScenario(workflow, {
      name: "source readiness",
      mockInputs: {
        ...cleanInputs(),
        "acquire-sources": [acquisition(), acquisition()],
        "prepare-data": [readiness(), readiness()],
        "review-data-inline": [
          { issues_count: 1, findings: "Reacquire provenance." },
          { issues_count: 0 },
        ],
        "repair-data-inline": {
          readiness_repair_reach: "source",
          readiness_record: readiness().readiness_record + " Reacquisition required.",
          repair_summary: "Reproduced the provenance defect and selected reacquisition.",
        },
      },
      expect: { status: "completed" },
    });
    const limited = await runScenario(workflow, {
      name: "limited readiness",
      mockInputs: {
        ...cleanInputs(),
        "review-data-inline": { issues_count: 1, findings: "Evidence is insufficient." },
        "repair-data-inline": {
          readiness_repair_reach: "limited",
          readiness_record: readiness().readiness_record + " Evidence remains insufficient.",
          repair_summary: "Confirmed that full analysis is unsupported.",
        },
        "produce-limited-result": { analysis_result: analysisResult("inline", "limited") },
      },
      expect: { status: "completed" },
    });
    expect([contained, reacquired, limited].filter((item) => !item.passed)).toEqual([]);
    expect(reacquired.inputSubmissionCounts["acquire-sources"]).toBe(2);
  });

  test("independent contract finding changes canonical context before reanalysis", async () => {
    const result = await runScenario(workflow, {
      name: "contract repair",
      mockInputs: {
        ...cleanInputs(),
        "frame-problem": [framing("Initial"), framing("Reframed")],
        "acquire-sources": [acquisition(), acquisition()],
        "prepare-data": [readiness(), readiness()],
        "review-data-inline": [{ issues_count: 0 }, { issues_count: 0 }],
        "analyze-and-synthesize": [
          { analysis_result: analysisResult() },
          {
            analysis_result: analysisResult(
              "inline",
              "complete",
              source(),
              "usable",
              revisedDecision,
            ),
          },
        ],
        "review-result-inline": [
          { issues_count: 1, findings: "The canonical decision context is stale." },
          { issues_count: 0 },
        ],
        "repair-result-inline": {
          result_repair_reach: "contract",
          repair_summary: "Changed the reproduced stale decision context.",
          ...contractRevision(revisedDecision),
          resume_stage: "acquisition",
        },
      },
      expect: { status: "completed", reaches: ["route-result-repair-contract"] },
    });
    expect(result.passed).toBe(true);
    expect(result.finalContext.decision_context).toBe(revisedDecision);
    expect(result.inputSubmissionCounts["acquire-sources"]).toBe(2);
  });

  test("interactive problem and final rejection consume feedback", async () => {
    const result = await runScenario(workflow, {
      name: "interactive feedback",
      mockInputs: {
        "capture-context": capture("inline", "interactive"),
        "frame-problem": [framing("Initial"), framing("Problem revised"), framing("Final revised")],
        "approve-problem": [
          { decision: "revise", feedback: "Clarify the launch boundary." },
          { decision: "accepted" },
          { decision: "accepted" },
        ],
        "revise-problem": {
          revision_summary: "Clarified the launch boundary in the canonical contract.",
          ...contractRevision(),
          resume_stage: "acquisition",
        },
        "acquire-sources": [acquisition(), acquisition()],
        "prepare-data": [readiness(), readiness()],
        "review-data-inline": [{ issues_count: 0 }, { issues_count: 0 }],
        "analyze-and-synthesize": [
          { analysis_result: analysisResult() },
          {
            analysis_result: analysisResult(
              "inline",
              "complete",
              source(),
              "usable",
              revisedDecision,
            ),
          },
        ],
        "review-result-inline": [{ issues_count: 0 }, { issues_count: 0 }],
        "approve-final": [
          { decision: "revise", feedback: "Use the full-launch decision context." },
          { decision: "accepted" },
        ],
        "revise-final-from-feedback": {
          result_repair_reach: "contract",
          repair_summary: "Applied the explicit full-launch context correction.",
          ...contractRevision(revisedDecision),
          resume_stage: "acquisition",
        },
      },
      expect: { status: "completed", reaches: ["revise-problem", "revise-final-from-feedback"] },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts["approve-problem"]).toBe(3);
    expect(result.inputSubmissionCounts["approve-final"]).toBe(2);
  });

  test("guarded process revision can resume at analysis after readiness", async () => {
    const result = await runScenario(workflow, {
      name: "teleport presentation revision",
      mockInputs: {
        ...cleanInputs(),
        "revise-analysis-process": {
          revision_summary: "Changed only audience presentation after readiness review.",
          ...contractRevision(),
          audience: "Release owner, engineering team, and support lead",
          resume_stage: "analysis",
        },
      },
      teleportAfter: {
        afterNode: "review-data-inline",
        visitNumber: 1,
        teleportTo: "revise-analysis-process",
      },
      expect: { status: "completed", reaches: ["revise-analysis-process"] },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts["acquire-sources"]).toBe(1);
  });

  test("combined scenarios cover every ordinary node and branch", async () => {
    const fileRepair: TestScenario = {
      name: "file final source repair",
      mockInputs: {
        ...cleanInputs("filesystem"),
        "acquire-sources": [acquisition(), acquisition()],
        "prepare-data": [readiness(), readiness()],
        "review-data-file": [{ issues_count: 0 }, { issues_count: 0 }],
        "analyze-and-synthesize": [
          { analysis_result: analysisResult("filesystem") },
          { analysis_result: analysisResult("filesystem") },
        ],
        "review-result-file": [{ issues_count: 1 }, { issues_count: 0 }],
        "repair-result-file": {
          result_repair_reach: "source",
          repair_summary: "Changed the reproduced provenance defect.",
          analysis_result: analysisResult("filesystem"),
        },
      },
      expect: { status: "completed" },
    };
    const dataRepair: TestScenario = {
      name: "inline final data repair",
      mockInputs: {
        ...cleanInputs(),
        "prepare-data": [readiness(), readiness()],
        "review-data-inline": [{ issues_count: 0 }, { issues_count: 0 }],
        "analyze-and-synthesize": [
          { analysis_result: analysisResult() },
          { analysis_result: analysisResult() },
        ],
        "review-result-inline": [
          { issues_count: 1, findings: "Preparation evidence is stale." },
          { issues_count: 0 },
        ],
        "repair-result-inline": {
          result_repair_reach: "data",
          repair_summary: "Changed the reproduced stale preparation evidence.",
          analysis_result: analysisResult(),
        },
      },
      expect: { status: "completed" },
    };
    const results = await Promise.all([
      runScenario(workflow, {
        name: "coverage inline",
        mockInputs: cleanInputs(),
        expect: { status: "completed" },
      }),
      runScenario(workflow, fileRepair, { engineSetup: useScenarioMaterializeGrant }),
      runScenario(workflow, dataRepair),
      runScenario(workflow, {
        name: "coverage limited",
        mockInputs: {
          ...cleanInputs(),
          "review-data-inline": { issues_count: 1, findings: "Evidence is insufficient." },
          "repair-data-inline": {
            readiness_repair_reach: "limited",
            readiness_record: readiness().readiness_record + " Evidence remains insufficient.",
            repair_summary: "Confirmed a limited result is required.",
          },
          "produce-limited-result": { analysis_result: analysisResult("inline", "limited") },
        },
        expect: { status: "completed" },
      }),
      runScenario(workflow, {
        name: "coverage interactive revision",
        mockInputs: {
          ...cleanInputs("inline", "interactive"),
          "frame-problem": [framing(), framing("Revised")],
          "approve-problem": [
            { decision: "revise", feedback: "Clarify scope." },
            { decision: "accepted" },
          ],
          "revise-problem": {
            revision_summary: "Clarified scope in the canonical contract.",
            ...contractRevision(),
            resume_stage: "acquisition",
          },
          "approve-final": { decision: "accepted" },
        },
        expect: { status: "completed" },
      }),
      runScenario(
        workflow,
        {
          name: "coverage file readiness repair",
          mockInputs: {
            ...cleanInputs("filesystem"),
            "review-data-file": [{ issues_count: 1 }, { issues_count: 0 }],
            "repair-data-file": {
              readiness_repair_reach: "contained",
              repair_summary: "Corrected the reproduced file-readiness finding.",
            },
          },
          expect: { status: "completed" },
        },
        { engineSetup: useScenarioMaterializeGrant },
      ),
      runScenario(workflow, {
        name: "coverage final feedback revision",
        mockInputs: {
          ...cleanInputs("inline", "interactive"),
          "frame-problem": [framing(), framing("Final feedback")],
          "approve-problem": [{ decision: "accepted" }, { decision: "accepted" }],
          "acquire-sources": [acquisition(), acquisition()],
          "prepare-data": [readiness(), readiness()],
          "review-data-inline": [{ issues_count: 0 }, { issues_count: 0 }],
          "analyze-and-synthesize": [
            { analysis_result: analysisResult() },
            {
              analysis_result: analysisResult(
                "inline",
                "complete",
                source(),
                "usable",
                revisedDecision,
              ),
            },
          ],
          "review-result-inline": [{ issues_count: 0 }, { issues_count: 0 }],
          "approve-final": [
            { decision: "revise", feedback: "Use the full-launch decision context." },
            { decision: "accepted" },
          ],
          "revise-final-from-feedback": {
            result_repair_reach: "contract",
            repair_summary: "Applied the explicit full-launch context correction.",
            ...contractRevision(revisedDecision),
            resume_stage: "acquisition",
          },
        },
        expect: { status: "completed" },
      }),
      runScenario(workflow, {
        name: "coverage guarded process revision",
        mockInputs: {
          ...cleanInputs(),
          "revise-analysis-process": {
            revision_summary: "Changed only audience presentation after readiness review.",
            ...contractRevision(),
            audience: "Release owner, engineering team, and support lead",
            resume_stage: "analysis",
          },
        },
        teleportAfter: {
          afterNode: "review-data-inline",
          visitNumber: 1,
          teleportTo: "revise-analysis-process",
        },
        expect: { status: "completed" },
      }),
      runScenario(workflow, {
        name: "coverage zero usable sources",
        mockInputs: {
          "capture-context": capture("inline", "autonomous", source("not_authorized", "unknown")),
          "frame-problem": framing(),
          "acquire-sources": acquisition("not_authorized"),
          "produce-limited-result": {
            analysis_result: analysisResult(
              "inline",
              "limited",
              source("not_authorized", "unknown"),
              "not_authorized",
            ),
          },
          "review-result-inline": { issues_count: 0 },
        },
        expect: { status: "completed" },
      }),
      runScenario(workflow, {
        name: "coverage readiness source repair",
        mockInputs: {
          ...cleanInputs(),
          "acquire-sources": [acquisition(), acquisition()],
          "prepare-data": [readiness(), readiness()],
          "review-data-inline": [
            { issues_count: 1, findings: "Reacquire provenance." },
            { issues_count: 0 },
          ],
          "repair-data-inline": {
            readiness_repair_reach: "source",
            readiness_record: readiness().readiness_record + " Reacquisition required.",
            repair_summary: "Reproduced the provenance defect and selected reacquisition.",
          },
        },
        expect: { status: "completed" },
      }),
      runScenario(workflow, {
        name: "coverage contained result repair",
        mockInputs: {
          ...cleanInputs(),
          "analyze-and-synthesize": [
            { analysis_result: analysisResult() },
            { analysis_result: analysisResult() },
          ],
          "review-result-inline": [
            { issues_count: 1, findings: "Correct presentation." },
            { issues_count: 0 },
          ],
          "repair-result-inline": {
            result_repair_reach: "contained",
            repair_summary: "Corrected the reproduced presentation defect.",
            analysis_result: analysisResult(),
          },
        },
        expect: { status: "completed" },
      }),
    ]);
    expect(results.filter((result) => !result.passed)).toEqual([]);
    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
  });
});
