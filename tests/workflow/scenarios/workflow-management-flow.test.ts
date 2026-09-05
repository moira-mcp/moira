/** Behavioral scenarios for workflow-management-flow v6. */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  GraphValidator,
  MaterializeHandler,
  detectCycles,
  projectExecutionProgress,
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

describe("workflow-management-flow v6", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("keeps canonical authoring doctrine themed, materialized, and explicitly consumed", async () => {
    const result = await new GraphValidator().validateUnified(workflow);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    expect(workflow.metadata.version).toBe("6.6.0");
    expect(workflow.metadata.description).toContain("one complete Moira workflow");
    expect(workflow.metadata.description).toContain("nine canonical thematic authoring references");
    // One node fewer than upstream 6.1.0: the analysis responsibility moved into the planning node.
    expect(workflow.nodes).toHaveLength(57);
    expect(workflow.nodes.some((node) => node.type === "expression")).toBe(false);
    expect(detectCycles(workflow).length).toBeGreaterThan(0);

    expect(Object.keys(workflow.variableRegistry ?? {}).sort()).toEqual(
      [
        "additional_edit_scope",
        "action_type",
        "local_workflow_path",
        "operating_mode",
        "progress_build_outcome",
        "progress_delivery_outcome",
        "progress_design_outcome",
        "progress_requirements_outcome",
        "progress_review_outcome",
        "progress_source_outcome",
        "workflow_artifact_path",
        "workflow_reference_antipatterns",
        "workflow_reference_artifacts",
        "workflow_reference_authority",
        "workflow_reference_design",
        "workflow_reference_engine",
        "workflow_reference_patterns",
        "workflow_reference_progress",
        "workflow_reference_review_repair",
        "workflow_reference_validation",
        "workspace_path",
        "workspace_process_id_file",
      ].sort(),
    );
    expect(workflow.variableRegistry?.operating_mode?.enum).toEqual(["autonomous", "interactive"]);
    const references = Object.fromEntries(
      Object.entries(workflow.variableRegistry ?? {})
        .filter(([name]) => name.startsWith("workflow_reference_"))
        .map(([name, declaration]) => [name, String(declaration.default)]),
    );
    expect(Object.keys(references)).toHaveLength(9);
    const expectedReferenceSections: Record<string, string[]> = {
      workflow_reference_engine: ["## Engine contract"],
      workflow_reference_design: [
        "## Design method",
        "### Design before build",
        "### Revising the process while the work runs",
        "### Rules stated as outcomes, each carrying its reason",
      ],
      workflow_reference_artifacts: [
        "## Durable artifact and context rules",
        "### Minimal consumed process record",
        "### Workspace owner",
        "### Source provenance and semantic reconciliation",
        "### The reference the run writes itself",
      ],
      workflow_reference_review_repair: [
        "## Review and repair",
        "### File-backed review without data roundtrip",
        "### Cause before repair",
        "### Replan without requirement erosion",
        "### Bounded class-wide repair",
        "### Routing a confirmed repair by its stale-evidence cone",
        "## Reviewer contract",
      ],
      workflow_reference_validation: [
        "## Validation and cost ordering",
        "### Discriminating evidence and matching modality",
        "### Validation as a requested result",
        "### Current structural projection before topology judgment",
      ],
      workflow_reference_authority: [
        "## Authority and side effects",
        "### Operating mode (autonomous vs interactive)",
      ],
      workflow_reference_patterns: [
        "## Patterns",
        "### Straight-line default",
        "### Minimal workflow editing",
      ],
      workflow_reference_antipatterns: [
        "## Antipattern catalog",
        "### A reference with no address",
        "### Materialized doctrine duplicated in directives",
        "### Plan as a mechanical implementation script",
        "### Order of telling taken for order of work",
        "### Redundancy required in every plan item",
        "### Directive as a drill order",
      ],
      workflow_reference_progress: [
        "## Content-rich execution progress",
        "progressActiveContent",
        "shallowly replaces only supplied",
      ],
    };
    for (const [name, sections] of Object.entries(expectedReferenceSections)) {
      for (const section of sections) expect(references[name]).toContain(section);
    }
    const allReferences = Object.values(references).join("\n");
    expect(allReferences).not.toContain("### Context-blind forced reread");
    expect(allReferences.toLowerCase()).toContain("materialization proves only that files were");
    expect(allReferences).toContain("each shared rule still has exactly one canonical owner");
    const scriptSection = references.workflow_reference_antipatterns.slice(
      references.workflow_reference_antipatterns.indexOf(
        "### Plan as a mechanical implementation script",
      ),
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

    const merged = nodes["create-edit-plan"];
    for (const carried of [
      "analysis first",
      "source-provenance.md",
      "{{additional_edit_scope}}",
      "must not record turn counts",
      "discriminating acceptance criteria",
    ]) {
      expect(merged.directive).toContain(carried);
    }
    expect(merged.completionCondition).toContain("complete analysis");
    expect(merged.completionCondition).toContain("outcome-oriented edit contract");
    expect(merged.completionCondition).toContain("without unused process diagnostics");

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
    const referencePaths = (id: string): string[] =>
      Array.from(
        nodes[id].directive.matchAll(/\{\{workspace_path\}\}\/reference\/([a-z-]+\.md)/g),
        (match: RegExpMatchArray) => match[1],
      );
    const consumerReferences: Record<string, string[]> = {
      "gather-workflow-requirements": ["authority.md", "progress.md"],
      "gather-edit-requirements": ["authority.md", "progress.md"],
      "design-workflow-structure": [
        "design.md",
        "validation.md",
        "patterns.md",
        "authority.md",
        "progress.md",
      ],
      "refine-structure": ["design.md", "authority.md", "progress.md"],
      "create-workflow-json": [
        "engine.md",
        "design.md",
        "artifacts.md",
        "validation.md",
        "authority.md",
        "patterns.md",
        "antipatterns.md",
        "progress.md",
      ],
      "prepare-edit-workflow": ["engine.md", "artifacts.md"],
      "audit-complete-workflow": [
        "engine.md",
        "design.md",
        "artifacts.md",
        "review-repair.md",
        "validation.md",
        "authority.md",
        "patterns.md",
        "antipatterns.md",
        "progress.md",
      ],
      "create-edit-plan": [
        "engine.md",
        "design.md",
        "artifacts.md",
        "validation.md",
        "authority.md",
        "patterns.md",
        "antipatterns.md",
        "progress.md",
      ],
      "revise-edit-plan": [
        "design.md",
        "review-repair.md",
        "engine.md",
        "artifacts.md",
        "validation.md",
        "authority.md",
        "patterns.md",
        "antipatterns.md",
        "progress.md",
      ],
      "apply-workflow-changes": [
        "engine.md",
        "design.md",
        "artifacts.md",
        "review-repair.md",
        "validation.md",
        "authority.md",
        "patterns.md",
        "antipatterns.md",
        "progress.md",
      ],
      "review-workflow-design": [
        "design.md",
        "validation.md",
        "authority.md",
        "review-repair.md",
        "engine.md",
        "progress.md",
      ],
      "fix-create-design": ["design.md", "validation.md", "review-repair.md"],
      "fix-edit-plan": ["design.md", "validation.md", "review-repair.md"],
      "review-workflow-quality": [
        "engine.md",
        "design.md",
        "artifacts.md",
        "review-repair.md",
        "validation.md",
        "authority.md",
        "patterns.md",
        "antipatterns.md",
        "progress.md",
      ],
      "fix-quality-issues": [
        "engine.md",
        "review-repair.md",
        "design.md",
        "artifacts.md",
        "validation.md",
        "authority.md",
        "patterns.md",
        "antipatterns.md",
        "progress.md",
      ],
      "reassess-design-contract": [
        "design.md",
        "validation.md",
        "authority.md",
        "review-repair.md",
        "progress.md",
      ],
    };
    for (const [id, expected] of Object.entries(consumerReferences)) {
      expect(referencePaths(id)).toEqual(expected);
      expect(nodes[id].directive).toMatch(
        /Before (deciding|designing|changing|mutation|preparing|auditing|analysis|revising|review|repair|reassessment)/,
      );
    }
    for (const id of [
      "get-action-type",
      "approve-structure",
      "present-edit-plan",
      "ask-full-antipattern-audit",
      "user-final-review",
      "report-final-result",
      "ask-upload",
      "save-workflow-to-target",
      "handle-upload-error",
      "sync-local-file",
      "revise-create-requirements",
      "revise-edit-requirements",
    ]) {
      expect(referencePaths(id)).toEqual([]);
    }
    expect(workflow.progress).toMatchObject({
      title: "Workflow Management Flow",
      nodes: [
        expect.objectContaining({ id: "source" }),
        expect.objectContaining({ id: "requirements" }),
        expect.objectContaining({ id: "design" }),
        expect.objectContaining({ id: "build" }),
        expect.objectContaining({ id: "review" }),
        expect.objectContaining({ id: "delivery" }),
      ],
    });
    expect(workflow.progress?.nodes.map((node) => node.id)).toEqual([
      "source",
      "requirements",
      "design",
      "build",
      "review",
      "delivery",
    ]);
    expect(workflow.progress?.nodes.map((node) => node.content?.outcome)).toEqual([
      "{{progress_source_outcome}}",
      "{{progress_requirements_outcome}}",
      "{{progress_design_outcome}}",
      "{{progress_build_outcome}}",
      "{{progress_review_outcome}}",
      "{{progress_delivery_outcome}}",
    ]);
    const visibleWaitingTypes = new Set([
      "agent-directive",
      "teleport",
      "lock",
      "materialize",
      "subgraph",
    ]);
    const visibleWaitingNodes = workflow.nodes.filter((node) => visibleWaitingTypes.has(node.type));
    expect(visibleWaitingNodes).toHaveLength(30);
    expect(visibleWaitingNodes.filter((node) => !node.progressNodeId)).toEqual([]);
    expect(visibleWaitingNodes.filter((node) => !node.progressActiveLabel)).toEqual([]);
    const stageOutcome = {
      source: "progress_source_outcome",
      requirements: "progress_requirements_outcome",
      design: "progress_design_outcome",
      build: "progress_build_outcome",
      review: "progress_review_outcome",
      delivery: "progress_delivery_outcome",
    } as const;
    const semanticWriters = visibleWaitingNodes.filter((node) =>
      node.inputSchema?.globalInputs?.some((name) => name.startsWith("progress_")),
    );
    for (const node of semanticWriters) {
      const expectedOutcome = stageOutcome[node.progressNodeId as keyof typeof stageOutcome];
      expect(node.inputSchema?.globalInputs).toContain(expectedOutcome);
      expect(node.inputSchema?.required).toContain(expectedOutcome);
    }
    expect(semanticWriters.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "get-action-type",
        "prepare-edit-workflow",
        "gather-workflow-requirements",
        "gather-edit-requirements",
        "design-workflow-structure",
        "create-edit-plan",
        "create-workflow-json",
        "apply-workflow-changes",
        "review-workflow-quality",
        "fix-quality-issues",
        "report-final-result",
        "user-final-review",
        "ask-upload",
        "save-workflow-to-target",
        "handle-upload-error",
        "sync-local-file",
      ]),
    );
    expect(nodes["revise-edit-requirements"].inputSchema.globalInputs).toEqual([
      "progress_requirements_outcome",
      "progress_design_outcome",
      "progress_build_outcome",
      "progress_review_outcome",
      "progress_delivery_outcome",
    ]);
    expect(nodes["fix-edit-plan"].inputSchema.globalInputs).toEqual([
      "progress_design_outcome",
      "progress_build_outcome",
      "progress_review_outcome",
      "progress_delivery_outcome",
    ]);
    expect(nodes["reassess-design-contract"].inputSchema.globalInputs).toEqual([
      "progress_requirements_outcome",
      "progress_design_outcome",
      "progress_build_outcome",
      "progress_review_outcome",
      "progress_delivery_outcome",
    ]);
    expect(nodes["fix-quality-issues"].inputSchema.globalInputs).toEqual([
      "progress_review_outcome",
      "progress_delivery_outcome",
    ]);
    expect(progressOutputsFor(workflow, "fix-edit-plan", { repair_outcome: "changed" })).toEqual({
      progress_design_outcome: "design: fix-edit-plan result accepted",
      progress_build_outcome: "Pending — invalidated by fix-edit-plan",
      progress_review_outcome: "Pending — invalidated by fix-edit-plan",
      progress_delivery_outcome: "Pending — invalidated by fix-edit-plan",
    });
    expect(progressOutputsFor(workflow, "ask-upload", { upload_confirmed: false })).toEqual({
      progress_delivery_outcome: "Server upload is not authorized; local result remains accepted",
    });
    expect(
      progressOutputsFor(workflow, "save-workflow-to-target", { upload_success: "no" }),
    ).toEqual({
      progress_delivery_outcome: "Authorized server upload failed; recovery decision required",
    });
    expect(progressOutputsFor(workflow, "sync-local-file", {})).toEqual({
      progress_delivery_outcome: "Accepted workflow synchronized to its repository target",
    });
    for (const [id, nextText] of [
      ["approve-structure", "refine and re-review"],
      ["present-edit-plan", "revise and re-review"],
      ["user-final-review", "revise requirements"],
      ["save-workflow-to-target", "upload failure"],
      ["handle-upload-error", "Retry an authorized upload"],
      ["fix-quality-issues", "Repeat independent quality review"],
    ] as const) {
      expect(nodes[id].progressActiveContent?.summary).toBeTruthy();
      expect(nodes[id].progressActiveContent?.next).toContain(nextText);
    }
    const projectionAt = (
      currentNodeId: string | null,
      status: "running" | "completed" = "running",
      waitingForInputNodeId: string | null = currentNodeId,
    ) =>
      projectExecutionProgress(workflow, {
        executionId: "wmf-progress",
        workflowId: workflow.id ?? "workflow-management-flow",
        userId: "scenario-user",
        currentNodeId,
        waitingForInputNodeId,
        status,
        revision: 4,
        createdAt: 1,
        updatedAt: 1,
        globalContext: {
          variables: {
            operating_mode: "autonomous",
            progress_source_outcome: "Source reconciled",
            progress_requirements_outcome: "Requirements accepted",
            progress_design_outcome: "Design reviewed",
            progress_build_outcome: "Workflow built",
            progress_review_outcome: "Independent review passed",
            progress_delivery_outcome: "Repository synchronization complete",
          },
          nodeStates: {},
          executionId: "wmf-progress",
          workflowId: workflow.id ?? "workflow-management-flow",
          userId: "scenario-user",
        },
      });
    expect(projectionAt("prepare-edit-workflow")?.activeNodeId).toBe("source");
    expect(projectionAt("sync-local-file")?.activeNodeId).toBe("delivery");
    expect(
      projectionAt(null, "completed", "sync-local-file")?.nodes.map((node) => node.state),
    ).toEqual(Array(6).fill("completed"));
    expect(
      projectionAt(null, "completed", "review-workflow-quality")?.nodes.map((node) => node.state),
    ).toEqual(["completed", "completed", "completed", "completed", "completed", "pending"]);
    expect(nodes["ask-full-antipattern-audit"].connections.success).toBe(
      "route-full-antipattern-audit",
    );
    expect(nodes["get-action-type"].connections.success).toBe("materialize-workspace-bootstrap");
    expect(nodes["materialize-workspace-bootstrap"]).toMatchObject({
      type: "materialize",
      basePath: "{{workspace_path}}",
      files: [
        { path: "process-id.txt", from: "workspace_process_id_file" },
        { path: "reference/engine.md", from: "workflow_reference_engine" },
        { path: "reference/design.md", from: "workflow_reference_design" },
        { path: "reference/artifacts.md", from: "workflow_reference_artifacts" },
        { path: "reference/review-repair.md", from: "workflow_reference_review_repair" },
        { path: "reference/validation.md", from: "workflow_reference_validation" },
        { path: "reference/authority.md", from: "workflow_reference_authority" },
        { path: "reference/patterns.md", from: "workflow_reference_patterns" },
        { path: "reference/antipatterns.md", from: "workflow_reference_antipatterns" },
        { path: "reference/progress.md", from: "workflow_reference_progress" },
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
    expect(nodes["audit-complete-workflow"].directive).toContain(
      "Autonomous mode includes confirmed findings",
    );
    expect(nodes["prepare-edit-workflow"].directive).toContain("autonomous mode decides");
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
