/**
 * CLI/MCP Parity Verification Tests
 *
 * Verifies that CLI and MCP produce identical results by using the same shared functions.
 * This is the core of Step 4 DRY principle implementation.
 */

import { describe, it, expect } from "@jest/globals";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import {
  listNodesCompact,
  analyzeVariableUsage,
  searchWorkflow,
} from "@mcp-moira/shared/services/workflow-query-service";

// Test workflow with various node types and variables
const testWorkflow: WorkflowGraph = {
  id: "parity-test",
  metadata: {
    name: "Parity Test Workflow",
    version: "1.0.0",
    description: "Workflow for testing CLI/MCP parity",
  },
  variableRegistry: {
    apiKey: { type: "string", description: "API key for external service", default: "sk-test-123" },
    maxRetries: { type: "number", description: "Maximum retry attempts", default: 3 },
    result: {
      type: "string",
      description: "Analysis result produced by analyze, used by validate",
    },
  },
  nodes: [
    {
      type: "start",
      id: "start",
      connections: {
        default: "analyze",
      },
    },
    {
      type: "agent-directive",
      id: "analyze",
      directive: "Analyze the data using {{apiKey}} with max {{maxRetries}} retries",
      completionCondition: "Analysis completed successfully",
      inputSchema: {
        type: "object",
        properties: {
          result: {
            type: "string",
            description: "Analysis result",
          },
        },
        required: ["result"],
      },
      connections: {
        success: "validate",
      },
    },
    {
      type: "agent-directive",
      id: "validate",
      directive: "Validate the result: {{result}}",
      completionCondition: "Validation passed",
      connections: {
        success: "end",
      },
    },
    {
      type: "end",
      id: "end",
      finalOutput: ["result"],
    },
  ],
  startNodeId: "start",
  endNodeIds: ["end"],
};

describe("CLI/MCP Parity Verification", () => {
  describe("listNodesCompact() parity", () => {
    it("produces consistent output structure for all nodes", () => {
      const nodes = listNodesCompact(testWorkflow);

      expect(nodes).toHaveLength(4);
      expect(nodes[0]).toEqual({
        id: "start",
        type: "start",
        connections: ["analyze"],
        directivePreview: undefined,
      });
      expect(nodes[1]).toEqual({
        id: "analyze",
        type: "agent-directive",
        connections: ["validate"],
        directivePreview: "Analyze the data using {{apiKey}} with max {{maxRetries}} retries",
      });
    });

    it("filters by type consistently", () => {
      const agentNodes = listNodesCompact(testWorkflow, { typeFilter: "agent-directive" });

      expect(agentNodes).toHaveLength(2);
      expect(agentNodes.map((n) => n.id)).toEqual(["analyze", "validate"]);
    });

    it("respects preview length option", () => {
      const nodes = listNodesCompact(testWorkflow, { previewLength: 20 });
      const analyzeNode = nodes.find((n) => n.id === "analyze");

      // Preview is truncated to previewLength characters + "..."
      expect(analyzeNode?.directivePreview).toHaveLength(23); // 20 chars + "..."
      expect(analyzeNode?.directivePreview).toMatch(/^Analyze the data .+\.\.\.$/);
    });

    it("excludes preview when includePreview is false", () => {
      const nodes = listNodesCompact(testWorkflow, { includePreview: false });

      nodes.forEach((node) => {
        expect(node.directivePreview).toBeUndefined();
      });
    });
  });

  describe("analyzeVariableUsage() parity", () => {
    it("finds all variable sources from the registry", () => {
      const analysis = analyzeVariableUsage(testWorkflow);

      expect(analysis.apiKey).toBeDefined();
      expect(analysis.apiKey.sources).toContainEqual({
        type: "registry",
        nodeId: "start",
        description: "API key for external service",
      });

      expect(analysis.maxRetries).toBeDefined();
      expect(analysis.maxRetries.sources).toContainEqual({
        type: "registry",
        nodeId: "start",
        description: "Maximum retry attempts",
      });
    });

    it("finds all variable sources from inputSchema", () => {
      const analysis = analyzeVariableUsage(testWorkflow);

      expect(analysis.result).toBeDefined();
      expect(analysis.result.sources).toContainEqual({
        type: "inputSchema",
        nodeId: "analyze",
        description: "Analysis result",
      });
    });

    it("finds all variable usages in templates", () => {
      const analysis = analyzeVariableUsage(testWorkflow);

      // apiKey used in analyze directive
      expect(analysis.apiKey.usages).toContainEqual(
        expect.objectContaining({
          nodeId: "analyze",
          field: "directive",
        }),
      );

      // maxRetries used in analyze directive
      expect(analysis.maxRetries.usages).toContainEqual(
        expect.objectContaining({
          nodeId: "analyze",
          field: "directive",
        }),
      );

      // result used in validate directive
      expect(analysis.result.usages).toContainEqual(
        expect.objectContaining({
          nodeId: "validate",
          field: "directive",
        }),
      );
    });

    it("counts usages correctly", () => {
      const analysis = analyzeVariableUsage(testWorkflow);

      expect(analysis.apiKey.usages.length).toBe(1);
      expect(analysis.maxRetries.usages.length).toBe(1);
      expect(analysis.result.usages.length).toBe(1);
    });
  });

  describe("searchWorkflow() parity", () => {
    it("finds matches in node directives", () => {
      const results = searchWorkflow(testWorkflow, "Analyze");

      expect(results.length).toBeGreaterThan(0);
      expect(results).toContainEqual(
        expect.objectContaining({
          type: "node",
          nodeId: "analyze",
          matchedIn: expect.arrayContaining(["directive"]),
        }),
      );
    });

    it("finds matches in variables when includeVariables is true", () => {
      const results = searchWorkflow(testWorkflow, "API key", { includeVariables: true });

      expect(results).toContainEqual(
        expect.objectContaining({
          type: "variable",
          variableName: "apiKey",
          matchedIn: expect.arrayContaining(["description"]),
        }),
      );
    });

    it("does not find variables when includeVariables is false", () => {
      const results = searchWorkflow(testWorkflow, "API key", { includeVariables: false });

      const variableResults = results.filter((r) => r.type === "variable");
      expect(variableResults).toHaveLength(0);
    });

    it("returns snippets in snippetMode", () => {
      const results = searchWorkflow(testWorkflow, "retries", { snippetMode: true });

      const analyzeResult = results.find((r) => r.nodeId === "analyze");
      expect(analyzeResult?.snippet).toBeDefined();
      expect(analyzeResult?.snippet).toContain("retries");
    });

    it("supports regex patterns", () => {
      const results = searchWorkflow(testWorkflow, "Analyze|Validate");

      expect(results.length).toBe(2);
      expect(results.map((r) => r.nodeId)).toContain("analyze");
      expect(results.map((r) => r.nodeId)).toContain("validate");
    });
  });

  describe("Shared function consistency", () => {
    it("listNodesCompact returns same structure regardless of caller", () => {
      // Call twice to verify deterministic output
      const result1 = listNodesCompact(testWorkflow);
      const result2 = listNodesCompact(testWorkflow);

      expect(result1).toEqual(result2);
    });

    it("analyzeVariableUsage returns same structure regardless of caller", () => {
      const result1 = analyzeVariableUsage(testWorkflow);
      const result2 = analyzeVariableUsage(testWorkflow);

      expect(result1).toEqual(result2);
    });

    it("searchWorkflow returns same results for same query", () => {
      const result1 = searchWorkflow(testWorkflow, "data");
      const result2 = searchWorkflow(testWorkflow, "data");

      expect(result1).toEqual(result2);
    });
  });
});
