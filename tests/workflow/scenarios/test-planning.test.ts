/**
 * Contract and behavioral scenarios for moira/test-planning.
 *
 * The flow writes one canonical structured contract and one Markdown projection, validates
 * structural records at the real agent-response boundary, and can deliver only after an
 * independent zero-finding review.
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { GraphValidator, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import {
  runScenario,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

type PlanRisk = {
  id: string;
  statement: string;
  impact: string;
  likelihood: string;
};

type PlanCase = {
  id: string;
  title: string;
  category: string;
  priority: "P0" | "P1" | "P2" | "P3";
  priority_rationale: string;
  preconditions: string[];
  steps: string[];
  expected_result: string;
  acceptance_criterion_ids: string[];
  risk_ids: string[];
};

type PlanContract = { risks: PlanRisk[]; cases: PlanCase[] };

const catalogEntry = findSystemCatalogEntry("test-planning", "public")!;

function loadWorkflow(): WorkflowGraph {
  return structuredClone(catalogEntry.graph) as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): any {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function validContract(title = "Successful checkout charges once"): PlanContract {
  return {
    risks: [
      {
        id: "R-1",
        statement: "A retry can create a duplicate charge",
        impact: "High: customer is charged twice",
        likelihood: "Medium under a timeout and retry",
      },
    ],
    cases: [
      {
        id: "TC-1",
        title,
        category: "Integration and data integrity",
        priority: "P0",
        priority_rationale: "Duplicate charging is release-blocking",
        preconditions: ["A payable cart and deterministic payment test double exist"],
        steps: ["Submit checkout", "Simulate a timeout", "Retry the same idempotency key"],
        expected_result: "Exactly one charge and one order exist for the idempotency key",
        acceptance_criterion_ids: ["AC-1"],
        risk_ids: ["R-1"],
      },
    ],
  };
}

function validPlanInput(contract = validContract()): Record<string, unknown> {
  return {
    workspace_path: "./moira-ws/test-planning-checkout_20260820",
    plan_contract: contract,
  };
}

async function runInvalidPlan(input: Record<string, unknown>): Promise<ScenarioResult> {
  return runScenario(loadWorkflow(), {
    name: "malformed producer response",
    description: "The actual engine must reject malformed producer data before review",
    mockInputs: { plan: input },
    expect: { status: "completed" },
  });
}

function compactRoute(result: ScenarioResult): string[] {
  return result.visitedNodes.filter((id, index, all) => id !== all[index - 1]);
}

describe("test-planning", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("preserves catalog identity and has the intended valid clean-or-repair graph", async () => {
    expect(catalogEntry.owner).toBe("system-moira");
    expect(catalogEntry.slug).toBe("test-planning");
    expect(catalogEntry.visibility).toBe("public");
    expect(workflow.id).toBe("31526b3b-d623-4e34-b62d-ef0327e9bd11");
    expect(workflow.metadata.version).toBe("2.0.0");

    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(workflow.nodes.map((candidate) => candidate.id)).toEqual([
      "start",
      "end",
      "plan",
      "review",
      "review-gate",
      "repair",
      "present",
    ]);
    expect(node(workflow, "review-gate").connections).toEqual({
      true: "present",
      false: "repair",
    });
    expect(node(workflow, "repair").connections).toEqual({ success: "review" });
    expect(node(workflow, "end").finalOutput).toEqual(["workspace_path", "result_summary"]);
  });

  test("publishes a decision-useful and truthful description with the no-test authority boundary", () => {
    const description = workflow.metadata.description;
    expect(description).toContain("discovers missing context");
    expect(description).toContain("test-plan.contract.json");
    expect(description).toContain("test-plan.md");
    expect(description).toContain("independent file-backed reviewer");
    expect(description).toContain("delivery is unreachable while known gaps remain");
    expect(description).toContain("does not execute tests");
    expect(description).toContain("separately authorized caller or workflow");
    expect(description).toContain("Choose Test Planning");
    expect(description).toContain("Test Generation");
    expect(description).toContain("full development workflow");

    for (const id of ["plan", "review", "repair", "present"]) {
      expect(node(workflow, id).directive).toMatch(
        /(does not|must not|Do not) execute (any )?tests/i,
      );
    }
  });

  test("uses one traversal-safe workspace and fixed derived artifact names", () => {
    const registry = workflow.variableRegistry!;
    expect(Object.keys(registry).sort()).toEqual([
      "issues_count",
      "result_summary",
      "workspace_path",
    ]);
    expect(registry.workspace_path.pattern).toBe(
      "^\\./moira-ws/test-planning-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    );
    expect(node(workflow, "plan").inputSchema.globalInputs).toEqual(["workspace_path"]);

    for (const id of ["review", "repair", "present"]) {
      const directive = node(workflow, id).directive;
      expect(directive).toContain("{{workspace_path}}/test-plan.contract.json");
      expect(directive).toContain("{{workspace_path}}/test-plan.md");
      expect(directive).not.toContain("{{contract_path}}");
      expect(directive).not.toContain("{{plan_path}}");
    }
  });

  test("keeps producer and repair on the same strict canonical contract schema", () => {
    const producerSchema = node(workflow, "plan").inputSchema.properties.plan_contract;
    const repairSchema = node(workflow, "repair").inputSchema.properties.plan_contract;
    expect(repairSchema).toEqual(producerSchema);
    expect(producerSchema.additionalProperties).toBe(false);
    expect(producerSchema.properties.risks.minItems).toBe(1);
    expect(producerSchema.properties.cases.minItems).toBe(1);
    expect(producerSchema.properties.cases.items.additionalProperties).toBe(false);
    expect(producerSchema.properties.cases.items.properties.priority.enum).toEqual([
      "P0",
      "P1",
      "P2",
      "P3",
    ]);
  });

  test("rejects a risk without likelihood at the actual producer response boundary", async () => {
    const contract = validContract() as unknown as {
      risks: Array<Record<string, unknown>>;
      cases: PlanCase[];
    };
    delete contract.risks[0].likelihood;
    const result = await runInvalidPlan(validPlanInput(contract as unknown as PlanContract));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'plan'");
    expect(result.visitedNodes).not.toContain("review");
  });

  test.each([
    "id",
    "title",
    "category",
    "priority",
    "priority_rationale",
    "preconditions",
    "steps",
    "expected_result",
    "acceptance_criterion_ids",
    "risk_ids",
  ])("rejects a case missing required field %s", async (field) => {
    const contract = validContract() as unknown as {
      risks: PlanRisk[];
      cases: Array<Record<string, unknown>>;
    };
    delete contract.cases[0][field];
    const result = await runInvalidPlan(validPlanInput(contract as unknown as PlanContract));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'plan'");
    expect(result.visitedNodes).not.toContain("review");
  });

  test("rejects a case with no acceptance-criterion or risk link", async () => {
    const contract = validContract();
    contract.cases[0].acceptance_criterion_ids = [];
    contract.cases[0].risk_ids = [];
    const result = await runInvalidPlan(validPlanInput(contract));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'plan'");
    expect(result.visitedNodes).not.toContain("review");
  });

  test.each([
    "./moira-ws/test-planning-../../tmp",
    "./moira-ws/test-planning-.",
    "./moira-ws/test-planning-a//b",
    "./moira-ws/test-planning-a/other",
  ])("rejects unsafe or nested workspace %s", async (workspacePath) => {
    const result = await runInvalidPlan({
      ...validPlanInput(),
      workspace_path: workspacePath,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'plan'");
    expect(result.visitedNodes).not.toContain("review");
  });

  test("delivers a valid plan only after a zero-finding independent review", async () => {
    const result = await runScenario(workflow, {
      name: "clean reviewed plan",
      mockInputs: {
        plan: validPlanInput(),
        review: { issues_count: 0 },
        present: {
          result_summary:
            "Accepted plan: ./moira-ws/test-planning-checkout_20260820/test-plan.md; no remaining limitations.",
        },
      },
      expect: { status: "completed", avoids: ["repair"] },
    });

    expect(result.passed).toBe(true);
    expect(compactRoute(result)).toEqual([
      "start",
      "plan",
      "review",
      "review-gate",
      "present",
      "end",
    ]);
    expect(result.finalContext.workspace_path).toBe("./moira-ws/test-planning-checkout_20260820");
    expect(result.finalContext).not.toHaveProperty("contract_path");
    expect(result.finalContext).not.toHaveProperty("plan_path");
  });

  test("repairs a contract/Markdown mismatch, re-reviews, and covers every route", async () => {
    const repairedContract = validContract("Retry preserves a single charge and order");
    const repairScenario: TestScenario = {
      name: "projection mismatch repaired",
      description: "The independent report blocks delivery until regenerated artifacts pass",
      mockInputs: {
        plan: validPlanInput(),
        review: [{ issues_count: 1 }, { issues_count: 0 }],
        repair: { plan_contract: repairedContract },
        present: {
          result_summary:
            "Accepted repaired plan: ./moira-ws/test-planning-checkout_20260820/test-plan.md.",
        },
      },
      expect: { status: "completed", reaches: ["repair", "present"] },
    };
    const repaired = await runScenario(workflow, repairScenario);

    expect(repaired.passed).toBe(true);
    expect(compactRoute(repaired)).toEqual([
      "start",
      "plan",
      "review",
      "review-gate",
      "repair",
      "review",
      "review-gate",
      "present",
      "end",
    ]);
    expect(repaired.inputSubmissionCounts.review).toBe(2);
    expect(repaired.inputSubmissionCounts.repair).toBe(1);
    expect(compactRoute(repaired).indexOf("present")).toBeGreaterThan(
      compactRoute(repaired).indexOf("repair"),
    );

    const clean = await runScenario(workflow, {
      name: "clean route for coverage",
      mockInputs: {
        plan: validPlanInput(),
        review: { issues_count: 0 },
        present: { result_summary: "Accepted test-plan.md with no remaining limitation." },
      },
      expect: { status: "completed", avoids: ["repair"] },
    });
    const coverage = calculateCoverage(workflow, [clean, repaired], { includeGapAnalysis: true });
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
  });
});
