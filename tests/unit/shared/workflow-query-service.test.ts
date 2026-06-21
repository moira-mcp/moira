/**
 * Unit tests for WorkflowQueryService
 * Tests pure functions for workflow analysis
 */

import { describe, test, expect } from "@jest/globals";
import {
  getWorkflowStructure,
  getNode,
  searchNodes,
  validateWorkflow,
  getWorkflowVariables,
  setWorkflowVariable,
  deleteWorkflowVariable,
  buildFlowGraph,
  // New shared functions for CLI/MCP parity
  listNodesCompact,
  analyzeVariableUsage,
  searchWorkflow,
} from "@mcp-moira/shared";
import type { WorkflowGraph, WorkflowNode } from "@mcp-moira/workflow-engine";

// Helper to create a minimal valid workflow
function createWorkflow(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    id: "test-workflow",
    metadata: {
      name: "Test Workflow",
      version: "1.0.0",
      description: "Test description",
    },
    nodes: [
      { id: "start", type: "start", connections: { default: "step-1" } },
      {
        id: "step-1",
        type: "agent-directive",
        directive: "Do something",
        completionCondition: "Task completed",
        connections: { default: "end" },
      },
      { id: "end", type: "end" },
    ],
    ...overrides,
  } as WorkflowGraph;
}

describe("WorkflowQueryService", () => {
  describe("getWorkflowStructure", () => {
    test("should return structure with metadata and stats", () => {
      const workflow = createWorkflow();
      const structure = getWorkflowStructure(workflow);

      expect(structure.id).toBe("test-workflow");
      expect(structure.metadata.name).toBe("Test Workflow");
      expect(structure.metadata.version).toBe("1.0.0");
      expect(structure.stats.totalNodes).toBe(3);
      expect(structure.stats.byType["start"]).toBe(1);
      expect(structure.stats.byType["agent-directive"]).toBe(1);
      expect(structure.stats.byType["end"]).toBe(1);
    });

    test("should return graph connections", () => {
      const workflow = createWorkflow();
      const structure = getWorkflowStructure(workflow);

      expect(structure.graph).toHaveLength(3);
      expect(structure.graph[0]).toEqual({
        nodeId: "start",
        type: "start",
        connections: { default: "step-1" },
      });
    });

    test("should handle workflow with no connections", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start" },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });
      const structure = getWorkflowStructure(workflow);

      expect(structure.graph[0].connections).toEqual({});
    });

    test("should include optional metadata fields", () => {
      const workflow = createWorkflow({
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Desc",
          author: "Test Author",
          tags: ["tag1", "tag2"],
        },
      });
      const structure = getWorkflowStructure(workflow);

      expect(structure.metadata.author).toBe("Test Author");
      expect(structure.metadata.tags).toEqual(["tag1", "tag2"]);
    });
  });

  describe("getNode", () => {
    test("should return node by ID", () => {
      const workflow = createWorkflow();
      const node = getNode(workflow, "step-1");

      expect(node).not.toBeNull();
      expect(node?.id).toBe("step-1");
      expect(node?.type).toBe("agent-directive");
    });

    test("should return null for non-existent node", () => {
      const workflow = createWorkflow();
      const node = getNode(workflow, "non-existent");

      expect(node).toBeNull();
    });
  });

  describe("searchNodes", () => {
    test("should find nodes by directive text", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "step-1" } },
          {
            id: "step-1",
            type: "agent-directive",
            directive: "Search for files in the project",
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const results = searchNodes(workflow, "files");
      expect(results).toHaveLength(1);
      expect(results[0].node.id).toBe("step-1");
      expect(results[0].matchedIn).toContain("directive");
    });

    test("should find nodes by completionCondition", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "step-1" } },
          {
            id: "step-1",
            type: "agent-directive",
            directive: "Do something",
            completionCondition: "All tests pass successfully",
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const results = searchNodes(workflow, "tests pass");
      expect(results).toHaveLength(1);
      expect(results[0].matchedIn).toContain("completionCondition");
    });

    test("should find nodes by ID", () => {
      const workflow = createWorkflow();
      const results = searchNodes(workflow, "step-1");

      expect(results).toHaveLength(1);
      expect(results[0].matchedIn).toContain("id");
    });

    test("should support regex patterns with |", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "validate" } },
          {
            id: "validate",
            type: "agent-directive",
            directive: "Validate the input",
            connections: { default: "verify" },
          },
          {
            id: "verify",
            type: "agent-directive",
            directive: "Verify the output",
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const results = searchNodes(workflow, "validate|verify");
      expect(results).toHaveLength(2);
    });

    test("should be case insensitive", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "step-1" } },
          {
            id: "step-1",
            type: "agent-directive",
            directive: "UPPERCASE directive",
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const results = searchNodes(workflow, "uppercase");
      expect(results).toHaveLength(1);
    });

    test("should return snippet from matching content", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "step-1" } },
          {
            id: "step-1",
            type: "agent-directive",
            directive: "First line\nSecond line with keyword\nThird line",
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const results = searchNodes(workflow, "keyword");
      expect(results[0].snippet).toContain("keyword");
    });
  });

  describe("validateWorkflow", () => {
    test("should validate a correct workflow", () => {
      const workflow = createWorkflow();
      const result = validateWorkflow(workflow);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("does not require a top-level workflow id (server-assigned)", () => {
      // Definition files omit the top-level id; the server assigns it on save.
      const workflow = createWorkflow({ id: "" });
      const result = validateWorkflow(workflow);

      expect(result.errors.some((e) => e.code === "MISSING_ID")).toBe(false);
    });

    test("should detect missing metadata", () => {
      const workflow = createWorkflow();
      // @ts-expect-error - intentionally setting to undefined for test
      workflow.metadata = undefined;
      const result = validateWorkflow(workflow);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "MISSING_METADATA")).toBe(true);
    });

    test("should detect duplicate node IDs", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "dup" } },
          { id: "dup", type: "agent-directive", connections: { default: "end" } },
          { id: "dup", type: "agent-directive", connections: { default: "end" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });
      const result = validateWorkflow(workflow);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "DUPLICATE_NODE_ID")).toBe(true);
    });

    test("should detect invalid connections", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "non-existent" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });
      const result = validateWorkflow(workflow);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "INVALID_CONNECTION")).toBe(true);
    });

    test("should detect missing start node", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "step-1", type: "agent-directive", connections: { default: "end" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });
      const result = validateWorkflow(workflow);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === "MISSING_START")).toBe(true);
    });

    test("should warn about missing end node", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "step-1" } },
          { id: "step-1", type: "agent-directive" },
        ] as WorkflowNode[],
      });
      const result = validateWorkflow(workflow);

      expect(result.warnings.some((w) => w.code === "MISSING_END")).toBe(true);
    });

    test("should warn about unreachable nodes", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "step-1" } },
          { id: "step-1", type: "agent-directive", connections: { default: "end" } },
          { id: "orphan", type: "agent-directive" }, // Not connected
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });
      const result = validateWorkflow(workflow);

      expect(
        result.warnings.some((w) => w.code === "UNREACHABLE_NODE" && w.nodeId === "orphan"),
      ).toBe(true);
    });

    test("should warn about multiple start nodes", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "start2", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });
      const result = validateWorkflow(workflow);

      expect(result.warnings.some((w) => w.code === "MULTIPLE_STARTS")).toBe(true);
    });
  });

  describe("getWorkflowVariables", () => {
    test("should return declared globals from the variableRegistry", () => {
      const workflow = createWorkflow({
        variableRegistry: {
          projectName: { type: "string", description: "Project name", default: "MyProject" },
          debug: { type: "boolean", description: "Debug mode flag", default: true },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const variables = getWorkflowVariables(workflow);
      expect(variables).toEqual({
        projectName: { description: "Project name", value: "MyProject", type: "string" },
        debug: { description: "Debug mode flag", value: true, type: "boolean" },
      });
    });

    test("should return empty object if no registry", () => {
      const workflow = createWorkflow();
      const variables = getWorkflowVariables(workflow);

      expect(variables).toEqual({});
    });

    test("ignores legacy start initialData.variables (no fallback)", () => {
      const workflow = createWorkflow({
        nodes: [
          {
            id: "start",
            type: "start",
            connections: { default: "end" },
            initialData: { variables: { legacy: { description: "Legacy", value: 1 } } },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      // No registry → no declared globals; initialData is not a fallback source.
      expect(getWorkflowVariables(workflow)).toEqual({});
    });

    test("reads declared globals from the variableRegistry (REG_ONLY workflow)", () => {
      // Registry-model workflow with NO start initialData.variables — the registry is the
      // only declaration site (the 8 REG_ONLY production flows look like this).
      const workflow = createWorkflow({
        variableRegistry: {
          counter: { type: "number", description: "A counter", default: 0 },
          label: { type: "string", description: "A label" },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const variables = getWorkflowVariables(workflow);
      expect(variables).toEqual({
        counter: { description: "A counter", value: 0, type: "number" },
        label: { description: "A label", value: null, type: "string" },
      });
    });

    test("registry takes precedence over legacy initialData.variables", () => {
      const workflow = createWorkflow({
        variableRegistry: {
          fromRegistry: { type: "string", description: "Declared in registry" },
        },
        nodes: [
          {
            id: "start",
            type: "start",
            connections: { default: "end" },
            initialData: {
              variables: { fromInitial: { description: "Legacy", value: "x" } },
            },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const variables = getWorkflowVariables(workflow);
      expect(Object.keys(variables)).toEqual(["fromRegistry"]);
    });
  });

  describe("setWorkflowVariable / deleteWorkflowVariable (registry model)", () => {
    function registryWorkflow(): WorkflowGraph {
      return createWorkflow({
        variableRegistry: {
          counter: { type: "number", description: "A counter", default: 0 },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });
    }

    test("set updates an existing registry variable's default (preserving description/type)", () => {
      const updated = setWorkflowVariable(registryWorkflow(), "counter", 5);
      expect(updated.variableRegistry).toEqual({
        counter: { type: "number", description: "A counter", default: 5 },
      });
    });

    test("set adds a new registry variable with inferred type", () => {
      const updated = setWorkflowVariable(registryWorkflow(), "name", "Alice", "User name");
      expect(updated.variableRegistry?.name).toEqual({
        type: "string",
        description: "User name",
        default: "Alice",
      });
    });

    test("set preserves a rich entry's enum/items when updating its value", () => {
      const workflow = createWorkflow({
        variableRegistry: {
          gate: { type: "string", description: "Gate", enum: ["yes", "no"] },
          tags: { type: "array", description: "Tags", items: { type: "string" } },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const afterGate = setWorkflowVariable(workflow, "gate", "yes");
      expect(afterGate.variableRegistry?.gate).toEqual({
        type: "string",
        description: "Gate",
        enum: ["yes", "no"],
        default: "yes",
      });

      const afterTags = setWorkflowVariable(workflow, "tags", ["a"]);
      expect(afterTags.variableRegistry?.tags).toEqual({
        type: "array",
        description: "Tags",
        items: { type: "string" },
        default: ["a"],
      });
    });

    test("delete removes a registry variable", () => {
      const updated = deleteWorkflowVariable(registryWorkflow(), "counter");
      expect(updated.variableRegistry).toEqual({});
    });
  });

  describe("buildFlowGraph", () => {
    test("should build graph from start node", () => {
      const workflow = createWorkflow();
      const graph = buildFlowGraph(workflow);

      expect(graph.length).toBeGreaterThan(0);
      expect(graph[0]).toContain("start");
    });

    test("should handle branching", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "condition" } },
          {
            id: "condition",
            type: "condition",
            connections: { true: "branch-a", false: "branch-b" },
          },
          { id: "branch-a", type: "agent-directive", connections: { default: "end" } },
          { id: "branch-b", type: "agent-directive", connections: { default: "end" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const graph = buildFlowGraph(workflow);
      const graphStr = graph.join("\n");

      expect(graphStr).toContain("branch-a");
      expect(graphStr).toContain("branch-b");
    });

    test("should handle cycles gracefully", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "loop" } },
          { id: "loop", type: "agent-directive", connections: { default: "check" } },
          { id: "check", type: "condition", connections: { true: "end", false: "loop" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const graph = buildFlowGraph(workflow);
      const graphStr = graph.join("\n");

      // Should mention the cycle instead of infinite recursion
      expect(graphStr).toContain("loop");
      expect(graphStr).toContain("see"); // "see loop above"
    });
  });

  describe("listNodesCompact", () => {
    test("should return compact node list", () => {
      const workflow = createWorkflow();
      const nodes = listNodesCompact(workflow);

      expect(nodes).toHaveLength(3);
      expect(nodes[0]).toEqual({
        id: "start",
        type: "start",
        connections: ["step-1"],
      });
    });

    test("should filter by type", () => {
      const workflow = createWorkflow();
      const nodes = listNodesCompact(workflow, { typeFilter: "agent-directive" });

      expect(nodes).toHaveLength(1);
      expect(nodes[0].id).toBe("step-1");
    });

    test("should include directive preview when requested", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "step-1" } },
          {
            id: "step-1",
            type: "agent-directive",
            directive: "This is a very long directive that should be truncated",
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const nodes = listNodesCompact(workflow, { includePreview: true, previewLength: 20 });

      const step = nodes.find((n) => n.id === "step-1");
      expect(step?.directivePreview).toBe("This is a very long ...");
    });

    test("should handle nodes without connections", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start" },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const nodes = listNodesCompact(workflow);
      expect(nodes[0].connections).toEqual([]);
    });
  });

  describe("analyzeVariableUsage", () => {
    test("should find variables from initialData", () => {
      const workflow = createWorkflow({
        nodes: [
          {
            id: "start",
            type: "start",
            connections: { default: "end" },
            initialData: {
              variables: {
                projectName: { description: "Project name", value: "Test" },
              },
            },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const analysis = analyzeVariableUsage(workflow);
      expect(analysis.projectName).toBeDefined();
      expect(analysis.projectName.sources).toHaveLength(1);
      expect(analysis.projectName.sources[0].type).toBe("initialData");
    });

    test("should report a registry source for registry-declared globals", () => {
      const workflow = createWorkflow({
        variableRegistry: {
          threshold: { type: "number", description: "A threshold", default: 10 },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const analysis = analyzeVariableUsage(workflow);
      expect(analysis.threshold).toBeDefined();
      expect(analysis.threshold.sources[0].type).toBe("registry");
      expect(analysis.threshold.sources[0].description).toBe("A threshold");
    });

    test("should find variables from inputSchema", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "step-1" } },
          {
            id: "step-1",
            type: "agent-directive",
            directive: "Do something",
            inputSchema: {
              type: "object",
              properties: {
                userInput: { type: "string", description: "User input value" },
              },
            },
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const analysis = analyzeVariableUsage(workflow);
      expect(analysis.userInput).toBeDefined();
      expect(analysis.userInput.sources[0].type).toBe("inputSchema");
      expect(analysis.userInput.sources[0].nodeId).toBe("step-1");
    });

    test("should find usages in directive templates", () => {
      const workflow = createWorkflow({
        nodes: [
          {
            id: "start",
            type: "start",
            connections: { default: "step-1" },
            initialData: {
              variables: {
                projectName: { description: "Name", value: "Test" },
              },
            },
          },
          {
            id: "step-1",
            type: "agent-directive",
            directive: "Work on project {{projectName}}",
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const analysis = analyzeVariableUsage(workflow);
      expect(analysis.projectName.usages).toHaveLength(1);
      expect(analysis.projectName.usages[0].field).toBe("directive");
      expect(analysis.projectName.usages[0].nodeId).toBe("step-1");
    });

    test("should find usages in completionCondition", () => {
      const workflow = createWorkflow({
        nodes: [
          {
            id: "start",
            type: "start",
            connections: { default: "step-1" },
            initialData: {
              variables: { status: { description: "Status", value: "pending" } },
            },
          },
          {
            id: "step-1",
            type: "agent-directive",
            directive: "Do task",
            completionCondition: "{{status}} is complete",
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const analysis = analyzeVariableUsage(workflow);
      expect(analysis.status.usages.some((u) => u.field === "completionCondition")).toBe(true);
    });
  });

  describe("searchWorkflow", () => {
    test("should search in nodes", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "step-1" } },
          {
            id: "step-1",
            type: "agent-directive",
            directive: "Find all TypeScript files",
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const results = searchWorkflow(workflow, "TypeScript");
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("node");
      expect(results[0].nodeId).toBe("step-1");
    });

    test("should search in variables when includeVariables is true", () => {
      const workflow = createWorkflow({
        variableRegistry: {
          config: { type: "string", description: "Config", default: "production-settings" },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const results = searchWorkflow(workflow, "production", { includeVariables: true });
      expect(results.some((r) => r.type === "variable")).toBe(true);
    });

    test("should return snippet in snippetMode", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "step-1" } },
          {
            id: "step-1",
            type: "agent-directive",
            directive: "First line\nSearch for keyword in this line\nThird line",
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const results = searchWorkflow(workflow, "keyword", { snippetMode: true });
      expect(results[0].snippet).toContain("keyword");
      expect(results[0].snippet!.length).toBeLessThan(100);
    });

    test("should support regex patterns", () => {
      const workflow = createWorkflow({
        nodes: [
          { id: "start", type: "start", connections: { default: "analyze" } },
          {
            id: "analyze",
            type: "agent-directive",
            directive: "Analyze the input",
            connections: { default: "validate" },
          },
          {
            id: "validate",
            type: "agent-directive",
            directive: "Validate the output",
            connections: { default: "end" },
          },
          { id: "end", type: "end" },
        ] as WorkflowNode[],
      });

      const results = searchWorkflow(workflow, "analyze|validate");
      expect(results).toHaveLength(2);
    });
  });
});
