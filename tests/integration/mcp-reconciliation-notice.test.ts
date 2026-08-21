import { describe, expect, test } from "@jest/globals";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildReconciliationAwareInstructions,
  createReconciliationAwareRegisterTool,
} from "../../packages/mcp-server/src/reconciliation-aware-server.js";

describe("MCP managed-workflow reconciliation notice", () => {
  test("exposes the unresolved summary in instructions and an ordinary registered tool response", async () => {
    const notice =
      "ERROR MANAGED_WORKFLOW_RECONCILIATION_REQUIRED: owner/flow (conflict); " +
      "previous=database:workflow-reconciliation:owner/flow#previous; " +
      "current=database:workflow-reconciliation:owner/flow#current; " +
      "incoming=database:workflow-reconciliation:owner/flow#incoming; " +
      "recovery=database:workflow-reconciliation:owner/flow. Run Workflow Management Flow (WMF).";
    const getNotice = () => notice;
    const server = new McpServer(
      { name: "reconciliation-test-server", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        instructions: buildReconciliationAwareInstructions("Base instructions", getNotice),
      },
    );
    const registerTool = createReconciliationAwareRegisterTool(server, getNotice);
    registerTool(
      "echo",
      {
        description: "Return the supplied value",
        inputSchema: { value: z.string() },
      },
      async ({ value }) => ({ content: [{ type: "text" as const, text: value }] }),
    );

    const client = new Client(
      { name: "reconciliation-test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getInstructions()).toBe(`${notice}\n\nBase instructions`);
      const result = await client.callTool({
        name: "echo",
        arguments: { value: "ordinary result" },
      });
      expect(result.content).toEqual([
        { type: "text", text: notice },
        { type: "text", text: "ordinary result" },
      ]);
      expect(JSON.stringify(result)).not.toContain('"graph"');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
