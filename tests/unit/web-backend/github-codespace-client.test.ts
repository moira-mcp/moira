import { describe, expect, jest, test } from "@jest/globals";
import type { CodespaceGitHubConfigStatus } from "@mcp-moira/shared";
import {
  GitHubCodespaceClientError,
  HttpGitHubCodespaceClient,
  githubCodespaceGuidance,
  projectGitHubCodespaceBillingSummary,
  providerRefusalMessage,
} from "../../../packages/web-backend/src/services/github-codespace-client.js";

const config: Extract<CodespaceGitHubConfigStatus, { state: "available" }> = {
  state: "available",
  clientId: "Iv23abcdefgh1234",
  clientSecret: "github-app-client-secret-value-1234567890",
  callbackUrl: "https://moira.example.com/api/integrations/github/callback",
  installationUrl: "https://github.com/apps/moira-codespaces/installations/new",
  vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
  vaultKeyVersion: "v1",
  settingsUrl: "https://moira.example.com/settings#integrations-github",
};

const billingInput = {
  payerLogin: "witqq",
  year: 2026,
  month: 9,
  retrievedAt: Date.UTC(2026, 8, 28, 10),
  planName: "free",
};

function billingItem(overrides: Record<string, unknown> = {}) {
  return {
    product: "Codespaces",
    sku: "codespaces_compute_d2",
    unitType: "hours",
    pricePerUnit: 0.18,
    grossQuantity: 10,
    grossAmount: 1.8,
    discountQuantity: 10,
    discountAmount: 1.8,
    netQuantity: 0,
    netAmount: 0,
    ...overrides,
  };
}

function billingSummary(usageItems: unknown[]) {
  return { timePeriod: { year: 2026, month: 9 }, user: "witqq", usageItems };
}

describe("HttpGitHubCodespaceClient", () => {
  test("publishes exact provider-owned setup links even before operational configuration exists", () => {
    expect(githubCodespaceGuidance(config)).toMatchObject({
      links: [
        { id: "settings", url: config.settingsUrl },
        { id: "install", url: config.installationUrl },
        { id: "create_repository", url: "https://github.com/new" },
        { id: "provider_console", url: "https://github.com/codespaces" },
      ],
      instructions: {
        repository_not_approved: expect.stringContaining("repository_create"),
      },
    });
    expect(
      githubCodespaceGuidance({
        state: "disabled",
        reason: "NOT_CONFIGURED",
        settingsUrl: config.settingsUrl,
      }),
    ).toMatchObject({
      links: expect.arrayContaining([
        { id: "settings", url: config.settingsUrl, label: "Moira settings" },
        {
          id: "create_repository",
          url: "https://github.com/new",
          label: "New GitHub repository",
        },
      ]),
      instructions: { not_configured: expect.any(String) },
    });
  });

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
    const client = new HttpGitHubCodespaceClient(config, fetchImpl, () => 1_000);

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
    const client = new HttpGitHubCodespaceClient(config, fetchImpl, () => 1_000);

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
              {
                id: 9002,
                account: { id: 9911, login: "moira-mcp" },
                target_type: "Organization",
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
    const client = new HttpGitHubCodespaceClient(config, fetchImpl);

    await expect(client.listInstallations("ghu_access")).resolves.toEqual([
      {
        id: "9001",
        accountId: "25282049",
        accountLogin: "witqq",
        targetType: "User",
        repositorySelection: "selected",
      },
      {
        id: "9002",
        accountId: "9911",
        accountLogin: "moira-mcp",
        targetType: "Organization",
        repositorySelection: "selected",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("reads the personal billing owner for an organization repository before creation", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ billable_owner: { id: 25282049, login: "witqq" } }), {
        status: 200,
      }),
    );
    const client = new HttpGitHubCodespaceClient(config, fetchImpl);

    await expect(
      client.preflightCreate(
        "ghu_access",
        { id: "201", fullName: "moira-mcp/moira", private: false },
        "feature/codespaces",
      ),
    ).resolves.toEqual({ billableOwnerId: "25282049" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.github.com/repos/moira-mcp/moira/codespaces/new?ref=feature%2Fcodespaces",
    );
    expect(init?.method).toBeUndefined();
  });

  test("fails closed when create preflight omits a valid billing owner", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ billable_owner: null }), { status: 200 }));
    const client = new HttpGitHubCodespaceClient(config, fetchImpl);

    await expect(
      client.preflightCreate(
        "ghu_access",
        { id: "201", fullName: "moira-mcp/moira", private: false },
        "master",
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("reads the current UTC month for the authenticated personal payer and exposes known plan limits", async () => {
    const fetchedAt = Date.UTC(2026, 8, 28, 10);
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 25282049, login: "witqq", plan: { name: "pro" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            timePeriod: { year: 2026 },
            user: "witqq",
            usageItems: [billingItem()],
          }),
          { status: 200 },
        ),
      );
    const client = new HttpGitHubCodespaceClient(config, fetchImpl, () => fetchedAt);

    await expect(
      client.getMonthlyBilling("ghu_access", { id: "25282049", login: "witqq" }),
    ).resolves.toMatchObject({
      state: "available",
      payer_login: "witqq",
      period: { year: 2026, month: 9 },
      retrieved_at: fetchedAt,
      plan: "pro",
      compute: { included_core_hours: 180 },
      storage: { included_gb_month: 20 },
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/users/witqq/settings/billing/usage/summary?year=2026&month=9",
    ]);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
  });

  test("refuses a different authenticated payer before billing is queried", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 999, login: "someone-else" }), { status: 200 }),
      );
    const client = new HttpGitHubCodespaceClient(config, fetchImpl);

    await expect(
      client.getMonthlyBilling("ghu_access", { id: "25282049", login: "witqq" }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("propagates a missing Plan permission for the caller to mark billing unavailable", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 25282049, login: "witqq" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }),
      );
    const client = new HttpGitHubCodespaceClient(config, fetchImpl, () => billingInput.retrievedAt);

    await expect(
      client.getMonthlyBilling("ghu_access", { id: "25282049", login: "witqq" }),
    ).rejects.toMatchObject({ status: 403 });
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
    const client = new HttpGitHubCodespaceClient(config, fetchImpl);

    await expect(client.listInstallations("ghu_access")).rejects.toBeInstanceOf(
      GitHubCodespaceClientError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("revokes superseded tokens and disconnected grants without putting tokens in URLs", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new HttpGitHubCodespaceClient(config, fetchImpl);

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

describe("GitHub Codespaces monthly billing projection", () => {
  test("converts compute hours to core-hours and sums codespace plus prebuild storage in GB-month", () => {
    const result = projectGitHubCodespaceBillingSummary(
      billingSummary([
        billingItem(),
        billingItem({
          sku: "codespaces_compute_d4",
          pricePerUnit: 0.36,
          grossQuantity: 5,
          grossAmount: 1.8,
          discountQuantity: 3.61,
          discountAmount: 1.3,
          netQuantity: 1.39,
          netAmount: 0.5,
        }),
        billingItem({
          sku: "codespaces_storage",
          unitType: "gigabyte-hours",
          pricePerUnit: 0.07,
          grossQuantity: 2.5,
          grossAmount: 0.18,
          discountQuantity: 2.5,
          discountAmount: 0.18,
          netQuantity: 0,
          netAmount: 0,
        }),
        billingItem({
          sku: "codespaces_prebuild_storage",
          unitType: "gigabyte-hours",
          pricePerUnit: 0.07,
          grossQuantity: 0.5,
          grossAmount: 0.04,
          discountQuantity: 0,
          discountAmount: 0,
          netQuantity: 0.5,
          netAmount: 0.04,
        }),
        billingItem({ product: "Actions", sku: "actions_linux", unitType: "minutes" }),
      ]),
      billingInput,
    );

    expect(result).toEqual({
      state: "available",
      payer_login: "witqq",
      period: { year: 2026, month: 9 },
      retrieved_at: billingInput.retrievedAt,
      plan: "free",
      compute: { used_core_hours: 40, included_core_hours: 120, net_amount_usd: 0.5 },
      storage: { used_gb_month: 3, included_gb_month: 15, net_amount_usd: 0.04 },
      net_amount_usd: 0.54,
    });
  });

  test("keeps measured usage when GitHub omits the plan and avoids claiming an allowance", () => {
    expect(
      projectGitHubCodespaceBillingSummary(billingSummary([billingItem()]), {
        ...billingInput,
        planName: undefined,
      }),
    ).toMatchObject({
      plan: null,
      compute: { used_core_hours: 20, included_core_hours: null },
      storage: { used_gb_month: 0, included_gb_month: null },
    });
  });

  test("keeps a nonzero sub-cent provider charge instead of rounding it to zero", () => {
    const result = projectGitHubCodespaceBillingSummary(
      billingSummary([billingItem({ netAmount: 0.004, discountAmount: 1.796 })]),
      billingInput,
    );
    expect(result.compute.net_amount_usd).toBe(0.004);
    expect(result.net_amount_usd).toBe(0.004);
  });

  test.each([
    ["unknown Codespaces SKU", billingSummary([billingItem({ sku: "codespaces_compute_d64" })])],
    ["unknown compute unit", billingSummary([billingItem({ unitType: "minutes" })])],
    ["changed compute price", billingSummary([billingItem({ pricePerUnit: 0.2 })])],
    ["missing quantity", billingSummary([billingItem({ grossQuantity: undefined })])],
    ["invalid amount", billingSummary([billingItem({ netAmount: Number.NaN })])],
    ["missing item identity", billingSummary([billingItem({ sku: undefined })])],
    ["missing items", { timePeriod: { year: 2026, month: 9 }, user: "witqq" }],
    ["wrong payer", { ...billingSummary([billingItem()]), user: "someone-else" }],
    ["wrong month", { ...billingSummary([billingItem()]), timePeriod: { year: 2026, month: 8 } }],
  ])("rejects %s instead of displaying zero", (_case, summary) => {
    expect(() => projectGitHubCodespaceBillingSummary(summary, billingInput)).toThrow(
      "GitHub returned an unsupported billing summary",
    );
  });
});

describe("provider refusal reasons", () => {
  test.each([
    [
      "a bare message",
      JSON.stringify({ message: "Machine type is not available" }),
      "Machine type is not available",
    ],
    [
      "a message with field errors",
      JSON.stringify({ message: "Invalid request.", errors: [{ message: "ref not found" }] }),
      "Invalid request. ref not found",
    ],
    ["an HTML body", "<html><body>  Bad   request </body></html>", "Bad request"],
  ])("carries %s as the refusal reason", (_name, body, expected) => {
    expect(providerRefusalMessage(body)).toBe(expected);
  });

  test.each([
    ["an empty body", ""],
    ["whitespace only", "   \n  "],
    ["a token the provider echoed", JSON.stringify({ message: "ghu_0123456789abcdef is invalid" })],
    ["a fine-grained token", JSON.stringify({ message: "github_pat_abcdefgh1234 was revoked" })],
    ["a labelled secret", JSON.stringify({ message: "Authorization: Bearer abcdef" })],
    ["a JWT", JSON.stringify({ message: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NT rejected" })],
    ["a URL", JSON.stringify({ message: "See https://api.github.com/user/codespaces" })],
  ])("drops %s rather than risking a leak", (_name, body) => {
    // Degrading to the status alone is the safe direction: a partially redacted secret is still a
    // secret, and an audit row outlives the request that produced it.
    expect(providerRefusalMessage(body)).toBeUndefined();
  });

  test("bounds a long message so a record cannot be flooded", () => {
    const long = providerRefusalMessage(JSON.stringify({ message: "x".repeat(2_000) }));
    expect(long).toHaveLength(300);
  });

  test("a refusing request throws with the provider's reason attached", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "Codespaces are disabled for this repository" }), {
        status: 403,
      }),
    );
    const client = new HttpGitHubCodespaceClient(config, fetchImpl, () => 1_000);

    await expect(client.getIdentity("ghu_secret")).rejects.toMatchObject({
      status: 403,
      providerMessage: "Codespaces are disabled for this repository",
    });
  });
});
