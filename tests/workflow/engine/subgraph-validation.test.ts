/**
 * Unit Tests for Subgraph Validation
 * Test JSON Schema and custom validation rules for subgraph nodes
 */

import { describe, test, expect } from "@jest/globals";
import { GraphValidator, WorkflowGraph } from "@mcp-moira/workflow-engine";

describe("Subgraph Validation", () => {
  let validator: GraphValidator;

  beforeEach(() => {
    validator = new GraphValidator(
      "./packages/workflow-engine/src/schemas/workflow-graph-schema.json",
    );
  });

  describe("JSON Schema Validation", () => {
    test("should validate correct subgraph node structure", async () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test workflow with subgraph",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "child-workflow",
            inputMapping: {
              parentVar: "childVar",
            },
            outputMapping: {
              childResult: "parentResult",
            },
            connections: {
              success: "end",
              error: "error-handler",
            },
          },
          {
            type: "end",
            id: "end",
          },
          {
            type: "end",
            id: "error-handler",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should reject subgraph node missing required fields", async () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test workflow with invalid subgraph",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            // Missing graphId, inputMapping, outputMapping
            connections: { success: "end" },
          } as any,
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      // Should have errors for missing required fields
      const errorMessages = result.errors.map((e) => e.message).join(" ");
      expect(errorMessages).toContain("graphId");
      expect(errorMessages).toContain("inputMapping");
      expect(errorMessages).toContain("outputMapping");
    });

    test("should reject subgraph node with invalid mapping types", async () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test workflow with invalid mappings",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "child-workflow",
            inputMapping: "invalid-not-object", // Should be object
            outputMapping: {
              validPath: "", // Invalid empty string
            },
            connections: { success: "end" },
          } as any,
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test("should reject subgraph node missing success connection", async () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test workflow with missing connection",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "child-workflow",
            inputMapping: {},
            outputMapping: {},
            connections: {
              error: "error-handler", // Missing required success connection
            },
          } as any,
          {
            type: "end",
            id: "error-handler",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(false);
      // JSON Schema validation will catch missing required 'success' property
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("Custom Validation Rules", () => {
    test("should validate graphId is not empty via JSON Schema", async () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test workflow",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "", // Invalid empty graphId - caught by JSON Schema
            inputMapping: {},
            outputMapping: {},
            connections: { success: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(false);
      // JSON Schema will catch empty graphId before custom validation
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test("should reject self-referencing workflows", async () => {
      const workflow: WorkflowGraph = {
        id: "recursive-workflow",
        metadata: {
          name: "Recursive Workflow",
          version: "1.0.0",
          description: "Self-referencing workflow",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "recursive-workflow", // References itself
            inputMapping: { data: "input" },
            outputMapping: { result: "output" },
            connections: { success: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      // Self-reference causes infinite recursion — must be invalid
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("references itself"))).toBe(true);
      expect(result.errors.some((e) => e.message.includes("infinite recursion"))).toBe(true);
    });

    test("should warn about excessive input mapping complexity", async () => {
      // Create mapping with >50 variables
      const largeInputMapping: Record<string, string> = {};
      const largeOutputMapping: Record<string, string> = {};

      for (let i = 0; i < 60; i++) {
        largeInputMapping[`var${i}`] = `childVar${i}`;
        largeOutputMapping[`childResult${i}`] = `parentResult${i}`;
      }

      const workflow: WorkflowGraph = {
        id: "complex-workflow",
        metadata: {
          name: "Complex Workflow",
          version: "1.0.0",
          description: "Workflow with excessive mappings",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "child-workflow",
            inputMapping: largeInputMapping,
            outputMapping: largeOutputMapping,
            connections: { success: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.message.includes("Large input mapping"))).toBe(true);
      expect(result.warnings.some((w) => w.message.includes("Large output mapping"))).toBe(true);
    });

    test("should warn about excessive subgraph complexity", async () => {
      // Create workflow with >10 subgraph nodes
      const nodes: any[] = [
        {
          type: "start",
          id: "start",
          connections: { default: "subgraph1" },
        },
      ];

      // Add 15 subgraph nodes
      for (let i = 1; i <= 15; i++) {
        nodes.push({
          type: "subgraph",
          id: `subgraph${i}`,
          graphId: `child-workflow-${i}`,
          inputMapping: {},
          outputMapping: {},
          connections: { success: i < 15 ? `subgraph${i + 1}` : "end" },
        });
      }

      nodes.push({
        type: "end",
        id: "end",
      });

      const workflow: WorkflowGraph = {
        id: "complex-subgraph-workflow",
        metadata: {
          name: "Complex Subgraph Workflow",
          version: "1.0.0",
          description: "Workflow with many subgraphs",
        },
        nodes,
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.message.includes("15 subgraph nodes"))).toBe(true);
      expect(
        result.warnings.some((w) => w.message.includes("consolidating for better performance")),
      ).toBe(true);
    });

    test("should detect duplicate workflow references", async () => {
      const workflow: WorkflowGraph = {
        id: "duplicate-ref-workflow",
        metadata: {
          name: "Duplicate Reference Workflow",
          version: "1.0.0",
          description: "Workflow with duplicate subgraph references",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph1" },
          },
          {
            type: "subgraph",
            id: "subgraph1",
            graphId: "child-workflow", // Same workflow referenced multiple times
            inputMapping: {},
            outputMapping: {},
            connections: { success: "subgraph2" },
          },
          {
            type: "subgraph",
            id: "subgraph2",
            graphId: "child-workflow", // Duplicate reference
            inputMapping: {},
            outputMapping: {},
            connections: { success: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(true);
      expect(
        result.warnings.some((w) => w.message.includes("multiple references to the same subgraph")),
      ).toBe(true);
    });
  });

  describe("Mapping Configuration Validation", () => {
    test("should validate input mapping structure via JSON Schema", async () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test mapping validation",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "child-workflow",
            inputMapping: {
              "": "invalidEmptySource", // JSON Schema will catch empty string keys
              validSource: "", // JSON Schema will catch empty string values
            },
            outputMapping: {},
            connections: { success: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(false);
      // JSON Schema validation will catch empty string violations
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test("should validate output mapping structure via JSON Schema", async () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test output mapping validation",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "child-workflow",
            inputMapping: {},
            outputMapping: {
              "": "invalidEmptySource", // JSON Schema will catch empty string keys
              validSource: "", // JSON Schema will catch empty string values
            },
            connections: { success: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(false);
      // JSON Schema validation will catch empty string violations
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test("should validate connection requirements via JSON Schema", async () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test connection validation",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "child-workflow",
            inputMapping: {},
            outputMapping: {},
            connections: {
              error: "error-handler", // Missing required success connection
            },
          } as any,
          {
            type: "end",
            id: "error-handler",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(false);
      // JSON Schema validation will catch missing required 'success' property
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("Best Practices Validation", () => {
    test("should accept valid subgraph configurations", async () => {
      const workflow: WorkflowGraph = {
        id: "well-designed-workflow",
        metadata: {
          name: "Well Designed Workflow",
          version: "1.0.0",
          description: "Properly designed workflow with subgraphs",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "different-workflow",
            inputMapping: {
              "user.name": "userName",
              "config.database.host": "dbHost",
            },
            outputMapping: {
              result: "processResult",
              status: "processStatus",
            },
            connections: {
              success: "verify",
              error: "error-handler",
            },
          },
          {
            type: "agent-directive",
            id: "verify",
            directive: "Verify results",
            completionCondition: "Results verified",
            connections: { success: "end" },
          },
          {
            type: "end",
            id: "end",
          },
          {
            type: "end",
            id: "error-handler",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Should have minimal or no warnings
      const significantWarnings = result.warnings.filter(
        (w) => !w.message.includes("Unreachable nodes"), // Ignore unreachable warnings for test
      );
      expect(significantWarnings.length).toBeLessThanOrEqual(1);
    });

    test("should provide helpful error categorization via JSON Schema", async () => {
      const workflow: WorkflowGraph = {
        id: "problematic-workflow",
        metadata: {
          name: "Problematic Workflow",
          version: "1.0.0",
          description: "Workflow with various issues",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "", // Empty graphId - JSON Schema error
            inputMapping: null, // Invalid structure - JSON Schema error
            outputMapping: {},
            connections: {}, // Missing success - JSON Schema error
          } as any,
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(false);

      // JSON Schema validation will categorize these as 'schema' errors
      const errorTypes = result.errors.map((e) => e.type);
      expect(errorTypes).toContain("schema"); // JSON Schema errors
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("Validation Edge Cases", () => {
    test("should handle workflows with no subgraph nodes", async () => {
      const workflow: WorkflowGraph = {
        id: "no-subgraph-workflow",
        metadata: {
          name: "No Subgraph Workflow",
          version: "1.0.0",
          description: "Workflow without subgraphs",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "action" },
          },
          {
            type: "agent-directive",
            id: "action",
            directive: "Perform action",
            completionCondition: "Action completed",
            connections: { success: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Should not have subgraph-related warnings
      const subgraphWarnings = result.warnings.filter(
        (w) => w.message.includes("subgraph") || w.message.includes("Subgraph"),
      );
      expect(subgraphWarnings).toHaveLength(0);
    });

    test("should validate complex but valid subgraph configuration", async () => {
      const workflow: WorkflowGraph = {
        id: "complex-valid-workflow",
        metadata: {
          name: "Complex Valid Workflow",
          version: "1.0.0",
          description: "Complex but valid subgraph usage",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            initialData: {
              variables: {
                users: {
                  description: "User list with profile data",
                  value: [
                    { name: "John", profile: { age: 30 } },
                    { name: "Jane", profile: { age: 25 } },
                  ],
                },
                config: {
                  description: "Environment configuration",
                  value: { env: "production" },
                },
              },
            },
            connections: { default: "subgraph" },
          },
          {
            type: "subgraph",
            id: "subgraph",
            graphId: "user-processor",
            inputMapping: {
              "users[0].name": "firstName",
              "users[0].profile.age": "firstAge",
              "users[1].name": "secondName",
              "config.env": "environment",
            },
            outputMapping: {
              processedUsers: "result.users",
              "summary.total": "result.summary.count",
              "summary.avgAge": "result.summary.averageAge",
            },
            connections: { success: "end", error: "error-handler" },
          },
          {
            type: "end",
            id: "end",
          },
          {
            type: "end",
            id: "error-handler",
          },
        ],
      };

      const result = await validator.validateWorkflow(workflow);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      // May have some performance warnings but should be valid
      const errorWarnings = result.warnings.filter((w) => w.type === "performance");
      expect(errorWarnings.length).toBeLessThanOrEqual(2); // Input/output mapping warnings acceptable
    });
  });
});
