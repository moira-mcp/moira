/**
 * MCP Persistent Token Authentication Tests
 *
 * Tests that MCP requests can authenticate via persistent API tokens (moira_ prefix)
 * instead of OAuth. Covers: successful auth, expired/revoked token rejection,
 * blocked user rejection, and OAuth flow remaining unaffected.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_TOOLS_REVISION } from "@mcp-moira/mcp-server/tool-contract";
import { createAuthenticatedMCPClient, callMCPTool, verifyUserEmail } from "../utils/mcp-auth.js";
import {
  getTestFetchUrl,
  getTestRequestOrigin,
  getAdminCredentials,
} from "../utils/test-config.js";
import { execSqliteInDocker } from "../utils/docker-command.js";

const FETCH_URL = getTestFetchUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

const TEST_USER = {
  email: `mcp-pat-test-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "MCP PAT Test User",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let userCookie: string;
let adminCookie: string;
let testUserId: string;

const initializeBody = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "persistent-revision-test", version: "1.0.0" },
  },
});

/** Sign in and return session cookie */
async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: getTestRequestOrigin() },
    body: JSON.stringify({ email, password }),
  });
  const cookies = res.headers.get("set-cookie");
  const match = cookies?.match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("Failed to sign in");
  const cookieName = FETCH_URL.startsWith("https://")
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
  return `${cookieName}=${match[1]}`;
}

/** Create a persistent API token via REST API */
async function createToken(
  cookie: string,
  name: string,
  expiresIn = "90d",
): Promise<{ token: string; id: string }> {
  const res = await fetch(`${FETCH_URL}/api/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name, expiresIn }),
  });
  if (!res.ok) throw new Error(`Create token failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data: { token: string; id: string } };
  return data.data;
}

/** Revoke a token via REST API */
async function revokeToken(cookie: string, tokenId: string): Promise<void> {
  const res = await fetch(`${FETCH_URL}/api/tokens/${tokenId}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  if (!res.ok) throw new Error(`Revoke failed: ${res.status}`);
}

/** Block user via admin API */
async function blockUser(userId: string): Promise<void> {
  const res = await fetch(`${FETCH_URL}/api/admin/users/${userId}/block`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });
  if (!res.ok) throw new Error(`Block failed: ${res.status}`);
}

/** Unblock user via admin API */
async function unblockUser(userId: string): Promise<void> {
  const res = await fetch(`${FETCH_URL}/api/admin/users/${userId}/unblock`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });
  if (!res.ok) throw new Error(`Unblock failed: ${res.status}`);
}

/** Make raw MCP JSON-RPC request with a Bearer token */
async function mcpRequest(
  token: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${FETCH_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  // MCP responses may be SSE (text/event-stream) for successful tool calls
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    return { status: res.status, body: await res.text() };
  }
  return { status: res.status, body: await res.json() };
}

/** Create MCP client using persistent token (not OAuth) */
async function createPersistentTokenMCPClient(token: string): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const client = new Client({ name: "pat-test-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${FETCH_URL}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  await client.connect(transport);
  return {
    client,
    cleanup: async () => {
      await client.close();
    },
  };
}

describe("MCP Persistent Token Authentication", () => {
  beforeAll(async () => {
    // Create test user
    const signUpRes = await fetch(`${FETCH_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: getTestRequestOrigin() },
      body: JSON.stringify(TEST_USER),
    });
    const signUpData = (await signUpRes.json()) as { user?: { id: string } };
    if (!signUpData?.user) throw new Error("Failed to create test user");
    testUserId = signUpData.user.id;

    // Sign in as admin for deployment-mode admission and block/unblock operations.
    adminCookie = await signIn(ADMIN_CREDENTIALS.email, ADMIN_CREDENTIALS.password);

    // Verify email via admin helper
    await verifyUserEmail(FETCH_URL, TEST_USER.email);

    const featuresResponse = await fetch(`${FETCH_URL}/api/features`);
    expect(featuresResponse.status).toBe(200);
    const features = (await featuresResponse.json()) as {
      data: { features: { accountApproval: boolean } };
    };
    if (features.data.features.accountApproval) {
      const approvalResponse = await fetch(`${FETCH_URL}/api/admin/users/${testUserId}/approve`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      expect(approvalResponse.status).toBe(200);
    }

    // Sign in as test user
    userCookie = await signIn(TEST_USER.email, TEST_USER.password);
  });

  afterAll(async () => {
    // Ensure user is unblocked for cleanup
    try {
      await unblockUser(testUserId);
    } catch {
      /* ignore */
    }
  });

  test("authenticates MCP request with valid persistent token", async () => {
    const { token } = await createToken(userCookie, "mcp-auth-test");
    const { client, cleanup } = await createPersistentTokenMCPClient(token);

    try {
      // Call a simple MCP tool - list workflows
      const result = await callMCPTool<{ workflows: unknown[]; total: number }>(client, "list", {});
      expect(result).toHaveProperty("workflows");
      expect(result).toHaveProperty("total");
    } finally {
      await cleanup();
    }
  });

  test("MCP tool calls work with persistent token auth", async () => {
    const { token } = await createToken(userCookie, "mcp-tool-test");
    const { client, cleanup } = await createPersistentTokenMCPClient(token);

    try {
      // Call session tool to verify user context propagation
      const result = await callMCPTool<{ email: string }>(client, "session", {
        action: "user",
      });
      expect(result.email).toBe(TEST_USER.email);
    } finally {
      await cleanup();
    }
  });

  test("rejects revoked persistent token with 401", async () => {
    const { token, id } = await createToken(userCookie, "revoked-token-test");
    await revokeToken(userCookie, id);

    const { status, body } = await mcpRequest(token, initializeBody(1));

    expect(status).toBe(401);
    expect(body).toHaveProperty("error", "invalid_token");
    expect((body as { error_description: string }).error_description).toContain("revoked");
  });

  test("rejects expired persistent token with 401", async () => {
    const { token, id } = await createToken(userCookie, "expired-token-test");

    // Expire token by setting expiresAt to past date directly in DB
    execSqliteInDocker(
      `UPDATE apiToken SET expiresAt = '2020-01-01T00:00:00.000Z' WHERE id = '${id}'`,
    );

    const { status, body } = await mcpRequest(token, initializeBody(1));

    expect(status).toBe(401);
    expect(body).toHaveProperty("error", "invalid_token");
    expect((body as { error_description: string }).error_description).toContain("expired");
  });

  test("rejects non-existent persistent token with 401", async () => {
    // Valid format but doesn't exist in DB
    const fakeToken = "moira_" + "a".repeat(40);

    const { status, body } = await mcpRequest(fakeToken, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    });

    expect(status).toBe(401);
    expect(body).toHaveProperty("error", "invalid_token");
  });

  test("rejects blocked user with 403 via persistent token", async () => {
    const { token } = await createToken(userCookie, "blocked-user-test");

    // Block the user
    await blockUser(testUserId);

    try {
      const { status, body } = await mcpRequest(token, initializeBody(1));

      expect(status).toBe(403);
      expect(body).toHaveProperty("error", "access_denied");
    } finally {
      // Unblock and re-sign in (block/unblock may invalidate session)
      await unblockUser(testUserId);
      userCookie = await signIn(TEST_USER.email, TEST_USER.password);
    }
  });

  test("OAuth authentication still works alongside persistent tokens", async () => {
    // Use standard OAuth-based MCP client
    const { client, cleanup } = await createAuthenticatedMCPClient();

    try {
      const result = await callMCPTool<{ workflows: unknown[] }>(client, "list", {});
      expect(result).toHaveProperty("workflows");
    } finally {
      await cleanup();
    }
  });

  test("initializes only the exact persistent credential with the same token", async () => {
    const first = await createToken(userCookie, "revision-first");
    const sibling = await createToken(userCookie, "revision-sibling");
    expect(
      execSqliteInDocker(
        `SELECT COALESCE(toolsVersion, 'null') FROM apiToken WHERE id IN ('${first.id}', '${sibling.id}') ORDER BY id`,
      ).split("\n"),
    ).toEqual(["null", "null"]);

    expect(
      (await mcpRequest(first.token, { jsonrpc: "2.0", method: "tools/list", id: 1 })).status,
    ).toBe(426);
    expect(
      execSqliteInDocker(
        `SELECT COALESCE(toolsVersion, 'null') FROM apiToken WHERE id = '${first.id}'`,
      ),
    ).toBe("null");
    expect((await mcpRequest(first.token, initializeBody(2))).status).toBe(200);
    expect(execSqliteInDocker(`SELECT toolsVersion FROM apiToken WHERE id = '${first.id}'`)).toBe(
      MCP_TOOLS_REVISION,
    );
    expect(
      execSqliteInDocker(
        `SELECT COALESCE(toolsVersion, 'null') FROM apiToken WHERE id = '${sibling.id}'`,
      ),
    ).toBe("null");
    expect(
      (await mcpRequest(first.token, { jsonrpc: "2.0", method: "tools/list", id: 3 })).status,
    ).toBe(200);

    execSqliteInDocker(
      `UPDATE apiToken SET toolsVersion = 'stale-revision' WHERE id = '${first.id}'`,
    );
    expect(
      (await mcpRequest(first.token, { jsonrpc: "2.0", method: "tools/list", id: 4 })).status,
    ).toBe(426);
    expect(execSqliteInDocker(`SELECT toolsVersion FROM apiToken WHERE id = '${first.id}'`)).toBe(
      "stale-revision",
    );
    expect((await mcpRequest(first.token, initializeBody(5))).status).toBe(200);
    expect(execSqliteInDocker(`SELECT toolsVersion FROM apiToken WHERE id = '${first.id}'`)).toBe(
      MCP_TOOLS_REVISION,
    );
  });

  test("does not initialize from notification, malformed, or batched input", async () => {
    const credential = await createToken(userCookie, "revision-invalid-shapes");
    const withoutId = { ...initializeBody(1), id: undefined };
    const malformed = { ...initializeBody(2), params: { capabilities: {} } };

    expect((await mcpRequest(credential.token, withoutId)).status).toBe(426);
    expect((await mcpRequest(credential.token, malformed)).status).toBe(426);
    expect((await mcpRequest(credential.token, [initializeBody(3)])).status).toBe(426);

    expect(
      execSqliteInDocker(
        `SELECT COALESCE(toolsVersion, 'null') FROM apiToken WHERE id = '${credential.id}'`,
      ),
    ).toBe("null");
  });

  test("repeated concurrent initialization converges without rotating the persistent token", async () => {
    const credential = await createToken(userCookie, "revision-concurrent");
    const responses = await Promise.all([
      mcpRequest(credential.token, initializeBody(10)),
      mcpRequest(credential.token, initializeBody(11)),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(
      execSqliteInDocker(`SELECT toolsVersion FROM apiToken WHERE id = '${credential.id}'`),
    ).toBe(MCP_TOOLS_REVISION);
    expect(
      (await mcpRequest(credential.token, { jsonrpc: "2.0", method: "tools/list", id: 12 })).status,
    ).toBe(200);
  });
});
