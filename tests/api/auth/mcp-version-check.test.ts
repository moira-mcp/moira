/**
 * MCP OAuth tools-revision integration.
 *
 * Null and stale revision decisions are deterministic unit-tested contract
 * cases. This suite keeps the real OAuth exchange, initialization-gated
 * persistence, and MCP request path executable.
 */

import { beforeAll, describe, expect, test } from "@jest/globals";
import { MCP_TOOLS_REVISION } from "@mcp-moira/mcp-server/tool-contract";
import { getAdminCredentials, getTestBaseUrl } from "../../utils/test-config.js";
import { signInUser } from "../../utils/mcp-auth.js";
import { execSqliteInDocker } from "../../utils/docker-command.js";

const BASE_URL = getTestBaseUrl();
const OAUTH_REDIRECT_URI = "http://localhost:3333/oauth/callback";

const initializeBody = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "oauth-revision-test", version: "1.0.0" },
  },
});

async function mcpRequest(accessToken: string, body: unknown): Promise<Response> {
  return fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
}

interface OAuthCredential {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

async function createOAuthToken(email: string, password: string): Promise<OAuthCredential> {
  const registerResponse = await fetch(`${BASE_URL}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `test-version-check-${Date.now()}`,
      redirect_uris: [OAUTH_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
    }),
  });
  expect(registerResponse.status).toBe(201);
  const client = (await registerResponse.json()) as {
    client_id: string;
    client_secret: string;
  };

  const sessionCookie = await signInUser(BASE_URL, email, password);
  const cookieName = BASE_URL.startsWith("https://")
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
  const authorizeUrl = new URL(`${BASE_URL}/api/auth/mcp/authorize`);
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "revision-test");
  authorizeUrl.searchParams.set("scope", "openid email profile offline_access");

  const authorizeResponse = await fetch(authorizeUrl, {
    headers: { Cookie: `${cookieName}=${sessionCookie}` },
    redirect: "manual",
  });
  expect(authorizeResponse.status).toBe(302);
  const location = authorizeResponse.headers.get("location");
  expect(location).not.toBeNull();
  const code = new URL(location!, BASE_URL).searchParams.get("code");
  expect(code).not.toBeNull();

  const tokenResponse = await fetch(`${BASE_URL}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: OAUTH_REDIRECT_URI,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const token = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
  expect(token.refresh_token).toEqual(expect.any(String));
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    clientId: client.client_id,
    clientSecret: client.client_secret,
  };
}

describe("MCP OAuth tools revision", () => {
  let adminCredentials: { email: string; password: string };

  beforeAll(() => {
    adminCredentials = getAdminCredentials();
  });

  test("initializes only the exact OAuth credential with the same access token", async () => {
    const firstCredential = await createOAuthToken(
      adminCredentials.email,
      adminCredentials.password,
    );
    const siblingCredential = await createOAuthToken(
      adminCredentials.email,
      adminCredentials.password,
    );
    const first = firstCredential.accessToken;
    const sibling = siblingCredential.accessToken;
    const storedBefore = execSqliteInDocker(
      `SELECT COALESCE(toolsVersion, 'null') FROM oauthAccessToken WHERE accessToken IN ('${first}', '${sibling}') ORDER BY accessToken`,
    );
    expect(storedBefore.split("\n")).toEqual(["null", "null"]);

    expect((await mcpRequest(first, { jsonrpc: "2.0", method: "tools/list", id: 1 })).status).toBe(
      426,
    );
    expect(
      execSqliteInDocker(
        `SELECT COALESCE(toolsVersion, 'null') FROM oauthAccessToken WHERE accessToken = '${first}'`,
      ),
    ).toBe("null");
    expect((await mcpRequest(first, initializeBody(2))).status).toBe(200);
    expect(
      execSqliteInDocker(
        `SELECT toolsVersion FROM oauthAccessToken WHERE accessToken = '${first}'`,
      ),
    ).toBe(MCP_TOOLS_REVISION);
    expect(
      execSqliteInDocker(
        `SELECT COALESCE(toolsVersion, 'null') FROM oauthAccessToken WHERE accessToken = '${sibling}'`,
      ),
    ).toBe("null");
    expect((await mcpRequest(first, { jsonrpc: "2.0", method: "tools/list", id: 3 })).status).toBe(
      200,
    );

    execSqliteInDocker(
      `UPDATE oauthAccessToken SET toolsVersion = 'stale-revision' WHERE accessToken = '${first}'`,
    );
    expect((await mcpRequest(first, { jsonrpc: "2.0", method: "tools/list", id: 4 })).status).toBe(
      426,
    );
    expect(
      execSqliteInDocker(
        `SELECT toolsVersion FROM oauthAccessToken WHERE accessToken = '${first}'`,
      ),
    ).toBe("stale-revision");
    const concurrent = await Promise.all([
      mcpRequest(first, initializeBody(5)),
      mcpRequest(first, initializeBody(6)),
    ]);
    expect(concurrent.map(({ status }) => status)).toEqual([200, 200]);
    expect(
      execSqliteInDocker(
        `SELECT toolsVersion FROM oauthAccessToken WHERE accessToken = '${first}'`,
      ),
    ).toBe(MCP_TOOLS_REVISION);

    const refreshResponse = await fetch(`${BASE_URL}/api/auth/mcp/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: firstCredential.refreshToken,
        client_id: firstCredential.clientId,
        client_secret: firstCredential.clientSecret,
      }),
    });
    const refreshBody = (await refreshResponse.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    expect({ status: refreshResponse.status, body: refreshBody }).toEqual({
      status: 200,
      body: expect.objectContaining({ access_token: expect.any(String) }),
    });
    const refreshed = { access_token: refreshBody.access_token! };
    expect(refreshed.access_token).not.toBe(first);
    expect(
      execSqliteInDocker(
        `SELECT COALESCE(toolsVersion, 'null') FROM oauthAccessToken WHERE accessToken = '${refreshed.access_token}'`,
      ),
    ).toBe("null");
    expect(
      (
        await mcpRequest(refreshed.access_token, {
          jsonrpc: "2.0",
          method: "tools/list",
          id: 7,
        })
      ).status,
    ).toBe(426);
    expect((await mcpRequest(refreshed.access_token, initializeBody(8))).status).toBe(200);
  });
});
