/**
 * Unit Tests - MAX_NODES Validation
 * Tests workflow node count limit enforcement
 *
 * Current limit: MAX_NODES = 300
 */

import { describe, test, expect } from "@jest/globals";
import { GraphValidator } from "@mcp-moira/workflow-engine";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

describe("MAX_NODES Validation", () => {
  let validator: GraphValidator;

  beforeEach(() => {
    validator = new GraphValidator();
  });

  test("validates workflow with exactly 300 nodes (at limit)", async () => {
    const workflow: WorkflowGraph = {
      id: "test-max-nodes",
      metadata: {
        name: "Max Nodes Test",
        version: "1.0.0",
        description: "Test workflow with 300 nodes (at MAX_NODES limit)",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "node-1" } },
        ...Array.from({ length: 298 }, (_, i) => ({
          type: "agent-directive" as const,
          id: `node-${i + 1}`,
          directive: `Task ${i + 1}`,
          completionCondition: `Done ${i + 1}`,
          connections: { success: i === 297 ? "end" : `node-${i + 2}` },
        })),
        { type: "end", id: "end" },
      ],
    };

    const result = await validator.validateWorkflow(workflow);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects workflow with 301 nodes (over limit)", async () => {
    const workflow: WorkflowGraph = {
      id: "test-over-max-nodes",
      metadata: {
        name: "Over Max Nodes Test",
        version: "1.0.0",
        description: "Test workflow with 301 nodes (exceeds MAX_NODES=300)",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "node-1" } },
        ...Array.from({ length: 299 }, (_, i) => ({
          type: "agent-directive" as const,
          id: `node-${i + 1}`,
          directive: `Task ${i + 1}`,
          completionCondition: `Done ${i + 1}`,
          connections: { success: i === 298 ? "end" : `node-${i + 2}` },
        })),
        { type: "end", id: "end" },
      ],
    };

    const result = await validator.validateWorkflow(workflow);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    const maxNodesError = result.errors.find(
      (e) => e.message.includes("maximum node count") || e.message.includes("300"),
    );

    expect(maxNodesError).toBeDefined();
    expect(maxNodesError?.type).toBe("structure");
    expect(maxNodesError?.message).toContain("301");
  });

  test("rejects workflow with 400 nodes", async () => {
    const workflow: WorkflowGraph = {
      id: "test-way-over-max",
      metadata: {
        name: "Way Over Max Test",
        version: "1.0.0",
        description: "Test workflow with 400 nodes",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "node-1" } },
        ...Array.from({ length: 398 }, (_, i) => ({
          type: "agent-directive" as const,
          id: `node-${i + 1}`,
          directive: `Task ${i + 1}`,
          completionCondition: `Done ${i + 1}`,
          connections: { success: i === 397 ? "end" : `node-${i + 2}` },
        })),
        { type: "end", id: "end" },
      ],
    };

    const result = await validator.validateWorkflow(workflow);

    expect(result.valid).toBe(false);

    const maxNodesError = result.errors.find((e) => e.message.includes("maximum node count"));

    expect(maxNodesError).toBeDefined();
    expect(maxNodesError?.message).toContain("400");
  });

  test("validates small workflow with 10 nodes", async () => {
    const workflow: WorkflowGraph = {
      id: "test-small",
      metadata: {
        name: "Small Workflow",
        version: "1.0.0",
        description: "Test small workflow",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "node-1" } },
        ...Array.from({ length: 8 }, (_, i) => ({
          type: "agent-directive" as const,
          id: `node-${i + 1}`,
          directive: `Task ${i + 1}`,
          completionCondition: `Done ${i + 1}`,
          connections: { success: i === 7 ? "end" : `node-${i + 2}` },
        })),
        { type: "end", id: "end" },
      ],
    };

    const result = await validator.validateWorkflow(workflow);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
