/**
 * MCP E2E Tests — materialize delivery fallback
 *
 * Exercises the path a host without a shell must use: the files arrive inside the tool response
 * over a real MCP client instead of through the presented curl command.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  advanceWorkflowExecution,
  createAuthenticatedMCPClient,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface TextBlock {
  type: string;
  text: string;
}

async function callForBlocks(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ blocks: TextBlock[]; isError: boolean }> {
  const result = await client.callTool({ name: "session", arguments: args });
  return {
    blocks: (result.content as TextBlock[]) ?? [],
    isError: result.isError === true,
  };
}

describe("MCP materialize fallback E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let execution: Awaited<ReturnType<typeof startWorkflowExecutionState>>;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Todo List opens on a materialize node, so the execution is paused exactly where the
    // fallback applies without needing a purpose-built fixture workflow.
    execution = await startWorkflowExecutionState(client, "moira/todo-list");
    expect(execution.response).toContain("workflow-guide.md");
    // The deployed image must actually present the fallback, not merely accept the call.
    expect(execution.response).toContain('session({ action: "materialize"');
  });

  afterAll(async () => {
    await cleanup();
  });

  test("delivers the guide body in the response while the node is presented", async () => {
    const { blocks, isError } = await callForBlocks(client, {
      action: "materialize",
      executionId: execution.processId,
    });

    expect(isError).toBe(false);
    // One summary block plus one block per delivered file.
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.text).toContain('- "workflow-guide.md"');

    const fileBlock = blocks[1]!.text;
    expect(fileBlock.startsWith("===== FILE: workflow-guide.md =====\n")).toBe(true);
    // The actual guide content, not an acknowledgement that a file exists.
    expect(fileBlock).toContain("# Todo List guide");
    expect(fileBlock.length).toBeGreaterThan(1000);
  });

  test("refuses once the execution has advanced past the materialize node", async () => {
    await advanceWorkflowExecution(client, execution, {});

    const { blocks } = await callForBlocks(client, {
      action: "materialize",
      executionId: execution.processId,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toContain("No materialize delivery is available");
    expect(blocks[0]!.text).not.toContain("# Todo List guide");
  });

  // Ownership scoping is asserted where it is decided rather than a third time here: the grant
  // lookup's user filter in tests/integration/workflow-file-tokens.test.ts, and the resolver's
  // foreign-execution refusal in tests/unit/workflow-engine/materialize-context-delivery.test.ts.

  test("reports the materialize action in the session tool contract", async () => {
    const tools = await client.listTools();
    const session = tools.tools.find((tool) => tool.name === "session");
    expect(session).toBeDefined();
    const action = (session!.inputSchema as { properties?: { action?: { enum?: string[] } } })
      .properties?.action;
    expect(action?.enum).toContain("materialize");
  });
});
