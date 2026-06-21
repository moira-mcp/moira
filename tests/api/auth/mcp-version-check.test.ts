/**
 * MCP Version Check Tests
 * Tests HTTP 426 behavior for outdated/null toolsVersion tokens
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 * These tests manipulate toolsVersion in database to simulate outdated clients
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../../utils/test-config.js";
import { signInUser } from "../../utils/mcp-auth.js";
import { execSqliteInDocker } from "../../utils/docker-command.js";

const BASE_URL = getTestBaseUrl();
const OAUTH_REDIRECT_URI = "http://localhost:3333/oauth/callback";

// Helper to execute sqlite3 command in Docker container (supports remote via REMOTE_DOCKER_CONTEXT)
function execSqlite(sql: string): string {
  return execSqliteInDocker(sql);
}

// Create OAuth token via full flow and return access token
async function createOAuthToken(email: string, password: string): Promise<string> {
  // Step 1: Register OAuth client
  const registerResponse = await fetch(`${BASE_URL}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `test-version-check-${Date.now()}`,
      redirect_uris: [OAUTH_REDIRECT_URI],
      grant_types: ["authorization_code"],
    }),
  });

  if (!registerResponse.ok) {
    throw new Error(`OAuth client registration failed: ${registerResponse.status}`);
  }

  const clientData = (await registerResponse.json()) as {
    client_id: string;
    client_secret: string;
  };

  // Step 2: Sign in to get session cookie
  const sessionCookie = await signInUser(BASE_URL, email, password);

  // Step 3: Get authorization code
  const isSecure = BASE_URL.startsWith("https://");
  const cookieName = isSecure ? "__Secure-better-auth.session_token" : "better-auth.session_token";

  const authorizeUrl = new URL(`${BASE_URL}/api/auth/mcp/authorize`);
  authorizeUrl.searchParams.set("client_id", clientData.client_id);
  authorizeUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "test-state");
  authorizeUrl.searchParams.set("scope", "openid email profile");

  const authorizeResponse = await fetch(authorizeUrl.toString(), {
    method: "GET",
    headers: { Cookie: `${cookieName}=${sessionCookie}` },
    redirect: "manual",
  });

  if (authorizeResponse.status !== 302) {
    throw new Error(`Expected 302 redirect, got ${authorizeResponse.status}`);
  }

  const location = authorizeResponse.headers.get("location");
  if (!location || !location.includes("code=")) {
    throw new Error(`No authorization code in redirect. Location: ${location}`);
  }

  const locationUrl = new URL(location, BASE_URL);
  const code = locationUrl.searchParams.get("code");
  if (!code) {
    throw new Error("Failed to extract authorization code");
  }

  // Step 4: Exchange code for access token
  const tokenResponse = await fetch(`${BASE_URL}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: clientData.client_id,
      client_secret: clientData.client_secret,
      redirect_uri: OAUTH_REDIRECT_URI,
    }),
  });

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${error}`);
  }

  const tokenData = (await tokenResponse.json()) as { access_token: string };
  return tokenData.access_token;
}

// Make MCP request with given token
async function makeMcpRequest(
  accessToken: string,
): Promise<{ status: number; body: Record<string, unknown>; isSSE: boolean }> {
  const response = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    }),
  });

  const contentType = response.headers.get("content-type") || "";

  // Success responses are SSE (text/event-stream), error responses are JSON
  if (contentType.includes("text/event-stream")) {
    // For SSE, just verify it's a stream - don't parse
    return { status: response.status, body: { result: "SSE stream" }, isSSE: true };
  }

  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body, isSSE: false };
}

/**
 * SKIPPED: Tests directly write to SQLite database via CLI to modify toolsVersion.
 * This causes "database is locked" errors when the app has active write transactions.
 *
 * TODO: Redesign approach - options:
 * 1. Create Admin API endpoint for test purposes (PUT /api/admin/tokens/:token/version)
 * 2. Use SQLite busy_timeout in execSqliteInDocker
 * 3. Run these tests serially with retry
 * 4. Mock version check at application level
 */
describe.skip("MCP Version Check", () => {
  let adminCredentials: { email: string; password: string };
  const createdTokens: string[] = [];

  beforeAll(() => {
    adminCredentials = getAdminCredentials();
  });

  afterAll(() => {
    // Clean up created tokens from database
    for (const token of createdTokens) {
      try {
        execSqlite(`DELETE FROM oauthAccessToken WHERE accessToken = '${token}'`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  test("returns HTTP 426 for token with null toolsVersion", async () => {
    // Create token via OAuth flow (it will have current toolsVersion)
    const accessToken = await createOAuthToken(adminCredentials.email, adminCredentials.password);
    createdTokens.push(accessToken);

    // Set toolsVersion to NULL to simulate pre-migration token
    execSqlite(
      `UPDATE oauthAccessToken SET toolsVersion = NULL WHERE accessToken = '${accessToken}'`,
    );

    // Force WAL checkpoint to ensure MCP server sees the update
    execSqlite(`PRAGMA wal_checkpoint(TRUNCATE)`);

    // Small delay to allow MCP server to pick up the change
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the update
    const result = execSqlite(
      `SELECT toolsVersion FROM oauthAccessToken WHERE accessToken = '${accessToken}'`,
    );
    expect(result).toBe(""); // NULL returns empty string from sqlite3

    // Make MCP request - should get 426
    const { status, body, isSSE } = await makeMcpRequest(accessToken);

    expect(isSSE).toBe(false); // Error responses are JSON, not SSE
    expect(status).toBe(426);
    expect(body.error).toBe("upgrade_required");
    expect(body).toHaveProperty("error_description");
    expect(body).toHaveProperty("serverVersion");
    expect(body.clientVersion).toBe("unknown"); // null displays as "unknown"
  });

  test("returns HTTP 426 for token with outdated toolsVersion", async () => {
    // Create token via OAuth flow
    const accessToken = await createOAuthToken(adminCredentials.email, adminCredentials.password);
    createdTokens.push(accessToken);

    // Set toolsVersion to old version
    const outdatedVersion = "0.0.1";
    execSqlite(
      `UPDATE oauthAccessToken SET toolsVersion = '${outdatedVersion}' WHERE accessToken = '${accessToken}'`,
    );

    // Force WAL checkpoint to ensure MCP server sees the update
    execSqlite(`PRAGMA wal_checkpoint(TRUNCATE)`);

    // Small delay to allow MCP server to pick up the change
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the update
    const result = execSqlite(
      `SELECT toolsVersion FROM oauthAccessToken WHERE accessToken = '${accessToken}'`,
    );
    expect(result).toBe(outdatedVersion);

    // Make MCP request - should get 426
    const { status, body, isSSE } = await makeMcpRequest(accessToken);

    expect(isSSE).toBe(false); // Error responses are JSON, not SSE
    expect(status).toBe(426);
    expect(body.error).toBe("upgrade_required");
    expect(body).toHaveProperty("error_description");
    expect(body).toHaveProperty("serverVersion");
    expect(body.clientVersion).toBe(outdatedVersion);
  });

  test("returns success for token with matching toolsVersion", async () => {
    // Create token via OAuth flow - it should have matching version automatically
    const accessToken = await createOAuthToken(adminCredentials.email, adminCredentials.password);
    createdTokens.push(accessToken);

    // Verify the token has a toolsVersion (not null)
    const result = execSqlite(
      `SELECT toolsVersion FROM oauthAccessToken WHERE accessToken = '${accessToken}'`,
    );
    expect(result).not.toBe(""); // Should have a version, not null

    // Make MCP request - should succeed
    const { status, isSSE } = await makeMcpRequest(accessToken);

    expect(status).toBe(200);
    expect(isSSE).toBe(true); // Success responses are SSE streams
  });
});
