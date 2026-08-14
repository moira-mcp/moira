/**
 * Tests for WorkflowTransformer utility
 * Verifies transformation of workflow nodes to React Flow visualization format
 */

import { describe, test, expect, jest } from "@jest/globals";
import { WorkflowTransformer } from "../../../packages/web-frontend/src/utils/workflow-transformer";
import { WorkflowGraph } from "../../../packages/web-frontend/src/types";
import {
  CompactNode,
  NodeFactory,
  NodeValidation,
  nodeTypes,
} from "../../../packages/web-frontend/src/utils/node-factory";

describe("WorkflowTransformer", () => {
  describe("Materialize Node", () => {
    test("registers materialize on the shared CompactNode renderer", () => {
      expect(nodeTypes.materialize).toBe(CompactNode);
    });

    test("creates declaration-only materialize data through NodeFactory", () => {
      const node: WorkflowGraph["nodes"][number] = {
        type: "materialize",
        id: "prepare-files",
        basePath: "workspace/{{projectSlug}}",
        files: [{ path: "README.md", from: "projectReadme" }],
        connections: { success: "done", error: "failed" },
      };

      const result = NodeFactory.createReactFlowNode(node);

      expect(result).toMatchObject({
        id: "prepare-files",
        type: "materialize",
        data: {
          nodeType: "materialize",
          label: "Materialize Files",
          description: "1 file → workspace/{{projectSlug}}",
          basePath: "workspace/{{projectSlug}}",
          fileCount: 1,
          filePaths: ["README.md"],
          successConnection: "done",
          errorConnection: "failed",
        },
      });
      expect(result.data).not.toHaveProperty("token");
      expect(result.data).not.toHaveProperty("renderedFiles");
      expect(result.data).not.toHaveProperty("files");
    });

    test("accepts a complete materialize declaration in frontend validation", () => {
      const result = NodeValidation.validateNode({
        type: "materialize",
        id: "prepare-files",
        basePath: "workspace",
        files: [{ path: "README.md", content: "" }],
        connections: { success: "done" },
      });

      expect(result).toEqual({ isValid: true, errors: [] });
    });

    test.each([
      {
        condition: "base path is empty",
        node: {
          type: "materialize",
          id: "prepare-files",
          basePath: "",
          files: [{ path: "README.md", content: "" }],
          connections: { success: "done" },
        },
        error: "Materialize node must have a base path",
      },
      {
        condition: "file list is empty",
        node: {
          type: "materialize",
          id: "prepare-files",
          basePath: "workspace",
          files: [],
          connections: { success: "done" },
        },
        error: "Materialize node must have at least one file",
      },
      {
        condition: "success connection is missing",
        node: {
          type: "materialize",
          id: "prepare-files",
          basePath: "workspace",
          files: [{ path: "README.md", content: "" }],
          connections: {},
        },
        error: "Materialize node must have success connection",
      },
    ])("rejects a materialize declaration when $condition", ({ node, error }) => {
      const result = NodeValidation.validateNode(node as unknown as WorkflowGraph["nodes"][number]);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(error);
    });

    test("uses CompactNode data with a content-free file summary and success/error edges", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const workflow: WorkflowGraph = {
        id: "materialize-demo",
        metadata: {
          name: "Materialize Demo",
          version: "1.0.0",
          description: "Materialize frontend contract",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "prepare-files" },
          },
          {
            type: "materialize",
            id: "prepare-files",
            basePath: "workspace/{{projectSlug}}",
            files: [
              { path: "README.md", from: "projectReadme" },
              { path: "src/index.ts", content: "" },
            ],
            connections: { success: "done", error: "failed" },
          },
          { type: "end", id: "done" },
          { type: "end", id: "failed" },
        ],
      };

      const result = WorkflowTransformer.transformWorkflow(workflow);
      const materialize = result.nodes.find((node) => node.id === "prepare-files");

      expect(materialize).toBeDefined();
      expect(materialize!.type).toBe("materialize");
      expect(materialize!.data).toMatchObject({
        nodeType: "materialize",
        label: "Materialize Files",
        description: "2 files → workspace/{{projectSlug}}",
        basePath: "workspace/{{projectSlug}}",
        fileCount: 2,
        filePaths: ["README.md", "src/index.ts"],
        successConnection: "done",
        errorConnection: "failed",
      });
      expect(materialize!.data).not.toHaveProperty("token");
      expect(materialize!.data).not.toHaveProperty("renderedFiles");
      expect(materialize!.data).not.toHaveProperty("files");

      const materializeEdges = result.edges.filter((edge) => edge.source === "prepare-files");
      expect(materializeEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: "done",
            data: expect.objectContaining({ connectionType: "success", style: "solid" }),
          }),
          expect.objectContaining({
            target: "failed",
            data: expect.objectContaining({ connectionType: "error", style: "dashed" }),
          }),
        ]),
      );
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe("Note Node Types", () => {
    test("should transform read-note node correctly", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test workflow with read-note node",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "read-notes" },
          },
          {
            type: "read-note",
            id: "read-notes",
            outputVariable: "userNotes",
            filter: {
              tag: "preferences",
              keyPattern: "user-*",
            },
            singleMode: false,
            connections: { default: "end", error: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = WorkflowTransformer.transformWorkflow(workflow);

      expect(result.nodes).toHaveLength(3);

      const readNoteNode = result.nodes.find((n) => n.id === "read-notes");
      expect(readNoteNode).toBeDefined();
      expect(readNoteNode!.type).toBe("read-note");
      expect(readNoteNode!.data.nodeType).toBe("read-note");
      expect(readNoteNode!.data.label).toBe("Read Note");
      expect(readNoteNode!.data.outputVariable).toBe("userNotes");
      expect(readNoteNode!.data.filter).toEqual({
        tag: "preferences",
        keyPattern: "user-*",
      });
      expect(readNoteNode!.data.defaultConnection).toBe("end");
      expect(readNoteNode!.data.errorConnection).toBe("end");
    });

    test("should transform write-note node correctly", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test workflow with write-note node",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "write-note" },
          },
          {
            type: "write-note",
            id: "write-note",
            key: "user-preferences",
            source: "ctx.preferences",
            tags: ["user", "settings"],
            batchMode: false,
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = WorkflowTransformer.transformWorkflow(workflow);

      const writeNoteNode = result.nodes.find((n) => n.id === "write-note");
      expect(writeNoteNode).toBeDefined();
      expect(writeNoteNode!.type).toBe("write-note");
      expect(writeNoteNode!.data.nodeType).toBe("write-note");
      expect(writeNoteNode!.data.label).toBe("Write Note");
      expect(writeNoteNode!.data.key).toBe("user-preferences");
      expect(writeNoteNode!.data.source).toBe("ctx.preferences");
      expect(writeNoteNode!.data.tags).toEqual(["user", "settings"]);
      expect(writeNoteNode!.data.defaultConnection).toBe("end");
    });

    test("should transform upsert-note node correctly", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Test workflow with upsert-note node",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "upsert-note" },
          },
          {
            type: "upsert-note",
            id: "upsert-note",
            search: {
              tag: "metrics",
              keyPattern: "daily-*",
            },
            keyTemplate: "daily-{{date}}",
            value: "ctx.metrics",
            tags: ["metrics", "daily"],
            outputVariable: "savedNote",
            connections: { default: "end", error: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = WorkflowTransformer.transformWorkflow(workflow);

      const upsertNoteNode = result.nodes.find((n) => n.id === "upsert-note");
      expect(upsertNoteNode).toBeDefined();
      expect(upsertNoteNode!.type).toBe("upsert-note");
      expect(upsertNoteNode!.data.nodeType).toBe("upsert-note");
      expect(upsertNoteNode!.data.label).toBe("Upsert Note");
      expect(upsertNoteNode!.data.keyTemplate).toBe("daily-{{date}}");
      expect(upsertNoteNode!.data.value).toBe("ctx.metrics");
      expect(upsertNoteNode!.data.search).toEqual({
        tag: "metrics",
        keyPattern: "daily-*",
      });
      expect(upsertNoteNode!.data.outputVariable).toBe("savedNote");
      expect(upsertNoteNode!.data.defaultConnection).toBe("end");
    });

    test("should generate correct description for read-note node", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "read-notes" },
          },
          {
            type: "read-note",
            id: "read-notes",
            outputVariable: "notes",
            filter: { tag: "important" },
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = WorkflowTransformer.transformWorkflow(workflow);
      const readNoteNode = result.nodes.find((n) => n.id === "read-notes");

      expect(readNoteNode!.data.description).toContain("tag: important");
      expect(readNoteNode!.data.description).toContain("notes");
    });

    test("should create edges for note node connections", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "write-note" },
          },
          {
            type: "write-note",
            id: "write-note",
            key: "test-key",
            source: "ctx.data",
            connections: { default: "end", error: "error-handler" },
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

      const result = WorkflowTransformer.transformWorkflow(workflow);

      // Check edges from write-note
      const writeNoteEdges = result.edges.filter((e) => e.source === "write-note");
      expect(writeNoteEdges).toHaveLength(2);

      const defaultEdge = writeNoteEdges.find((e) => e.target === "end");
      const errorEdge = writeNoteEdges.find((e) => e.target === "error-handler");

      expect(defaultEdge).toBeDefined();
      expect(errorEdge).toBeDefined();
      expect(errorEdge!.data?.connectionType).toBe("error");
    });

    test("should use custom displayName for note nodes when provided", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "read-notes" },
          },
          {
            type: "read-note",
            id: "read-notes",
            metadata: {
              displayName: "Load User Preferences",
            },
            outputVariable: "prefs",
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = WorkflowTransformer.transformWorkflow(workflow);
      const readNoteNode = result.nodes.find((n) => n.id === "read-notes");

      expect(readNoteNode!.data.label).toBe("Load User Preferences");
    });
  });

  describe("Mixed Workflow with Note Nodes", () => {
    test("should handle workflow with multiple note node types", () => {
      const workflow: WorkflowGraph = {
        id: "notes-demo",
        metadata: {
          name: "Notes Demo",
          version: "1.0.0",
          description: "Workflow demonstrating all note node types",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "read-config" },
          },
          {
            type: "read-note",
            id: "read-config",
            outputVariable: "config",
            filter: { tag: "config" },
            singleMode: true,
            connections: { default: "process" },
          },
          {
            type: "agent-directive",
            id: "process",
            directive: "Process the configuration",
            completionCondition: "Processing complete",
            connections: { success: "write-result" },
          },
          {
            type: "write-note",
            id: "write-result",
            key: "process-result",
            source: "ctx.result",
            tags: ["results"],
            connections: { default: "upsert-metrics" },
          },
          {
            type: "upsert-note",
            id: "upsert-metrics",
            keyTemplate: "metrics-{{timestamp}}",
            value: "ctx.metrics",
            tags: ["metrics"],
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = WorkflowTransformer.transformWorkflow(workflow);

      expect(result.nodes).toHaveLength(6);
      expect(result.metadata.nodeCount).toBe(6);

      // Verify all node types are present
      const nodeTypes = result.nodes.map((n) => n.type);
      expect(nodeTypes).toContain("start");
      expect(nodeTypes).toContain("read-note");
      expect(nodeTypes).toContain("agent-directive");
      expect(nodeTypes).toContain("write-note");
      expect(nodeTypes).toContain("upsert-note");
      expect(nodeTypes).toContain("end");

      // Verify edges connect properly
      expect(result.edges).toHaveLength(5);
    });
  });

  describe("Fallback Node Handling", () => {
    test("should render unknown node types as fallback instead of throwing", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test Workflow",
          version: "1.0.0",
          description: "Workflow with unknown node type",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "unknown-node" },
          },
          {
            type: "custom-unknown-type" as never,
            id: "unknown-node",
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      // Should NOT throw - previously this would crash the app
      const result = WorkflowTransformer.transformWorkflow(workflow);

      expect(result.nodes).toHaveLength(3);

      const unknownNode = result.nodes.find((n) => n.id === "unknown-node");
      expect(unknownNode).toBeDefined();
      expect(unknownNode!.type).toBe("fallback");
      expect(unknownNode!.data.nodeType).toBe("fallback");
      expect((unknownNode!.data as { originalType: string }).originalType).toBe(
        "custom-unknown-type",
      );
    });

    test("should set warning validation status for fallback nodes", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "future-node" },
          },
          {
            type: "future-ai-node" as never,
            id: "future-node",
            directive: "Some future directive",
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = WorkflowTransformer.transformWorkflow(workflow);
      const futureNode = result.nodes.find((n) => n.id === "future-node");

      expect(futureNode!.data.validationStatus).toBe("warning");
    });

    test("should preserve connections for fallback nodes", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "unknown" },
          },
          {
            type: "some-exotic-type" as never,
            id: "unknown",
            connections: { default: "end", error: "error-handler" },
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

      const result = WorkflowTransformer.transformWorkflow(workflow);

      // Should create edges from fallback node
      const edgesFromUnknown = result.edges.filter((e) => e.source === "unknown");
      expect(edgesFromUnknown).toHaveLength(2);

      const defaultEdge = edgesFromUnknown.find((e) => e.target === "end");
      const errorEdge = edgesFromUnknown.find((e) => e.target === "error-handler");

      expect(defaultEdge).toBeDefined();
      expect(errorEdge).toBeDefined();
    });

    test("should use displayName if available for fallback node label", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "custom" },
          },
          {
            type: "proprietary-node" as never,
            id: "custom",
            metadata: {
              displayName: "Custom Display Name",
            },
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = WorkflowTransformer.transformWorkflow(workflow);
      const customNode = result.nodes.find((n) => n.id === "custom");

      expect(customNode!.data.label).toBe("Custom Display Name");
    });

    test("should uppercase node type as label when no displayName", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "exotic" },
          },
          {
            type: "exotic-type" as never,
            id: "exotic",
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = WorkflowTransformer.transformWorkflow(workflow);
      const exoticNode = result.nodes.find((n) => n.id === "exotic");

      expect(exoticNode!.data.label).toBe("EXOTIC-TYPE");
    });

    test("should include description with original type for fallback nodes", () => {
      const workflow: WorkflowGraph = {
        id: "test-workflow",
        metadata: {
          name: "Test",
          version: "1.0.0",
          description: "Test",
        },
        nodes: [
          {
            type: "start",
            id: "start",
            connections: { default: "mystery" },
          },
          {
            type: "mystery-node" as never,
            id: "mystery",
            connections: { default: "end" },
          },
          {
            type: "end",
            id: "end",
          },
        ],
      };

      const result = WorkflowTransformer.transformWorkflow(workflow);
      const mysteryNode = result.nodes.find((n) => n.id === "mystery");

      expect(mysteryNode!.data.description).toContain("mystery-node");
    });
  });
});
