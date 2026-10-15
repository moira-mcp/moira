import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  callMCPTool,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
} from "../utils/mcp-auth.js";
import { getTestFetchUrl } from "../utils/test-config.js";
import { execSqliteInDocker } from "../utils/docker-command.js";

const baseUrl = getTestFetchUrl();
const password = "TestPass123!";
const suffix = Date.now();
const users = [
  { email: `communication-a-${suffix}@example.com`, name: "Communication A" },
  { email: `communication-b-${suffix}@example.com`, name: "Communication B" },
];
interface ClientState {
  client: Client;
  accessToken: string;
  cleanup: () => Promise<void>;
}

describe("MCP communication tool", () => {
  const clients: ClientState[] = [];
  beforeAll(async () => {
    for (const user of users) {
      await createTestUserViaApi(baseUrl, user.email, password, user.name);
      clients.push(await createAuthenticatedMCPClient({ email: user.email, password }));
    }
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled(clients.map((client) => client.cleanup()));
  });

  test("ordinary configured-channel text remains callable without a file owner", async () => {
    expect(
      await callMCPTool(clients[0]!.client, "communication", {
        action: "send",
        message: "Test-only notification",
      }),
    ).toMatchObject({ status: "no_configured_channels", deliveredChannels: 0 });
  });

  test("rejects undeclared destination authority before MCP normalization", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clients[0]!.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 67,
        method: "tools/call",
        params: {
          name: "communication",
          arguments: { action: "send", message: "private", recipient: "someone-else" },
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32602 } });
  });

  test("native delivery without a paired owner refuses before admission and preserves the chosen original identity", async () => {
    const request_id = "ws1-033c20a1-3c09-487e-8d60-c75226769951";
    const result = await callMCPTool(clients[0]!.client, "communication", {
      action: "deliver-file",
      request_id,
      kind: "document",
      message: "Report",
      file: {
        file_id: "file_CommunicationFixture",
        download_url: "https://files.oaiusercontent.com/no-controller-source",
        file_name: "report.bin",
        mime_type: "application/octet-stream",
        size_bytes: 3,
      },
    });
    expect(result).toMatchObject({
      status: "unavailable",
      request_id,
      error: { code: "COMMUNICATION_OWNER_UNAVAILABLE" },
    });
    expect(JSON.stringify(result)).not.toContain("download_url");
  });

  test("collection requires the original assigned owner and does not create an upload grant", async () => {
    const result = await callMCPTool(clients[1]!.client, "communication", {
      action: "operation",
      request_id: "ws1-3669eb26-6af3-4e9e-a722-dcc43efa1792",
    });
    expect(result).toEqual({ status: "rejected", reason: "original_owner_identity_required" });
    expect(
      execSqliteInDocker(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('codespaceTransfer','communication_attachment_grant')",
      ),
    ).toBe("0");
  });

  test("the old binary grant action and upload endpoint cannot revive cloud attachment storage", async () => {
    const result = await clients[0]!.client.callTool({
      name: "communication",
      arguments: { action: "attachment-token", message: "Report" },
    });
    expect(result.isError).toBe(true);
    const response = await fetch(`${baseUrl}/api/communication/attachments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clients[0]!.accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: Uint8Array.of(0, 255, 1),
    });
    expect(response.status).toBe(404);
  });
});
