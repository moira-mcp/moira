/**
 * notes-demo-metrics-reporter Scenario Tests
 *
 * Metrics reporting workflow demonstrating read-note node and {{note:KEY}} template syntax.
 * Part 2 of the Notes Demo Metrics Pipeline.
 *
 * Uses engineSetup to inject mock NoteService into the read-note handler,
 * enabling both success and error path testing without a real database.
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  runScenario,
  type TestScenario,
  type ScenarioResult,
} from "../../helpers/scenario-runner.js";
import { calculateCoverage, formatCoverageReport } from "../../helpers/coverage-calculator.js";
import { GraphValidator, detectCycles, ReadNoteHandler } from "@mcp-moira/workflow-engine";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

function loadWorkflow(): WorkflowGraph {
  return findSystemCatalogEntry("notes-demo-metrics-reporter", "public")!.graph as WorkflowGraph;
}

/** Create a mock NoteService that returns metrics data */
function createSuccessMockNoteService() {
  const now = Date.now();
  const mockNote = {
    id: "note-1",
    key: "metrics-test-project-2025-03-01",
    tags: ["metrics", "test-project", "raw-data"],
    value: JSON.stringify({
      linesOfCode: 15000,
      sourceFiles: 120,
      primaryLanguage: "TypeScript",
      totalTests: 1800,
      testPassRate: 99.5,
    }),
    size: 150,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  return {
    exists: async () => true,
    save: async () => ({ id: "mock-id", version: 1 }),
    list: async () => ({
      notes: [
        {
          id: mockNote.id,
          key: mockNote.key,
          tags: mockNote.tags,
          size: mockNote.size,
          currentVersion: 1,
          preview: mockNote.value.slice(0, 100),
          createdAt: now,
          updatedAt: now,
        },
      ],
      total: 1,
      allTags: ["metrics", "test-project", "raw-data"],
    }),
    get: async () => mockNote,
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

describe("notes-demo-metrics-reporter Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "notes-demo-metrics-reporter"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have no cycles (linear pipeline with error branch)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles).toHaveLength(0);
    });

    it("should have expected node count", () => {
      // start + ask-project + load-all-metrics + generate-report + no-data + end-success + end-no-data
      expect(workflow.nodes.length).toBe(7);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        {
          name: "Success path - metrics found and report generated",
          description: "Happy path: ask project → read notes → generate report",
          mockInputs: {
            "ask-project": { projectName: "test-project" },
            "generate-report": {
              report:
                "# Metrics Report\n## test-project\n- Lines: 15000\n- Tests: 1800 (99.5% pass)",
            },
          },
          expect: {
            reaches: ["start", "ask-project", "load-all-metrics", "generate-report", "end-success"],
            avoids: ["no-data", "end-no-data"],
            status: "completed",
          },
        },
        {
          name: "Error path - no metrics data found",
          description: "DB error on read-note routes to no-data handler",
          mockInputs: {
            "ask-project": { projectName: "unknown-project" },
            "no-data": {},
          },
          expect: {
            reaches: ["start", "ask-project", "load-all-metrics", "no-data", "end-no-data"],
            avoids: ["generate-report", "end-success"],
            status: "completed",
          },
        },
      ];

      const successMock = createSuccessMockNoteService();
      const errorMock = createErrorMockNoteService();

      const results: ScenarioResult[] = [];

      // Scenario 1: Success - read-note returns data
      results.push(
        await runScenario(workflow, scenarios[0], {
          engineSetup: (engine) => {
            const handlers = (engine as any).nodeHandlers as Map<string, any>;
            handlers.set("read-note", new ReadNoteHandler(successMock));
          },
        }),
      );

      // Scenario 2: Error - read-note fails
      results.push(
        await runScenario(workflow, scenarios[1], {
          engineSetup: (engine) => {
            const handlers = (engine as any).nodeHandlers as Map<string, any>;
            handlers.set("read-note", new ReadNoteHandler(errorMock));
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
