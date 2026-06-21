/**
 * Note Node Schema Validation Tests
 * Tests that GraphValidator correctly validates read-note, write-note, upsert-note nodes
 */

import { describe, test, expect } from "@jest/globals";
import { GraphValidator } from "../../../packages/workflow-engine/src/validation/graph-validator.js";

describe("GraphValidator - Note Node Validation", () => {
  const validator = new GraphValidator();

  // Helper to wrap nodes in a minimal valid workflow
  function makeWorkflow(nodes: unknown[]) {
    return {
      id: "test-note-validation",
      metadata: { name: "Test", version: "1.0.0", description: "Test" },
      nodes: [
        {
          id: "start",
          type: "start",
          connections: { default: nodes[0] && (nodes[0] as { id: string }).id },
        },
        ...nodes,
        { id: "end", type: "end" },
      ],
    };
  }

  describe("read-note node", () => {
    test("valid read-note passes validation", async () => {
      const workflow = makeWorkflow([
        {
          type: "read-note",
          id: "read",
          outputVariable: "notes",
          filter: { tag: "metrics" },
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("read-note with all optional fields passes", async () => {
      const workflow = makeWorkflow([
        {
          type: "read-note",
          id: "read",
          outputVariable: "notes",
          filter: { tag: "metrics", keyPattern: "latest-", keySearch: "project" },
          singleMode: true,
          connections: { default: "end", error: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("read-note missing outputVariable fails validation", async () => {
      const workflow = makeWorkflow([
        {
          type: "read-note",
          id: "read",
          // outputVariable missing
          filter: { tag: "metrics" },
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(false);

      const errorMessages = result.errors.map((e) => e.message).join(" ");
      expect(errorMessages.includes("outputVariable") || errorMessages.includes("required")).toBe(
        true,
      );
    });

    test("read-note missing connections fails validation", async () => {
      const workflow = makeWorkflow([
        {
          type: "read-note",
          id: "read",
          outputVariable: "notes",
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(false);
    });
  });

  describe("write-note node", () => {
    test("valid write-note passes validation", async () => {
      const workflow = makeWorkflow([
        {
          type: "write-note",
          id: "write",
          key: "metrics-key",
          source: "{{metricsData}}",
          tags: ["metrics", "raw"],
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("write-note with batch mode passes", async () => {
      const workflow = makeWorkflow([
        {
          type: "write-note",
          id: "write",
          source: "{{batchData}}",
          batchMode: true,
          connections: { default: "end", error: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("write-note missing source fails validation", async () => {
      const workflow = makeWorkflow([
        {
          type: "write-note",
          id: "write",
          key: "test-key",
          // source missing
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(false);

      const errorMessages = result.errors.map((e) => e.message).join(" ");
      expect(errorMessages.includes("source") || errorMessages.includes("required")).toBe(true);
    });
  });

  describe("upsert-note node", () => {
    test("valid upsert-note passes validation", async () => {
      const workflow = makeWorkflow([
        {
          type: "upsert-note",
          id: "upsert",
          search: { tag: "latest" },
          keyTemplate: "latest-{{project}}",
          value: "{{data}}",
          tags: ["latest"],
          outputVariable: "result",
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("upsert-note minimal (required fields only) passes", async () => {
      const workflow = makeWorkflow([
        {
          type: "upsert-note",
          id: "upsert",
          keyTemplate: "key",
          value: "val",
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("upsert-note missing keyTemplate fails validation", async () => {
      const workflow = makeWorkflow([
        {
          type: "upsert-note",
          id: "upsert",
          // keyTemplate missing
          value: "val",
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(false);

      const errorMessages = result.errors.map((e) => e.message).join(" ");
      expect(errorMessages.includes("keyTemplate") || errorMessages.includes("required")).toBe(
        true,
      );
    });

    test("upsert-note missing value fails validation", async () => {
      const workflow = makeWorkflow([
        {
          type: "upsert-note",
          id: "upsert",
          keyTemplate: "key",
          // value missing
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(false);
    });
  });

  describe("error message quality for note nodes", () => {
    test("error for invalid write-note references the node ID", async () => {
      const workflow = makeWorkflow([
        {
          type: "write-note",
          id: "my-write-node",
          // source missing
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(false);

      const hasNodeRef = result.errors.some(
        (e) =>
          e.nodeId === "my-write-node" ||
          e.message.includes("my-write-node") ||
          e.message.includes("write-note"),
      );
      expect(hasNodeRef).toBe(true);
    });

    test("error for invalid read-note does not mention unrelated node types", async () => {
      const workflow = makeWorkflow([
        {
          type: "read-note",
          id: "bad-read",
          // outputVariable missing
          connections: { default: "end" },
        },
      ]);

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(false);

      const errorMessages = result.errors.map((e) => e.message).join(" ");
      // Should NOT mention unrelated types
      expect(errorMessages).not.toContain("directive");
      expect(errorMessages).not.toContain("condition");
      expect(errorMessages).not.toContain("subgraph");
    });
  });

  describe("note nodes in mixed workflows", () => {
    test("workflow with all three note node types passes", async () => {
      const workflow = {
        id: "test-all-notes",
        metadata: { name: "All Notes", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "write" } },
          {
            type: "write-note",
            id: "write",
            key: "data",
            source: "content",
            connections: { default: "upsert", error: "end" },
          },
          {
            type: "upsert-note",
            id: "upsert",
            keyTemplate: "latest",
            value: "content",
            connections: { default: "read", error: "end" },
          },
          {
            type: "read-note",
            id: "read",
            outputVariable: "notes",
            connections: { default: "end", error: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("workflow mixing note nodes with agent-directive passes", async () => {
      const workflow = {
        id: "test-mixed",
        metadata: { name: "Mixed", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "step1" } },
          {
            type: "agent-directive",
            id: "step1",
            directive: "Gather data",
            completionCondition: "Done",
            connections: { success: "write" },
          },
          {
            type: "write-note",
            id: "write",
            key: "result",
            source: "{{data}}",
            connections: { default: "end", error: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateWorkflow(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
