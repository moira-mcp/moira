/**
 * notes-demo-metrics-collector Scenario Tests
 *
 * Metrics collection workflow demonstrating write-note and upsert-note nodes.
 * Part 1 of the Notes Demo Metrics Pipeline.
 *
 * Uses engineSetup to inject mock NoteService into note handlers,
 * enabling both success and error path testing without a real database.
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  runScenario,
  type TestScenario,
  type ScenarioResult,
} from "../../helpers/scenario-runner.js";
import { calculateCoverage, formatCoverageReport } from "../../helpers/coverage-calculator.js";
import {
  GraphValidator,
  detectCycles,
  WriteNoteHandler,
  UpsertNoteHandler,
} from "@mcp-moira/workflow-engine";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

function loadWorkflow(): WorkflowGraph {
  return findSystemCatalogEntry("notes-demo-metrics-collector", "public")!.graph as WorkflowGraph;
}

/** Create a mock NoteService that succeeds */
function createSuccessMockNoteService() {
  return {
    exists: async () => false,
    save: async () => ({ id: "mock-id", version: 1 }),
    list: async () => ({ notes: [], total: 0, allTags: [] }),
    get: async () => ({
      id: "mock-id",
      key: "mock",
      tags: [],
      value: "{}",
      size: 2,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  } as any;
}

/** Create a mock NoteService that fails */
function createErrorMockNoteService() {
  const error = new Error("Database connection failed");
  return {
    exists: async () => {
      throw error;
    },
    save: async () => {
      throw error;
    },
    list: async () => {
      throw error;
    },
    get: async () => {
      throw error;
    },
  } as any;
}

describe("notes-demo-metrics-collector Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = {
        id: `moira/${workflow.slug || "notes-demo-metrics-collector"}`,
        ...workflow,
      };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have no cycles (linear pipeline)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles).toHaveLength(0);
    });

    it("should have expected node count", () => {
      // start + gather-metrics + write-metrics-note + upsert-latest-summary + confirm-saved + end-success + end-error
      expect(workflow.nodes.length).toBe(7);
    });
  });

  describe("Scenario Coverage", () => {
    const metricsInput = {
      projectName: "test-project",
      collectionDate: "2025-03-01",
      metrics: {
        linesOfCode: 15000,
        sourceFiles: 120,
        primaryLanguage: "TypeScript",
        totalTests: 1800,
        testPassRate: 99.5,
        testCategories: "unit, integration, e2e",
        knownIssues: 5,
        codeReviewStatus: "up-to-date",
        documentationCoverage: "good",
      },
    };

    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        {
          name: "Success path - metrics collected and saved",
          description: "Happy path: gather metrics → write note → upsert summary → confirm",
          mockInputs: {
            "gather-metrics": metricsInput,
            "confirm-saved": {},
          },
          expect: {
            reaches: [
              "start",
              "gather-metrics",
              "write-metrics-note",
              "upsert-latest-summary",
              "confirm-saved",
              "end-success",
            ],
            avoids: ["end-error"],
            status: "completed",
          },
        },
        {
          name: "Error path - write-note fails",
          description: "DB error on write-note routes to end-error",
          mockInputs: {
            "gather-metrics": metricsInput,
          },
          expect: {
            reaches: ["start", "gather-metrics", "write-metrics-note", "end-error"],
            avoids: ["upsert-latest-summary", "confirm-saved", "end-success"],
            status: "completed",
          },
        },
        {
          name: "Error path - upsert-note fails after write succeeds",
          description: "Write succeeds but upsert fails, routes to end-error",
          mockInputs: {
            "gather-metrics": metricsInput,
          },
          expect: {
            reaches: [
              "start",
              "gather-metrics",
              "write-metrics-note",
              "upsert-latest-summary",
              "end-error",
            ],
            avoids: ["confirm-saved", "end-success"],
            status: "completed",
          },
        },
      ];

      const successMock = createSuccessMockNoteService();
      const errorMock = createErrorMockNoteService();

      const results: ScenarioResult[] = [];

      // Scenario 1: Success - both note handlers use success mock
      results.push(
        await runScenario(workflow, scenarios[0], {
          engineSetup: (engine) => {
            const handlers = (engine as any).nodeHandlers as Map<string, any>;
            handlers.set("write-note", new WriteNoteHandler(successMock));
            handlers.set("upsert-note", new UpsertNoteHandler(successMock));
          },
        }),
      );

      // Scenario 2: Error on write-note
      results.push(
        await runScenario(workflow, scenarios[1], {
          engineSetup: (engine) => {
            const handlers = (engine as any).nodeHandlers as Map<string, any>;
            handlers.set("write-note", new WriteNoteHandler(errorMock));
          },
        }),
      );

      // Scenario 3: Write succeeds, upsert fails
      results.push(
        await runScenario(workflow, scenarios[2], {
          engineSetup: (engine) => {
            const handlers = (engine as any).nodeHandlers as Map<string, any>;
            handlers.set("write-note", new WriteNoteHandler(successMock));
            handlers.set("upsert-note", new UpsertNoteHandler(errorMock));
          },
        }),
      );

      // All scenarios should pass
      for (const result of results) {
        expect(result.passed).toBe(true);
        if (!result.passed) {
          console.error(`FAILED: ${result.scenario}`, result.error, result.failedExpectations);
        }
      }

      // Calculate coverage
      const coverage = calculateCoverage(workflow, results);
      console.log(formatCoverageReport(coverage));

      expect(coverage.nodeCoverage).toBe(100);
      expect(coverage.branchCoverage).toBe(100);
    });
  });
});
