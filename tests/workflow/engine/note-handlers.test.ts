/**
 * Unit Tests for Note Node Handlers
 * Tests read-note, write-note, and upsert-note handlers
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import {
  ReadNoteHandler,
  WriteNoteHandler,
  UpsertNoteHandler,
  AgentMessageQueue,
  ReadNoteNode,
  WriteNoteNode,
  UpsertNoteNode,
} from "@mcp-moira/workflow-engine";
import { IGraphStorage, IGraphExecutionEngine } from "@mcp-moira/workflow-engine";
import type { NoteService } from "@mcp-moira/shared";

// Create mock NoteService for testing
function createMockNoteService() {
  return {
    list: jest.fn(),
    get: jest.fn(),
    save: jest.fn(),
    exists: jest.fn(),
    delete: jest.fn(),
    getWithVersion: jest.fn(),
    getHistory: jest.fn(),
    getStats: jest.fn(),
  } as unknown as NoteService;
}

describe("ReadNoteHandler", () => {
  let mockNoteService: ReturnType<typeof createMockNoteService>;
  let handler: ReadNoteHandler;
  const mockStorage = {} as IGraphStorage;
  const mockEngine = {} as IGraphExecutionEngine;

  beforeEach(() => {
    mockNoteService = createMockNoteService();
    handler = new ReadNoteHandler(mockNoteService);
    jest.clearAllMocks();
  });

  test("should return correct node type", () => {
    expect(handler.getNodeType()).toBe("read-note");
  });

  test("should read notes with tag filter", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.list as jest.Mock).mockResolvedValue({
      notes: [{ key: "note-1" }, { key: "note-2" }],
      total: 2,
    });

    (mockNoteService.get as jest.Mock)
      .mockResolvedValueOnce({
        key: "note-1",
        value: "content 1",
        tags: ["tag1"],
        version: 1,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      })
      .mockResolvedValueOnce({
        key: "note-2",
        value: "content 2",
        tags: ["tag1"],
        version: 1,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      });

    const readNode: ReadNoteNode = {
      type: "read-note",
      id: "read-1",
      outputVariable: "myNotes",
      filter: { tag: "tag1" },
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      readNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.nodeId).toBe("read-1");
    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe("default");
    expect(result.data).toHaveProperty("myNotes");
    expect(Array.isArray(result.data!.myNotes)).toBe(true);
    expect((result.data!.myNotes as unknown[]).length).toBe(2);
  });

  test("should read single note in singleMode", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.list as jest.Mock).mockResolvedValue({
      notes: [{ key: "single-note" }],
      total: 1,
    });

    (mockNoteService.get as jest.Mock).mockResolvedValue({
      key: "single-note",
      value: "the content",
      tags: ["important"],
      version: 3,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-15",
    });

    const readNode: ReadNoteNode = {
      type: "read-note",
      id: "read-single",
      outputVariable: "theNote",
      filter: { keySearch: "single" },
      singleMode: true,
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      readNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.data!.theNote).toMatchObject({
      key: "single-note",
      value: "the content",
      version: 3,
    });
  });

  test("should process template expressions in filter", async () => {
    const context = TestUtils.createTestContext({ tagName: "dynamic-tag" });

    (mockNoteService.list as jest.Mock).mockResolvedValue({ notes: [], total: 0 });

    const readNode: ReadNoteNode = {
      type: "read-note",
      id: "read-templated",
      outputVariable: "notes",
      filter: { tag: "{{tagName}}" },
      connections: { default: "next-node" },
    };

    await handler.execute(readNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

    expect(mockNoteService.list).toHaveBeenCalledWith("test-user-123", {
      tag: "dynamic-tag",
    });
  });

  test("should use error connection on failure", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.list as jest.Mock).mockRejectedValue(new Error("Database error"));

    const readNode: ReadNoteNode = {
      type: "read-note",
      id: "read-error",
      outputVariable: "notes",
      connections: { default: "next-node", error: "error-handler" },
    };

    const result = await handler.execute(
      readNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe("error");
    expect(result.data).toHaveProperty("readNoteError");
  });

  test("should throw when no error connection and failure", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.list as jest.Mock).mockRejectedValue(new Error("Database error"));

    const readNode: ReadNoteNode = {
      type: "read-note",
      id: "read-no-error-conn",
      outputVariable: "notes",
      connections: { default: "next-node" },
    };

    await expect(
      handler.execute(readNode, context, new AgentMessageQueue(), mockStorage, mockEngine),
    ).rejects.toThrow("Database error");
  });

  test("canExecute should return true for read-note nodes", () => {
    const context = TestUtils.createTestContext({});
    const readNode: ReadNoteNode = {
      type: "read-note",
      id: "test",
      outputVariable: "notes",
      connections: { default: "next" },
    };
    expect(handler.canExecute(readNode, context)).toBe(true);
  });

  test("canExecute should return false for non-read-note nodes", () => {
    const context = TestUtils.createTestContext({});
    const startNode = { type: "start", id: "start", connections: { default: "next" } };
    expect(handler.canExecute(startNode as any, context)).toBe(false);
  });
});

describe("WriteNoteHandler", () => {
  let mockNoteService: ReturnType<typeof createMockNoteService>;
  let handler: WriteNoteHandler;
  const mockStorage = {} as IGraphStorage;
  const mockEngine = {} as IGraphExecutionEngine;

  beforeEach(() => {
    mockNoteService = createMockNoteService();
    handler = new WriteNoteHandler(mockNoteService);
    jest.clearAllMocks();
  });

  test("should return correct node type", () => {
    expect(handler.getNodeType()).toBe("write-note");
  });

  test("should write single note", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.exists as jest.Mock).mockResolvedValue(false);
    (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

    const writeNode: WriteNoteNode = {
      type: "write-note",
      id: "write-1",
      key: "my-note",
      source: "This is the content",
      tags: ["tag1", "tag2"],
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      writeNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe("default");
    expect(result.data!.writeNoteResults).toEqual([{ key: "my-note", version: 1, created: true }]);

    expect(mockNoteService.save).toHaveBeenCalledWith("test-user-123", {
      key: "my-note",
      value: "This is the content",
      tags: ["tag1", "tag2"],
    });
  });

  test("should update existing note", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.exists as jest.Mock).mockResolvedValue(true);
    (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 5 });

    const writeNode: WriteNoteNode = {
      type: "write-note",
      id: "write-update",
      key: "existing-note",
      source: "Updated content",
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      writeNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.data!.writeNoteResults).toEqual([
      { key: "existing-note", version: 5, created: false },
    ]);
  });

  test("should write batch of notes", async () => {
    const context = TestUtils.createTestContext({
      notesData: [
        { key: "batch-1", value: "content 1", tags: ["batch"] },
        { key: "batch-2", value: "content 2" },
      ],
    });

    (mockNoteService.exists as jest.Mock).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    (mockNoteService.save as jest.Mock)
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 1 });

    const writeNode: WriteNoteNode = {
      type: "write-note",
      id: "write-batch",
      source: "notesData",
      batchMode: true,
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      writeNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.data!.writeNoteResults).toHaveLength(2);
    expect(mockNoteService.save).toHaveBeenCalledTimes(2);
  });

  test("should process template expressions in key and source", async () => {
    const context = TestUtils.createTestContext({
      noteKey: "dynamic-key",
      noteContent: "dynamic content",
    });

    (mockNoteService.exists as jest.Mock).mockResolvedValue(false);
    (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

    const writeNode: WriteNoteNode = {
      type: "write-note",
      id: "write-templated",
      key: "{{noteKey}}",
      source: "{{noteContent}}",
      connections: { default: "next-node" },
    };

    await handler.execute(writeNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

    expect(mockNoteService.save).toHaveBeenCalledWith("test-user-123", {
      key: "dynamic-key",
      value: "dynamic content",
      tags: undefined,
    });
  });

  test("should use error connection on failure", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.exists as jest.Mock).mockRejectedValue(new Error("Save failed"));

    const writeNode: WriteNoteNode = {
      type: "write-note",
      id: "write-error",
      key: "fail-note",
      source: "content",
      connections: { default: "next-node", error: "error-handler" },
    };

    const result = await handler.execute(
      writeNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.outputPath).toBe("error");
    expect(result.data).toHaveProperty("writeNoteError");
  });

  test("canExecute should return true for write-note nodes", () => {
    const context = TestUtils.createTestContext({});
    const writeNode: WriteNoteNode = {
      type: "write-note",
      id: "test",
      key: "k",
      source: "s",
      connections: { default: "next" },
    };
    expect(handler.canExecute(writeNode, context)).toBe(true);
  });

  describe("Auto-serialization", () => {
    test("should auto-serialize object source to JSON string", async () => {
      const context = TestUtils.createTestContext({
        "gather-metrics": {
          metrics: {
            linesOfCode: 15000,
            sourceFiles: 120,
            primaryLanguage: "TypeScript",
          },
        },
      });

      (mockNoteService.exists as jest.Mock).mockResolvedValue(false);
      (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

      const writeNode: WriteNoteNode = {
        type: "write-note",
        id: "write-obj",
        key: "test-key",
        source: "{{gather-metrics.metrics}}",
        connections: { default: "next-node" },
      };

      await handler.execute(writeNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

      const savedValue = (mockNoteService.save as jest.Mock).mock.calls[0][1].value;
      // Should be valid JSON, not [object Object] or safeSerialize output
      const parsed = JSON.parse(savedValue);
      expect(parsed).toEqual({
        linesOfCode: 15000,
        sourceFiles: 120,
        primaryLanguage: "TypeScript",
      });
    });

    test("should auto-serialize array source to JSON string", async () => {
      const context = TestUtils.createTestContext({
        items: ["alpha", "beta", "gamma"],
      });

      (mockNoteService.exists as jest.Mock).mockResolvedValue(false);
      (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

      const writeNode: WriteNoteNode = {
        type: "write-note",
        id: "write-arr",
        key: "test-key",
        source: "{{items}}",
        connections: { default: "next-node" },
      };

      await handler.execute(writeNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

      const savedValue = (mockNoteService.save as jest.Mock).mock.calls[0][1].value;
      const parsed = JSON.parse(savedValue);
      expect(parsed).toEqual(["alpha", "beta", "gamma"]);
    });

    test("should pass string source through unchanged", async () => {
      const context = TestUtils.createTestContext({
        message: "Hello, world!",
      });

      (mockNoteService.exists as jest.Mock).mockResolvedValue(false);
      (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

      const writeNode: WriteNoteNode = {
        type: "write-note",
        id: "write-str",
        key: "test-key",
        source: "{{message}}",
        connections: { default: "next-node" },
      };

      await handler.execute(writeNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

      const savedValue = (mockNoteService.save as jest.Mock).mock.calls[0][1].value;
      expect(savedValue).toBe("Hello, world!");
    });

    test("should convert number source to string", async () => {
      const context = TestUtils.createTestContext({
        count: 42,
      });

      (mockNoteService.exists as jest.Mock).mockResolvedValue(false);
      (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

      const writeNode: WriteNoteNode = {
        type: "write-note",
        id: "write-num",
        key: "test-key",
        source: "{{count}}",
        connections: { default: "next-node" },
      };

      await handler.execute(writeNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

      const savedValue = (mockNoteService.save as jest.Mock).mock.calls[0][1].value;
      expect(savedValue).toBe("42");
    });

    test("should convert boolean source to string", async () => {
      const context = TestUtils.createTestContext({
        flag: true,
      });

      (mockNoteService.exists as jest.Mock).mockResolvedValue(false);
      (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

      const writeNode: WriteNoteNode = {
        type: "write-note",
        id: "write-bool",
        key: "test-key",
        source: "{{flag}}",
        connections: { default: "next-node" },
      };

      await handler.execute(writeNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

      const savedValue = (mockNoteService.save as jest.Mock).mock.calls[0][1].value;
      expect(savedValue).toBe("true");
    });

    test("should use template processing for mixed templates", async () => {
      const context = TestUtils.createTestContext({
        name: "TestProject",
      });

      (mockNoteService.exists as jest.Mock).mockResolvedValue(false);
      (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

      const writeNode: WriteNoteNode = {
        type: "write-note",
        id: "write-mixed",
        key: "test-key",
        source: "Project: {{name}} is great",
        connections: { default: "next-node" },
      };

      await handler.execute(writeNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

      const savedValue = (mockNoteService.save as jest.Mock).mock.calls[0][1].value;
      expect(savedValue).toBe("Project: TestProject is great");
    });

    test("should resolve dot-path to nested object and serialize", async () => {
      const context = TestUtils.createTestContext({
        "node-output": {
          deeply: {
            nested: { value: [1, 2, 3] },
          },
        },
      });

      (mockNoteService.exists as jest.Mock).mockResolvedValue(false);
      (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

      const writeNode: WriteNoteNode = {
        type: "write-note",
        id: "write-deep",
        key: "test-key",
        source: "{{node-output.deeply.nested}}",
        connections: { default: "next-node" },
      };

      await handler.execute(writeNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

      const savedValue = (mockNoteService.save as jest.Mock).mock.calls[0][1].value;
      const parsed = JSON.parse(savedValue);
      expect(parsed).toEqual({ value: [1, 2, 3] });
    });
  });
});

describe("UpsertNoteHandler", () => {
  let mockNoteService: ReturnType<typeof createMockNoteService>;
  let handler: UpsertNoteHandler;
  const mockStorage = {} as IGraphStorage;
  const mockEngine = {} as IGraphExecutionEngine;

  beforeEach(() => {
    mockNoteService = createMockNoteService();
    handler = new UpsertNoteHandler(mockNoteService);
    jest.clearAllMocks();
  });

  test("should return correct node type", () => {
    expect(handler.getNodeType()).toBe("upsert-note");
  });

  test("should create new note when not found", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.list as jest.Mock).mockResolvedValue({ notes: [], total: 0 });
    (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

    const upsertNode: UpsertNoteNode = {
      type: "upsert-note",
      id: "upsert-1",
      search: { tag: "project-config" },
      keyTemplate: "project-settings",
      value: "default settings",
      tags: ["config"],
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      upsertNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.action).toBe("continue");
    expect(result.data!.upsertNoteResult).toEqual({
      key: "project-settings",
      version: 1,
      created: true,
    });

    expect(mockNoteService.save).toHaveBeenCalledWith("test-user-123", {
      key: "project-settings",
      value: "default settings",
      tags: ["config"],
    });
  });

  test("should update existing note when found", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.list as jest.Mock).mockResolvedValue({
      notes: [{ key: "existing-settings" }],
      total: 1,
    });
    (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 5 });

    const upsertNode: UpsertNoteNode = {
      type: "upsert-note",
      id: "upsert-update",
      search: { tag: "project-config" },
      keyTemplate: "new-settings",
      value: "updated value",
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      upsertNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.data!.upsertNoteResult).toEqual({
      key: "existing-settings",
      version: 5,
      created: false,
    });

    // Should use found key, not keyTemplate
    expect(mockNoteService.save).toHaveBeenCalledWith("test-user-123", {
      key: "existing-settings",
      value: "updated value",
      tags: undefined,
    });
  });

  test("should process template expressions", async () => {
    const context = TestUtils.createTestContext({
      projectName: "my-project",
      settingsContent: "project config data",
    });

    (mockNoteService.list as jest.Mock).mockResolvedValue({ notes: [], total: 0 });
    (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

    const upsertNode: UpsertNoteNode = {
      type: "upsert-note",
      id: "upsert-templated",
      search: { tag: "{{projectName}}-config" },
      keyTemplate: "{{projectName}}-settings",
      value: "{{settingsContent}}",
      connections: { default: "next-node" },
    };

    await handler.execute(upsertNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

    expect(mockNoteService.list).toHaveBeenCalledWith("test-user-123", {
      tag: "my-project-config",
    });
    expect(mockNoteService.save).toHaveBeenCalledWith("test-user-123", {
      key: "my-project-settings",
      value: "project config data",
      tags: undefined,
    });
  });

  test("should store result in outputVariable", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.list as jest.Mock).mockResolvedValue({ notes: [], total: 0 });
    (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

    const upsertNode: UpsertNoteNode = {
      type: "upsert-note",
      id: "upsert-output",
      search: { tag: "test" },
      keyTemplate: "test-key",
      value: "test value",
      outputVariable: "saveResult",
      connections: { default: "next-node" },
    };

    const result = await handler.execute(
      upsertNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.data!.upsertNoteResult).toBeDefined();
    expect(result.data!.saveResult).toEqual(result.data!.upsertNoteResult);
  });

  test("should use error connection on failure", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.list as jest.Mock).mockRejectedValue(new Error("Search failed"));

    const upsertNode: UpsertNoteNode = {
      type: "upsert-note",
      id: "upsert-error",
      search: { tag: "test" },
      keyTemplate: "key",
      value: "value",
      connections: { default: "next-node", error: "error-handler" },
    };

    const result = await handler.execute(
      upsertNode,
      context,
      new AgentMessageQueue(),
      mockStorage,
      mockEngine,
    );

    expect(result.outputPath).toBe("error");
    expect(result.data).toHaveProperty("upsertNoteError");
  });

  test("should throw when no error connection and failure", async () => {
    const context = TestUtils.createTestContext({});

    (mockNoteService.list as jest.Mock).mockRejectedValue(new Error("Critical failure"));

    const upsertNode: UpsertNoteNode = {
      type: "upsert-note",
      id: "upsert-throw",
      search: { tag: "test" },
      keyTemplate: "key",
      value: "value",
      connections: { default: "next-node" },
    };

    await expect(
      handler.execute(upsertNode, context, new AgentMessageQueue(), mockStorage, mockEngine),
    ).rejects.toThrow("Critical failure");
  });

  test("canExecute should return true for upsert-note nodes", () => {
    const context = TestUtils.createTestContext({});
    const upsertNode: UpsertNoteNode = {
      type: "upsert-note",
      id: "test",
      search: { tag: "t" },
      keyTemplate: "k",
      value: "v",
      connections: { default: "next" },
    };
    expect(handler.canExecute(upsertNode, context)).toBe(true);
  });

  test("canExecute should return false for non-upsert-note nodes", () => {
    const context = TestUtils.createTestContext({});
    const startNode = { type: "start", id: "start", connections: { default: "next" } };
    expect(handler.canExecute(startNode as any, context)).toBe(false);
  });

  describe("Auto-serialization", () => {
    test("should auto-serialize object value to JSON string", async () => {
      const context = TestUtils.createTestContext({
        "gather-metrics": {
          metrics: {
            linesOfCode: 15000,
            sourceFiles: 120,
            primaryLanguage: "TypeScript",
          },
        },
      });

      (mockNoteService.list as jest.Mock).mockResolvedValue({ notes: [], total: 0 });
      (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

      const upsertNode: UpsertNoteNode = {
        type: "upsert-note",
        id: "upsert-obj",
        keyTemplate: "metrics-latest",
        value: "{{gather-metrics.metrics}}",
        connections: { default: "next-node" },
      };

      await handler.execute(upsertNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

      const savedValue = (mockNoteService.save as jest.Mock).mock.calls[0][1].value;
      const parsed = JSON.parse(savedValue);
      expect(parsed).toEqual({
        linesOfCode: 15000,
        sourceFiles: 120,
        primaryLanguage: "TypeScript",
      });
    });

    test("should auto-serialize array value to JSON string", async () => {
      const context = TestUtils.createTestContext({
        tags: ["alpha", "beta", "gamma"],
      });

      (mockNoteService.list as jest.Mock).mockResolvedValue({ notes: [], total: 0 });
      (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

      const upsertNode: UpsertNoteNode = {
        type: "upsert-note",
        id: "upsert-arr",
        keyTemplate: "arr-note",
        value: "{{tags}}",
        connections: { default: "next-node" },
      };

      await handler.execute(upsertNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

      const savedValue = (mockNoteService.save as jest.Mock).mock.calls[0][1].value;
      const parsed = JSON.parse(savedValue);
      expect(parsed).toEqual(["alpha", "beta", "gamma"]);
    });

    test("should pass string value through unchanged", async () => {
      const context = TestUtils.createTestContext({
        content: "plain text content",
      });

      (mockNoteService.list as jest.Mock).mockResolvedValue({ notes: [], total: 0 });
      (mockNoteService.save as jest.Mock).mockResolvedValue({ version: 1 });

      const upsertNode: UpsertNoteNode = {
        type: "upsert-note",
        id: "upsert-str",
        keyTemplate: "str-note",
        value: "{{content}}",
        connections: { default: "next-node" },
      };

      await handler.execute(upsertNode, context, new AgentMessageQueue(), mockStorage, mockEngine);

      const savedValue = (mockNoteService.save as jest.Mock).mock.calls[0][1].value;
      expect(savedValue).toBe("plain text content");
    });
  });
});
