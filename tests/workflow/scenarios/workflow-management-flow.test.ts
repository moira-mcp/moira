/** Behavioral scenarios for workflow-management-flow. */

import {
  blockStatuses,
  deriveProcess,
  GraphExecutionEngine,
  MaterializeHandler,
  type ExecutionVisit,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import {
  runScenario as runScenarioBase,
  type MockInput,
  type MockInputContext,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";
import { catalogGraph } from "../../helpers/catalog-graphs.js";

function loadWorkflow(): WorkflowGraph {
  return catalogGraph("workflow-management-flow");
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
    "gather-workflow-requirements": { complexity_tier: "standard" },
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
    "gather-edit-requirements": { recorded_tier: "none", complexity_tier: "standard" },
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
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId) as
    { progressNodeId?: string; inputSchema?: { globalInputs?: string[] } } | undefined;
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

/** The plan list the plan writers return: the stages of a new workflow or the changes of an edit. */
const PLANNED_CHANGES = [{ title: "Capture the request" }, { title: "Check the result" }];
const PLAN_WRITERS = new Set([
  "gather-workflow-requirements",
  "gather-edit-requirements",
  "revise-create-requirements",
  "revise-edit-requirements",
  "design-workflow-structure",
  "refine-structure",
  "create-edit-plan",
  "revise-edit-plan",
  "fix-create-design",
  "fix-edit-plan",
  "approve-structure",
  "present-edit-plan",
  "teleport-revise-process",
]);
const DECISIONS = new Set(["ask-full-antipattern-audit", "ask-upload", "handle-upload-error"]);

/** The fields a step writes for the person reading its notifications (the note, the plan list,
 * decision reasons, the result's name and version, an upload failure). */
function readerOutputsFor(nodeId: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(nodeId === "get-action-type" ? { execution_note: "Build the release checklist" } : {}),
    ...(PLAN_WRITERS.has(nodeId) && input.repair_outcome !== "reassess"
      ? { planned_changes: PLANNED_CHANGES }
      : {}),
    ...(DECISIONS.has(nodeId) ? { decision_summary: "Decided on the evidence at hand" } : {}),
    ...(nodeId === "ask-upload"
      ? { workflow_name: "Release checklist", workflow_version: "1.0.0" }
      : {}),
    ...(nodeId === "save-workflow-to-target" && input.upload_success === "no"
      ? { failure_summary: "The server refused the upload" }
      : {}),
  };
}

function withOutputs(
  workflow: WorkflowGraph,
  nodeId: string,
  item: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...progressOutputsFor(workflow, nodeId, item),
    ...readerOutputsFor(nodeId, item),
    ...item,
  };
}

function addProgressOutputs(workflow: WorkflowGraph, nodeId: string, input: MockInput): MockInput {
  if (Array.isArray(input)) {
    return input.map((item) => withOutputs(workflow, nodeId, item));
  }
  if (typeof input === "function") {
    return (context: MockInputContext) => withOutputs(workflow, nodeId, input(context));
  }
  return withOutputs(workflow, nodeId, input);
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
  options: Pick<TestScenario, "teleportAfter"> & { contextContains?: Record<string, unknown> } = {},
): TestScenario {
  const { contextContains, ...rest } = options;
  return {
    name,
    mockInputs,
    ...rest,
    expect: { status: "completed", reaches, avoids, maxSteps: 120, contextContains },
  };
}

/** A create run at the simple level: requirements go straight to the build and the light review. */
function simpleInputs(name: string): Record<string, MockInput> {
  return {
    ...createInputs(name),
    "gather-workflow-requirements": { complexity_tier: "simple" },
    "review-workflow-minimum": { light_repair_pending: "", light_review_outcome: "pass" },
    "fix-light-review-findings": { repair_outcome: "changed", light_repair_pending: "yes" },
  };
}

/** An edit run at the simple level: requirements go straight to the change and the light review. */
function simpleEditInputs(name: string): Record<string, MockInput> {
  return {
    ...editInputs(name),
    "gather-edit-requirements": { recorded_tier: "simple", complexity_tier: "simple" },
    "review-workflow-minimum": { light_repair_pending: "", light_review_outcome: "pass" },
    "fix-light-review-findings": { repair_outcome: "changed", light_repair_pending: "yes" },
  };
}

/** The planning responsibilities the simple level skips on edit. */
const EDIT_PLAN_PATH = [
  "ask-full-antipattern-audit",
  "audit-complete-workflow",
  "create-edit-plan",
  "present-edit-plan",
];

/** A person's explicit request for a simpler process, as the lowering gates record it. */
const LOWER_TO_SIMPLE = {
  lowering_request: "Please keep this simple, just the steps in order",
  complexity_tier: "simple",
  escalation_reason: "",
};

/** The design responsibilities the simple level skips on create. */
const DESIGN_PATH = ["design-workflow-structure", "review-workflow-design", "approve-structure"];

function routeVisits(result: ScenarioResult): string[] {
  return result.visitedNodes.filter(
    (node, index, visits) => index === 0 || node !== visits[index - 1],
  );
}

const scenarios: TestScenario[] = [
  scenario(
    "simple create, interactive: build, light review and final review without design",
    simpleInputs("simple-interactive"),
    [
      "gather-workflow-requirements",
      "create-workflow-json",
      "review-workflow-minimum",
      "user-final-review",
      "end",
    ],
    [...DESIGN_PATH, "review-workflow-quality"],
    { contextContains: { complexity_tier: "simple" } },
  ),
  scenario(
    "simple create, autonomous: the light review leads to the final report",
    autonomous(simpleInputs("simple-autonomous")),
    ["create-workflow-json", "review-workflow-minimum", "report-final-result", "end"],
    [...DESIGN_PATH, "user-final-review", "review-workflow-quality"],
    { contextContains: { complexity_tier: "simple" } },
  ),
  scenario(
    "complex create runs structure design, design review and approval",
    {
      ...createInputs("complex-create"),
      "gather-workflow-requirements": { complexity_tier: "complex" },
    },
    [...DESIGN_PATH, "create-workflow-json", "review-workflow-quality", "end"],
    ["review-workflow-minimum"],
    { contextContains: { complexity_tier: "complex" } },
  ),
  scenario(
    "a simple run whose light review needs more is raised into design without new requirements",
    {
      ...simpleInputs("simple-escalation"),
      "review-workflow-minimum": {
        light_repair_pending: "",
        light_review_outcome: "escalate",
        complexity_tier: "standard",
        escalation_reason:
          "The check must be redone until it passes, which is a review-and-redo loop",
      },
    },
    [
      "review-workflow-minimum",
      "route-after-level-raise",
      ...DESIGN_PATH,
      "review-workflow-quality",
      "end",
    ],
    ["fix-light-review-findings"],
    {
      contextContains: {
        complexity_tier: "standard",
        escalation_reason:
          "The check must be redone until it passes, which is a review-and-redo loop",
      },
    },
  ),
  scenario(
    "a simple repair that shows the flow needs more raises the level from the repair",
    {
      ...simpleInputs("simple-repair-escalation"),
      "review-workflow-minimum": [
        { light_repair_pending: "", light_review_outcome: "repair" },
        { light_repair_pending: "", light_review_outcome: "repair" },
      ],
      "fix-light-review-findings": [
        { repair_outcome: "changed", light_repair_pending: "yes" },
        {
          light_repair_pending: "yes",
          repair_outcome: "escalate",
          complexity_tier: "complex",
          escalation_reason: "The flow has to call a sub-process",
        },
      ],
    },
    ["fix-light-review-findings", "design-workflow-structure", "review-workflow-quality", "end"],
    [],
    { contextContains: { complexity_tier: "complex" } },
  ),
  scenario(
    "a standard workflow the quality review finds needs the complex level is designed again",
    {
      ...createInputs("standard-escalation"),
      "review-workflow-quality": [
        {
          quality_review_outcome: "escalate",
          complexity_tier: "complex",
          escalation_reason: "Two review loops now interact",
        },
        { quality_review_outcome: "pass" },
      ],
    },
    ["review-workflow-quality", "route-after-level-raise", "design-workflow-structure", "end"],
    ["review-workflow-minimum"],
    { contextContains: { complexity_tier: "complex" } },
  ),
  scenario(
    "a rejected simple result is revised and rebuilt without design",
    {
      ...simpleInputs("simple-revision"),
      "user-final-review": [
        { work_approved: "no", final_feedback: "Add a step that tells the teammate who to ask" },
        { work_approved: "yes" },
      ],
    },
    ["revise-create-requirements", "create-workflow-json", "review-workflow-minimum", "end"],
    [...DESIGN_PATH, "review-workflow-quality"],
    { contextContains: { complexity_tier: "simple" } },
  ),
  scenario(
    "a process revision during a simple create rebuilds from the corrected requirements without design",
    { ...simpleInputs("simple-process-revision"), "teleport-revise-process": {} },
    [
      "create-workflow-json",
      "teleport-revise-process",
      "route-action-after-reassessment",
      "review-workflow-minimum",
      "end",
    ],
    [...DESIGN_PATH, "review-workflow-quality"],
    {
      teleportAfter: { afterNode: "create-workflow-json", teleportTo: "teleport-revise-process" },
      contextContains: { complexity_tier: "simple" },
    },
  ),
  scenario(
    "simple edit: the change goes straight to the light review without audit, plan or approval",
    simpleEditInputs("simple-edit"),
    [
      "gather-edit-requirements",
      "apply-workflow-changes",
      "review-workflow-minimum",
      "user-final-review",
      "end",
    ],
    [...EDIT_PLAN_PATH, "review-workflow-design", "review-workflow-quality"],
    { contextContains: { complexity_tier: "simple" } },
  ),
  scenario(
    "complex edit runs the full antipattern audit without asking",
    {
      ...editInputs("complex-edit"),
      "gather-edit-requirements": { recorded_tier: "complex", complexity_tier: "complex" },
    },
    ["audit-complete-workflow", "create-edit-plan", "review-workflow-quality", "end"],
    ["ask-full-antipattern-audit", "review-workflow-minimum"],
    { contextContains: { complexity_tier: "complex" } },
  ),
  scenario(
    "a rejected simple edit is revised and applied again without an edit plan",
    {
      ...simpleEditInputs("simple-edit-revision"),
      "user-final-review": [
        { work_approved: "no", final_feedback: "Also remind the teammate to book the laptop" },
        { work_approved: "yes" },
      ],
    },
    ["revise-edit-requirements", "apply-workflow-changes", "review-workflow-minimum", "end"],
    [...EDIT_PLAN_PATH, "review-workflow-quality"],
    { contextContains: { complexity_tier: "simple" } },
  ),
  scenario(
    "a simple edit the light review finds needs more is raised into the edit plan",
    {
      ...simpleEditInputs("simple-edit-escalation"),
      "review-workflow-minimum": {
        light_repair_pending: "",
        light_review_outcome: "escalate",
        complexity_tier: "standard",
        escalation_reason: "The change adds a review-and-redo loop",
      },
    },
    [
      "review-workflow-minimum",
      "route-after-level-raise",
      "ask-full-antipattern-audit",
      "create-edit-plan",
      "review-workflow-design",
      "present-edit-plan",
      "review-workflow-quality",
      "end",
    ],
    ["audit-complete-workflow", "fix-light-review-findings"],
    { contextContains: { complexity_tier: "standard" } },
  ),
  scenario(
    "an autonomous simple edit raised to standard decides the audit itself, without the question",
    {
      ...autonomous(simpleEditInputs("simple-edit-escalation-autonomous")),
      "review-workflow-minimum": {
        light_repair_pending: "",
        light_review_outcome: "escalate",
        complexity_tier: "standard",
        escalation_reason: "The change adds a review-and-redo loop",
      },
    },
    [
      "route-after-level-raise",
      "ask-full-antipattern-audit",
      "notify-audit-skipped",
      "create-edit-plan",
      "notify-edit-started",
      "end",
    ],
    ["notify-audit-question", "present-edit-plan"],
    { contextContains: { complexity_tier: "standard" } },
  ),
  scenario(
    "a simple edit raised to complex runs the full antipattern audit before the edit plan",
    {
      ...simpleEditInputs("simple-edit-raised-complex"),
      "review-workflow-minimum": [{ light_repair_pending: "", light_review_outcome: "repair" }],
      "fix-light-review-findings": {
        light_repair_pending: "yes",
        repair_outcome: "escalate",
        complexity_tier: "complex",
        escalation_reason: "The change needs a sub-process and a lock",
      },
    },
    [
      "fix-light-review-findings",
      "route-after-level-raise",
      "audit-complete-workflow",
      "create-edit-plan",
      "review-workflow-quality",
      "end",
    ],
    ["ask-full-antipattern-audit"],
    { contextContains: { complexity_tier: "complex" } },
  ),
  scenario(
    "a process revision during a simple edit applies the corrected requirements without a plan",
    { ...simpleEditInputs("simple-edit-process-revision"), "teleport-revise-process": {} },
    [
      "teleport-revise-process",
      "route-action-after-reassessment",
      "review-workflow-minimum",
      "end",
    ],
    [...EDIT_PLAN_PATH, "review-workflow-quality"],
    {
      teleportAfter: { afterNode: "apply-workflow-changes", teleportTo: "teleport-revise-process" },
      contextContains: { complexity_tier: "simple" },
    },
  ),
  scenario(
    "a person who asks for a simpler process at structure approval gets the simple build",
    {
      ...createInputs("lowered-at-approval"),
      "gather-workflow-requirements": { complexity_tier: "complex" },
      "approve-structure": { structure_approved: "yes", ...LOWER_TO_SIMPLE },
      "review-workflow-minimum": { light_repair_pending: "", light_review_outcome: "pass" },
    },
    ["approve-structure", "create-workflow-json", "review-workflow-minimum", "end"],
    ["review-workflow-quality", "refine-structure"],
    { contextContains: { complexity_tier: "simple", escalation_reason: "" } },
  ),
  scenario(
    "a person who asks for a simpler process at plan approval gets the simple change",
    {
      ...editInputs("lowered-at-plan"),
      "present-edit-plan": {
        plan_approval: "no",
        user_feedback: "This is too much for a small change",
        ...LOWER_TO_SIMPLE,
      },
      "review-workflow-minimum": { light_repair_pending: "", light_review_outcome: "pass" },
    },
    ["present-edit-plan", "apply-workflow-changes", "review-workflow-minimum", "end"],
    ["revise-edit-plan", "review-workflow-quality"],
    { contextContains: { complexity_tier: "simple" } },
  ),
  scenario(
    "a person who asks for a simpler process at the final review gets a simple revision",
    {
      ...editInputs("lowered-at-final-review"),
      "user-final-review": [
        { work_approved: "no", final_feedback: "Drop the extra checks", ...LOWER_TO_SIMPLE },
        { work_approved: "yes" },
      ],
      "review-workflow-minimum": { light_repair_pending: "", light_review_outcome: "pass" },
    },
    ["revise-edit-requirements", "review-workflow-minimum", "end"],
    [],
    { contextContains: { complexity_tier: "simple" } },
  ),
  scenario(
    "a light-review finding the repair cannot reproduce twice ends as an open point, not a loop",
    {
      ...simpleInputs("simple-disputed-finding"),
      "review-workflow-minimum": [
        { light_repair_pending: "", light_review_outcome: "repair" },
        { light_repair_pending: "", light_review_outcome: "repair" },
        { light_repair_pending: "", light_review_outcome: "pass" },
      ],
      "fix-light-review-findings": [
        {
          light_repair_pending: "yes",
          repair_outcome: "not_reproduced",
          not_reproduced_reason: "Every route from start reaches end in the schema output",
        },
        {
          light_repair_pending: "yes",
          repair_outcome: "not_reproduced",
          not_reproduced_reason: "The restated steps also reach end",
        },
      ],
    },
    ["fix-light-review-findings", "review-workflow-minimum", "user-final-review", "end"],
    ["route-after-level-raise", ...DESIGN_PATH],
    { contextContains: { complexity_tier: "simple", light_repair_pending: "" } },
  ),
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
    ["fix-create-design", "review-workflow-design", "create-workflow-json", "end"],
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
    ["review-workflow-quality", "reassess-design-contract", "create-edit-plan", "end"],
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
    ["fix-quality-issues", "reassess-design-contract", "end"],
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
    ["handle-upload-error", "save-workflow-to-target", "end"],
  ),
  scenario(
    "upload failure can skip",
    {
      ...createInputs("upload-skip"),
      "ask-upload": { upload_confirmed: true, upload_method: "standard" },
      "save-workflow-to-target": { upload_success: "no", upload_error: "Unavailable" },
      "handle-upload-error": { error_action: "skip" },
    },
    ["handle-upload-error", "route-local-sync", "end"],
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
    "autonomous edit skips the audit and saves the upload, announcing each decision after it",
    {
      ...autonomous(editInputs("autonomous-edit-save")),
      "ask-upload": { upload_confirmed: true, upload_method: "standard" },
    },
    [
      "ask-full-antipattern-audit",
      "notify-audit-skipped",
      "create-edit-plan",
      "ask-upload",
      "notify-upload-saving",
      "save-workflow-to-target",
      "end",
    ],
    ["notify-audit-question", "notify-upload-question", "audit-complete-workflow"],
  ),
  scenario(
    "autonomous upload failure is decided without asking: a retry, then a skip",
    {
      ...autonomous(createInputs("autonomous-upload-error")),
      "ask-upload": { upload_confirmed: true, upload_method: "standard" },
      "save-workflow-to-target": [
        { upload_success: "no", upload_error: "Service unavailable" },
        { upload_success: "no", upload_error: "Service unavailable" },
      ],
      "handle-upload-error": [{ error_action: "retry" }, { error_action: "skip" }],
    },
    [
      "handle-upload-error",
      "notify-upload-retrying",
      "save-workflow-to-target",
      "notify-upload-skipped",
      "route-local-sync",
      "end",
    ],
    ["notify-upload-error"],
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

  test("keeps shared gates and routes each local answer on its owning directive", () => {
    expect(workflow.metadata.version).toBe("6.19.0");
    expect(
      workflow.nodes.filter((node) => node.type === "condition").map((node) => node.id),
    ).toEqual([
      "route-action-type",
      "route-final-feedback-action",
      "route-local-sync",
      "route-operating-mode-structure",
      "route-operating-mode-plan",
      "route-operating-mode-final",
      "route-action-after-design-review",
      "route-action-design-repair",
      "route-action-after-reassessment",
      "route-after-level-raise",
    ]);

    const eq = (path: string, right: string | boolean, output: string) => ({
      when: { operator: "eq", left: { contextPath: path }, right },
      output,
    });
    // An autonomous decision routes to its own "decided for you" message from the deciding node,
    // so the message is sent after the decision and before the route acts on it.
    const autonomous = eq("operating_mode", "autonomous", "autonomous").when;
    const inAutonomous = (condition: { when: unknown; output: string }, output: string) => ({
      when: { operator: "and", conditions: [autonomous, condition.when] },
      output,
    });
    const retryCase = {
      when: {
        operator: "or",
        conditions: ["retry", "copy_new", "admin_override"].map((right) => ({
          operator: "eq",
          left: { contextPath: "handle-upload-error.error_action" },
          right,
        })),
      },
      output: "retry",
    };
    const routes: Array<[string, unknown[], Record<string, string>]> = [
      [
        "gather-workflow-requirements",
        [eq("gather-workflow-requirements.complexity_tier", "simple", "simple")],
        { success: "design-workflow-structure", simple: "start-create-build" },
      ],
      [
        "create-workflow-json",
        [eq("complexity_tier", "simple", "simple")],
        { success: "review-workflow-quality", simple: "review-workflow-minimum" },
      ],
      [
        "revise-create-requirements",
        [eq("complexity_tier", "simple", "simple")],
        { success: "design-workflow-structure", simple: "start-create-build" },
      ],
      [
        "review-workflow-minimum",
        [
          eq("review-workflow-minimum.light_review_outcome", "pass", "pass"),
          eq("review-workflow-minimum.light_review_outcome", "escalate", "escalate"),
        ],
        {
          success: "fix-light-review-findings",
          pass: "route-operating-mode-final",
          escalate: "route-after-level-raise",
        },
      ],
      [
        "fix-light-review-findings",
        [eq("fix-light-review-findings.repair_outcome", "escalate", "escalate")],
        { success: "review-workflow-minimum", escalate: "route-after-level-raise" },
      ],
      [
        "gather-edit-requirements",
        [
          eq("gather-edit-requirements.complexity_tier", "simple", "simple"),
          eq("gather-edit-requirements.complexity_tier", "complex", "complex"),
          { when: autonomous, output: "autonomous" },
        ],
        {
          success: "notify-audit-question",
          simple: "start-edit-build",
          complex: "audit-complete-workflow",
          autonomous: "ask-full-antipattern-audit",
        },
      ],
      [
        "apply-workflow-changes",
        [eq("complexity_tier", "simple", "simple")],
        { success: "review-workflow-quality", simple: "review-workflow-minimum" },
      ],
      [
        "revise-edit-requirements",
        [eq("complexity_tier", "simple", "simple")],
        { success: "create-edit-plan", simple: "start-edit-build" },
      ],
      [
        "ask-full-antipattern-audit",
        [
          inAutonomous(
            eq("ask-full-antipattern-audit.full_antipattern_audit", "yes", ""),
            "autonomous-audit",
          ),
          { when: autonomous, output: "autonomous-skip" },
          eq("ask-full-antipattern-audit.full_antipattern_audit", "yes", "audit"),
        ],
        {
          success: "create-edit-plan",
          audit: "audit-complete-workflow",
          "autonomous-audit": "notify-audit-chosen",
          "autonomous-skip": "notify-audit-skipped",
        },
      ],
      [
        "review-workflow-design",
        [
          eq("review-workflow-design.design_review_outcome", "pass", "pass"),
          eq("review-workflow-design.design_review_outcome", "replan", "replan"),
        ],
        {
          success: "route-action-design-repair",
          pass: "route-action-after-design-review",
          replan: "reassess-design-contract",
        },
      ],
      [
        "fix-edit-plan",
        [eq("fix-edit-plan.repair_outcome", "changed", "changed")],
        { success: "reassess-design-contract", changed: "review-workflow-design" },
      ],
      [
        "fix-create-design",
        [eq("fix-create-design.repair_outcome", "changed", "changed")],
        { success: "reassess-design-contract", changed: "review-workflow-design" },
      ],
      [
        "approve-structure",
        [
          eq("complexity_tier", "simple", "simple"),
          eq("approve-structure.structure_approved", "yes", "approved"),
        ],
        {
          success: "refine-structure",
          simple: "start-create-build",
          approved: "create-workflow-json",
        },
      ],
      [
        "present-edit-plan",
        [
          eq("complexity_tier", "simple", "simple"),
          eq("present-edit-plan.plan_approval", "yes", "approved"),
        ],
        {
          success: "revise-edit-plan",
          simple: "start-edit-build",
          approved: "apply-workflow-changes",
        },
      ],
      [
        "review-workflow-quality",
        [
          eq("review-workflow-quality.quality_review_outcome", "pass", "pass"),
          eq("review-workflow-quality.quality_review_outcome", "replan", "replan"),
          eq("review-workflow-quality.quality_review_outcome", "escalate", "escalate"),
        ],
        {
          success: "fix-quality-issues",
          pass: "route-operating-mode-final",
          replan: "reassess-design-contract",
          escalate: "route-after-level-raise",
        },
      ],
      [
        "fix-quality-issues",
        [eq("fix-quality-issues.repair_outcome", "changed", "changed")],
        { success: "reassess-design-contract", changed: "review-workflow-quality" },
      ],
      [
        "user-final-review",
        [eq("user-final-review.work_approved", "yes", "approved")],
        { success: "route-final-feedback-action", approved: "notify-upload-question" },
      ],
      [
        "ask-upload",
        [
          inAutonomous(eq("ask-upload.upload_confirmed", true, ""), "autonomous-save"),
          { when: autonomous, output: "autonomous-keep" },
          eq("ask-upload.upload_confirmed", true, "confirmed"),
        ],
        {
          success: "route-local-sync",
          confirmed: "save-workflow-to-target",
          "autonomous-save": "notify-upload-saving",
          "autonomous-keep": "notify-upload-not-saving",
        },
      ],
      [
        "save-workflow-to-target",
        [
          eq("save-workflow-to-target.upload_success", "yes", "uploaded"),
          { when: autonomous, output: "autonomous" },
        ],
        {
          success: "notify-upload-error",
          uploaded: "route-local-sync",
          autonomous: "handle-upload-error",
        },
      ],
      [
        "handle-upload-error",
        [
          inAutonomous(retryCase, "autonomous-retry"),
          inAutonomous(eq("handle-upload-error.error_action", "skip", ""), "autonomous-skip"),
          retryCase,
          eq("handle-upload-error.error_action", "skip", "skip"),
        ],
        {
          success: "notify-cancelled",
          retry: "save-workflow-to-target",
          skip: "route-local-sync",
          "autonomous-retry": "notify-upload-retrying",
          "autonomous-skip": "notify-upload-skipped",
        },
      ],
    ];
    for (const [id, cases, connections] of routes) {
      expect(workflow.nodes.find((node) => node.id === id)).toMatchObject({
        type: "agent-directive",
        cases,
        connections,
      });
    }
    // A raise continues by action and level: a new workflow is designed again, an edit raised to
    // complex is audited in full, and an edit raised to standard gets the audit question.
    expect(workflow.nodes.find((node) => node.id === "route-after-level-raise")).toMatchObject({
      type: "condition",
      cases: [
        eq("get-action-type.action_type", "create", "true"),
        eq("complexity_tier", "complex", "audit"),
        { when: autonomous, output: "autonomous" },
      ],
      connections: {
        true: "design-workflow-structure",
        audit: "audit-complete-workflow",
        autonomous: "ask-full-antipattern-audit",
        default: "notify-audit-question",
      },
    });
    // The shared reassessment router: a revised simple create builds again, any other create is
    // designed again, and an edit is planned again.
    expect(
      workflow.nodes.find((node) => node.id === "route-action-after-reassessment"),
    ).toMatchObject({
      type: "condition",
      cases: [
        {
          when: {
            operator: "and",
            conditions: [
              eq("get-action-type.action_type", "create", "").when,
              eq("complexity_tier", "simple", "").when,
            ],
          },
          output: "simple",
        },
        eq("complexity_tier", "simple", "simple-edit"),
        eq("get-action-type.action_type", "create", "true"),
      ],
      connections: {
        true: "design-workflow-structure",
        simple: "start-create-build",
        "simple-edit": "start-edit-build",
        default: "create-edit-plan",
      },
    });
  });

  test("all create edit audit publication and recovery routes are covered", async () => {
    const results: ScenarioResult[] = [];
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
    const directTransitions: Record<string, [string, string]> = {
      "repairable create design returns with changed knowledge": [
        "fix-create-design",
        "review-workflow-design",
      ],
      "scanner validation defect replans without artifact repair": [
        "review-workflow-quality",
        "reassess-design-contract",
      ],
      "same-root guard repair exits to reassessment instead of nesting validators": [
        "fix-quality-issues",
        "reassess-design-contract",
      ],
      "upload failure retries with an explicitly chosen method": [
        "handle-upload-error",
        "save-workflow-to-target",
      ],
      "upload failure can skip": ["handle-upload-error", "route-local-sync"],
    };
    for (const result of results) {
      const transition = directTransitions[result.scenario];
      if (!transition) continue;
      const visits = routeVisits(result);
      expect(
        visits.some((node, index) => node === transition[0] && visits[index + 1] === transition[1]),
      ).toBe(true);
    }
    const revised = routeVisits(
      results.find(
        (result) =>
          result.scenario ===
          "a process revision during a simple create rebuilds from the corrected requirements without design",
      )!,
    );
    expect(revised.slice(revised.indexOf("teleport-revise-process"))).toEqual(
      expect.arrayContaining(["create-workflow-json", "review-workflow-minimum"]),
    );

    const after = (name: string, node: string) => {
      const visits = routeVisits(results.find((result) => result.scenario === name)!);
      return visits.slice(visits.lastIndexOf(node) + 1);
    };
    // After a lowering, the run does not take the routes the higher level adds.
    expect(
      after(
        "a person who asks for a simpler process at the final review gets a simple revision",
        "revise-edit-requirements",
      ),
    ).not.toContain("create-edit-plan");
    expect(
      after(
        "a person who asks for a simpler process at the final review gets a simple revision",
        "revise-edit-requirements",
      ),
    ).not.toContain("review-workflow-quality");
    expect(
      after(
        "a process revision during a simple edit applies the corrected requirements without a plan",
        "teleport-revise-process",
      ),
    ).toEqual(expect.arrayContaining(["apply-workflow-changes", "review-workflow-minimum"]));
    // An edit raise continues from the current edit requirements: their owner runs once.
    expect(
      routeVisits(
        results.find(
          (result) =>
            result.scenario ===
            "a simple edit the light review finds needs more is raised into the edit plan",
        )!,
      ).filter((node) => node === "gather-edit-requirements"),
    ).toHaveLength(1);
    // Lowering is accepted only where the person is present: the interactive gates and the
    // requirements owners. No autonomous run visits a gate that lowers.
    const lowering = workflow.nodes
      .filter(
        (node) =>
          (node as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema
            ?.properties?.lowering_request !== undefined,
      )
      .map((node) => node.id)
      .sort();
    expect(lowering).toEqual([
      "approve-structure",
      "gather-edit-requirements",
      "present-edit-plan",
      "user-final-review",
    ]);
    const autonomousRuns = scenarios
      .map((item, index) => ({ item, result: results[index] }))
      .filter(
        ({ item }) =>
          (item.mockInputs["get-action-type"] as Record<string, unknown>).operating_mode ===
          "autonomous",
      );
    expect(autonomousRuns.length).toBeGreaterThan(0);
    for (const { result } of autonomousRuns) {
      for (const gate of ["approve-structure", "present-edit-plan", "user-final-review"]) {
        expect({ scenario: result.scenario, visits: routeVisits(result).includes(gate) }).toEqual({
          scenario: result.scenario,
          visits: false,
        });
      }
    }

    // A disputed finding goes to repair twice and then ends in the light review's pass.
    const disputed = routeVisits(
      results.find(
        (result) =>
          result.scenario ===
          "a light-review finding the repair cannot reproduce twice ends as an open point, not a loop",
      )!,
    );
    expect(disputed.filter((node) => node === "fix-light-review-findings")).toHaveLength(2);
    expect(disputed.filter((node) => node === "review-workflow-minimum")).toHaveLength(3);

    // A raise continues from the current requirements: the requirements owner runs once.
    for (const name of [
      "a simple run whose light review needs more is raised into design without new requirements",
      "a simple repair that shows the flow needs more raises the level from the repair",
    ]) {
      const visits = routeVisits(results.find((result) => result.scenario === name)!);
      expect(visits.filter((node) => node === "gather-workflow-requirements")).toHaveLength(1);
    }

    // The process view stays truthful: on the simple path the design block reads skipped and the
    // light review is review work; once raised, the design block is visited.
    const statusesOf = (name: string) => {
      const result = results.find((candidate) => candidate.scenario === name)!;
      const visits: ExecutionVisit[] = routeVisits(result).map((nodeId, seq) => ({
        seq,
        nodeId,
        exitKey: "done",
        changes: {},
      }));
      return blockStatuses(
        deriveProcess(workflow)!,
        new Map(workflow.nodes.map((node) => [node.id, node.type])),
        { status: "completed", currentNodeId: "end", waitingForInputNodeId: null },
        visits,
      );
    };
    const simple = statusesOf(
      "simple create, interactive: build, light review and final review without design",
    );
    expect(simple.get("design")?.status).toBe("skipped");
    const simpleEdit = statusesOf(
      "simple edit: the change goes straight to the light review without audit, plan or approval",
    );
    expect(simpleEdit.get("design")?.status).toBe("skipped");
    expect(simpleEdit.get("build")?.status).toBe("done");
    expect(simpleEdit.get("review")?.status).toBe("done");
    expect(simple.get("review")?.status).toBe("done");
    const raised = statusesOf(
      "a simple run whose light review needs more is raised into design without new requirements",
    );
    expect(raised.get("design")?.status).not.toBe("skipped");
    expect(raised.get("design")?.visits).toBeGreaterThan(0);

    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
  });
});
