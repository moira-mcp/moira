import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  callMCPTool,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
} from "../utils/mcp-auth.js";
import { getTestFetchUrl, getTestRequestOrigin } from "../utils/test-config.js";
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

interface AttachmentGrant {
  uploadUrl: string;
  grant: string;
  correlationId: string;
}

describe("MCP communication tool", () => {
  const clients: ClientState[] = [];
  let persistentToken: string;

  beforeAll(async () => {
    for (const user of users) {
      await createTestUserViaApi(baseUrl, user.email, password, user.name);
      clients.push(await createAuthenticatedMCPClient({ email: user.email, password }));
    }
    const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: getTestRequestOrigin() },
      body: JSON.stringify({ email: users[0].email, password }),
    });
    const session = signIn.headers
      .get("set-cookie")
      ?.match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/)?.[1];
    if (!session) throw new Error("Persistent-token test sign-in failed");
    const cookieName = baseUrl.startsWith("https://")
      ? "__Secure-better-auth.session_token"
      : "better-auth.session_token";
    const tokenResponse = await fetch(`${baseUrl}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `${cookieName}=${session}` },
      body: JSON.stringify({ name: "communication-upload", expiresIn: "30d" }),
    });
    const tokenResponseText = await tokenResponse.text();
    const tokenBody = JSON.parse(tokenResponseText) as { data?: { token: string } };
    if (!tokenResponse.ok || !tokenBody.data?.token)
      throw new Error(
        `Persistent token creation failed: ${tokenResponse.status} ${tokenResponseText}`,
      );
    persistentToken = tokenBody.data.token;
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled(clients.map((client) => client.cleanup()));
  });

  async function mint(): Promise<AttachmentGrant> {
    return callMCPTool<AttachmentGrant>(clients[0].client, "communication", {
      action: "attachment-token",
      message: "Generated report",
      kind: "document",
      filename: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
    });
  }

  async function upload(grant: AttachmentGrant, token: string, body: string, length = 4) {
    return fetch(grant.uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Moira-Communication-Grant": grant.grant,
        "Content-Type": "text/plain",
        "Content-Length": String(length),
      },
      body,
    });
  }

  test("sends text through the authenticated user's configured-channel projection", async () => {
    const result = await callMCPTool<{ status: string; deliveredChannels: number }>(
      clients[0].client,
      "communication",
      { action: "send", message: "Test-only notification" },
    );
    expect(result).toEqual(
      expect.objectContaining({ status: "no_configured_channels", deliveredChannels: 0 }),
    );
  });

  test("rejects undeclared recipient authority before MCP normalization can strip it", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clients[0].accessToken}`,
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
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: -32602 }) }),
    );
  });

  test("binds a binary grant to its authenticated owner and makes delivery single-use", async () => {
    const grant = await mint();
    expect(grant.grant).not.toBe("");
    expect(grant.uploadUrl).not.toContain(grant.grant);

    const wrongOwner = await upload(grant, clients[1].accessToken, "test");
    expect(wrongOwner.status).toBe(401);
    expect(await wrongOwner.json()).toEqual({ error: "invalid_grant" });

    const delivered = await upload(grant, clients[0].accessToken, "test");
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toEqual(
      expect.objectContaining({ status: "no_configured_channels" }),
    );

    const replay = await upload(grant, clients[0].accessToken, "test");
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
  });

  test("redeems an OAuth-minted grant with the same user's persistent MCP credential", async () => {
    const grant = await mint();
    const delivered = await upload(grant, persistentToken, "test");
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toEqual(
      expect.objectContaining({ status: "no_configured_channels" }),
    );
  });

  test("admits only one common-service delivery when the same grant races", async () => {
    const grant = await mint();
    const responses = await Promise.all([
      upload(grant, clients[0].accessToken, "test"),
      upload(grant, clients[0].accessToken, "test"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const deliveryAudits = execSqliteInDocker(
      `SELECT COUNT(*) FROM auditLog WHERE action = 'mcp:communication_attachment_deliver' AND resourceId = '${grant.correlationId}'`,
    );
    expect(deliveryAudits).toBe("1");
  });

  test("releases a grant after pre-delivery validation failure", async () => {
    const grant = await mint();
    const mismatch = await upload(grant, clients[0].accessToken, "tes", 3);
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ error: "declared_size_mismatch" });

    const retry = await upload(grant, clients[0].accessToken, "test");
    expect(retry.status).toBe(200);
  });

  test("checks image signatures before invoking a provider and permits a corrected retry", async () => {
    const grant = await callMCPTool<AttachmentGrant>(clients[0].client, "communication", {
      action: "attachment-token",
      message: "Image",
      kind: "image",
      filename: "image.png",
      mimeType: "image/png",
      sizeBytes: 8,
    });
    const headers = {
      Authorization: `Bearer ${clients[0].accessToken}`,
      "X-Moira-Communication-Grant": grant.grant,
      "Content-Type": "image/png",
      "Content-Length": "8",
    };
    const invalid = await fetch(grant.uploadUrl, {
      method: "POST",
      headers,
      body: Buffer.alloc(8),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_image_signature" });

    const valid = await fetch(grant.uploadUrl, {
      method: "POST",
      headers,
      body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    expect(valid.status).toBe(200);
  });
});
