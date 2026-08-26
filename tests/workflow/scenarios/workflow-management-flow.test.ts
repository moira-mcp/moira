/** Behavioral scenarios for workflow-management-flow v6. */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  GraphValidator,
  MaterializeHandler,
  detectCycles,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import { runScenario, type MockInput, type TestScenario } from "../../helpers/scenario-runner.js";

function loadWorkflow(): WorkflowGraph {
  return structuredClone(
    findSystemCatalogEntry("workflow-management-flow", "public")!.graph,
  ) as WorkflowGraph;
}

function useScenarioMaterializeGrant(engine: GraphExecutionEngine): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, MaterializeHandler> })
    .nodeHandlers;
  handlers.set(
    "materialize",
    new MaterializeHandler(
      { createMaterializeToken: () => "scenario-token" },
      () => "https://moira.example",
    ),
  );
}

function createInputs(name: string): Record<string, MockInput> {
  const workspace = `./moira-ws/workflow-management-flow-${name}-create`;
  return {
    "get-action-type": {
      action_type: "create",
      operating_mode: "interactive",
      workspace_path: workspace,
    },
    "gather-workflow-requirements": {},
    "design-workflow-structure": {},
    "review-workflow-design": { design_review_outcome: "pass" },
    "fix-create-design": {
      repair_outcome: "changed",
      root_cause_class: "design contract defect",
      changed_knowledge: "The design contract now distinguishes the required behavior",
    },
    "reassess-design-contract": {},
    "approve-structure": { structure_approved: "yes" },
    "refine-structure": {},
    "create-workflow-json": { workflow_artifact_path: `${workspace}/workflow.json` },
    "review-workflow-quality": { quality_review_outcome: "pass" },
    "fix-quality-issues": {
      repair_outcome: "changed",
      root_cause_class: "workflow artifact defect",
      changed_knowledge: "The relevant workflow behavior changed and was structurally validated",
    },
    "user-final-review": { work_approved: "yes" },
    "revise-create-requirements": {},
    "ask-upload": { upload_confirmed: false },
    "save-workflow-to-target": { upload_success: "yes" },
    "handle-upload-error": { error_action: "retry" },
    "sync-local-file": {},
  };
}

function editInputs(name: string, localPath = `workflows/${name}.json`): Record<string, MockInput> {
  const workspace = `./moira-ws/workflow-management-flow-${name}-edit`;
  return {
    "get-action-type": {
      action_type: "edit",
      workflow_identity: name,
      offline_mode: false,
      operating_mode: "interactive",
      workspace_path: workspace,
    },
    "prepare-edit-workflow": {
      local_workflow_path: localPath,
      workflow_artifact_path: `${workspace}/workflow.json`,
    },
    "gather-edit-requirements": {},
    "ask-full-antipattern-audit": { full_antipattern_audit: "no" },
    "audit-complete-workflow": { additional_edit_scope: "none" },
    "create-edit-plan": {},
    "review-workflow-design": { design_review_outcome: "pass" },
    "fix-edit-plan": {
      repair_outcome: "changed",
      root_cause_class: "edit design contract defect",
      changed_knowledge: "The edit contract now supplies discriminating acceptance evidence",
    },
    "reassess-design-contract": {},
    "present-edit-plan": { plan_approval: "yes" },
    "revise-edit-plan": {},
    "apply-workflow-changes": {},
    "review-workflow-quality": { quality_review_outcome: "pass" },
    "fix-quality-issues": {
      repair_outcome: "changed",
      root_cause_class: "workflow artifact defect",
      changed_knowledge: "The relevant workflow behavior changed and was structurally validated",
    },
    "user-final-review": { work_approved: "yes" },
    "revise-edit-requirements": {},
    "ask-upload": { upload_confirmed: false },
    "save-workflow-to-target": { upload_success: "yes" },
    "handle-upload-error": { error_action: "retry" },
    "sync-local-file": {},
  };
}

/** Same run as the interactive helpers, but with the mode that routes around the approval gates. */
function autonomous(inputs: Record<string, MockInput>): Record<string, MockInput> {
  const entry = inputs["get-action-type"] as Record<string, unknown>;
  return {
    ...inputs,
    "get-action-type": { ...entry, operating_mode: "autonomous" },
    "report-final-result": {},
  };
}

function scenario(
  name: string,
  mockInputs: Record<string, MockInput>,
  reaches: string[] = [],
  avoids: string[] = [],
  options: Pick<TestScenario, "teleportAfter"> = {},
): TestScenario {
  return {
    name,
    mockInputs,
    ...options,
    expect: { status: "completed", reaches, avoids, maxSteps: 120 },
  };
}

const scenarios: TestScenario[] = [
  scenario(
    "create without upload",
    createInputs("create-no-upload"),
    ["end"],
    ["save-workflow-to-target"],
  ),
  scenario(
    "create refinement quality repair and final feedback",
    {
      ...createInputs("create-rework"),
      "approve-structure": [
        { structure_approved: "no", structure_feedback: "Add an approval boundary" },
        { structure_approved: "yes" },
        { structure_approved: "yes" },
      ],
      "review-workflow-design": [
        { design_review_outcome: "pass" },
        { design_review_outcome: "pass" },
        { design_review_outcome: "pass" },
      ],
      "review-workflow-quality": [
        { quality_review_outcome: "repair" },
        { quality_review_outcome: "pass" },
        { quality_review_outcome: "pass" },
      ],
      "user-final-review": [
        { work_approved: "no", final_feedback: "Clarify the completion contract" },
        { work_approved: "yes" },
      ],
    },
    ["refine-structure", "fix-quality-issues", "revise-create-requirements", "end"],
  ),
  scenario(
    "edit local source with optional complete audit and plan loops",
    {
      ...editInputs("edit-audit"),
      "ask-full-antipattern-audit": { full_antipattern_audit: "yes" },
      "audit-complete-workflow": { additional_edit_scope: "Repair confirmed legacy machinery" },
      "review-workflow-design": [
        { design_review_outcome: "repair" },
        { design_review_outcome: "pass" },
        { design_review_outcome: "pass" },
        { design_review_outcome: "pass" },
      ],
      "present-edit-plan": [
        { plan_approval: "no", user_feedback: "Preserve the public contract" },
        { plan_approval: "yes" },
      ],
      "user-final-review": [
        { work_approved: "no", final_feedback: "Repair the remaining edit defect" },
        { work_approved: "yes" },
      ],
    },
    [
      "audit-complete-workflow",
      "fix-edit-plan",
      "revise-edit-plan",
      "revise-edit-requirements",
      "sync-local-file",
    ],
  ),
  scenario(
    "unprovable proxy criterion replans before create mutation",
    {
      ...createInputs("create-proxy-replan"),
      "review-workflow-design": [
        { design_review_outcome: "replan" },
        { design_review_outcome: "pass" },
      ],
    },
    ["reassess-design-contract", "design-workflow-structure", "create-workflow-json", "end"],
    ["fix-create-design"],
  ),
  scenario(
    "repairable create design returns with changed knowledge",
    {
      ...createInputs("create-design-repair"),
      "review-workflow-design": [
        { design_review_outcome: "repair" },
        { design_review_outcome: "pass" },
      ],
    },
    ["fix-create-design", "route-create-design-repair-changed", "create-workflow-json", "end"],
    ["reassess-design-contract"],
  ),
  scenario(
    "create proof-token design repair can request reassessment",
    {
      ...createInputs("create-proof-token-reassess"),
      "review-workflow-design": [
        { design_review_outcome: "repair" },
        { design_review_outcome: "pass" },
      ],
      "fix-create-design": { repair_outcome: "reassess" },
    },
    ["fix-create-design", "reassess-design-contract", "design-workflow-structure", "end"],
  ),
  scenario(
    "edit metatest repair can request contract reassessment",
    {
      ...editInputs("edit-metatest-reassess"),
      "review-workflow-design": [
        { design_review_outcome: "repair" },
        { design_review_outcome: "pass" },
      ],
      "fix-edit-plan": { repair_outcome: "reassess" },
    },
    ["fix-edit-plan", "reassess-design-contract", "create-edit-plan", "end"],
  ),
  scenario(
    "scanner validation defect replans without artifact repair",
    {
      ...editInputs("edit-scanner-replan"),
      "review-workflow-quality": [
        { quality_review_outcome: "replan" },
        { quality_review_outcome: "pass" },
      ],
    },
    ["route-quality-review-replan", "reassess-design-contract", "create-edit-plan", "end"],
    ["fix-quality-issues"],
  ),
  scenario(
    "same-root guard repair exits to reassessment instead of nesting validators",
    {
      ...createInputs("create-guard-reassess"),
      "review-workflow-design": [
        { design_review_outcome: "pass" },
        { design_review_outcome: "pass" },
      ],
      "review-workflow-quality": [
        { quality_review_outcome: "repair" },
        { quality_review_outcome: "pass" },
      ],
      "fix-quality-issues": { repair_outcome: "reassess" },
    },
    ["fix-quality-issues", "route-quality-repair-changed", "reassess-design-contract", "end"],
  ),
  scenario(
    "edit server-only source without local synchronization",
    editInputs("edit-server-only", ""),
    ["route-local-sync", "end"],
    ["sync-local-file"],
  ),
  scenario(
    "upload succeeds then synchronizes a real local target",
    {
      ...editInputs("upload-success"),
      "ask-upload": { upload_confirmed: true, upload_method: "standard" },
    },
    ["save-workflow-to-target", "sync-local-file", "end"],
  ),
  scenario(
    "upload failure retries with an explicitly chosen method",
    {
      ...createInputs("upload-retry"),
      "ask-upload": { upload_confirmed: true, upload_method: "standard" },
      "save-workflow-to-target": [
        { upload_success: "no", upload_error: "Conflict" },
        { upload_success: "yes" },
      ],
      "handle-upload-error": { error_action: "admin_override" },
    },
    ["handle-upload-error", "route-error-action-new", "end"],
  ),
  scenario(
    "upload failure can skip",
    {
      ...createInputs("upload-skip"),
      "ask-upload": { upload_confirmed: true, upload_method: "standard" },
      "save-workflow-to-target": { upload_success: "no", upload_error: "Unavailable" },
      "handle-upload-error": { error_action: "skip" },
    },
    ["route-error-skip-or-cancel", "end"],
  ),
  scenario(
    "autonomous create reaches the final report without design or result approval",
    autonomous(createInputs("autonomous-create")),
    ["route-operating-mode-structure", "route-operating-mode-final", "report-final-result", "end"],
    ["approve-structure", "refine-structure", "user-final-review"],
  ),
  scenario(
    "autonomous edit selects the audit scope itself and skips both approval gates",
    {
      ...autonomous(editInputs("autonomous-edit")),
      "ask-full-antipattern-audit": { full_antipattern_audit: "yes" },
      "audit-complete-workflow": { additional_edit_scope: "Repair the confirmed blocking finding" },
    },
    [
      "audit-complete-workflow",
      "route-operating-mode-plan",
      "apply-workflow-changes",
      "report-final-result",
      "sync-local-file",
      "end",
    ],
    ["present-edit-plan", "revise-edit-plan", "user-final-review", "revise-edit-requirements"],
  ),
  scenario(
    "process revision teleport re-enters the ordinary analysis and plan contract",
    {
      ...editInputs("revise-process"),
      "teleport-revise-process": {},
    },
    [
      "teleport-revise-process",
      "create-edit-plan",
      "present-edit-plan",
      "apply-workflow-changes",
      "end",
    ],
    [],
    {
      teleportAfter: { afterNode: "apply-workflow-changes", teleportTo: "teleport-revise-process" },
    },
  ),
  scenario(
    "upload failure can cancel",
    {
      ...createInputs("upload-cancel"),
      "ask-upload": { upload_confirmed: true, upload_method: "standard" },
      "save-workflow-to-target": { upload_success: "no", upload_error: "Unauthorized" },
      "handle-upload-error": { error_action: "cancel" },
    },
    ["end-cancelled"],
    ["end"],
  ),
];

describe("workflow-management-flow v6", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("keeps the complete authoring policy embedded and file-backed", async () => {
    const result = await new GraphValidator().validateUnified(workflow);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    expect(workflow.metadata.version).toBe("6.2.2");
    expect(workflow.metadata.description).toContain("complete existing definition");
    expect(workflow.metadata.description).toContain("official workflow schema tool");
    // One node fewer than upstream 6.1.0: the analysis responsibility moved into the planning node.
    expect(workflow.nodes).toHaveLength(57);
    expect(workflow.nodes.some((node) => node.type === "expression")).toBe(false);
    expect(detectCycles(workflow).length).toBeGreaterThan(0);

    expect(Object.keys(workflow.variableRegistry ?? {})).toEqual([
      "additional_edit_scope",
      "local_workflow_path",
      "workspace_path",
      "action_type",
      "workflow_artifact_path",
      "workflow_authoring_reference",
      "operating_mode",
      "workspace_process_id_file",
    ]);
    expect(workflow.variableRegistry?.operating_mode?.enum).toEqual(["autonomous", "interactive"]);
    const reference = String(workflow.variableRegistry?.workflow_authoring_reference?.default);
    for (const section of [
      "## Engine contract",
      "## Durable artifact and context rules",
      "## Review and repair",
      "## Validation and cost ordering",
      "## Patterns",
      "## Antipattern catalog",
      "## Reviewer contract",
      "### Operating mode (autonomous vs interactive)",
      "### Revising the process while the work runs",
      "### The reference the run writes itself",
      "### Design before build",
      "### Discriminating evidence and matching modality",
      "### Cause before repair",
      "### Replan without requirement erosion",
      "### Bounded class-wide repair",
      "### Validation as a requested result",
      "### Minimal consumed process record",
      "### Routing a confirmed repair by its stale-evidence cone",
      "### Late design discovery",
      "### Non-discriminating evidence",
      "### Evidence modality mismatch",
      "### Repair before diagnosis",
      "### Validator nesting",
      "### Changed bytes without changed knowledge",
      "### Universal detector for a contextual property",
      "### Validation-only drift",
      "### User approval as semantic review",
      "### Engine state computed by the agent",
      "### A reference with no address",
      "mechanical validation",
      "decorative flags",
      "do not force the same agent to reread",
    ]) {
      expect(reference.toLowerCase()).toContain(section.toLowerCase());
    }

    // One assertion per rule the formulation pass carries: each pins the phrase that carries the
    // rule, so removing the rule fails here instead of passing silently. The rule about matching
    // evidence to the kind of claim is upstream's ("Discriminating evidence and matching
    // modality"), so only the prose-deliverable paragraph it lacked is ours, and it lives inside
    // upstream's plan-as-a-script antipattern rather than in a second section of its own.
    for (const rule of [
      "### Rules stated as outcomes, each carrying its reason",
      "### Order of telling taken for order of work",
      "the order belongs to the executor",
      "### Redundancy required in every plan item",
      "judged item by item, on whether it genuinely applies there",
      "### Directive as a drill order",
      "Remove the capitals and the signs",
      "### Discriminating evidence and matching modality",
      "Where the deliverable is itself prose",
      "does not distinguish two states of the result",
    ]) {
      expect(reference.toLowerCase()).toContain(rule.toLowerCase());
    }
    // The prose paragraph continues upstream's code-only prohibition instead of standing apart.
    const scriptSection = reference.slice(
      reference.indexOf("### Plan as a mechanical implementation script"),
    );
    expect(scriptSection).toContain("Where the deliverable is itself prose");

    const nodes = Object.fromEntries(workflow.nodes.map((node) => [node.id, node])) as Record<
      string,
      any
    >;
    expect(nodes["gather-workflow-requirements"].directive).toContain("workspace");
    expect(nodes["create-edit-plan"].directive).toContain("edit-plan.md");
    expect(nodes["review-workflow-design"].directive).toContain("workflow-design-review.md");
    expect(
      nodes["review-workflow-design"].inputSchema.properties.design_review_outcome.enum,
    ).toEqual(["pass", "repair", "replan"]);

    // One responsibility writes one document: the analysis section and the outcomes derived from
    // it share a file, so a correction cannot land in one of them and leave the other superseded.
    // Each assertion pins a half that lived in the deleted analysis node, and the completion
    // condition demands both — without it the gate would accept a plan with no analysis at all.
    const merged = nodes["create-edit-plan"];
    for (const carried of [
      "the analysis section first",
      "source-provenance.md",
      "workflow-authoring-reference.md",
      "{{additional_edit_scope}}",
      "baseline diagnostics",
      "observable acceptance criteria",
      "entry points, not an exhaustive whitelist",
    ]) {
      expect(merged.directive).toContain(carried);
    }
    expect(merged.completionCondition).toContain("complete analysis");
    expect(merged.completionCondition).toContain("outcome-oriented edit design contract");

    // The acceptance criteria of an approved plan are the contract the executor is judged by, so
    // the executor may not reword them: it states the rule and names the teleport as the way out.
    expect(nodes["apply-workflow-changes"].directive).toContain("acceptance criterion");
    expect(nodes["apply-workflow-changes"].directive).toContain("process-revision teleport");
    expect(nodes["review-workflow-quality"].directive).toContain("workflow-quality-review.md");
    expect(
      nodes["review-workflow-quality"].inputSchema.properties.quality_review_outcome.enum,
    ).toEqual(["pass", "repair", "replan"]);
    for (const id of ["fix-create-design", "fix-edit-plan", "fix-quality-issues"]) {
      expect(nodes[id].inputSchema.properties.repair_outcome.enum).toEqual(["changed", "reassess"]);
      expect(nodes[id].inputSchema.allOf[0].then.required).toEqual([
        "root_cause_class",
        "changed_knowledge",
      ]);
    }
    expect(nodes["design-workflow-structure"].directive).toContain("plausible wrong state");
    expect(nodes["create-edit-plan"].directive).toContain("observation that distinguishes");
    expect(nodes["review-workflow-quality"].directive).toContain("surrogate signal");
    expect(nodes["ask-full-antipattern-audit"].connections.success).toBe(
      "route-full-antipattern-audit",
    );
    expect(nodes["get-action-type"].connections.success).toBe("materialize-workspace-bootstrap");
    expect(nodes["materialize-workspace-bootstrap"]).toMatchObject({
      type: "materialize",
      basePath: "{{workspace_path}}",
      files: [
        { path: "process-id.txt", from: "workspace_process_id_file" },
        { path: "workflow-authoring-reference.md", from: "workflow_authoring_reference" },
      ],
      connections: { success: "route-action-type" },
    });

    // Autonomous mode is routed, not schema-driven: every approval gate is entered through its
    // own mode condition, and the autonomous branch continues where approval would have led.
    for (const [routeId, gateId, approvedTarget] of [
      ["route-operating-mode-structure", "approve-structure", "create-workflow-json"],
      ["route-operating-mode-plan", "present-edit-plan", "apply-workflow-changes"],
      ["route-operating-mode-final", "user-final-review", "report-final-result"],
    ] as const) {
      expect(nodes[routeId].type).toBe("condition");
      expect(nodes[routeId].condition.left.contextPath).toBe("operating_mode");
      expect(nodes[routeId].condition.right).toBe("autonomous");
      expect(nodes[routeId].connections.true).toBe(approvedTarget);
      expect(nodes[routeId].connections.false).toBe(gateId);
    }
    expect(nodes["report-final-result"].connections.success).toBe("ask-upload");

    // The revision teleport is a jump target: no ordinary incoming edges, landing on the node that
    // re-derives scope, so a revision re-enters the ordinary plan/review contract.
    const teleports = workflow.nodes.filter((candidate) => candidate.type === "teleport");
    expect(teleports.map((candidate) => candidate.id)).toEqual(["teleport-revise-process"]);
    expect(
      workflow.nodes.some((candidate) =>
        Object.values(
          (candidate as { connections?: Record<string, string> }).connections ?? {},
        ).includes("teleport-revise-process"),
      ),
    ).toBe(false);
    expect(nodes["teleport-revise-process"].connections.success).toBe(
      "route-action-after-reassessment",
    );
    // Whichever way an edit run re-enters, it lands on the node that derives the analysis and the
    // contract again together — the analysis has no separate node to return to any more.
    expect(nodes["route-action-after-reassessment"].connections.false).toBe("create-edit-plan");
    expect(nodes["route-full-antipattern-audit"].connections.false).toBe("create-edit-plan");
    expect(nodes["audit-complete-workflow"].connections.success).toBe("create-edit-plan");
    expect(nodes["revise-edit-requirements"].connections.success).toBe("create-edit-plan");
    expect(nodes["teleport-revise-process"].hint).toContain("belong to their repair owners");
    // A criterion that turns out wrong is a legitimate trigger, so the executor forbidden from
    // rewording it in place can find the sanctioned route at the moment it needs one.
    expect(nodes["teleport-revise-process"].hint).toContain("acceptance criterion");
    expect(nodes["report-final-result"].inputSchema.properties).toEqual({});
    // The nodes that keep asking in interactive mode must state their autonomous rule.
    expect(nodes["ask-upload"].directive).toContain("`autonomous` mode do not ask");
    expect(nodes["audit-complete-workflow"].directive).toContain("select the scope yourself");
    expect(nodes["prepare-edit-workflow"].directive).toContain("decide on evidence");
    // Intake resolves the canonical path once; both branch owners consume that global path.
    expect(nodes["get-action-type"].directive).toContain("./moira-ws/workflow-management-flow-");
    for (const id of ["gather-workflow-requirements", "prepare-edit-workflow"]) {
      expect(nodes[id].directive).toContain("{{workspace_path}}");
    }

    const serialized = JSON.stringify(workflow);
    for (const removed of [
      "quality_fix_counter",
      "validation_fix_counter",
      "findings_history",
      "issue_history",
      "anti_pattern_catalog",
      "upload_admin_override",
      // The second document about the edit is gone, not merely unreferenced by the writer.
      "edit-analysis.md",
      "analyze-edit-problem",
    ]) {
      expect(serialized).not.toContain(removed);
    }
  });

  test("all create edit audit publication and recovery routes are covered", async () => {
    const results = [];
    for (const item of scenarios) {
      results.push(await runScenario(workflow, item, { engineSetup: useScenarioMaterializeGrant }));
    }
    const failed = results.filter((result) => !result.passed);
    if (failed.length > 0) {
      throw new Error(
        failed
          .map(
            (result) =>
              `${result.scenario}: ${result.error ?? result.failedExpectations?.join("; ")}`,
          )
          .join("\n\n"),
      );
    }
    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
  });
});
