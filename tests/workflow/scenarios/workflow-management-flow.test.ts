/** Behavioral scenarios for workflow-management-flow. */

import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  MaterializeHandler,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import {
  runScenario as runScenarioBase,
  type MockInput,
  type MockInputContext,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

function loadWorkflow(): WorkflowGraph {
  return structuredClone(
    findCatalogEntryBySlug("workflow-management-flow")!.graph,
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

function progressOutputsFor(
  workflow: WorkflowGraph,
  nodeId: string,
  input: Record<string, unknown>,
): Record<string, string> {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  const globals = node?.inputSchema?.globalInputs ?? [];
  const ownOutcome = node?.progressNodeId ? `progress_${node.progressNodeId}_outcome` : null;
  return Object.fromEntries(
    globals
      .filter((name) => name.startsWith("progress_"))
      .map((name) => {
        if (name !== ownOutcome) return [name, `Pending — invalidated by ${nodeId}`];
        if (nodeId === "ask-upload") {
          return [
            name,
            input.upload_confirmed
              ? "Approved workflow is authorized for server upload"
              : "Server upload is not authorized; local result remains accepted",
          ];
        }
        if (nodeId === "save-workflow-to-target") {
          return [
            name,
            input.upload_success === "yes"
              ? "Authorized server upload completed"
              : "Authorized server upload failed; recovery decision required",
          ];
        }
        if (nodeId === "handle-upload-error") {
          return [name, `Upload recovery selected: ${String(input.error_action)}`];
        }
        if (nodeId === "sync-local-file") {
          return [name, "Accepted workflow synchronized to its repository target"];
        }
        if (nodeId === "user-final-review") {
          return [
            name,
            input.work_approved === "yes"
              ? "Final workflow approved; delivery decision pending"
              : "Final workflow rejected; requirements revision required",
          ];
        }
        return [name, `${node?.progressNodeId ?? "workflow"}: ${nodeId} result accepted`];
      }),
  );
}

function addProgressOutputs(workflow: WorkflowGraph, nodeId: string, input: MockInput): MockInput {
  if (Array.isArray(input)) {
    return input.map((item) => ({ ...progressOutputsFor(workflow, nodeId, item), ...item }));
  }
  if (typeof input === "function") {
    return (context: MockInputContext) => {
      const resolved = input(context);
      return { ...progressOutputsFor(workflow, nodeId, resolved), ...resolved };
    };
  }
  return { ...progressOutputsFor(workflow, nodeId, input), ...input };
}

async function runScenario(
  workflow: WorkflowGraph,
  testScenario: TestScenario,
  options?: Parameters<typeof runScenarioBase>[2],
): ReturnType<typeof runScenarioBase> {
  return runScenarioBase(
    workflow,
    {
      ...testScenario,
      mockInputs: Object.fromEntries(
        Object.entries(testScenario.mockInputs).map(([nodeId, input]) => [
          nodeId,
          addProgressOutputs(workflow, nodeId, input),
        ]),
      ),
    },
    options,
  );
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

describe("workflow-management-flow", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
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
