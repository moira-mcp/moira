/**
 * Contract and behavioral scenarios for moira/task-breakdown-flow.
 *
 * The flow owns one bounded task, a strict dependency-safe plan, engine-owned sequential
 * progress, per-item evidence and independent review, changed retries/recovery, protected
 * suffix revision, and a final zero-only review in filesystem or bounded memory mode.
 */

import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import { GraphValidator, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { runScenario } from "../../helpers/scenario-runner.js";

type PlanItem = {
  id: string;
  action: string;
  expected_result: string;
  dependencies: string[];
};

const catalogEntry = findCatalogEntryBySlug("task-breakdown-flow")!;
const task = "Prepare and verify a bounded release-readiness summary";
const expected = "A checked release-readiness summary exists";
const criteria = ["The summary is complete", "Every claim has verification evidence"];
const authority = "Inspect local authorized inputs and write only the requested local result";

const first: PlanItem = {
  id: "inspect",
  action: "Inspect the authorized readiness inputs",
  expected_result: "Relevant readiness facts are identified",
  dependencies: [],
};
const second: PlanItem = {
  id: "report",
  action: "Write and verify the readiness summary",
  expected_result: "The bounded readiness summary satisfies both criteria",
  dependencies: ["inspect"],
};
const plan = [first, second];

function loadWorkflow(): WorkflowGraph {
  return structuredClone(catalogEntry.graph) as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): any {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function capture(operatingMode: "autonomous" | "interactive" = "autonomous") {
  return {
    operating_mode: operatingMode,
    storage_mode: "memory",
    task_description: task,
    expected_result: expected,
    success_criteria: criteria,
    constraints: ["Do not publish or deploy"],
    authority_boundary: authority,
  };
}

function verifiedLedger(items: PlanItem[]) {
  return items.map((item) => ({
    item_id: item.id,
    status: "verified",
    actual_result: `Completed ${item.id}`,
    verification: `Observed proof for ${item.id}`,
  }));
}

function cleanInputs(operatingMode: "autonomous" | "interactive" = "autonomous") {
  return {
    capture_contract: capture(operatingMode),
    create_plan: { steps: plan },
    review_plan: { plan_issues_count: 0, findings_summary: [] },
    execute_item: [
      { execution_status: "verified", evidence_ledger: verifiedLedger([first]) },
      { execution_status: "verified", evidence_ledger: verifiedLedger(plan) },
    ],
    review_item: [
      { item_issues_count: 0, findings_summary: [] },
      { item_issues_count: 0, findings_summary: [] },
    ],
    assemble_result: { result_summary: "Both plan items completed with verified evidence." },
    review_final: {
      final_issues_count: 0,
      findings_summary: [],
      reviewed_outcome: "clean",
    },
    finalize_result: { artifact_location: "in-memory execution context" },
    ...(operatingMode === "interactive"
      ? {
          present_plan: { decision: "accept" },
          present_result: { decision: "accept" },
        }
      : {}),
  };
}

describe("task-breakdown-flow", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("validates the executable task-breakdown graph", async () => {
    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  test("completes a two-item autonomous memory task only after both independent gates", async () => {
    const result = await runScenario(workflow, {
      name: "autonomous memory clean",
      mockInputs: cleanInputs(),
      expect: {
        status: "completed",
        reaches: ["review_plan", "review_item", "review_final", "end_clean"],
        avoids: ["present_plan", "present_result", "end_limited"],
        contextContains: {
          current_step: 2,
          completed_items: 2,
          retry_count: 0,
          terminal_outcome: "clean",
          artifact_location: "in-memory execution context",
        },
      },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts.execute_item).toBe(2);
    expect(result.inputSubmissionCounts.review_item).toBe(2);
  });

  test("requires nonblank interactive plan feedback before revision", async () => {
    const result = await runScenario(workflow, {
      name: "missing plan revision feedback",
      mockInputs: {
        capture_contract: capture("interactive"),
        create_plan: { steps: plan },
        review_plan: { plan_issues_count: 0, findings_summary: [] },
        present_plan: { decision: "revise" },
      },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'present_plan'");
    expect(result.visitedNodes).not.toContain("revise_plan");
  });

  test("accepts a blocked plan repair without inventing a replacement plan", async () => {
    const result = await runScenario(workflow, {
      name: "blocked plan repair",
      mockInputs: {
        capture_contract: capture(),
        create_plan: { steps: plan },
        review_plan: { plan_issues_count: 1, findings_summary: ["Plan cannot be authorized"] },
        repair_plan: { repair_status: "blocked", blocked_reason: "Required authority is absent" },
        record_plan_blocked: {
          result_summary: "Plan repair stopped without executing work.",
          limitation_reason: "Required authority is absent",
        },
      },
      expect: {
        status: "completed",
        reaches: ["repair_plan", "record_plan_blocked", "end_recovery"],
        avoids: ["execute_item", "end_clean"],
        contextContains: { terminal_outcome: "recovery" },
      },
    });
    expect(result.passed).toBe(true);
  });

  test("requires a materially changed retry, then re-verifies the same current item", async () => {
    const failedFirst = [
      {
        item_id: first.id,
        status: "failed",
        actual_result: "Initial inspection was incomplete",
        verification: "Required readiness source was not checked",
      },
    ];
    const result = await runScenario(workflow, {
      name: "changed retry",
      mockInputs: {
        ...cleanInputs(),
        execute_item: [
          { execution_status: "failed", evidence_ledger: failedFirst },
          { execution_status: "verified", evidence_ledger: verifiedLedger([first]) },
          { execution_status: "verified", evidence_ledger: verifiedLedger(plan) },
        ],
        prepare_retry: {
          retry_status: "changed",
          retry_approach: "Inspect the missing primary readiness source before summarizing",
        },
      },
      expect: {
        status: "completed",
        reaches: ["prepare_retry", "increment_retry", "end_clean"],
        contextContains: { current_step: 2, retry_count: 0, terminal_outcome: "clean" },
      },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts.execute_item).toBe(3);
  });

  test("interactive result rework returns through final review before acceptance", async () => {
    const inputs = cleanInputs("interactive");
    const result = await runScenario(workflow, {
      name: "interactive projection rework",
      mockInputs: {
        ...inputs,
        review_final: [
          { final_issues_count: 0, findings_summary: [], reviewed_outcome: "clean" },
          { final_issues_count: 0, findings_summary: [], reviewed_outcome: "clean" },
        ],
        finalize_result: [
          { artifact_location: "in-memory execution context" },
          { artifact_location: "in-memory execution context" },
        ],
        present_result: [
          { decision: "rework", feedback: "Make the bounded summary more precise" },
          { decision: "accept" },
        ],
        rework_result: {
          final_repair_reach: "projection",
          result_summary: "Both items and both success criteria are verified.",
        },
      },
      expect: {
        status: "completed",
        reaches: ["rework_result", "route_rework_projection", "end_clean"],
      },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts.review_final).toBe(2);
    expect(result.inputSubmissionCounts.present_result).toBe(2);
  });

  test("rejects a suffix revision that rewrites the verified prefix", async () => {
    const failedSecond = [
      verifiedLedger([first])[0],
      {
        item_id: second.id,
        status: "failed",
        actual_result: "The report step is obsolete",
        verification: "Changed task conditions require a new suffix",
      },
    ];
    const rewrittenPrefix = [{ ...first, action: "Rewrite already verified work" }, second];
    const result = await runScenario(workflow, {
      name: "protected prefix rewrite",
      mockInputs: {
        capture_contract: capture("interactive"),
        create_plan: { steps: plan },
        review_plan: { plan_issues_count: 0, findings_summary: [] },
        present_plan: { decision: "accept" },
        execute_item: [
          { execution_status: "verified", evidence_ledger: verifiedLedger([first]) },
          { execution_status: "failed", evidence_ledger: failedSecond },
          { execution_status: "failed", evidence_ledger: failedSecond },
        ],
        review_item: { item_issues_count: 0, findings_summary: [] },
        prepare_retry: [
          { retry_status: "changed", retry_approach: "Use a changed report approach" },
          { retry_status: "blocked", blocked_reason: "The remaining plan is obsolete" },
        ],
        ask_recovery: { decision: "revise", reason: "Replace the obsolete suffix" },
        revise_suffix: { steps: rewrittenPrefix },
      },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("protected plan prefix item 0 differs");
    expect(result.visitedNodes).not.toContain("apply_revision");
  });
});
