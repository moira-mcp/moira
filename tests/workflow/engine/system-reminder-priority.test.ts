/**
 * System Reminder Priority Tests
 *
 * Tests for per-workflow systemReminder with priority over global setting
 * Priority: workflow.systemReminder > global mcp.systemReminder
 */

import { describe, it, expect } from "@jest/globals";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

describe("System Reminder Priority", () => {
  describe("WorkflowGraph interface", () => {
    it("should accept systemReminder as optional field", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test workflow",
        },
        nodes: [],
        systemReminder: "Custom reminder text",
      };

      expect(workflow.systemReminder).toBe("Custom reminder text");
    });

    it("should work without systemReminder field", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test workflow",
        },
        nodes: [],
      };

      expect(workflow.systemReminder).toBeUndefined();
    });
  });

  describe("Priority logic", () => {
    // Helper function that mimics UniversalGraphExecutor.getSystemReminder logic
    function getEffectiveReminder(
      workflowReminder: string | undefined,
      globalReminder: string | null,
    ): string | null {
      // Priority 1: Per-workflow systemReminder
      if (workflowReminder) {
        return workflowReminder;
      }
      // Priority 2: Global mcp.systemReminder
      return globalReminder;
    }

    it("workflow.systemReminder should take priority over global", () => {
      const workflowReminder = "Workflow specific reminder";
      const globalReminder = "Global admin reminder";

      const result = getEffectiveReminder(workflowReminder, globalReminder);

      expect(result).toBe("Workflow specific reminder");
    });

    it("should fall back to global when workflow.systemReminder is undefined", () => {
      const workflowReminder = undefined;
      const globalReminder = "Global admin reminder";

      const result = getEffectiveReminder(workflowReminder, globalReminder);

      expect(result).toBe("Global admin reminder");
    });

    it("should fall back to global when workflow.systemReminder is empty string", () => {
      const workflowReminder = "";
      const globalReminder = "Global admin reminder";

      // Empty string is falsy, so it falls back to global
      const result = getEffectiveReminder(workflowReminder, globalReminder);

      expect(result).toBe("Global admin reminder");
    });

    it("should return null when both are undefined/null", () => {
      const workflowReminder = undefined;
      const globalReminder = null;

      const result = getEffectiveReminder(workflowReminder, globalReminder);

      expect(result).toBeNull();
    });

    it("should use workflow reminder even if global is null", () => {
      const workflowReminder = "Workflow reminder";
      const globalReminder = null;

      const result = getEffectiveReminder(workflowReminder, globalReminder);

      expect(result).toBe("Workflow reminder");
    });
  });

  describe("Workflow with systemReminder", () => {
    it("should store systemReminder in workflow graph", () => {
      const workflow: WorkflowGraph = {
        id: "wf-with-reminder",
        metadata: {
          name: "Workflow With Reminder",
          version: "1.0.0",
          description: "Has custom system reminder",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "end" } },
          { type: "end", id: "end", connections: {} },
        ],
        systemReminder: "This is a custom system reminder for this workflow only",
      };

      expect(workflow.systemReminder).toBe(
        "This is a custom system reminder for this workflow only",
      );
      expect(workflow.nodes.length).toBe(2);
    });

    it("should serialize and deserialize systemReminder correctly", () => {
      const original: WorkflowGraph = {
        id: "wf-serialize-test",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test",
        },
        nodes: [],
        systemReminder: "Serialized reminder\nWith multiple lines",
      };

      const serialized = JSON.stringify(original);
      const deserialized = JSON.parse(serialized) as WorkflowGraph;

      expect(deserialized.systemReminder).toBe("Serialized reminder\nWith multiple lines");
    });

    it("should handle multiline system reminder", () => {
      const workflow: WorkflowGraph = {
        id: "wf-multiline",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test",
        },
        nodes: [],
        systemReminder: `=== CUSTOM INSTRUCTIONS ===

This workflow has specific requirements:
- Follow the directive exactly
- Complete all subtasks
- Report progress regularly

Remember: quality over speed.`,
      };

      expect(workflow.systemReminder).toContain("CUSTOM INSTRUCTIONS");
      expect(workflow.systemReminder).toContain("quality over speed");
    });
  });
});
