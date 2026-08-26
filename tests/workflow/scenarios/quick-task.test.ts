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
    "get-task": {
      task_file: taskFile,
      execution_file: executionFile,
      operating_mode: "interactive",
    },
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
    // Pinned so a directive change cannot ship without the version that publishes it, and without
    // this file being reopened alongside the flow.
    expect(workflow.metadata.version).toBe("4.4.2");
    expect(workflow.metadata.description).toContain("bounded non-development task");
    expect(workflow.metadata.description).toContain("Todo List");
  });

  it("keeps only the plan reference, approved length, execution cursor, and operating mode globals", () => {
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
      operating_mode: {
        type: "string",
        description:
          "How this run treats the user before the final result: autonomous skips the plan approval and the acceptance question, interactive keeps them",
        enum: ["autonomous", "interactive"],
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
    // The engine inlines declared registry globals into the agent-visible schema, so a raw node
    // schema alone is not what an agent is validated against; mirror that inlining here.
    const schema = (nodeId: string) => {
      const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
      expect(node?.type).toBe("agent-directive");
      const raw = (node as { inputSchema: Record<string, any> }).inputSchema;
      const globals: string[] = raw.globalInputs ?? [];
      if (globals.length === 0) return raw;
      return {
        ...raw,
        properties: {
          ...raw.properties,
          ...Object.fromEntries(
            globals.map((name) => [name, workflow.variableRegistry![name] as object]),
          ),
        },
      };
    };

    const validateIntake = ajv.compile(schema("get-task"));
    expect(
      validateIntake({
        task_file: taskFile,
        execution_file: executionFile,
        operating_mode: "interactive",
      }),
    ).toBe(true);
    expect(
      validateIntake({
        task_file: "../task.md",
        execution_file: executionFile,
        operating_mode: "interactive",
      }),
    ).toBe(false);
    // The mode is a bounded routing value, not free text.
    expect(
      validateIntake({ task_file: taskFile, execution_file: executionFile, operating_mode: "off" }),
    ).toBe(false);

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
    // revise-plan is reached both from a user rejection and from the mid-execution replan jump, so
    // it must not template an artifact that exists on only one of those routes: an undefined
    // variable renders as a placeholder into the directive the agent is given.
    expect(directive("revise-plan")).not.toContain("{{present-plan.decision_file}}");
    expect(directive("revise-plan")).toContain("{{current_plan_file}}");
    expect(directive("revise-plan")).toContain("decision record");
    expect(directive("revise-plan")).toContain("mid-execution replan");
    expect(directive("execute-step")).toContain("{{get-task.execution_file}}");
    expect(directive("fix-issues")).toContain("{{final-review.review_file}}");
    expect(directive("rework")).toContain("{{present-to-user.decision_file}}");

    // A plan unit fixes what must become true, the evidence that would accept it, and what it
    // depends on; it does not carry the deliverable. The rule
    // is stated once where the plan is first written, and the two nodes that publish later
    // iterations refer to it, so a revision cannot quietly lower the plan back onto the result.
    const createPlan = workflow.nodes.find((node) => node.id === "create-plan") as {
      directive: string;
      completionCondition: string;
    };
    expect(createPlan.directive).toContain("it does not carry the deliverable itself");
    expect(createPlan.directive).toContain("work an intelligent executor still has to do remains");
    expect(createPlan.directive).toContain(
      "a unit a later step could satisfy by copying text out of the plan",
    );
    expect(createPlan.completionCondition).toContain(
      "every unit fixes an outcome, its acceptance, and what it depends on rather than containing the deliverable",
    );
    expect(createPlan.directive).toContain("Where the result is prose");
    // Every node that publishes a plan iteration carries the rule in both of its halves: the
    // directive that tells the author, and the gate the author measures the result against. A plan
    // is lowered back onto the result exactly when it is being repaired or revised, not when it is
    // first written, so a gate that is silent there is the one that matters.
    // Both repair-plan and revise-plan are reachable mid-flight — revise-plan straight from
    // teleport-replan, repair-plan right behind it through plan-review — where completed units stay
    // as executed, so each gate binds only the units that node shapes, never the whole plan.
    const planNode = (nodeId: string) =>
      workflow.nodes.find((candidate) => candidate.id === nodeId) as {
        directive: string;
        completionCondition: string;
      };
    expect(planNode("repair-plan").directive).toContain(
      "the units it shapes fix what must become true, the evidence that would accept it",
    );
    // Whatever the plan is repaired or revised for, work that already happened stays as it happened:
    // the executed unit keeps its position, because the zero-based cursor addresses units by index,
    // and its evidence entry keeps its text, because that entry is the record of what was done. Both
    // halves are pinned in every carrier — a gate that names only positions leaves the evidence
    // unguarded, and the run has three nodes that may write a plan after execution has begun.
    for (const nodeId of ["repair-plan", "revise-plan"]) {
      expect(planNode(nodeId).completionCondition).toContain(
        "preserves already executed units at their positions without rewriting their recorded execution evidence",
      );
    }
    expect(planNode("repair-plan").directive).toContain(
      "every already executed unit at its position, without rewriting existing execution evidence",
    );
    expect(planNode("teleport-replan").completionCondition).toContain(
      "with executed units preserved at their positions and their recorded execution evidence left as written",
    );
    // The directives said both halves before this edit and keep saying them: a half left unpinned is
    // the half a later edit drops.
    expect(planNode("revise-plan").directive).toContain(
      "every already executed unit at its position, without rewriting existing execution evidence",
    );
    expect(planNode("teleport-replan").directive).toContain(
      "Their evidence entries stay as written",
    );
    expect(planNode("repair-plan").completionCondition).toContain(
      "keeps every unit it shapes at the altitude the initial plan is held to rather than containing the deliverable",
    );
    expect(planNode("revise-plan").directive).toContain(
      "The units this revision shapes keep the altitude the initial plan is held to",
    );
    expect(planNode("revise-plan").completionCondition).toContain(
      "keeps every unit it shapes at the altitude the initial plan is held to rather than containing the deliverable",
    );

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

  it("offers exactly one jump-only replan entry that lands on the existing plan revision", () => {
    const teleports = workflow.nodes.filter((node) => node.type === "teleport");
    expect(teleports.map((node) => node.id)).toEqual(["teleport-replan"]);

    const replan = teleports[0] as { hint: string; directive: string; connections: any };
    expect(
      workflow.nodes.some((node) =>
        Object.values(node.connections ?? {}).includes("teleport-replan"),
      ),
    ).toBe(false);
    expect(replan.connections).toEqual({ success: "revise-plan" });

    // The hint is appended to every step, so it carries the abuse boundary: each misrouted case
    // names the owner it actually belongs to.
    expect(replan.hint).toContain("repair-plan");
    expect(replan.hint).toContain("fix-issues");
    expect(replan.hint).toContain("merely hard or blocked");
    // Executed units keep their positions, which is what keeps the zero-based cursor meaningful.
    expect(replan.directive).toContain("at its position");
  });

  it("exports no internal file-backed payload at End", () => {
    const end = workflow.nodes.find((node) => node.id === "end");
    expect(end?.type).toBe("end");
    expect((end as { finalOutput?: string[] }).finalOutput).toEqual([]);
  });

  it("covers clean execution, plan repair and revision, result repair, and user rework", async () => {
    const scenarios: TestScenario[] = [
      {
        name: "autonomous run skips the plan approval and still delivers the result",
        mockInputs: {
          ...successfulInputs(1),
          "get-task": {
            task_file: taskFile,
            execution_file: executionFile,
            operating_mode: "autonomous",
          },
        },
        expect: {
          status: "completed",
          reaches: [
            "route-operating-mode-plan-approval",
            "execute-step",
            "final-review",
            "present-to-user",
            "end",
          ],
          avoids: ["present-plan", "revise-plan"],
        },
      },
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
          "get-task": {
            task_file: taskFile,
            execution_file: executionFile,
            operating_mode: "interactive",
          },
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
      {
        // The plan is found to be wrong after the first unit is executed: the jump publishes a new
        // plan iteration, that iteration goes back through review and approval, and execution
        // resumes at the preserved cursor instead of restarting.
        name: "mid-execution replan re-enters review and resumes at the preserved cursor",
        mockInputs: {
          "get-task": {
            task_file: taskFile,
            execution_file: executionFile,
            operating_mode: "interactive",
          },
          "create-plan": { current_plan_file: planFile(1), total_steps: 2 },
          "plan-review": [
            { review_file: planReviewFile(1), issues_count: 0 },
            { review_file: planReviewFile(2), issues_count: 0 },
          ],
          "present-plan": [
            { approval: "yes", decision_file: planDecisionFile(1) },
            { approval: "yes", decision_file: planDecisionFile(2) },
          ],
          "revise-plan": { current_plan_file: planFile(2), total_steps: 2 },
          "execute-step": [{}, {}],
          "final-review": { review_file: resultReviewFile(1), issues_count: 0 },
          "present-to-user": { decision: "accept", decision_file: resultDecisionFile(1) },
        },
        teleportAfter: { afterNode: "execute-step", visitNumber: 2, teleportTo: "teleport-replan" },
        expect: {
          status: "completed",
          reaches: ["teleport-replan", "revise-plan", "plan-review", "present-plan", "end"],
          avoids: ["repair-plan", "fix-issues", "rework"],
          contextContains: {
            current_plan_file: planFile(2),
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

    // The replan run closed exactly two units in total: the unit finished before the jump was not
    // executed again after the plan was republished.
    const replanRun = results[results.length - 1];
    expect(replanRun.visitedNodes.filter((id) => id === "close-completed-step")).toHaveLength(2);
    expect(replanRun.inputSubmissionCounts["revise-plan"]).toBe(1);

    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    console.log(formatCoverageReport(coverage));
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
  });
});
