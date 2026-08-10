/**
 * quick-task scenario tests
 *
 * Exercises the filesystem-first Plan → Approve → Execute → Review → Accept contract.
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { GraphValidator, detectCycles, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import Ajv from "ajv";
import {
  runScenario,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";
import { calculateCoverage, formatCoverageReport } from "../../helpers/coverage-calculator.js";

function loadProductionWorkflow(): WorkflowGraph {
  return findSystemCatalogEntry("quick-task", "public")!.graph as WorkflowGraph;
}

const executionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspace = `./moira-ws/quick-task-${executionId}`;
const taskFile = `${workspace}/task.md`;
const executionFile = `${workspace}/execution.md`;
const planFile = (iteration: number) =>
  `${workspace}/plans/${String(iteration).padStart(3, "0")}/plan.md`;
const planReviewFile = (iteration: number) =>
  `${workspace}/plans/${String(iteration).padStart(3, "0")}/review.md`;
const planDecisionFile = (iteration: number) =>
  `${workspace}/plans/${String(iteration).padStart(3, "0")}/decision.md`;
const resultReviewFile = (iteration: number) =>
  `${workspace}/result-reviews/${String(iteration).padStart(3, "0")}/review.md`;
const resultDecisionFile = (iteration: number) =>
  `${workspace}/result-reviews/${String(iteration).padStart(3, "0")}/decision.md`;

function successfulInputs(stepCount = 1) {
  return {
    "get-task": { task_file: taskFile, execution_file: executionFile },
    "create-plan": { current_plan_file: planFile(1), total_steps: stepCount },
    "plan-review": { review_file: planReviewFile(1), issues_count: 0 },
    "present-plan": { approval: "yes", decision_file: planDecisionFile(1) },
    "execute-step": Array.from({ length: stepCount }, () => ({})),
    "final-review": { review_file: resultReviewFile(1), issues_count: 0 },
    "present-to-user": { decision: "accept", decision_file: resultDecisionFile(1) },
  };
}

describe("quick-task scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  it("is structurally and semantically valid", async () => {
    const validator = new GraphValidator();
    const validation = await validator.validateWorkflow({
      id: `moira/${workflow.slug || "quick-task"}`,
      ...workflow,
    });

    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it("keeps only the plan reference, approved length, and execution cursor global", () => {
    expect(workflow.variableRegistry).toEqual({
      current_plan_file: {
        type: "string",
        description: "Path to the current complete immutable plan record.",
        pattern: "^\\./moira-ws/quick-task-[0-9a-f-]+/plans/[0-9]+/plan\\.md$",
        maxLength: 240,
      },
      total_steps: {
        type: "number",
        description:
          "Exact number of work units in the current immutable plan; authoritative for execution only after approval.",
        minimum: 1,
        maximum: 10,
        multipleOf: 1,
      },
      current_step: {
        type: "number",
        description: "Zero-based cursor of the next approved plan unit to execute.",
        minimum: 0,
        maximum: 10,
        multipleOf: 1,
        default: 0,
      },
    });

    const cycles = detectCycles(workflow);
    expect(cycles.length).toBeGreaterThan(0);
    expect(workflow.nodes.some((node) => node.id === "project-current-step")).toBe(false);
    expect(workflow.nodes.some((node) => node.id.includes("limit"))).toBe(false);
    expect(workflow.nodes.some((node) => node.id.includes("recovery"))).toBe(false);
  });

  it("uses bounded typed paths and minimal routing outputs", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const schema = (nodeId: string) => {
      const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
      expect(node?.type).toBe("agent-directive");
      return (node as { inputSchema: object }).inputSchema;
    };

    const validateIntake = ajv.compile(schema("get-task"));
    expect(validateIntake({ task_file: taskFile, execution_file: executionFile })).toBe(true);
    expect(validateIntake({ task_file: "../task.md", execution_file: executionFile })).toBe(false);

    const validatePlanReview = ajv.compile(schema("plan-review"));
    expect(validatePlanReview({ review_file: planReviewFile(1), issues_count: 0 })).toBe(true);
    expect(validatePlanReview({ review_file: planReviewFile(1), issues_count: 0.5 })).toBe(false);

    const validatePlanDecision = ajv.compile(schema("present-plan"));
    expect(validatePlanDecision({ approval: "no", decision_file: planDecisionFile(1) })).toBe(true);
    expect(
      validatePlanDecision({
        approval: "no",
        decision_file: planDecisionFile(1),
        feedback: "must remain on disk",
      }),
    ).toBe(false);

    const validateResultReview = ajv.compile(schema("final-review"));
    expect(validateResultReview({ review_file: resultReviewFile(1), issues_count: 0 })).toBe(true);

    const validateResultDecision = ajv.compile(schema("present-to-user"));
    expect(
      validateResultDecision({ decision: "rework", decision_file: resultDecisionFile(1) }),
    ).toBe(true);
    expect(validateResultDecision({ decision: "accept", decision_file: "result-review.md" })).toBe(
      false,
    );

    const outputKeys = new Set<string>();
    for (const node of workflow.nodes) {
      if (node.type !== "agent-directive") continue;
      const properties = (node.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      for (const key of Object.keys(properties ?? {})) outputKeys.add(key);
    }
    expect([...outputKeys].sort()).toEqual(
      [
        "approval",
        "decision",
        "decision_file",
        "execution_file",
        "issues_count",
        "review_file",
        "task_file",
      ].sort(),
    );
  });

  it("passes file references to named consumers without relaying file bodies", () => {
    const directive = (nodeId: string) => {
      const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
      expect(node?.type).toBe("agent-directive");
      return (node as { directive: string }).directive;
    };

    expect(directive("get-task")).toContain("process-id.txt");
    expect(directive("get-task")).toContain("task.md");
    expect(directive("get-task")).toContain("execution.md");
    expect(directive("create-plan")).toContain("{{get-task.task_file}}");
    expect(directive("plan-review")).toContain("{{current_plan_file}}");
    expect(directive("repair-plan")).toContain("{{plan-review.review_file}}");
    expect(directive("revise-plan")).toContain("{{present-plan.decision_file}}");
    expect(directive("execute-step")).toContain("{{get-task.execution_file}}");
    expect(directive("fix-issues")).toContain("{{final-review.review_file}}");
    expect(directive("rework")).toContain("{{present-to-user.decision_file}}");

    const serialized = JSON.stringify(workflow.nodes);
    for (const removedTemplate of [
      "{{steps}}",
      "{{task_contract}}",
      "{{user_feedback}}",
      "{{review_issues}}",
      "{{plan_review_findings}}",
      "{{result_review_findings}}",
      "{{evidence}}",
    ]) {
      expect(serialized).not.toContain(removedTemplate);
    }
  });

  it("keeps review and mutation separate and returns every mutation through review", () => {
    const connection = (nodeId: string, route = "success") =>
      workflow.nodes.find((node) => node.id === nodeId)?.connections[route];

    expect(connection("plan-review")).toBe("check-plan-review-clean");
    expect(connection("check-plan-review-clean", "false")).toBe("repair-plan");
    expect(connection("repair-plan")).toBe("plan-review");
    expect(connection("revise-plan")).toBe("plan-review");
    expect(connection("final-review")).toBe("check-review-clean");
    expect(connection("check-review-clean", "false")).toBe("fix-issues");
    expect(connection("fix-issues")).toBe("final-review");
    expect(connection("rework")).toBe("final-review");

    const reviewerDirectives = ["plan-review", "final-review"].map(
      (id) => (workflow.nodes.find((node) => node.id === id) as { directive: string }).directive,
    );
    for (const reviewerDirective of reviewerDirectives) {
      expect(reviewerDirective).toContain("Do not");
      expect(reviewerDirective.toLowerCase()).toContain("review");
    }
  });

  it("exports no internal file-backed payload at End", () => {
    const end = workflow.nodes.find((node) => node.id === "end");
    expect(end?.type).toBe("end");
    expect((end as { finalOutput?: string[] }).finalOutput).toEqual([]);
  });

  it("covers clean execution, plan repair and revision, result repair, and user rework", async () => {
    const scenarios: TestScenario[] = [
      {
        name: "clean two-unit filesystem-backed execution",
        mockInputs: successfulInputs(2),
        expect: {
          status: "completed",
          reaches: [
            "get-task",
            "create-plan",
            "plan-review",
            "present-plan",
            "execute-step",
            "close-completed-step",
            "final-review",
            "present-to-user",
            "end",
          ],
          avoids: ["repair-plan", "revise-plan", "fix-issues", "rework"],
          contextContains: {
            current_plan_file: planFile(1),
            total_steps: 2,
            current_step: 2,
          },
        },
      },
      {
        name: "all review and user-feedback branches use immutable file references",
        mockInputs: {
          "get-task": { task_file: taskFile, execution_file: executionFile },
          "create-plan": { current_plan_file: planFile(1), total_steps: 2 },
          "plan-review": [
            { review_file: planReviewFile(1), issues_count: 1 },
            { review_file: planReviewFile(2), issues_count: 0 },
            { review_file: planReviewFile(3), issues_count: 0 },
          ],
          "repair-plan": { current_plan_file: planFile(2), total_steps: 2 },
          "present-plan": [
            { approval: "no", decision_file: planDecisionFile(2) },
            { approval: "yes", decision_file: planDecisionFile(3) },
          ],
          "revise-plan": { current_plan_file: planFile(3), total_steps: 2 },
          "execute-step": [{}, {}],
          "final-review": [
            { review_file: resultReviewFile(1), issues_count: 1 },
            { review_file: resultReviewFile(2), issues_count: 0 },
            { review_file: resultReviewFile(3), issues_count: 0 },
          ],
          "fix-issues": {},
          "present-to-user": [
            { decision: "rework", decision_file: resultDecisionFile(2) },
            { decision: "accept", decision_file: resultDecisionFile(3) },
          ],
          rework: {},
        },
        expect: {
          status: "completed",
          reaches: [
            "repair-plan",
            "revise-plan",
            "execute-step",
            "fix-issues",
            "rework",
            "final-review",
            "present-to-user",
            "end",
          ],
          contextContains: {
            current_plan_file: planFile(3),
            total_steps: 2,
            current_step: 2,
          },
        },
      },
    ];

    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) {
      results.push(await runScenario(workflow, scenario));
    }

    const failed = results.filter((result) => !result.passed);
    if (failed.length > 0) {
      console.error(
        failed
          .map(
            (result) =>
              `${result.scenario}: ${result.error || result.failedExpectations?.join(", ")}`,
          )
          .join("\n"),
      );
    }
    expect(failed).toHaveLength(0);

    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    console.log(formatCoverageReport(coverage));
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
  });
});
