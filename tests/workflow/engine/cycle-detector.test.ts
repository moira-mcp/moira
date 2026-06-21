/**
 * Cycle Detection Tests
 *
 * Tests for detectCycles function that identifies cycles in workflow graphs.
 * Cycles are valid in workflows with iteration/revision loops.
 */

import { describe, test, expect } from "@jest/globals";
import { detectCycles } from "../../../packages/workflow-engine/src/validation/cycle-detector.js";
import type { WorkflowGraph } from "../../../packages/workflow-engine/src/interfaces/core-interfaces.js";

describe("detectCycles", () => {
  test("detects simple two-node cycle", () => {
    const workflow: WorkflowGraph = {
      id: "cycle-test",
      metadata: { name: "Cycle Test", version: "1.0.0", description: "Test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "a" } },
        {
          type: "agent-directive",
          id: "a",
          directive: "A",
          completionCondition: "Done",
          connections: { success: "b" },
        },
        {
          type: "agent-directive",
          id: "b",
          directive: "B",
          completionCondition: "Done",
          connections: { success: "a" },
        }, // Cycle back to a
        { type: "end", id: "end" },
      ],
    };

    const cycles = detectCycles(workflow);

    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain("a");
    expect(cycles[0]).toContain("b");
  });

  test("returns empty array for linear workflow without cycles", () => {
    const workflow: WorkflowGraph = {
      id: "linear-test",
      metadata: { name: "Linear Test", version: "1.0.0", description: "Test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "a" } },
        {
          type: "agent-directive",
          id: "a",
          directive: "A",
          completionCondition: "Done",
          connections: { success: "b" },
        },
        {
          type: "agent-directive",
          id: "b",
          directive: "B",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };

    const cycles = detectCycles(workflow);

    expect(cycles).toHaveLength(0);
  });

  test("detects self-loop (node pointing to itself)", () => {
    const workflow: WorkflowGraph = {
      id: "self-loop-test",
      metadata: { name: "Self Loop Test", version: "1.0.0", description: "Test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "loop" } },
        {
          type: "condition",
          id: "loop",
          condition: { operator: "eq", left: 1, right: 1 },
          connections: { true: "loop", false: "end" }, // Self-loop on true
        },
        { type: "end", id: "end" },
      ],
    };

    const cycles = detectCycles(workflow);

    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain("loop");
  });

  test("detects multiple independent cycles", () => {
    const workflow: WorkflowGraph = {
      id: "multi-cycle-test",
      metadata: { name: "Multi Cycle Test", version: "1.0.0", description: "Test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "branch" } },
        {
          type: "condition",
          id: "branch",
          condition: { operator: "eq", left: 1, right: 1 },
          connections: { true: "a", false: "c" },
        },
        // First cycle: a -> b -> a
        {
          type: "agent-directive",
          id: "a",
          directive: "A",
          completionCondition: "Done",
          connections: { success: "b" },
        },
        {
          type: "agent-directive",
          id: "b",
          directive: "B",
          completionCondition: "Done",
          connections: { success: "a" },
        },
        // Second cycle: c -> d -> c
        {
          type: "agent-directive",
          id: "c",
          directive: "C",
          completionCondition: "Done",
          connections: { success: "d" },
        },
        {
          type: "agent-directive",
          id: "d",
          directive: "D",
          completionCondition: "Done",
          connections: { success: "c" },
        },
        { type: "end", id: "end" },
      ],
    };

    const cycles = detectCycles(workflow);

    // Should detect both cycles
    expect(cycles.length).toBeGreaterThanOrEqual(2);
  });

  test("handles workflow with condition branches forming diamond (no cycle)", () => {
    const workflow: WorkflowGraph = {
      id: "diamond-test",
      metadata: { name: "Diamond Test", version: "1.0.0", description: "Test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "decision" } },
        {
          type: "condition",
          id: "decision",
          condition: { operator: "eq", left: 1, right: 1 },
          connections: { true: "path-a", false: "path-b" },
        },
        {
          type: "agent-directive",
          id: "path-a",
          directive: "Path A",
          completionCondition: "Done",
          connections: { success: "merge" },
        },
        {
          type: "agent-directive",
          id: "path-b",
          directive: "Path B",
          completionCondition: "Done",
          connections: { success: "merge" },
        },
        {
          type: "agent-directive",
          id: "merge",
          directive: "Merge",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };

    const cycles = detectCycles(workflow);

    expect(cycles).toHaveLength(0);
  });

  test("handles empty workflow gracefully", () => {
    const workflow: WorkflowGraph = {
      id: "empty-test",
      metadata: { name: "Empty Test", version: "1.0.0", description: "Test" },
      nodes: [],
    };

    const cycles = detectCycles(workflow);

    expect(cycles).toHaveLength(0);
  });
});
