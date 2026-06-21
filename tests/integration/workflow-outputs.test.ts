/**
 * Snapshot tests for workflow execution outputs
 * Stage 19: Comprehensive Snapshot Coverage
 */

import { describe, test, expect } from "@jest/globals";
import { GraphTemplateProcessor } from "@mcp-moira/workflow-engine";
import { AgentMessageQueue } from "@mcp-moira/workflow-engine";

describe("Workflow Output Snapshots", () => {
  test("template processing results", () => {
    const processor = new GraphTemplateProcessor();
    const context = {
      variables: { userName: "TestUser", score: 95, items: ["a", "b", "c"] },
      nodeStates: {},
      executionId: "test-execution",
      workflowId: "test-workflow",
      userId: "test-user-123",
    };

    const templateResult = processor.processDirective(
      "Welcome {{userName}}! Your score is {{score}}/100. Items: {{items}}",
      context,
    );

    expect(templateResult).toMatchInlineSnapshot(
      `"Welcome TestUser! Your score is 95/100. Items: [a,b,c]"`,
    );
  });

  test("agent message queue formatting", () => {
    const queue = new AgentMessageQueue();

    queue.addNotification(
      "test-node",
      "Complete the task: Task completed successfully",
      "directive",
    );
    queue.addNotification("test-node", "Important notice", "info");

    const response = queue.flush("test-process");

    expect(response.messages).toMatchSnapshot("agent-message-queue-response");
  });

  test("complex workflow context serialization", () => {
    const complexContext = {
      variables: {
        user: { name: "John", profile: { age: 30, skills: ["JS", "TS"] } },
        workflow: { stage: "testing", completed: ["init", "validate"] },
        metadata: { timestamp: "2025-01-01T00:00:00Z", version: "1.0.0" },
      },
      nodeStates: {
        "node-1": { retries: 0, completed: true },
        "node-2": { retries: 1, completed: false },
      },
      executionId: "exec-123",
      workflowId: "workflow-abc",
      userId: "test-user-123",
    };

    expect(complexContext).toMatchSnapshot("complex-workflow-context");
  });
});
