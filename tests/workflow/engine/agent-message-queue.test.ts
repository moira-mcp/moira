/**
 * Unit tests for AgentMessageQueue with formatting functionality
 */

import { describe, test, expect } from "@jest/globals";
import { AgentMessageQueue } from "@mcp-moira/workflow-engine";

describe("Agent Message Queue Tests", () => {
  test("returns array of messages without schema", () => {
    const queue = new AgentMessageQueue();

    queue.addMessage("test-node", "Complete the analysis task", "Analysis completed successfully");

    const response = queue.flush("test-process");

    expect(response.processId).toBe("test-process");
    expect(response.totalMessages).toBe(1);
    expect(response.messages).toHaveLength(1);
    expect((response.messages[0] as any).directive).toBe("Complete the analysis task");
    expect((response.messages[0] as any).completionCondition).toBe(
      "Analysis completed successfully",
    );
    expect(response.messages[0].nodeId).toBe("test-node");
  });

  test("formats single message with object schema", () => {
    const queue = new AgentMessageQueue();
    const schema = {
      type: "object",
      properties: {
        username: { type: "string", description: "User login name" },
        email: { type: "string", description: "User email address" },
      },
      required: ["username"],
    };

    queue.addMessage(
      "test-node",
      "Process user registration",
      "User registered successfully",
      schema,
    );

    const result = queue.flush("test-process");

    expect(result.totalMessages).toBe(1);
    expect(result.messages[0].type).toBe("directive");
    expect((result.messages[0] as any).directive).toBe("Process user registration");
    expect((result.messages[0] as any).completionCondition).toBe("User registered successfully");
    expect((result.messages[0] as any).inputSchema).toEqual(schema);
    // Test the structured object properties, not string content
    expect(result.processId).toBe("test-process");
  });

  test("concatenates multiple messages", () => {
    const queue = new AgentMessageQueue();

    queue.addMessage("node1", "First task", "First completed");
    queue.addMessage("node2", "Second task", "Second completed");
    queue.addMessage("node3", "Third task", "Third completed");

    const result = queue.flush("test-process");

    expect(result.totalMessages).toBe(3);
    expect(result.messages).toHaveLength(3);
    expect((result.messages[0] as any).directive).toBe("First task");
    expect((result.messages[0] as any).completionCondition).toBe("First completed");
    expect((result.messages[1] as any).directive).toBe("Second task");
    expect((result.messages[2] as any).directive).toBe("Third task");
  });

  test("returns structured response for formatQueueResponse processing", () => {
    const queue = new AgentMessageQueue();

    queue.addMessage("test-node", "Complete task", "Task completed");

    const response = queue.flush("test-process");

    expect(response.processId).toBe("test-process");
    expect(response.totalMessages).toBe(1);
    expect(response.messages).toHaveLength(1);
    expect((response.messages[0] as any).directive).toBe("Complete task");
    expect((response.messages[0] as any).completionCondition).toBe("Task completed");
    expect(response.messages[0].nodeId).toBe("test-node");
  });

  test("handles empty queue gracefully", () => {
    const queue = new AgentMessageQueue();

    const result = queue.flush("test-process");

    expect(result.totalMessages).toBe(0);
    expect(result.messages).toHaveLength(0);
    expect(result.processId).toBe("test-process");
  });

  test("stores message with string schema", () => {
    const queue = new AgentMessageQueue();
    const schema = {
      type: "string",
      minLength: 10,
      description: "Summary text",
    };

    queue.addMessage("test-node", "Provide summary", "Summary provided", schema);

    const result = queue.flush("test-process");

    expect(result.totalMessages).toBe(1);
    expect((result.messages[0] as any).directive).toBe("Provide summary");
    expect((result.messages[0] as any).completionCondition).toBe("Summary provided");
    expect((result.messages[0] as any).inputSchema).toEqual(schema);
  });

  test("stores message with array schema", () => {
    const queue = new AgentMessageQueue();
    const schema = {
      type: "array",
      items: { type: "string" },
      description: "List of items",
    };

    queue.addMessage("test-node", "List all items", "Items listed", schema);

    const result = queue.flush("test-process");

    expect(result.totalMessages).toBe(1);
    expect((result.messages[0] as any).directive).toBe("List all items");
    expect((result.messages[0] as any).completionCondition).toBe("Items listed");
    expect((result.messages[0] as any).inputSchema).toEqual(schema);
  });

  test("verifies queue state management", () => {
    const queue = new AgentMessageQueue();

    expect(queue.isEmpty()).toBe(true);
    expect(queue.getLength()).toBe(0);

    queue.addMessage("node1", "Task 1", "Completed 1");
    expect(queue.isEmpty()).toBe(false);
    expect(queue.getLength()).toBe(1);

    queue.addMessage("node2", "Task 2", "Completed 2");
    expect(queue.getLength()).toBe(2);

    // Flush should clear the queue
    queue.flush("test-process");
    expect(queue.isEmpty()).toBe(true);
    expect(queue.getLength()).toBe(0);
  });

  test("stores complex nested schema", () => {
    const queue = new AgentMessageQueue();
    const complexSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
        },
        actions: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["user"],
    };

    queue.addMessage("test-node", "Process complex data", "Data processed", complexSchema);

    const result = queue.flush("test-process");

    expect(result.totalMessages).toBe(1);
    expect((result.messages[0] as any).directive).toBe("Process complex data");
    expect((result.messages[0] as any).completionCondition).toBe("Data processed");
    expect((result.messages[0] as any).inputSchema).toEqual(complexSchema);
  });
});
