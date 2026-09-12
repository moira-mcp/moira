import { describe, expect, jest, test } from "@jest/globals";
import type { WorkspaceGitHubConfigStatus } from "@mcp-moira/shared";
import {
  GitHubWorkspaceClientError,
  HttpGitHubWorkspaceClient,
} from "../../../packages/web-backend/src/services/github-workspace-client.js";

const config: Extract<WorkspaceGitHubConfigStatus, { state: "available" }> = {
  state: "available",
  clientId: "Iv23abcdefgh1234",
  clientSecret: "github-app-client-secret-value-1234567890",
  callbackUrl: "https://moira.example.com/api/integrations/github/callback",
  installationUrl: "https://github.com/apps/moira-workspaces/installations/new",
  vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
  vaultKeyVersion: "v1",
  settingsUrl: "https://moira.example.com/settings#integrations-github",
};

describe("HttpGitHubWorkspaceClient", () => {
  test("exchanges a browser code for an expiring GitHub App token pair", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "ghu_access",
          refresh_token: "ghr_refresh",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new HttpGitHubWorkspaceClient(config, fetchImpl, () => 1_000);

    await expect(client.exchangeCode("browser-code")).resolves.toEqual({
      accessToken: "ghu_access",
      refreshToken: "ghr_refresh",
      accessTokenExpiresAt: 28_801_000,
      refreshTokenExpiresAt: 15_897_601_000,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(String(init?.body)).toContain(`client_id=${config.clientId}`);
    expect(String(init?.body)).toContain("code=browser-code");
    expect(String(init?.body)).not.toContain("device_code");
  });

  test("refreshes an expiring user token with the server-side GitHub App contract", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "ghu_successor",
          refresh_token: "ghr_successor",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new HttpGitHubWorkspaceClient(config, fetchImpl, () => 1_000);

    const refreshed = await client.refreshToken("ghr_predecessor-secret");
    expect(refreshed).toEqual({
      accessToken: "ghu_successor",
      refreshToken: "ghr_successor",
      accessTokenExpiresAt: 28_801_000,
      refreshTokenExpiresAt: 15_897_601_000,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(String(url)).not.toContain("ghr_predecessor-secret");
    expect(String(init?.body)).toBe(
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: "ghr_predecessor-secret",
      }).toString(),
    );
    expect(JSON.stringify(refreshed)).not.toContain("ghr_predecessor-secret");

    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "bad_verification_code",
          error_description: "provider echoed ghr_predecessor-secret",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    const failed = client.refreshToken("ghr_predecessor-secret");
    await expect(failed).rejects.toMatchObject({
      message: "GitHub credential exchange failed",
      status: 400,
    });
    await expect(failed).rejects.not.toThrow(/ghr_predecessor-secret/);
  });

  test("follows bounded same-origin installation pagination and preserves numeric IDs", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            installations: [
              {
                id: 9001,
                account: { id: 25282049, login: "witqq" },
                target_type: "User",
                repository_selection: "selected",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ installations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const client = new HttpGitHubWorkspaceClient(config, fetchImpl);

    await expect(client.listInstallations("ghu_access")).resolves.toEqual([
      {
        id: "9001",
        accountId: "25282049",
        accountLogin: "witqq",
        targetType: "User",
        repositorySelection: "selected",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("refuses a pagination link that leaves GitHub API origin", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ installations: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Link: '<https://attacker.example/steal>; rel="next"',
        },
      }),
    );
    const client = new HttpGitHubWorkspaceClient(config, fetchImpl);

    await expect(client.listInstallations("ghu_access")).rejects.toBeInstanceOf(
      GitHubWorkspaceClientError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("revokes superseded tokens and disconnected grants without putting tokens in URLs", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new HttpGitHubWorkspaceClient(config, fetchImpl);

    await client.revokeToken("ghu_revoke-me");
    await client.revokeGrant("ghu_disconnect-me");
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `https://api.github.com/applications/${config.clientId}/token`,
      `https://api.github.com/applications/${config.clientId}/grant`,
    ]);
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).join("\n")).not.toMatch(
      /ghu_revoke-me|ghu_disconnect-me/,
    );
    expect(fetchImpl.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ access_token: "ghu_revoke-me" }),
    );
    expect(fetchImpl.mock.calls[1][1]?.body).toBe(
      JSON.stringify({ access_token: "ghu_disconnect-me" }),
    );
  });
});
