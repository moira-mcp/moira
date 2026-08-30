/** Observable scenarios for the cause-aware Robust Task v9. */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { GraphValidator, detectCycles, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import { runScenario, type MockInput, type TestScenario } from "../../helpers/scenario-runner.js";

function loadWorkflow(): WorkflowGraph {
  return structuredClone(findSystemCatalogEntry("robust-task", "public")!.graph) as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): any {
  const result = workflow.nodes.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing workflow node: ${id}`);
  return result;
}

const plan = (revision: number) => ({
  current_plan_file: `plans/${String(revision).padStart(3, "0")}/plan.md`,
  total_steps: 1,
});

const progressOutcome = {
  intake: "Durable task contract established in interactive mode",
  plan: "Current complete plan independently reviewed and approved",
  execution: "Current plan-qualified step completed with direct evidence",
  stepReview: "Current step attempt independently reviewed clean",
  finalReview: "Complete result independently reviewed clean",
  delivery: "Reviewed result delivered with no unresolved obligation",
};

const replan = (revision: number) => ({
  ...plan(revision),
  progress_plan_outcome: `Replacement plan revision ${revision} ready for independent review`,
  progress_execution_outcome: "Pending",
  progress_step_review_outcome: "Pending",
  progress_final_review_outcome: "Pending",
});

const planReview = (review_outcome: "pass" | "repair" | "replan") => ({
  review_outcome,
  progress_plan_outcome: `Current plan review outcome: ${review_outcome}`,
});

const stepEvidence = (planRevision: number, attempt: number) => ({
  evidence_file: `steps/1/plans/${String(planRevision).padStart(3, "0")}/attempts/${attempt}/evidence.md`,
});

const stepVerdict = (
  planRevision: number,
  attempt: number,
  review_outcome: "pass" | "repair" | "replan",
  repair_owner?: "result" | "evidence_projection",
) => ({
  verdict_file: `steps/1/plans/${String(planRevision).padStart(3, "0")}/attempts/${attempt}/verdict.md`,
  review_outcome,
  progress_step_review_outcome: `Current step review outcome: ${review_outcome}`,
  ...(repair_owner ? { repair_owner } : {}),
});

const finalReview = (
  revision: number,
  review_outcome: "pass" | "repair" | "replan",
  repair_owner?: "deliverable" | "evidence_projection",
) => ({
  review_file: `final/reviews/${String(revision).padStart(3, "0")}-review.md`,
  review_outcome,
  progress_final_review_outcome: `Current final review outcome: ${review_outcome}`,
  ...(repair_owner ? { repair_owner } : {}),
});

function ordinaryInputs(): Record<string, MockInput> {
  return {
    "initialize-workspace": {
      workspace_path: "./moira-ws/robust-task-example-20260821-2300/",
      operating_mode: "interactive",
      progress_intake_outcome: progressOutcome.intake,
    },
    "create-plan": { ...plan(1), progress_plan_outcome: "Initial complete plan ready for review" },
    "review-plan": planReview("pass"),
    "ask-plan-review-limit": {
      decision: "finish_incomplete",
      progress_plan_outcome: "Plan review bound ended with disclosed incomplete scope",
    },
    "fix-plan": { repair_outcome: "changed", ...replan(2) },
    "approve-plan": { decision: "yes", progress_plan_outcome: progressOutcome.plan },
    "revise-plan": replan(2),
    "execute-step": {
      ...stepEvidence(1, 1),
      progress_execution_outcome: progressOutcome.execution,
    },
    "review-step": stepVerdict(1, 1, "pass"),
    "repair-step": {
      repair_outcome: "changed",
      ...stepEvidence(1, 2),
      progress_step_review_outcome: "Current step finding repaired with changed evidence",
    },
    "ask-retry-decision": {
      decision: "finish_incomplete",
      decision_file: "steps/1/decisions/001.md",
      progress_step_review_outcome: "Retry bound ended with disclosed incomplete scope",
    },
    "replan-from-verdict": replan(2),
    "replan-from-decision": replan(2),
    "replan-from-plan-review": replan(2),
    "replan-from-plan-reassess": replan(2),
    "replan-from-step-reassess": replan(2),
    "replan-from-final-review": replan(2),
    "replan-from-final-reassess": replan(2),
    "teleport-replan": replan(2),
    "final-review": finalReview(1, "pass"),
    "ask-final-review-limit": {
      decision: "accept_incomplete",
      progress_final_review_outcome: "Final review bound accepted with disclosed incomplete scope",
    },
    "fix-final-review": {
      repair_outcome: "changed",
      progress_final_review_outcome: "Current final finding repaired",
    },
    "deliver-result": {
      delivery_file: "final/delivery.md",
      delivery_status: "complete",
      summary: "All active requirements are satisfied.",
      progress_delivery_outcome: progressOutcome.delivery,
    },
  };
}

function scenario(
  name: string,
  overrides: Record<string, MockInput>,
  reaches: string[],
  options: Pick<TestScenario, "initialVariables" | "teleportAfter"> = {},
): TestScenario {
  return {
    name,
    mockInputs: { ...ordinaryInputs(), ...overrides },
    expect: { status: "completed", reaches, maxSteps: 220 },
    ...options,
  };
}

const scenarios: TestScenario[] = [
  scenario(
    "autonomous run completes without the plan approval gate",
    {
      "initialize-workspace": {
        workspace_path: "./moira-ws/robust-task-example-20260821-2300/",
        operating_mode: "autonomous",
        progress_intake_outcome: "Durable task contract established in autonomous mode",
      },
    },
    ["route-operating-mode-plan-approval", "execute-step", "final-review", "end"],
  ),
  scenario("ordinary interactive execution completes", {}, [
    "notify-plan-ready",
    "approve-plan",
    "execute-step",
    "final-review",
    "end",
  ]),
  scenario(
    "plan repair creates a new immutable revision",
    {
      "review-plan": [planReview("repair"), planReview("pass")],
      "fix-plan": { repair_outcome: "changed", ...replan(2) },
    },
    ["fix-plan", "increment-plan-review-round", "review-plan", "end"],
  ),
  scenario(
    "plan repair reassessment replans from its exact cause",
    {
      "review-plan": [planReview("repair"), planReview("pass")],
      "fix-plan": {
        repair_outcome: "reassess",
        reassessment_file: "plans/001/repair.md",
        progress_plan_outcome: "Plan repair reassessed as requiring replanning",
      },
    },
    ["route-plan-repair-outcome", "replan-from-plan-reassess", "review-plan", "end"],
  ),
  scenario(
    "plan reviewer can request direct replan",
    { "review-plan": [planReview("replan"), planReview("pass")] },
    ["route-plan-review-replan", "replan-from-plan-review", "review-plan", "end"],
  ),
  scenario(
    "plan review bound can authorize one changed repair",
    {
      "review-plan": [planReview("repair"), planReview("pass")],
      "ask-plan-review-limit": {
        decision: "repair",
        progress_plan_outcome: "One changed plan repair authorized at the review bound",
      },
    },
    ["ask-plan-review-limit", "reset-plan-review-for-repair", "fix-plan", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "plan review bound can finish truthfully incomplete",
    {
      "review-plan": planReview("repair"),
      "ask-plan-review-limit": {
        decision: "finish_incomplete",
        progress_plan_outcome: "Plan review bound ended with disclosed incomplete scope",
      },
      "deliver-result": {
        delivery_file: "final/delivery.md",
        delivery_status: "incomplete",
        summary: "The unresolved plan finding is disclosed.",
        progress_delivery_outcome: "Incomplete delivery discloses the unresolved plan finding",
      },
    },
    ["ask-plan-review-limit", "deliver-result", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "interactive plan rejection creates and reviews a new revision",
    {
      "approve-plan": [
        { decision: "no", progress_plan_outcome: "Current plan rejected for revision" },
        { decision: "yes", progress_plan_outcome: progressOutcome.plan },
      ],
      "revise-plan": replan(2),
    },
    ["revise-plan", "review-plan", "approve-plan", "end"],
  ),
  scenario(
    "result repair consumes a retry only after a changed attempt",
    {
      "review-step": [stepVerdict(1, 1, "repair", "result"), stepVerdict(1, 2, "pass")],
      "repair-step": {
        repair_outcome: "changed",
        ...stepEvidence(1, 2),
        progress_step_review_outcome: "Result repair produced a changed attempt",
      },
    },
    ["repair-step", "route-step-repair-budget", "increment-step-retry", "review-step", "end"],
  ),
  scenario(
    "evidence repair returns to review without consuming result retry",
    {
      "review-step": [
        stepVerdict(1, 1, "repair", "evidence_projection"),
        stepVerdict(1, 2, "pass"),
      ],
      "repair-step": {
        repair_outcome: "changed",
        ...stepEvidence(1, 2),
        progress_step_review_outcome: "Evidence repair produced a changed projection",
      },
    },
    ["route-step-repair-owner", "repair-step", "review-step", "end"],
  ),
  scenario(
    "step repair reassessment replans from its exact cause",
    {
      "execute-step": [
        { ...stepEvidence(1, 1), progress_execution_outcome: progressOutcome.execution },
        { ...stepEvidence(2, 1), progress_execution_outcome: progressOutcome.execution },
      ],
      "review-step": [stepVerdict(1, 1, "repair", "result"), stepVerdict(2, 1, "pass")],
      "repair-step": {
        repair_outcome: "reassess",
        reassessment_file: "steps/1/plans/001/attempts/1/repair.md",
        progress_step_review_outcome: "Step repair reassessed as requiring replanning",
      },
    },
    ["route-step-repair-outcome", "replan-from-step-reassess", "review-plan", "end"],
  ),
  scenario(
    "step reviewer can request direct replan",
    {
      "execute-step": [
        { ...stepEvidence(1, 1), progress_execution_outcome: progressOutcome.execution },
        { ...stepEvidence(2, 1), progress_execution_outcome: progressOutcome.execution },
      ],
      "review-step": [stepVerdict(1, 1, "replan"), stepVerdict(2, 1, "pass")],
    },
    ["route-verifier-replan", "replan-from-verdict", "review-plan", "end"],
  ),
  scenario(
    "retry exhaustion can authorize another changed repair",
    {
      "review-step": [
        stepVerdict(1, 1, "repair", "result"),
        stepVerdict(1, 2, "repair", "result"),
        stepVerdict(1, 3, "pass"),
      ],
      "repair-step": [
        {
          repair_outcome: "changed",
          ...stepEvidence(1, 2),
          progress_step_review_outcome: "First changed result repair produced",
        },
        {
          repair_outcome: "changed",
          ...stepEvidence(1, 3),
          progress_step_review_outcome: "Authorized changed result repair produced",
        },
      ],
      "ask-retry-decision": {
        decision: "retry",
        decision_file: "steps/1/decisions/001.md",
        progress_step_review_outcome: "Another changed retry authorized",
      },
    },
    ["notify-escalation", "ask-retry-decision", "reset-step-retry", "repair-step", "end"],
    { initialVariables: { max_retries: 1 } },
  ),
  scenario(
    "retry exhaustion can replan the unfinished tail",
    {
      "execute-step": [
        { ...stepEvidence(1, 1), progress_execution_outcome: progressOutcome.execution },
        { ...stepEvidence(2, 1), progress_execution_outcome: progressOutcome.execution },
      ],
      "review-step": [
        stepVerdict(1, 1, "repair", "result"),
        stepVerdict(1, 2, "repair", "result"),
        stepVerdict(2, 1, "pass"),
      ],
      "repair-step": {
        repair_outcome: "changed",
        ...stepEvidence(1, 2),
        progress_step_review_outcome: "Changed attempt remains blocked",
      },
      "ask-retry-decision": {
        decision: "replan",
        decision_file: "steps/1/decisions/001.md",
        progress_step_review_outcome: "Retry exhaustion requires replanning",
      },
    },
    ["route-replan-choice", "replan-from-decision", "review-plan", "end"],
    { initialVariables: { max_retries: 1 } },
  ),
  scenario(
    "retry exhaustion can finish truthfully incomplete",
    {
      "review-step": [stepVerdict(1, 1, "repair", "result"), stepVerdict(1, 2, "repair", "result")],
      "repair-step": {
        repair_outcome: "changed",
        ...stepEvidence(1, 2),
        progress_step_review_outcome: "Changed attempt remains incomplete",
      },
      "ask-retry-decision": {
        decision: "finish_incomplete",
        decision_file: "steps/1/decisions/001.md",
        progress_step_review_outcome: "Retry exhaustion ended with disclosed incomplete scope",
      },
      "deliver-result": {
        delivery_file: "final/delivery.md",
        delivery_status: "incomplete",
        summary: "The open step remains incomplete by explicit decision.",
        progress_delivery_outcome: "Incomplete delivery discloses the unresolved open step",
      },
    },
    ["ask-retry-decision", "deliver-result", "end"],
    { initialVariables: { max_retries: 1 } },
  ),
  scenario(
    "final review repair returns to the same reviewer",
    {
      "final-review": [finalReview(1, "repair", "deliverable"), finalReview(2, "pass")],
      "fix-final-review": {
        repair_outcome: "changed",
        progress_final_review_outcome: "Final deliverable finding repaired",
      },
    },
    ["fix-final-review", "increment-final-review-round", "final-review", "end"],
  ),
  scenario(
    "final repair reassessment replans from its exact cause",
    {
      "final-review": [finalReview(1, "repair", "deliverable"), finalReview(2, "pass")],
      "fix-final-review": {
        repair_outcome: "reassess",
        reassessment_file: "final/reviews/001-reassess.md",
        progress_final_review_outcome: "Final repair reassessed as requiring replanning",
      },
    },
    ["route-final-repair-outcome", "replan-from-final-reassess", "review-plan", "end"],
  ),
  scenario(
    "final reviewer can request direct replan",
    { "final-review": [finalReview(1, "replan"), finalReview(2, "pass")] },
    ["route-final-review-replan", "replan-from-final-review", "review-plan", "end"],
  ),
  scenario(
    "final review bound can authorize one changed repair",
    {
      "final-review": [finalReview(1, "repair", "deliverable"), finalReview(2, "pass")],
      "ask-final-review-limit": {
        decision: "repair",
        progress_final_review_outcome: "One changed final repair authorized at the review bound",
      },
    },
    ["ask-final-review-limit", "reset-final-for-repair", "fix-final-review", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "final review bound can accept an explicitly incomplete result",
    {
      "final-review": finalReview(1, "repair", "deliverable"),
      "ask-final-review-limit": {
        decision: "accept_incomplete",
        progress_final_review_outcome:
          "Final review bound accepted with disclosed incomplete scope",
      },
      "deliver-result": {
        delivery_file: "final/delivery.md",
        delivery_status: "incomplete",
        summary: "The accepted final finding is disclosed.",
        progress_delivery_outcome: "Incomplete delivery discloses the accepted final finding",
      },
    },
    ["ask-final-review-limit", "deliver-result", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "teleport replan preserves completed work and returns through review",
    {
      "execute-step": [
        { ...stepEvidence(1, 1), progress_execution_outcome: progressOutcome.execution },
        { ...stepEvidence(2, 1), progress_execution_outcome: progressOutcome.execution },
      ],
      "review-step": stepVerdict(2, 1, "pass"),
    },
    ["teleport-replan", "review-plan", "approve-plan", "end"],
    { teleportAfter: { afterNode: "execute-step", teleportTo: "teleport-replan" } },
  ),
];

describe("Robust Task cause-aware contract", () => {
  const workflow = loadWorkflow();

  test("keeps durable recovery state and cause-owned routing", async () => {
    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.valid).toBe(true);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(detectCycles(workflow).length).toBeGreaterThan(0);

    const serialized = JSON.stringify(workflow);
    for (const removed of [
      "criteria_review_round",
      "verify-criteria",
      "jsonFingerprint",
      "operation_state",
      "fingerprint",
      "proof_token",
      "source_epoch",
    ]) {
      expect(serialized).not.toContain(removed);
    }

    expect(workflow.metadata.version).toBe("9.1.3");
    expect(node(workflow, "initialize-workspace").directive).toContain("process-id.txt");

    // Version is pinned so a directive change cannot ship without reopening this file.
    expect(workflow.metadata.version).toBe("9.1.3");
    expect(workflow.metadata.description).toContain("restartable state across context loss");
    expect(workflow.metadata.description).toContain("truthfully incomplete");
    // A plan step fixes what must become true, the evidence that would accept it, and what it
    // depends on; it never carries the deliverable. The rule is written
    // out once where the first plan is made, and every node that publishes a later plan version
    // carries the reference in both halves — directive and gate — because a plan is lowered back
    // onto the result while it is being repaired or replanned, not while it is first written. The
    // gate binds only the steps that node may reshape: four of the five preserve completed steps as
    // executed, so demanding altitude of those would make the gate unpassable mid-run.
    const createPlan = node(workflow, "create-plan");
    expect(createPlan.directive).toContain("it does not carry the deliverable itself");
    expect(createPlan.directive).toContain("Where the result is prose");
    expect(createPlan.directive).toContain("work an intelligent executor still has to do remains");
    expect(createPlan.directive).toContain(
      "a step a later turn could satisfy by copying text out of the plan",
    );
    expect(createPlan.completionCondition).toContain(
      "every step fixes an outcome, its acceptance, and what it depends on rather than containing the deliverable",
    );
    // fix-plan looks pre-approval, but a mid-run replan re-enters review and a blocking finding
    // routes straight back into it (execute-step → teleport-replan → reset-plan-review-round →
    // review-plan → route-plan-review:false → check-plan-review-limit:false), so it binds only the
    // steps it shapes, exactly like the four nodes below.
    const fixPlan = node(workflow, "fix-plan");
    expect(fixPlan.directive).toContain(
      "The steps this revision shapes keep the altitude the first plan is held to",
    );
    expect(fixPlan.completionCondition).toContain(
      "every step it shapes fixes an outcome, its acceptance, and what it depends on rather than containing the deliverable",
    );
    // Work that is already closed stays closed: every node that publishes a plan version after
    // execution may begin says so in its directive and answers for it at its gate. fix-plan looked
    // exempt because its only edges come from the review router, but the run reaches it mid-flight
    // through replan-from-verdict, so it carries the same obligation. Evidence needs no clause here:
    // it lives in immutable attempt directories addressed by plan version, and no plan node writes
    // there.
    expect(node(workflow, "fix-plan").directive).toContain("preserve unaffected decisions");
    expect(node(workflow, "fix-plan").directive).toContain(
      "Steps already executed stay as they were executed",
    );
    expect(node(workflow, "revise-plan").directive).toContain(
      "Preserve completed steps 1 through {{current_step}} - 1 when execution has begun",
    );
    expect(node(workflow, "replan-from-verdict").directive).toContain(
      "preserve completed outcomes",
    );
    expect(node(workflow, "replan-from-decision").directive).toContain(
      "Preserve completed steps and reshape only the open step and unfinished tail",
    );
    expect(node(workflow, "teleport-replan").directive).toContain(
      "preserve completed steps before {{current_step}}, and reshape only the open step and unfinished tail",
    );
    // The gates say it in three shapes that predate this edit and are kept as equals; each is pinned
    // where it stands, so swapping one for another is visible too.
    for (const [nodeId, gateClause] of [
      ["fix-plan", "every step it shapes fixes an outcome"],
      ["revise-plan", "completed work remains preserved"],
      ["replan-from-verdict", "preserves completed outcomes"],
      ["replan-from-decision", "completed work is preserved"],
      ["teleport-replan", "preserves completed work"],
    ] as const) {
      expect(node(workflow, nodeId).completionCondition).toContain(gateClause);
    }
    // The four nodes that reshape a plan mid-run may only touch the unfinished tail, so both halves
    // bind exactly the steps they shape: a gate demanding more would be unpassable once a run has
    // executed a step written below the altitude.
    for (const nodeId of [
      "revise-plan",
      "replan-from-verdict",
      "replan-from-decision",
      "teleport-replan",
    ]) {
      const publisher = node(workflow, nodeId);
      expect(publisher.directive).toContain(
        "The steps this revision shapes keep the altitude the first plan is held to",
      );
      expect(publisher.directive).toContain(
        "they fix what must become true, the evidence that would accept it, and what it depends on",
      );
      expect(publisher.completionCondition).toContain(
        "every step it shapes fixes an outcome, its acceptance, and what it depends on rather than containing the deliverable",
      );
    }
    // Autonomous mode is routed, not schema-driven: the plan-approval gate is entered through its
    // mode condition, and both notification routes lead to that condition.
    expect(workflow.variableRegistry?.operating_mode?.enum).toEqual(["autonomous", "interactive"]);
    expect(node(workflow, "route-operating-mode-plan-approval").connections).toEqual({
      true: "check-all-steps-done",
      false: "approve-plan",
    });
    expect(node(workflow, "notify-plan-ready").connections).toEqual({
      default: "route-operating-mode-plan-approval",
      error: "route-operating-mode-plan-approval",
    });
    expect(node(workflow, "review-plan").inputSchema.properties.review_outcome.enum).toEqual([
      "pass",
      "repair",
      "replan",
    ]);
    expect(node(workflow, "review-step").inputSchema.properties.repair_owner.enum).toEqual([
      "result",
      "evidence_projection",
    ]);
    expect(node(workflow, "repair-step").inputSchema.properties.repair_outcome.enum).toEqual([
      "changed",
      "reassess",
    ]);
    expect(node(workflow, "final-review").inputSchema.properties.repair_owner.enum).toEqual([
      "deliverable",
      "evidence_projection",
    ]);
    expect(node(workflow, "ask-retry-decision").inputSchema.properties.decision.enum).toEqual([
      "retry",
      "replan",
      "finish_incomplete",
    ]);
    expect(node(workflow, "end").finalOutput).toEqual([
      "workspace_path",
      "delivery_file",
      "delivery_status",
      "summary",
    ]);
  });

  test("projects complete render-only progress from the latest authoritative plan revision", () => {
    expect(workflow.progress?.nodes.map((candidate) => candidate.id)).toEqual([
      "intake",
      "plan",
      "execute",
      "step-review",
      "final-review",
      "deliver",
    ]);
    expect(workflow.progress?.nodes.map((candidate) => candidate.connections?.default)).toEqual([
      "plan",
      "execute",
      "step-review",
      "final-review",
      "deliver",
      undefined,
    ]);

    const waitingTypes = new Set([
      "agent-directive",
      "teleport",
      "lock",
      "materialize",
      "subgraph",
    ]);
    const waitingNodes = workflow.nodes.filter((candidate) => waitingTypes.has(candidate.type));
    expect(waitingNodes).toHaveLength(23);
    expect(
      waitingNodes.every(
        (candidate: any) =>
          Boolean(candidate.progressNodeId) &&
          Boolean(candidate.progressActiveLabel) &&
          Boolean(candidate.progressActiveContent?.summary) &&
          Boolean(candidate.progressActiveContent?.next) &&
          candidate.progressActiveContent?.outcome === undefined,
      ),
    ).toBe(true);

    const progressVariables = Object.entries(workflow.variableRegistry ?? {}).filter(([name]) =>
      name.startsWith("progress_"),
    );
    expect(progressVariables.map(([name]) => name)).toEqual([
      "progress_intake_outcome",
      "progress_plan_outcome",
      "progress_execution_outcome",
      "progress_step_review_outcome",
      "progress_final_review_outcome",
      "progress_delivery_outcome",
    ]);
    expect(
      progressVariables.every(
        ([, schema]: any) => schema.minLength === 1 && schema.maxLength === 500,
      ),
    ).toBe(true);

    const routingText = JSON.stringify(
      workflow.nodes.map((candidate: any) => ({
        condition: candidate.type === "condition" ? candidate.condition : undefined,
        expressions: candidate.type === "expression" ? candidate.expressions : undefined,
        connections: candidate.connections,
      })),
    );
    expect(routingText).not.toContain("progress_");

    const currentPlanConsumers = [
      "ask-plan-review-limit",
      "review-step",
      "ask-retry-decision",
      "replan-from-verdict",
      "replan-from-decision",
      "teleport-replan",
      "final-review",
      "fix-final-review",
      "deliver-result",
      "replan-from-plan-review",
      "repair-step",
      "replan-from-final-review",
      "replan-from-plan-reassess",
      "replan-from-step-reassess",
      "replan-from-final-reassess",
    ];
    for (const nodeId of currentPlanConsumers) {
      expect(node(workflow, nodeId).directive).toContain("{{workspace_path}}{{current_plan_file}}");
    }

    const revisionWriters = [
      "revise-plan",
      "teleport-replan",
      "replan-from-plan-review",
      "replan-from-plan-reassess",
      "replan-from-verdict",
      "replan-from-decision",
      "replan-from-step-reassess",
      "replan-from-final-review",
      "replan-from-final-reassess",
    ];
    const revisionProgressFields = [
      "progress_execution_outcome",
      "progress_final_review_outcome",
      "progress_plan_outcome",
      "progress_step_review_outcome",
    ];
    for (const nodeId of revisionWriters) {
      expect(node(workflow, nodeId).inputSchema.required).toEqual(
        expect.arrayContaining(revisionProgressFields),
      );
      expect(node(workflow, nodeId).inputSchema.globalInputs).toEqual(
        expect.arrayContaining(revisionProgressFields),
      );
    }

    const fixPlanSchema = node(workflow, "fix-plan").inputSchema;
    expect(fixPlanSchema.globalInputs).toEqual(expect.arrayContaining(revisionProgressFields));
    expect(fixPlanSchema.required).toContain("progress_plan_outcome");
    expect(fixPlanSchema.allOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          if: expect.objectContaining({
            properties: expect.objectContaining({ repair_outcome: { const: "changed" } }),
          }),
          then: expect.objectContaining({
            required: expect.arrayContaining([
              "progress_execution_outcome",
              "progress_final_review_outcome",
              "progress_step_review_outcome",
            ]),
          }),
        }),
      ]),
    );
  });

  test("keeps direct and reassessment replan sources structurally separate", () => {
    const pairs = [
      ["route-plan-review-replan", "replan-from-plan-review", "review"],
      ["route-plan-repair-outcome", "replan-from-plan-reassess", "reassessment"],
      ["route-verifier-replan", "replan-from-verdict", "verdict"],
      ["route-step-repair-outcome", "replan-from-step-reassess", "reassessment"],
      ["route-final-review-replan", "replan-from-final-review", "review"],
      ["route-final-repair-outcome", "replan-from-final-reassess", "reassessment"],
    ] as const;

    for (const [routeId, consumerId, requiredSource] of pairs) {
      expect(node(workflow, routeId).connections.true).toBe(consumerId);
      const contract = `${node(workflow, consumerId).directive} ${node(workflow, consumerId).completionCondition}`;
      expect(contract.toLowerCase()).toContain(requiredSource);
    }
    for (const directConsumer of [
      "replan-from-plan-review",
      "replan-from-verdict",
      "replan-from-final-review",
    ]) {
      expect(node(workflow, directConsumer).completionCondition.toLowerCase()).not.toContain(
        "reassessment",
      );
    }
    expect(node(workflow, "replan-from-verdict").completionCondition).toContain(
      "current verifier verdict cause",
    );
    expect(node(workflow, "replan-from-verdict").completionCondition).not.toContain(
      "repair-producer",
    );
  });

  test("representative routes cover every node and branch", async () => {
    const results = [];
    for (const route of scenarios) {
      const result = await runScenario(workflow, route);
      expect({
        scenario: route.name,
        error: result.error,
        failed: result.failedExpectations,
      }).toEqual({
        scenario: route.name,
        error: undefined,
        failed: undefined,
      });
      results.push(result);
    }

    const coverage = calculateCoverage(workflow, results);
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

  test("scenario names are unique", () => {
    expect(new Set(scenarios.map(({ name }) => name)).size).toBe(scenarios.length);
  });
});
