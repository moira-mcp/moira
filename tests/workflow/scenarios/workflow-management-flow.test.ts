/** Behavioral scenarios for workflow-management-flow v5. */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { GraphValidator, detectCycles, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import { runScenario, type MockInput, type TestScenario } from "../../helpers/scenario-runner.js";

function loadWorkflow(): WorkflowGraph {
  return structuredClone(
    findSystemCatalogEntry("workflow-management-flow", "public")!.graph,
  ) as WorkflowGraph;
}

function createInputs(name: string): Record<string, MockInput> {
  const workspace = `./moira-ws/${name}-create`;
  return {
    "get-action-type": { action_type: "create" },
    "gather-workflow-requirements": { workspace_path: workspace },
    "design-workflow-structure": {},
    "approve-structure": { structure_approved: "yes" },
    "refine-structure": {},
    "create-workflow-json": { workflow_artifact_path: `${workspace}/workflow.json` },
    "review-workflow-quality": { quality_issues_count: 0 },
    "fix-quality-issues": {},
    "user-final-review": { work_approved: "yes" },
    "revise-create-requirements": {},
    "ask-upload": { upload_confirmed: false },
    "save-workflow-to-target": { upload_success: "yes" },
    "handle-upload-error": { error_action: "retry" },
    "sync-local-file": {},
  };
}

function editInputs(name: string, localPath = `workflows/${name}.json`): Record<string, MockInput> {
  const workspace = `./moira-ws/${name}-edit`;
  return {
    "get-action-type": { action_type: "edit", workflow_identity: name, offline_mode: false },
    "prepare-edit-workflow": {
      workspace_path: workspace,
      local_workflow_path: localPath,
      workflow_artifact_path: `${workspace}/workflow.json`,
    },
    "gather-edit-requirements": {},
    "ask-full-antipattern-audit": { full_antipattern_audit: "no" },
    "audit-complete-workflow": { additional_edit_scope: "none" },
    "analyze-edit-problem": {},
    "create-edit-plan": {},
    "validate-edit-plan": { plan_issues_count: 0 },
    "fix-edit-plan": {},
    "present-edit-plan": { plan_approval: "yes" },
    "revise-edit-plan": {},
    "apply-workflow-changes": {},
    "review-workflow-quality": { quality_issues_count: 0 },
    "fix-quality-issues": {},
    "user-final-review": { work_approved: "yes" },
    "revise-edit-requirements": {},
    "ask-upload": { upload_confirmed: false },
    "save-workflow-to-target": { upload_success: "yes" },
    "handle-upload-error": { error_action: "retry" },
    "sync-local-file": {},
  };
}

function scenario(
  name: string,
  mockInputs: Record<string, MockInput>,
  reaches: string[] = [],
  avoids: string[] = [],
): TestScenario {
  return { name, mockInputs, expect: { status: "completed", reaches, avoids, maxSteps: 120 } };
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
      "review-workflow-quality": [
        { quality_issues_count: 1 },
        { quality_issues_count: 0 },
        { quality_issues_count: 0 },
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
      "validate-edit-plan": [
        { plan_issues_count: 1 },
        { plan_issues_count: 0 },
        { plan_issues_count: 0 },
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

describe("workflow-management-flow v5", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("keeps the complete authoring policy embedded and file-backed", async () => {
    const result = await new GraphValidator().validateUnified(workflow);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    expect(workflow.metadata.version).toBe("5.0.1");
    expect(workflow.nodes).toHaveLength(42);
    expect(workflow.nodes.some((node) => node.type === "expression")).toBe(false);
    expect(detectCycles(workflow).length).toBeGreaterThan(0);

    expect(Object.keys(workflow.variableRegistry ?? {})).toEqual([
      "additional_edit_scope",
      "local_workflow_path",
      "workspace_path",
      "action_type",
      "workflow_artifact_path",
      "workflow_authoring_reference",
    ]);
    const reference = String(workflow.variableRegistry?.workflow_authoring_reference?.default);
    for (const section of [
      "## Engine contract",
      "## Durable artifact and context rules",
      "## Review and repair",
      "## Validation and cost ordering",
      "## Patterns",
      "## Antipattern catalog",
      "## Reviewer contract",
      "mechanical validation",
      "decorative flags",
      "do not force the same agent to reread",
    ]) {
      expect(reference.toLowerCase()).toContain(section.toLowerCase());
    }

    const nodes = Object.fromEntries(workflow.nodes.map((node) => [node.id, node])) as Record<
      string,
      any
    >;
    expect(nodes["gather-workflow-requirements"].directive).toContain("workspace");
    expect(nodes["create-edit-plan"].directive).toContain("edit-plan.md");
    expect(nodes["validate-edit-plan"].directive).toContain("edit-plan-review.md");
    expect(nodes["review-workflow-quality"].directive).toContain("workflow-quality-review.md");
    expect(nodes["ask-full-antipattern-audit"].connections.success).toBe(
      "route-full-antipattern-audit",
    );

    const serialized = JSON.stringify(workflow);
    for (const removed of [
      "quality_fix_counter",
      "validation_fix_counter",
      "findings_history",
      "issue_history",
      "anti_pattern_catalog",
      "upload_admin_override",
    ]) {
      expect(serialized).not.toContain(removed);
    }
  });

  test("all create edit audit publication and recovery routes are covered", async () => {
    const results = [];
    for (const item of scenarios) results.push(await runScenario(workflow, item));
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
