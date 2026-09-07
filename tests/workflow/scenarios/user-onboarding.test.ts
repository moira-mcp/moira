/**
 * Contract and behavioral scenarios for moira/user-onboarding.
 *
 * The flow teaches the execution model, resolves an exact qualified target from the complete
 * authorized public catalog, and either defers without mutation or starts one linked child.
 */

import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import { GraphValidator, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import {
  runScenario,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

const catalogEntry = findCatalogEntryBySlug("user-onboarding")!;
const childId = "11111111-1111-4111-8111-111111111111";

function loadWorkflow(): WorkflowGraph {
  return structuredClone(catalogEntry.graph) as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): any {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

async function runInvalidWelcome(input: Record<string, unknown>): Promise<ScenarioResult> {
  return runScenario(loadWorkflow(), {
    name: "invalid onboarding selection",
    description: "The real response boundary must reject an invalid selection contract",
    mockInputs: { welcome: input },
    expect: { status: "completed" },
  });
}

describe("user-onboarding", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("validates selection and handoff routing", async () => {
    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(node(workflow, "selection-valid").connections).toEqual({
      true: "route-intent",
      false: "welcome",
    });
    expect(node(workflow, "check-start-now").connections).toEqual({
      true: "start-chosen-workflow",
      false: "end",
    });
  });

  test("binds create-own to the workflow authoring flow at the response boundary", async () => {
    const result = await runInvalidWelcome({
      user_intent: "create_own",
      selected_workflow: "moira/quick-task",
      selection_valid: true,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'welcome'");
    expect(result.visitedNodes).not.toContain("route-intent");
  });

  test.each([
    "-usr/slug",
    "user/-slug",
    "us--er/slug",
    "user/sl--ug",
    `${"a".repeat(41)}/slug`,
    `user/${"b".repeat(81)}`,
  ])("rejects invalid qualified identity %s", async (selected_workflow) => {
    const result = await runInvalidWelcome({
      user_intent: "try_existing",
      selected_workflow,
      selection_valid: false,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'welcome'");
    expect(result.visitedNodes).not.toContain("selection-valid");
  });

  test("covers existing, authoring, start, defer, and invalid-selection retry routes", async () => {
    const scenarios: TestScenario[] = [
      {
        name: "existing workflow starts as a linked child",
        mockInputs: {
          welcome: {
            user_intent: "try_existing",
            selected_workflow: "moira/data-analysis",
            selection_valid: true,
          },
          "launch-workflow": { handoff_decision: "start" },
          "start-chosen-workflow": { child_execution_id: childId },
        },
        expect: {
          status: "completed",
          contextContains: {
            user_intent: "try_existing",
            selected_workflow: "moira/data-analysis",
            handoff_decision: "start",
            child_execution_id: childId,
          },
        },
      },
      {
        name: "existing workflow is deferred without handoff",
        mockInputs: {
          welcome: {
            user_intent: "try_existing",
            selected_workflow: "moira/verified-research",
            selection_valid: true,
          },
          "launch-workflow": { handoff_decision: "defer" },
        },
        expect: {
          status: "completed",
          avoids: ["start-chosen-workflow", "suggest-creation"],
          contextContains: { handoff_decision: "defer" },
        },
      },
      {
        name: "workflow authoring starts as a linked child",
        mockInputs: {
          welcome: {
            user_intent: "create_own",
            selected_workflow: "moira/workflow-management-flow",
            selection_valid: true,
          },
          "suggest-creation": { handoff_decision: "start" },
          "start-chosen-workflow": { child_execution_id: childId },
        },
        expect: { status: "completed", reaches: ["suggest-creation"] },
      },
      {
        name: "workflow authoring is deferred",
        mockInputs: {
          welcome: {
            user_intent: "create_own",
            selected_workflow: "moira/workflow-management-flow",
            selection_valid: true,
          },
          "suggest-creation": { handoff_decision: "defer" },
        },
        expect: { status: "completed", avoids: ["start-chosen-workflow"] },
      },
      {
        name: "absent qualified target returns to the catalog selection owner",
        mockInputs: {
          welcome: [
            {
              user_intent: "try_existing",
              selected_workflow: "moira/not-in-catalog",
              selection_valid: false,
            },
            {
              user_intent: "try_existing",
              selected_workflow: "moira/test-planning",
              selection_valid: true,
            },
          ],
          "launch-workflow": { handoff_decision: "defer" },
        },
        expect: { status: "completed", reaches: ["selection-valid", "launch-workflow"] },
      },
    ];

    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) {
      results.push(await runScenario(workflow, scenario));
    }

    expect(results.filter((result) => !result.passed)).toEqual([]);
    expect(results[4].inputSubmissionCounts.welcome).toBe(2);
    expect(results[1].finalContext.child_execution_id).toBeUndefined();
    expect(results[3].finalContext.child_execution_id).toBeUndefined();

    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
  });
});
