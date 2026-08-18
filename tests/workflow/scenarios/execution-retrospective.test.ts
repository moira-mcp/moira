import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";
import { extract } from "tar-stream";
import {
  AgentMessageQueue,
  createMaterializeTar,
  GraphExecutionEngine,
  GraphValidator,
  MaterializeHandler,
  renderMaterializeFiles,
  type ExecutionContext,
  type MaterializeNode,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import { runScenario, type MockInput, type TestScenario } from "../../helpers/scenario-runner.js";

const catalogEntry = findSystemCatalogEntry("execution-retrospective", "public")!;
const workflow = structuredClone(catalogEntry.graph) as WorkflowGraph;
const reference = String(workflow.variableRegistry?.retrospective_reference?.default);
const referenceSha256 = "d144c2f9de5c80df85705bd4f411c77c09eb3c1310f3334674d357337e3a99f1";

type Candidate = {
  candidate_id: string;
  target:
    | "result"
    | "workflow"
    | "system_prompt"
    | "evaluator"
    | "tool_interface"
    | "observability"
    | "memory";
  claim: string;
  evidence_refs: string[];
  scope_and_exclusions: string;
  support_and_counterexamples: { support: string[]; counterexamples: string[] };
  attribution: "causal" | "contributory" | "correlated" | "unknown";
  confidence: "low" | "medium" | "high";
  proposed_delta: string;
  predicted_benefit: string;
  cost_latency_privacy_safety_tradeoffs: {
    cost: string;
    latency: string;
    privacy: string;
    safety: string;
  };
  validation: {
    unchanged_baseline: string;
    target_case: string;
    held_out_cases: string[];
    unrelated_regressions: string[];
    guardrails: string[];
    repeated_trials: string;
  };
  approval_owner: string;
  rollback_or_rejection_condition: string;
  expiry_or_recheck_trigger: string;
  disposition: "observe" | "eval" | "pilot" | "propose-change" | "no-change";
};

type BehavioralFixture = {
  name: string;
  evidenceState: "sufficient" | "partial" | "unavailable";
  sourceManifest: Record<string, unknown>;
  evidence: Record<string, unknown>;
  analysis?: Record<string, unknown>;
  retrospective: Record<string, unknown>;
};

const boundedCandidate: Candidate = {
  candidate_id: "candidate-objective-failure-1",
  target: "result",
  claim:
    "The delivered result violates objective-check-1 and needs root-cause isolation before correction.",
  evidence_refs: ["evidence.md#objective-check-1", "analysis.md#finding-1"],
  scope_and_exclusions:
    "Only the observed expected-2/got-3 result; no workflow or prompt cause is claimed.",
  support_and_counterexamples: {
    support: ["objective-check-1 records expected 2 and observed 3"],
    counterexamples: ["No isolated intervention identifies which mechanism produced 3"],
  },
  attribution: "unknown",
  confidence: "medium",
  proposed_delta:
    "Run a bounded root-cause eval, then correct only the isolated result-producing mechanism.",
  predicted_benefit:
    "Restores the failing objective check without prematurely changing the workflow.",
  cost_latency_privacy_safety_tradeoffs: {
    cost: "one bounded diagnostic and regression case",
    latency: "one additional evaluation cycle",
    privacy: "retain only the check ID and minimized observed values",
    safety: "proposal only; reject any change without isolated evidence",
  },
  validation: {
    unchanged_baseline: "Current workflow on the same fixture corpus",
    target_case: "objective-failure fixture",
    held_out_cases: ["clean-success", "retry-replan-success", "user-correction"],
    unrelated_regressions: ["no-data remains successful", "partial remains qualified"],
    guardrails: ["no hidden reasoning", "no automatic mutation"],
    repeated_trials: "Run 5 times if the evaluator is stochastic",
  },
  approval_owner: "workflow maintainer and user",
  rollback_or_rejection_condition:
    "Reject if no mechanism is isolated or a held-out case regresses",
  expiry_or_recheck_trigger: "Recheck when comparative intervention evidence is available",
  disposition: "eval",
};

const behavioralFixtures: BehavioralFixture[] = [
  {
    name: "clean-success",
    evidenceState: "sufficient",
    sourceManifest: { sources: ["execution_context", "session", "workspace"], missing: [] },
    evidence: {
      objective_checks: [{ id: "check-1", result: "passed" }],
      process_events: [{ event: "completed_without_rework" }],
      gaps: [],
    },
    analysis: {
      outcome: "passed",
      process: "passed",
      preserved_strengths: ["Objective check and delivered artifact agree"],
      findings: [],
    },
    retrospective: {
      outcome_verdict: "passed",
      process_verdict: "passed",
      preserved_strengths: ["Objective check and delivered artifact agree"],
      candidates: [],
      disposition: "no-change",
      automatic_mutations: [],
    },
  },
  {
    name: "objective-failure",
    evidenceState: "sufficient",
    sourceManifest: { sources: ["execution_context", "workspace", "objective_check"], missing: [] },
    evidence: {
      objective_checks: [
        { id: "objective-check-1", result: "failed", observed: "expected 2, got 3" },
      ],
      process_events: [],
      gaps: [],
    },
    analysis: {
      outcome: "failed",
      process: "passed",
      findings: [
        {
          claim: "The result violates objective-check-1; the producing mechanism is not isolated.",
          factor: "unknown result-producing mechanism",
          evidence: "objective-check-1",
          counterevidence: "No comparative intervention identifies the mechanism.",
          scope: "This execution and this objective check only",
          attribution: "unknown",
          confidence: "medium",
        },
      ],
    },
    retrospective: {
      outcome_verdict: "failed: objective-check-1",
      process_verdict: "passed",
      candidates: [boundedCandidate],
      automatic_mutations: [],
    },
  },
  {
    name: "retry-replan-success",
    evidenceState: "sufficient",
    sourceManifest: { sources: ["execution_context", "session", "objective_check"], missing: [] },
    evidence: {
      objective_checks: [
        { id: "check-before-replan", result: "failed" },
        { id: "check-after-replan", result: "passed" },
      ],
      process_events: [{ event: "replan" }, { event: "retry" }, { event: "completed" }],
      isolation: "not isolated",
      gaps: [],
    },
    analysis: {
      outcome: "passed",
      process: "required rework",
      findings: [
        {
          evidence: ["check-before-replan", "check-after-replan"],
          attribution: "contributory",
          confidence: "medium",
          limitation: "The successful adaptation was not isolated from other changes",
        },
      ],
    },
    retrospective: {
      outcome_verdict: "passed after retry/replan",
      process_verdict: "required rework",
      candidates: [],
      disposition: "observe",
      automatic_mutations: [],
    },
  },
  {
    name: "user-correction",
    evidenceState: "sufficient",
    sourceManifest: {
      sources: ["execution_context", "session", "user_interventions"],
      missing: [],
    },
    evidence: {
      corrections: [
        { text: "Fix the broken output", classification: "defect" },
        { text: "Prefer a shorter title", classification: "preference" },
        { text: "Now include the appendix", classification: "requirement-change" },
        { text: "I edited the published copy", classification: "downstream-edit" },
      ],
      gaps: [],
    },
    analysis: {
      outcome: "mixed",
      process: "corrected",
      findings: [
        {
          evidence: "defect correction only",
          attribution: "contributory",
          confidence: "medium",
          scope: "this execution; preferences and changed requirements are excluded",
        },
      ],
    },
    retrospective: {
      outcome_verdict: "mixed: one defect corrected; other interventions are not defects",
      process_verdict: "corrected with intervention classification preserved",
      correction_classifications: ["defect", "preference", "requirement-change", "downstream-edit"],
      candidates: [],
      disposition: "observe",
      automatic_mutations: [],
    },
  },
  {
    name: "data-poor-partial",
    evidenceState: "partial",
    sourceManifest: {
      sources: ["execution_context", "workspace"],
      missing: ["immutable workflow snapshot", "complete event stream"],
    },
    evidence: {
      objective_checks: [{ id: "final-check", result: "passed" }],
      gaps: ["retry ordering unavailable", "prompt version unavailable"],
    },
    analysis: {
      outcome: "passed within available checks",
      process: "unknown beyond final state",
      findings: [
        {
          claim: "No process defect can be localized",
          attribution: "unknown",
          confidence: "low",
          limitations: ["retry ordering unavailable", "prompt version unavailable"],
        },
      ],
    },
    retrospective: {
      outcome_verdict: "passed within available checks, bounded by missing evidence",
      process_verdict: "unknown",
      limitations: ["retry ordering unavailable", "prompt version unavailable"],
      candidates: [],
      disposition: "observe",
      automatic_mutations: [],
    },
  },
  {
    name: "data-poor-unavailable",
    evidenceState: "unavailable",
    sourceManifest: {
      sources: [],
      missing: ["execution_context", "session", "workspace", "objective checks"],
    },
    evidence: { observable_events: [], gaps: ["all outcome and process evidence unavailable"] },
    retrospective: {
      report_type: "no-data",
      outcome_verdict: "cannot be answered",
      process_verdict: "cannot be answered",
      diagnosis: null,
      candidates: [],
      observability_improvements: ["retain an immutable execution-bound workflow snapshot"],
      automatic_mutations: [],
    },
  },
];

const canonicalCandidateKeys = [
  "candidate_id",
  "target",
  "claim",
  "evidence_refs",
  "scope_and_exclusions",
  "support_and_counterexamples",
  "attribution",
  "confidence",
  "proposed_delta",
  "predicted_benefit",
  "cost_latency_privacy_safety_tradeoffs",
  "validation",
  "approval_owner",
  "rollback_or_rejection_condition",
  "expiry_or_recheck_trigger",
  "disposition",
] as const;

function writeJsonArtifact(directory: string, name: string, value: unknown): void {
  writeFileSync(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function writeReview(directory: string, tier: string, findings: string[]): void {
  const body =
    findings.length === 0
      ? `# Independent ${tier} review\n\nBlocking findings: 0\n`
      : `# Independent ${tier} review\n\n${findings
          .map((finding, index) => `## Finding ${index + 1}\n\n${finding}`)
          .join("\n\n")}\n\nBlocking findings: ${findings.length}\n`;
  writeFileSync(resolve(directory, "review.md"), body);
}

function buildSourceManifest(
  fixture: BehavioralFixture,
  subjectExecutionId: string,
): Record<string, unknown> {
  const availableSources = (fixture.sourceManifest.sources as string[] | undefined) ?? [];
  const missingSources = (fixture.sourceManifest.missing as string[] | undefined) ?? [];
  const relevantTimestamps = ["2026-08-18T20:39:00.000Z"];
  return {
    subject_execution_id: subjectExecutionId,
    workflow_id: "execution-retrospective",
    evidence_state: fixture.evidenceState,
    sources: availableSources,
    missing: missingSources,
    source_records: [
      ...availableSources.map((sourceIdentity) => ({
        source_identity: sourceIdentity,
        access_result: "available",
        provenance: `${sourceIdentity}:${subjectExecutionId}`,
        relevant_timestamps: relevantTimestamps,
      })),
      ...missingSources.map((sourceIdentity) => ({
        source_identity: sourceIdentity,
        access_result: "unavailable",
        provenance: `${sourceIdentity}:${subjectExecutionId}`,
        relevant_timestamps: relevantTimestamps,
      })),
    ],
    redaction_decisions: [
      {
        category: "secrets-and-credentials",
        decision: "excluded",
        reason: "Not required to evaluate the subject execution",
      },
      {
        category: "hidden-reasoning",
        decision: "excluded",
        reason: "Only observable actions and retained artifacts are admissible evidence",
      },
      {
        category: "unrelated-personal-data",
        decision: "excluded",
        reason: "Outside the declared subject and minimization boundary",
      },
    ],
  };
}

function buildCompleteAnalysis(fixture: BehavioralFixture): Record<string, unknown> {
  if (!fixture.analysis) throw new Error("Diagnosis fixture is missing analysis output");
  const evidenceGaps = (fixture.evidence.gaps as string[] | undefined) ?? [];
  const rawFindings =
    (fixture.analysis.findings as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    ...fixture.analysis,
    findings: rawFindings.map((finding, index) => ({
      claim: finding.claim ?? `Material finding ${index + 1} for ${fixture.name}`,
      factor: finding.factor ?? "observed but not isolated execution factor",
      evidence_refs: Array.isArray(finding.evidence)
        ? finding.evidence
        : [finding.evidence ?? `evidence.md#${fixture.name}`],
      counterevidence_refs: [
        finding.counterevidence ?? "No isolated intervention establishes a stronger attribution",
      ],
      scope: finding.scope ?? "This subject execution only",
      alternatives: [
        "task contract",
        "model/action",
        "prompt/context",
        "workflow",
        "tools",
        "environment/data",
        "evaluator",
        "human interaction",
      ],
      attribution: finding.attribution ?? "unknown",
      confidence: finding.confidence ?? "low",
      limitations: Array.isArray(finding.limitations)
        ? finding.limitations
        : finding.limitation
          ? [finding.limitation]
          : evidenceGaps,
    })),
  };
}

function buildCompleteRetrospective(
  fixture: BehavioralFixture,
  subjectExecutionId: string,
): Record<string, unknown> {
  const sourceManifest = buildSourceManifest(fixture, subjectExecutionId);
  const missing = (fixture.sourceManifest.missing as string[] | undefined) ?? [];
  const evidenceGaps = (fixture.evidence.gaps as string[] | undefined) ?? [];
  const failedChecks =
    (
      fixture.evidence.objective_checks as Array<{ id: string; result: string }> | undefined
    )?.filter((check) => check.result === "failed") ?? [];
  const processEvents =
    (fixture.evidence.process_events as Array<{ event: string }> | undefined)?.map(
      (event) => event.event,
    ) ?? [];
  const corrections =
    (fixture.evidence.corrections as Array<{ text: string; classification: string }> | undefined) ??
    [];
  return {
    subject_identity: {
      execution_id: subjectExecutionId,
      workflow_id: "execution-retrospective",
    },
    evidence_coverage: {
      state: fixture.evidenceState,
      provenance: sourceManifest.source_records,
      redactions: sourceManifest.redaction_decisions,
      limitations: [...missing, ...evidenceGaps],
    },
    outcome_verdict: "unknown",
    process_verdict: "unknown",
    preserved_strengths: [],
    failures: failedChecks.map((check) => check.id),
    rework: processEvents.filter((event) => event === "retry" || event === "replan"),
    user_corrections: corrections,
    constraints: [...missing, ...evidenceGaps],
    supported_patterns: [],
    unresolved_competing_hypotheses: [
      "Task, model/action, prompt/context, workflow, tool, environment, evaluator, and human factors remain alternatives unless isolated",
    ],
    candidates: [],
    prioritized_experiments: [],
    human_discussion_questions: ["Which proposal, if any, should receive a separate evaluation?"],
    automatic_mutations: [],
    ...fixture.retrospective,
  };
}

function independentlyReviewAnalysis(directory: string): string[] {
  const findings: string[] = [];
  const manifest = JSON.parse(readFileSync(resolve(directory, "source-manifest.md"), "utf8"));
  const evidence = JSON.parse(readFileSync(resolve(directory, "evidence.md"), "utf8"));
  const analysis = JSON.parse(readFileSync(resolve(directory, "analysis.md"), "utf8"));
  if (!Array.isArray(manifest.missing) || !Array.isArray(evidence.gaps)) {
    findings.push("Source provenance or evidence gaps are not explicit arrays.");
  }
  if (!("outcome" in analysis) || !("process" in analysis)) {
    findings.push("Outcome and process verdicts are not separated.");
  }
  expect(reference).toContain("For each material finding include exact");
  for (const finding of analysis.findings ?? []) {
    for (const field of [
      "claim",
      "factor",
      "evidence_refs",
      "counterevidence_refs",
      "scope",
      "alternatives",
      "attribution",
      "confidence",
      "limitations",
    ]) {
      if (!(field in finding)) findings.push(`A material finding is missing ${field}.`);
    }
    if (!Array.isArray(finding.evidence_refs) || finding.evidence_refs.length === 0) {
      findings.push("A material finding has no evidence reference.");
    }
    if (!Array.isArray(finding.counterevidence_refs) || finding.counterevidence_refs.length === 0) {
      findings.push("A material finding has no counterevidence reference.");
    }
    if (!Array.isArray(finding.alternatives) || finding.alternatives.length < 2) {
      findings.push("A material finding does not compare plausible alternatives.");
    }
    if (
      !(["causal", "contributory", "correlated", "unknown"] as unknown[]).includes(
        finding.attribution,
      )
    ) {
      findings.push("A material finding has no bounded attribution label.");
    }
    if (finding.attribution === "causal" && !Array.isArray(finding.intervention_evidence)) {
      findings.push("A causal finding has no comparative intervention evidence.");
    }
    if (evidence.gaps.length > 0 && !Array.isArray(finding.limitations)) {
      findings.push("A partial-evidence finding lost its explicit limitations.");
    }
  }
  writeReview(directory, "analysis", findings);
  return findings;
}

function independentlyReviewFinal(directory: string): string[] {
  const findings: string[] = [];
  const stableReference = readFileSync(resolve(directory, "retrospective-reference.md"), "utf8");
  const manifest = JSON.parse(readFileSync(resolve(directory, "source-manifest.md"), "utf8"));
  const evidence = JSON.parse(readFileSync(resolve(directory, "evidence.md"), "utf8"));
  const analysisPath = resolve(directory, "analysis.md");
  const analysis = existsSync(analysisPath)
    ? JSON.parse(readFileSync(analysisPath, "utf8"))
    : undefined;
  const retrospective = JSON.parse(readFileSync(resolve(directory, "retrospective.md"), "utf8"));
  expect(stableReference).toBe(reference);
  for (const field of [
    "subject_identity",
    "evidence_coverage",
    "outcome_verdict",
    "process_verdict",
    "preserved_strengths",
    "failures",
    "rework",
    "user_corrections",
    "constraints",
    "supported_patterns",
    "unresolved_competing_hypotheses",
    "candidates",
    "prioritized_experiments",
    "human_discussion_questions",
    "automatic_mutations",
  ]) {
    if (!(field in retrospective)) findings.push(`The final report is missing ${field}.`);
  }
  if (
    retrospective.subject_identity?.execution_id !== manifest.subject_execution_id ||
    retrospective.subject_identity?.workflow_id !== manifest.workflow_id
  ) {
    findings.push("The final report subject/workflow identity does not match the source manifest.");
  }
  if (
    retrospective.evidence_coverage?.state !== manifest.evidence_state ||
    JSON.stringify(retrospective.evidence_coverage?.provenance) !==
      JSON.stringify(manifest.source_records)
  ) {
    findings.push("The final report evidence state or provenance does not match the manifest.");
  }
  if (!Array.isArray(manifest.source_records) || manifest.source_records.length === 0) {
    findings.push("The source manifest has no concrete access/provenance records.");
  }
  for (const sourceRecord of manifest.source_records ?? []) {
    for (const field of ["source_identity", "access_result", "provenance", "relevant_timestamps"]) {
      if (!(field in sourceRecord)) findings.push(`A source record is missing ${field}.`);
    }
    if (!Array.isArray(sourceRecord.relevant_timestamps)) {
      findings.push("A source record has no explicit relevant timestamps.");
    }
  }
  const expectedLimitations = [...(manifest.missing ?? []), ...(evidence.gaps ?? [])];
  for (const limitation of expectedLimitations) {
    if (!retrospective.evidence_coverage?.limitations?.includes(limitation)) {
      findings.push(`The final report lost evidence limitation: ${limitation}.`);
    }
  }
  if (
    !Array.isArray(manifest.redaction_decisions) ||
    JSON.stringify(retrospective.evidence_coverage?.redactions) !==
      JSON.stringify(manifest.redaction_decisions)
  ) {
    findings.push("The final report redaction decisions do not match the source manifest.");
  }
  if (!("outcome_verdict" in retrospective) || !("process_verdict" in retrospective)) {
    findings.push("The final report does not separate outcome and process verdicts.");
  }
  if (!Array.isArray(retrospective.candidates)) {
    findings.push("The final report has no typed candidates array.");
  }
  if (
    !Array.isArray(retrospective.automatic_mutations) ||
    retrospective.automatic_mutations.length > 0
  ) {
    findings.push("The proposal-only authority boundary is violated.");
  }
  for (const candidate of retrospective.candidates ?? []) {
    if (JSON.stringify(Object.keys(candidate)) !== JSON.stringify(canonicalCandidateKeys)) {
      findings.push("A candidate does not use the canonical field contract.");
    }
    if (
      !(
        candidate.target === "result" ||
        candidate.target === "workflow" ||
        candidate.target === "system_prompt" ||
        candidate.target === "evaluator" ||
        candidate.target === "tool_interface" ||
        candidate.target === "observability" ||
        candidate.target === "memory"
      )
    ) {
      findings.push("A candidate target is outside the canonical enum.");
    }
    if (!Array.isArray(candidate.evidence_refs) || candidate.evidence_refs.length === 0) {
      findings.push("A candidate has no evidence references.");
    }
    if (candidate.attribution === "causal") {
      findings.push("A causal candidate lacks comparative intervention evidence in this fixture.");
    }
  }
  const failedCheckIds = (evidence.objective_checks ?? [])
    .filter((check: { result: string }) => check.result === "failed")
    .map((check: { id: string }) => check.id);
  for (const checkId of failedCheckIds) {
    if (!retrospective.failures?.includes(checkId)) {
      findings.push(`The final report lost failing objective check ${checkId}.`);
    }
  }
  const requiredRework = (evidence.process_events ?? [])
    .map((event: { event: string }) => event.event)
    .filter((event: string) => event === "retry" || event === "replan");
  for (const event of requiredRework) {
    if (!retrospective.rework?.includes(event)) {
      findings.push(`The final report lost observed rework event ${event}.`);
    }
  }
  if (
    Array.isArray(evidence.corrections) &&
    JSON.stringify(retrospective.user_corrections) !== JSON.stringify(evidence.corrections)
  ) {
    findings.push("The final report changed or omitted user-correction classifications.");
  }
  if (manifest.evidence_state === "partial" && !analysis) {
    findings.push("Partial evidence did not produce a bounded analysis.");
  }
  if (manifest.evidence_state === "unavailable") {
    if (retrospective.report_type !== "no-data" || retrospective.diagnosis !== null) {
      findings.push("Unavailable evidence invented a diagnosis instead of a no-data report.");
    }
    if (analysis) findings.push("Unavailable evidence improperly produced analysis.md.");
    if ((retrospective.candidates ?? []).length !== 0) {
      findings.push("A no-data report invented a change candidate.");
    }
  } else if (!analysis) {
    findings.push("An answerable execution has no reviewed analysis.");
  } else {
    const outcomeAnchor = String(analysis.outcome).split(/[ :]/)[0];
    const processAnchor = String(analysis.process).split(/[ :]/)[0];
    if (!String(retrospective.outcome_verdict).includes(outcomeAnchor)) {
      findings.push("The final outcome verdict is not faithful to analysis.md.");
    }
    if (!String(retrospective.process_verdict).includes(processAnchor)) {
      findings.push("The final process verdict is not faithful to analysis.md.");
    }
  }
  if (retrospective.disposition === "no-change") {
    if (
      retrospective.candidates.length !== 0 ||
      !Array.isArray(retrospective.preserved_strengths) ||
      retrospective.preserved_strengths.length === 0
    ) {
      findings.push(
        "Clean success did not preserve strengths with a zero-candidate no-change result.",
      );
    }
  }
  writeReview(directory, "final report", findings);
  return findings;
}

function scriptedInputs(
  root: string,
  fixture: BehavioralFixture,
  seenDirectives: string[],
): Record<string, MockInput> {
  const directory = resolve(root, fixture.name);
  const logicalWorkspace = `./moira-ws/execution-retrospective-${fixture.name}-20260818-2239`;
  mkdirSync(directory, { recursive: true });

  function inspectDirective(directive: string | undefined, expected: string): void {
    expect(directive).toBeDefined();
    expect(directive).toContain(expected);
    seenDirectives.push(directive!);
  }

  return {
    "resolve-subject-and-workspace": {
      subject_execution_id: `subject-${fixture.name}`,
      workspace_path: logicalWorkspace,
    },
    "materialize-retrospective-bootstrap": ({ directive }) => {
      inspectDirective(directive, "Materialize 2 files into");
      writeFileSync(resolve(directory, "retrospective-reference.md"), reference);
      return {};
    },
    "acquire-and-reconstruct-evidence": ({ directive }) => {
      inspectDirective(directive, logicalWorkspace);
      writeJsonArtifact(
        directory,
        "source-manifest.md",
        buildSourceManifest(fixture, `subject-${fixture.name}`),
      );
      writeJsonArtifact(directory, "evidence.md", fixture.evidence);
      return { evidence_state: fixture.evidenceState };
    },
    "write-no-data-report": ({ directive }) => {
      inspectDirective(directive, "no-data report");
      expect(existsSync(resolve(directory, "analysis.md"))).toBe(false);
      writeJsonArtifact(
        directory,
        "retrospective.md",
        buildCompleteRetrospective(fixture, `subject-${fixture.name}`),
      );
      return {};
    },
    "evaluate-and-diagnose": ({ directive }) => {
      inspectDirective(directive, "outcome quality and process quality separate");
      expect(existsSync(resolve(directory, "source-manifest.md"))).toBe(true);
      expect(existsSync(resolve(directory, "evidence.md"))).toBe(true);
      writeJsonArtifact(directory, "analysis.md", buildCompleteAnalysis(fixture));
      return {};
    },
    "review-analysis": ({ directive }) => {
      inspectDirective(directive, "genuinely separate reviewer context");
      const findings = independentlyReviewAnalysis(directory);
      return { issues_count: findings.length };
    },
    "synthesize-retrospective": ({ directive }) => {
      inspectDirective(directive, "explicit no-change");
      expect(readFileSync(resolve(directory, "review.md"), "utf8")).toContain(
        "Blocking findings: 0",
      );
      writeJsonArtifact(
        directory,
        "retrospective.md",
        buildCompleteRetrospective(fixture, `subject-${fixture.name}`),
      );
      return {};
    },
    "review-final-report": ({ directive }) => {
      inspectDirective(directive, "same genuinely separate reviewer thread");
      const findings = independentlyReviewFinal(directory);
      return { issues_count: findings.length };
    },
    "present-retrospective": ({ directive }) => {
      inspectDirective(directive, "exact independently accepted current report");
      expect(readFileSync(resolve(directory, "review.md"), "utf8")).toContain(
        "Blocking findings: 0",
      );
      return { report_path: `${logicalWorkspace}/retrospective.md` };
    },
  };
}

function useMaterializeGrant(engine: GraphExecutionEngine): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, MaterializeHandler> })
    .nodeHandlers;
  handlers.set(
    "materialize",
    new MaterializeHandler(
      { createMaterializeToken: () => "retrospective-scenario-token" },
      () => "https://moira.example",
    ),
  );
}

function inputs(
  name: string,
  evidenceState: "sufficient" | "partial" | "unavailable",
): Record<string, MockInput> {
  return {
    "resolve-subject-and-workspace": {
      subject_execution_id: `subject-${name}`,
      workspace_path: `./moira-ws/execution-retrospective-${name}-20260818-2239`,
    },
    "acquire-and-reconstruct-evidence": { evidence_state: evidenceState },
    "write-no-data-report": {},
    "evaluate-and-diagnose": {},
    "review-analysis": { issues_count: 0 },
    "repair-analysis": {},
    "synthesize-retrospective": {},
    "review-final-report": { issues_count: 0 },
    "repair-final-report": { repair_reach: "contained" },
    "present-retrospective": {
      report_path: `./moira-ws/execution-retrospective-${name}-20260818-2239/retrospective.md`,
    },
  };
}

function scenario(
  name: string,
  mockInputs: Record<string, MockInput>,
  reaches: string[],
  avoids: string[] = [],
): TestScenario {
  return {
    name,
    mockInputs,
    expect: { status: "completed", reaches, avoids, maxSteps: 100 },
  };
}

const scenarios: TestScenario[] = [
  scenario(
    "clean success can preserve strengths and conclude no-change",
    inputs("clean-success", "sufficient"),
    ["evaluate-and-diagnose", "synthesize-retrospective", "present-retrospective", "end"],
    ["write-no-data-report", "repair-analysis", "repair-final-report"],
  ),
  scenario(
    "objective failure reaches evidence-grounded diagnosis",
    inputs("objective-failure", "sufficient"),
    ["evaluate-and-diagnose", "review-analysis", "synthesize-retrospective", "end"],
    ["write-no-data-report"],
  ),
  scenario(
    "successful retry or replan remains process evidence rather than a forced defect",
    inputs("retry-replan-success", "sufficient"),
    ["evaluate-and-diagnose", "review-analysis", "review-final-report", "end"],
  ),
  scenario(
    "user correction with partial evidence keeps limitations through review",
    inputs("user-correction", "sufficient"),
    ["evaluate-and-diagnose", "review-analysis", "synthesize-retrospective", "end"],
    ["write-no-data-report"],
  ),
  scenario(
    "data-poor partial execution keeps bounded diagnosis limitations",
    inputs("data-poor-partial", "partial"),
    ["evaluate-and-diagnose", "review-analysis", "synthesize-retrospective", "end"],
    ["write-no-data-report"],
  ),
  scenario(
    "data-poor execution produces reviewed no-data report",
    inputs("data-poor", "unavailable"),
    ["write-no-data-report", "review-final-report", "present-retrospective", "end"],
    ["evaluate-and-diagnose", "review-analysis", "synthesize-retrospective"],
  ),
  scenario(
    "analysis finding is repaired and rereviewed",
    {
      ...inputs("analysis-repair", "sufficient"),
      "review-analysis": [{ issues_count: 2 }, { issues_count: 0 }],
    },
    ["repair-analysis", "review-analysis", "synthesize-retrospective", "end"],
  ),
  scenario(
    "contained report repair returns only to final reviewer",
    {
      ...inputs("contained-repair", "sufficient"),
      "review-final-report": [{ issues_count: 1 }, { issues_count: 0 }],
      "repair-final-report": { repair_reach: "contained" },
    },
    ["repair-final-report", "route-final-repair-reach", "review-final-report", "end"],
  ),
  scenario(
    "spreading report repair reacquires evidence and reruns downstream gates",
    {
      ...inputs("spreading-repair", "sufficient"),
      "acquire-and-reconstruct-evidence": [
        { evidence_state: "sufficient" },
        { evidence_state: "partial" },
      ],
      "review-analysis": [{ issues_count: 0 }, { issues_count: 0 }],
      "review-final-report": [{ issues_count: 1 }, { issues_count: 0 }],
      "repair-final-report": { repair_reach: "spreading" },
    },
    [
      "repair-final-report",
      "route-final-repair-reach",
      "acquire-and-reconstruct-evidence",
      "evaluate-and-diagnose",
      "review-analysis",
      "end",
    ],
  ),
];

async function untar(buffer: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const parser = extract();
  const complete = new Promise<void>((resolvePromise, reject) => {
    parser.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.once("error", reject);
      stream.resume();
    });
    parser.once("finish", resolvePromise);
    parser.once("error", reject);
  });
  parser.end(buffer);
  await complete;
  return entries;
}

describe("execution-retrospective validation packet", () => {
  test("exact release candidate is structurally valid and preserves the authority contract", async () => {
    const result = await new GraphValidator().validateUnified(workflow);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    expect(catalogEntry).toMatchObject({
      slug: "execution-retrospective",
      owner: "system-moira",
      visibility: "public",
    });
    expect(workflow).toMatchObject({
      metadata: { name: "Execution Retrospective", version: "1.0.0" },
    });
    expect(workflow.nodes).toHaveLength(17);
    expect(Object.keys(workflow.variableRegistry ?? {})).toEqual([
      "subject_execution_id",
      "workspace_path",
      "evidence_state",
      "issues_count",
      "report_path",
      "workspace_process_id_file",
      "retrospective_reference",
    ]);
    expect(workflow.nodes.map((node) => node.type)).not.toEqual(
      expect.arrayContaining(["write-note", "upsert-note", "telegram-notification", "lock"]),
    );

    const serialized = JSON.stringify(workflow);
    for (const forbidden of [
      "retry_counter",
      "pass_id",
      "findings_history",
      "approval_status",
      "mutate the reviewed result",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    const nodes = Object.fromEntries(workflow.nodes.map((node) => [node.id, node])) as Record<
      string,
      { directive?: string }
    >;
    expect(nodes["review-analysis"].directive).toContain("genuinely separate reviewer context");
    expect(nodes["review-analysis"].directive).toContain("Reuse the same reviewer thread");
    expect(nodes["review-final-report"].directive).toContain(
      "same genuinely separate reviewer thread",
    );
    expect(nodes["evaluate-and-diagnose"].directive).toContain(
      "objective failures/rework/corrections",
    );
    expect(nodes["evaluate-and-diagnose"].directive).toContain("Classify user correction");
    expect(nodes["synthesize-retrospective"].directive).toContain("explicit no-change");
    expect(String(workflow.variableRegistry?.retrospective_reference?.default)).toBe(reference);
    expect(createHash("sha256").update(reference).digest("hex")).toBe(referenceSha256);
  });

  test("all semantic archetypes, nodes, conditions, and repair routes execute", async () => {
    const results = [];
    for (const item of scenarios) {
      results.push(await runScenario(workflow, item, { engineSetup: useMaterializeGrant }));
    }
    const failed = results.filter((result) => !result.passed);
    expect(failed).toEqual([]);
    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
    for (const result of results) {
      expect(result.finalContext).toMatchObject({
        subject_execution_id: expect.any(String),
        evidence_state: expect.stringMatching(/^(sufficient|partial|unavailable)$/),
        report_path: expect.stringMatching(/retrospective\.md$/),
      });
      expect(result.finalContext.end).toEqual({
        subject_execution_id: result.finalContext.subject_execution_id,
        evidence_state: result.finalContext.evidence_state,
        report_path: result.finalContext.report_path,
      });
    }
  });

  test("scripted agent fixtures produce and verify the required semantic artifacts", async () => {
    const artifactRoot = mkdtempSync(resolve(tmpdir(), "execution-retrospective-behavior-"));
    try {
      for (const fixture of behavioralFixtures) {
        const seenDirectives: string[] = [];
        const directory = resolve(artifactRoot, fixture.name);
        const route = scenario(
          fixture.name,
          scriptedInputs(artifactRoot, fixture, seenDirectives),
          fixture.evidenceState === "unavailable"
            ? ["write-no-data-report", "review-final-report", "end"]
            : ["evaluate-and-diagnose", "review-analysis", "synthesize-retrospective", "end"],
          fixture.evidenceState === "unavailable"
            ? ["evaluate-and-diagnose", "review-analysis", "synthesize-retrospective"]
            : ["write-no-data-report"],
        );
        const result = await runScenario(workflow, route, { engineSetup: useMaterializeGrant });
        expect(result.passed).toBe(true);
        expect(result.finalContext.end).toEqual({
          subject_execution_id: `subject-${fixture.name}`,
          evidence_state: fixture.evidenceState,
          report_path: `./moira-ws/execution-retrospective-${fixture.name}-20260818-2239/retrospective.md`,
        });
        expect(seenDirectives).toHaveLength(fixture.evidenceState === "unavailable" ? 5 : 7);

        for (const file of ["source-manifest.md", "evidence.md", "review.md", "retrospective.md"]) {
          expect(existsSync(resolve(directory, file))).toBe(true);
        }
        const manifest = JSON.parse(readFileSync(resolve(directory, "source-manifest.md"), "utf8"));
        const evidence = JSON.parse(readFileSync(resolve(directory, "evidence.md"), "utf8"));
        const retrospective = JSON.parse(
          readFileSync(resolve(directory, "retrospective.md"), "utf8"),
        );
        expect(Array.isArray(manifest.missing)).toBe(true);
        expect(Array.isArray(evidence.gaps)).toBe(true);
        expect(readFileSync(resolve(directory, "review.md"), "utf8")).toContain(
          "Blocking findings: 0",
        );
        expect(retrospective.automatic_mutations).toEqual([]);

        if (fixture.evidenceState === "unavailable") {
          expect(existsSync(resolve(directory, "analysis.md"))).toBe(false);
          expect(retrospective).toMatchObject({
            report_type: "no-data",
            outcome_verdict: "cannot be answered",
            process_verdict: "cannot be answered",
            diagnosis: null,
            candidates: [],
          });
        } else {
          expect(existsSync(resolve(directory, "analysis.md"))).toBe(true);
          const analysis = JSON.parse(readFileSync(resolve(directory, "analysis.md"), "utf8"));
          expect(analysis).toHaveProperty("outcome");
          expect(analysis).toHaveProperty("process");
        }

        if (fixture.name === "clean-success") {
          expect(retrospective.preserved_strengths).toContain(
            "Objective check and delivered artifact agree",
          );
          expect(retrospective.candidates).toEqual([]);
          expect(retrospective.disposition).toBe("no-change");
        }
        if (fixture.name === "objective-failure") {
          expect(evidence.objective_checks[0]).toMatchObject({
            id: "objective-check-1",
            result: "failed",
          });
          expect(retrospective.outcome_verdict).toContain("objective-check-1");
          expect(retrospective.candidates).toHaveLength(1);
          expect(Object.keys(retrospective.candidates[0])).toEqual(canonicalCandidateKeys);
          for (const key of canonicalCandidateKeys) {
            expect(reference).toContain(key);
          }
          expect(retrospective.candidates[0]).toMatchObject({
            attribution: "unknown",
            confidence: "medium",
            disposition: "eval",
            approval_owner: expect.any(String),
          });
        }
        if (fixture.name === "retry-replan-success") {
          expect(
            evidence.objective_checks.map((check: { result: string }) => check.result),
          ).toEqual(["failed", "passed"]);
          expect(evidence.process_events.map((event: { event: string }) => event.event)).toEqual([
            "replan",
            "retry",
            "completed",
          ]);
          const analysis = JSON.parse(readFileSync(resolve(directory, "analysis.md"), "utf8"));
          expect(analysis.findings[0].attribution).not.toBe("causal");
          expect(analysis.findings[0].limitations).toContain(
            "The successful adaptation was not isolated from other changes",
          );
        }
        if (fixture.name === "user-correction") {
          expect(
            evidence.corrections.map((item: { classification: string }) => item.classification),
          ).toEqual(["defect", "preference", "requirement-change", "downstream-edit"]);
          expect(retrospective.correction_classifications).toEqual([
            "defect",
            "preference",
            "requirement-change",
            "downstream-edit",
          ]);
          const analysis = JSON.parse(readFileSync(resolve(directory, "analysis.md"), "utf8"));
          expect(analysis.findings[0].scope).toContain(
            "preferences and changed requirements are excluded",
          );
        }
        if (fixture.name === "data-poor-partial") {
          const analysis = JSON.parse(readFileSync(resolve(directory, "analysis.md"), "utf8"));
          for (const finding of analysis.findings) {
            expect(finding.limitations).toEqual(expect.arrayContaining(evidence.gaps));
          }
          expect(retrospective.limitations).toEqual(expect.arrayContaining(evidence.gaps));
          expect(retrospective.process_verdict).toBe("unknown");
        }
      }
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  test("exact registry defaults render to a two-file archive without entering the directive body", async () => {
    const materialize = workflow.nodes.find(
      (node) => node.id === "materialize-retrospective-bootstrap",
    ) as MaterializeNode;
    const context: ExecutionContext = {
      executionId: "execution-validation-packet",
      workflowId: workflow.id ?? "execution-retrospective",
      userId: "validation-user",
      variables: { workspace_path: "./moira-ws/execution-retrospective-validation" },
      nodeStates: {},
    };
    const rendered = await renderMaterializeFiles(
      materialize,
      workflow.variableRegistry ?? {},
      context,
    );
    expect(rendered.map((entry) => entry.path)).toEqual([
      "process-id.txt",
      "retrospective-reference.md",
    ]);
    expect(rendered[0].content.toString()).toBe(context.executionId);
    expect(rendered[1].content.toString()).toBe(reference);
    const archive = await untar(await createMaterializeTar(rendered));
    expect([...archive.keys()]).toEqual(["process-id.txt", "retrospective-reference.md"]);
    expect(archive.get("process-id.txt")?.toString()).toBe(context.executionId);
    expect(archive.get("retrospective-reference.md")?.toString()).toBe(reference);

    const queue = new AgentMessageQueue();
    const handler = new MaterializeHandler(
      { createMaterializeToken: () => "exact-candidate-token" },
      () => "https://moira.example",
    );
    await handler.execute(
      materialize,
      context,
      queue,
      workflow.variableRegistry ?? {},
      {} as never,
    );
    const message = queue.flush(context.executionId).messages[0];
    expect(message.type).toBe("directive");
    if (message.type !== "directive") throw new Error("Expected materialize directive");
    expect(message.directive).toContain("Materialize 2 files into");
    expect(message.directive).not.toContain(reference.slice(0, 80));
    expect(message.inputSchema).toEqual({
      type: ["object", "null"],
      additionalProperties: false,
      maxProperties: 0,
    });
    await expect(
      handler.execute(
        materialize,
        context,
        new AgentMessageQueue(),
        workflow.variableRegistry ?? {},
        {} as never,
        null,
      ),
    ).resolves.toMatchObject({ action: "continue", outputPath: "success" });
    const objectContext = { ...context, nodeStates: {} };
    await handler.execute(
      materialize,
      objectContext,
      new AgentMessageQueue(),
      workflow.variableRegistry ?? {},
      {} as never,
    );
    await expect(
      handler.execute(
        materialize,
        objectContext,
        new AgentMessageQueue(),
        workflow.variableRegistry ?? {},
        {} as never,
        {},
      ),
    ).resolves.toMatchObject({ action: "continue", outputPath: "success" });
  });
});
