/**
 * Contract and behavioral scenarios for moira/prd-creation.
 *
 * The flow writes a canonical structured PRD and an exact Markdown projection in one safe
 * workspace. Delivery is reachable only after an independent zero-finding review; every
 * non-zero result must be repaired and reviewed again.
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { GraphValidator, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import {
  runScenario,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

type PrdContract = Record<string, unknown>;

const catalogEntry = findSystemCatalogEntry("prd-creation", "public")!;

function loadWorkflow(): WorkflowGraph {
  return structuredClone(catalogEntry.graph) as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): any {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function validContract(): PrdContract {
  return {
    title: "Idempotent checkout retries",
    executive_summary: "Prevent duplicate orders and charges when checkout is retried.",
    evidence_sources: [
      {
        id: "EV-1",
        kind: "code",
        source: "checkout retry handler and incident record",
        finding: "A timeout can trigger a second charge for the same checkout request.",
      },
    ],
    evidence_gaps: [],
    problem: {
      statement: "Checkout retries can create duplicate charges and orders.",
      target_users: [
        {
          id: "USER-1",
          name: "Online shopper",
          role: "Customer",
          context: "Retries checkout after an ambiguous timeout.",
        },
      ],
      urgency: "The failure can cause immediate financial and support impact.",
      cost_of_inaction: "Customers can be charged twice and require manual refunds.",
      evidence_ids: ["EV-1"],
    },
    solution: {
      description: "Use one idempotency key for charge and order creation.",
      rationale: "A durable key makes retries converge on the original result.",
      alternatives: [],
      in_scope: ["Checkout charge and order idempotency"],
      out_of_scope: ["Payment-provider settlement changes"],
      constraints: [],
      dependencies: [],
      previous_attempts: [],
      evidence_ids: ["EV-1"],
    },
    requirements: [
      {
        id: "REQ-1",
        statement: "A repeated checkout key must return the original order without a new charge.",
        priority: "must",
        priority_rationale: "Duplicate charging is release-blocking.",
        evidence_ids: ["EV-1"],
        acceptance_criteria: [
          {
            id: "AC-1",
            statement: "A timeout followed by a retry leaves exactly one charge and one order.",
          },
        ],
      },
    ],
    user_stories: [
      {
        id: "STORY-1",
        actor: "Online shopper",
        goal: "retry checkout safely after a timeout",
        outcome: "receive one order and one charge",
        requirement_ids: ["REQ-1"],
        acceptance_criterion_ids: ["AC-1"],
      },
    ],
    edge_cases: [
      {
        id: "EDGE-1",
        scenario: "The first charge succeeds but its response times out.",
        expected_behavior: "The retry returns the existing order and charge.",
        recovery: "Reconcile the stored idempotency record before returning the result.",
        requirement_ids: ["REQ-1"],
      },
    ],
    metrics: {
      primary: {
        id: "METRIC-1",
        name: "Duplicate charge rate",
        baseline: "Current incident baseline is measured before release.",
        target: "Zero duplicate charges in retry integration scenarios.",
        measurement_method: "Count duplicate charges by idempotency key in tests and monitoring.",
        timeframe: "During release validation and the first 30 production days.",
        evidence_ids: ["EV-1"],
        requirement_ids: ["REQ-1"],
      },
      secondary: [],
    },
    assumptions: [],
    risks: [
      {
        id: "RISK-1",
        description: "A partial write can leave the idempotency record incomplete.",
        likelihood: "medium",
        impact: "high",
        mitigation: "Persist charge, order, and key atomically or reconcile before retry.",
        requirement_ids: ["REQ-1"],
      },
    ],
    applicability_decisions: [],
    open_questions: [],
    limitations: [],
    readiness: "ready-with-limitations",
    readiness_rationale: "Implementation can start after the baseline measurement is captured.",
  };
}

function validAuthorInput(contract = validContract()): Record<string, unknown> {
  return {
    workspace_path: "./moira-ws/prd-creation-checkout_20260820",
    prd_contract: contract,
  };
}

async function runInvalidAuthor(input: Record<string, unknown>): Promise<ScenarioResult> {
  return runScenario(loadWorkflow(), {
    name: "malformed PRD author response",
    description: "The actual engine must reject malformed PRD data before review",
    mockInputs: { author: input },
    expect: { status: "completed" },
  });
}

function compactRoute(result: ScenarioResult): string[] {
  return result.visitedNodes.filter((id, index, all) => id !== all[index - 1]);
}

describe("prd-creation", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("preserves public identity and has the intended valid clean-or-repair graph", async () => {
    expect(catalogEntry.owner).toBe("system-moira");
    expect(catalogEntry.slug).toBe("prd-creation");
    expect(catalogEntry.visibility).toBe("public");
    expect(workflow.id).toBe("bc9be4e1-78d3-43e0-a512-6a571c24f7e2");
    expect(workflow.metadata.version).toBe("2.0.0");
    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(workflow.nodes.map((candidate) => candidate.id)).toEqual([
      "start",
      "end",
      "author",
      "review",
      "review-gate",
      "present",
      "repair",
    ]);
    expect(node(workflow, "review-gate").connections).toEqual({ true: "present", false: "repair" });
    expect(node(workflow, "repair").connections).toEqual({ success: "review" });
    expect(node(workflow, "end").finalOutput).toEqual(["workspace_path", "result_summary"]);
  });

  test("publishes a decision-useful description and explicit local-only authority", () => {
    const description = workflow.metadata.description;
    expect(description).toContain("evidence-grounded Product Requirements Document");
    expect(description).toContain("prd.contract.json");
    expect(description).toContain("prd.md projection");
    expect(description).toContain("independent file-backed reviewer");
    expect(description).toContain("delivery is unreachable while known blocking gaps remain");
    expect(description).toContain(
      "does not implement the product, modify project files, execute tests",
    );
    expect(description).toContain("Choose PRD Creation");
    expect(description).toContain("Software Development Flow");
    for (const id of ["author", "review", "repair", "present"]) {
      const directive = node(workflow, id).directive;
      expect(directive).toMatch(/implement the product/i);
      expect(directive).toMatch(/execute (any )?tests/i);
      expect(directive).toMatch(/publish|upload/i);
      expect(directive).toMatch(/deploy/i);
    }
  });

  test("uses one traversal-safe workspace, fixed artifacts, and only consumed global state", () => {
    const registry = workflow.variableRegistry!;
    expect(Object.keys(registry).sort()).toEqual([
      "issues_count",
      "result_summary",
      "workspace_path",
    ]);
    expect(registry.workspace_path.pattern).toBe(
      "^\\./moira-ws/prd-creation-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    );
    expect(node(workflow, "author").inputSchema.globalInputs).toEqual(["workspace_path"]);
    for (const id of ["review", "repair"]) {
      const directive = node(workflow, id).directive;
      for (const file of [
        "prd-requirements.md",
        "prd-standards.md",
        "prd.contract.json",
        "prd.md",
        "review.md",
      ]) {
        expect(directive).toContain(`{{workspace_path}}/${file}`);
      }
    }
    for (const file of ["prd.contract.json", "prd.md", "review.md"]) {
      expect(node(workflow, "present").directive).toContain(`{{workspace_path}}/${file}`);
    }
  });

  test("keeps author and repair on the same closed, bounded canonical contract schema", () => {
    const authorSchema = node(workflow, "author").inputSchema.properties.prd_contract;
    const repairSchema = node(workflow, "repair").inputSchema.properties.prd_contract;
    expect(repairSchema).toEqual(authorSchema);
    expect(authorSchema.additionalProperties).toBe(false);
    expect(authorSchema.properties.requirements.items.additionalProperties).toBe(false);
    expect(authorSchema.properties.user_stories.items.properties.requirement_ids.minItems).toBe(1);
    expect(authorSchema.properties.edge_cases.items.required).toContain("recovery");
    expect(authorSchema.properties.metrics.properties.primary.required).toEqual(
      expect.arrayContaining(["baseline", "target", "measurement_method", "timeframe"]),
    );
    expect(authorSchema.properties.readiness.enum).toEqual([
      "ready",
      "ready-with-limitations",
      "not-ready",
    ]);
  });

  test.each([
    "title",
    "executive_summary",
    "evidence_sources",
    "evidence_gaps",
    "problem",
    "solution",
    "requirements",
    "user_stories",
    "edge_cases",
    "metrics",
    "assumptions",
    "risks",
    "applicability_decisions",
    "open_questions",
    "limitations",
    "readiness",
    "readiness_rationale",
  ])("rejects a contract missing required top-level field %s", async (field) => {
    const contract = validContract();
    delete contract[field];
    const result = await runInvalidAuthor(validAuthorInput(contract));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'author'");
    expect(result.visitedNodes).not.toContain("review");
  });

  test("rejects an evidence record without a finding", async () => {
    const contract = validContract() as any;
    delete contract.evidence_sources[0].finding;
    const result = await runInvalidAuthor(validAuthorInput(contract));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'author'");
    expect(result.visitedNodes).not.toContain("review");
  });

  test("rejects an edge case without a recovery path", async () => {
    const contract = validContract() as any;
    delete contract.edge_cases[0].recovery;
    const result = await runInvalidAuthor(validAuthorInput(contract));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'author'");
    expect(result.visitedNodes).not.toContain("review");
  });

  test.each(["measurement_method", "timeframe"])(
    "rejects a primary metric without %s",
    async (field) => {
      const contract = validContract() as any;
      delete contract.metrics.primary[field];
      const result = await runInvalidAuthor(validAuthorInput(contract));
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Input validation failed for node 'author'");
      expect(result.visitedNodes).not.toContain("review");
    },
  );

  test.each(["requirement_ids", "acceptance_criterion_ids"])(
    "rejects a user story with an empty %s link set",
    async (field) => {
      const contract = validContract() as any;
      contract.user_stories[0][field] = [];
      const result = await runInvalidAuthor(validAuthorInput(contract));
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Input validation failed for node 'author'");
      expect(result.visitedNodes).not.toContain("review");
    },
  );

  test.each([
    "./moira-ws/prd-creation-../../tmp",
    "./moira-ws/prd-creation-.",
    "./moira-ws/prd-creation-a//b",
    "./moira-ws/prd-creation-a/other",
  ])("rejects unsafe or nested workspace %s", async (workspacePath) => {
    const result = await runInvalidAuthor({ ...validAuthorInput(), workspace_path: workspacePath });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'author'");
    expect(result.visitedNodes).not.toContain("review");
  });

  test("delivers a valid PRD only after a zero-finding independent review", async () => {
    const result = await runScenario(workflow, {
      name: "clean reviewed PRD",
      mockInputs: {
        author: validAuthorInput(),
        review: { issues_count: 0 },
        present: {
          result_summary:
            "Accepted PRD: ./moira-ws/prd-creation-checkout_20260820/prd.md; readiness has documented limitations.",
        },
      },
      expect: { status: "completed", avoids: ["repair"] },
    });
    expect(result.passed).toBe(true);
    expect(compactRoute(result)).toEqual([
      "start",
      "author",
      "review",
      "review-gate",
      "present",
      "end",
    ]);
    expect(result.finalContext.workspace_path).toBe("./moira-ws/prd-creation-checkout_20260820");
    expect(result.finalContext).not.toHaveProperty("prd_contract");
  });

  test("repairs a finding, re-reviews, and covers every reachable route", async () => {
    const repairedContract = validContract();
    repairedContract.readiness_rationale =
      "The baseline is now recorded and all approved implementation prerequisites are resolved.";
    const repairScenario: TestScenario = {
      name: "unsupported readiness repaired",
      description: "The independent report blocks delivery until repaired artifacts pass",
      mockInputs: {
        author: validAuthorInput(),
        review: [{ issues_count: 1 }, { issues_count: 0 }],
        repair: { prd_contract: repairedContract },
        present: {
          result_summary:
            "Accepted repaired PRD: ./moira-ws/prd-creation-checkout_20260820/prd.md.",
        },
      },
      expect: { status: "completed", reaches: ["repair", "present"] },
    };
    const repaired = await runScenario(workflow, repairScenario);
    expect(repaired.passed).toBe(true);
    expect(compactRoute(repaired)).toEqual([
      "start",
      "author",
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

    const clean = await runScenario(workflow, {
      name: "clean route for coverage",
      mockInputs: {
        author: validAuthorInput(),
        review: { issues_count: 0 },
        present: { result_summary: "Accepted prd.md with documented readiness." },
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
