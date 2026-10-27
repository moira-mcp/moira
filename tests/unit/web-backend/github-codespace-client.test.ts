import { describe, expect, jest, test } from "@jest/globals";
import type { CodespaceGitHubConfigStatus } from "@mcp-moira/shared";
import {
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
  const creation = {
    repository: { id: "201", fullName: "person/project", private: true },
    ref: "main",
    machine: {
      name: "standard",
      displayName: "Standard",
      operatingSystem: "linux",
      cpuCores: 2,
      memoryBytes: 4096,
      storageBytes: 8192,
    },
    operationMarker: "moira-" + "a".repeat(24),
    idleTimeoutMinutes: 30,
    retentionMinutes: 1440,
  };
  test.each([500, 408])(
    "preserves received HTTP%s evidence for the original unknown creation without exposing credentials",
    async (status) => {
      const client = new HttpGitHubCodespaceClient(
        config,
        jest
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json(
              { message: "Provider temporarily refused the request" },
              { status, headers: { "x-github-request-id": "AB12:CD34:EF56" } },
            ),
          ),
      );
      const result = client.create("ghu_private-original", creation);
      await expect(result).rejects.toMatchObject({
        providerFailure: {
          kind: "http",
          phase: "request",
          status,
          githubRequestId: "AB12:CD34:EF56",
          reason: "Provider temporarily refused the request",
        },
      });
      await expect(result).rejects.not.toThrow("ghu_private-original");
    },
  );
  test.each([
    [401, "Requires authentication"],
    [402, "Codespaces usage not allowed by the configured budget"],
  ])(
    "treats an actual HTTP%s refusal as known without repeating creation",
    async (status, message) => {
      const fetchImpl = jest
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ message }, { status, headers: { "x-github-request-id": "AB12:CD34" } }),
        );
      await expect(
        new HttpGitHubCodespaceClient(config, fetchImpl).create("ghu_private-original", creation),
      ).resolves.toEqual({
        outcome: "rejected",
        reason: `github_status_${status}`,
        detail: message,
        providerFailure: {
          kind: "http",
          phase: "request",
          status,
          githubRequestId: "AB12:CD34",
          reason: message,
        },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  test("keeps safe evidence on a confirmed create refusal and drops secret-shaped provider metadata", async () => {
    const client = new HttpGitHubCodespaceClient(
      config,
      jest
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { message: "ghu_private-original was rejected" },
            { status: 403, headers: { "x-github-request-id": "ghu_private-original" } },
          ),
        ),
    );
    await expect(client.create("ghu_private-original", creation)).resolves.toEqual({
      outcome: "rejected",
      reason: "github_status_403",
      providerFailure: { kind: "http", phase: "request", status: 403 },
    });
  });
  test("distinguishes a missing transport reply from a received invalid JSON reply", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("https://api.github.com/?token=ghu_private-original"));
    const client = new HttpGitHubCodespaceClient(config, fetchImpl);
    await expect(client.create("ghu_private-original", creation)).rejects.toMatchObject({
      providerFailure: { kind: "transport", phase: "request", cause: "request_failed" },
    });
    fetchImpl.mockResolvedValueOnce(
      new Response("{", { status: 201, headers: { "x-github-request-id": "AB12:CD34" } }),
    );
    await expect(client.create("ghu_private-original", creation)).rejects.toMatchObject({
      providerFailure: {
        kind: "reply_invalid",
        phase: "json",
        status: 201,
        githubRequestId: "AB12:CD34",
      },
    });
    fetchImpl.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("ghu_private-original body interrupted"));
          },
        }),
        { status: 201, headers: { "x-github-request-id": "AB12:CD34" } },
      ),
    );
    await expect(client.create("ghu_private-original", creation)).rejects.toMatchObject({
      providerFailure: {
        kind: "transport",
        phase: "body",
        status: 201,
        githubRequestId: "AB12:CD34",
        cause: "request_failed",
      },
    });
  });
  test("retains successful HTTP identity when resource projection fails after provider acceptance", async () => {
    const client = new HttpGitHubCodespaceClient(
      config,
      jest.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            state: "Provisioning",
            created_at: "2026-10-14T00:00:00Z",
            name: "provider-created",
            display_name: "Original",
            owner: { id: 101 },
            billable_owner: { id: 101 },
            repository: { full_name: "person/project" },
          },
          { status: 201, headers: { "x-github-request-id": "AB12:CD34" } },
        ),
      ),
    );
    await expect(client.create("ghu_private-original", creation)).rejects.toMatchObject({
      providerFailure: {
        kind: "reply_invalid",
        phase: "projection",
        status: 201,
        githubRequestId: "AB12:CD34",
        reason: "GitHub returned an invalid identifier",
      },
    });
  });
  test("scopes an existing parent to one exact numeric repository and retains malformed candidate metadata", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "ghu_candidate",
          expires_at: "invalid",
          installation: { permissions: { administration: "write" } },
        }),
        { status: 200 },
      ),
    );
    const client = new HttpGitHubCodespaceClient(config, fetchImpl);
    await expect(
      client.createScopedToken("ghu_parent", {
        repositoryId: 1414067342,
        target: "witqq",
        permissions: { metadata: "read", contents: "read" },
      }),
    ).resolves.toMatchObject({ token: "ghu_candidate", expiresAt: null });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://api.github.com/applications/${config.clientId}/token/scoped`);
    expect(init?.headers).toMatchObject({ "X-GitHub-Api-Version": "2022-11-28" });
    expect(JSON.parse(String(init?.body))).toEqual({
      access_token: "ghu_parent",
      target: "witqq",
      repository_ids: [1414067342],
      permissions: { metadata: "read", contents: "read" },
    });
    expect(String(url)).not.toContain("ghu_parent");
  });
  test("scoped disposal accepts confirmed token absence and preserves other unconfirmed failures", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: "ghu_child-secret" }), { status: 404 }),
      );
    const client = new HttpGitHubCodespaceClient(config, fetchImpl);
    await expect(client.revokeScopedToken("ghu_child-secret")).resolves.toBeUndefined();
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "ghu_child-secret" }), { status: 500 }),
    );
    await expect(client.revokeScopedToken("ghu_child-secret")).rejects.toMatchObject({
      status: 500,
      message: "Scoped credential disposal unconfirmed",
    });
    fetchImpl.mockRejectedValueOnce(new Error("ghu_child-secret"));
    await expect(client.revokeScopedToken("ghu_child-secret")).rejects.not.toThrow(
      "ghu_child-secret",
    );
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.revokeScopedToken("ghu_child-secret")).resolves.toBeUndefined();
  });
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

  test("follows same-origin installation pagination and preserves numeric IDs", async () => {
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

    await expect(client.listInstallations("ghu_access")).rejects.toMatchObject({
      providerFailure: { kind: "reply_invalid", phase: "projection", status: 200 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("a malformed successful grant page retains the received HTTP identity instead of looking like a lost request", async () => {
    const client = new HttpGitHubCodespaceClient(
      config,
      jest
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(null, { status: 200, headers: { "x-github-request-id": "AB12:CD34" } }),
        ),
    );
    await expect(client.listInstallations("ghu_private-original")).rejects.toMatchObject({
      providerFailure: {
        kind: "reply_invalid",
        phase: "projection",
        status: 200,
        githubRequestId: "AB12:CD34",
        reason: "GitHub returned an invalid JSON response",
      },
    });
  });

  test.each(["codespaces", "machines", "installations", "repositories"] as const)(
    "%s discovery refuses missing and malformed arrays but accepts an actual empty result",
    async (field) => {
      let body: unknown = {};
      const client = new HttpGitHubCodespaceClient(
        config,
        jest.fn<typeof fetch>(async () =>
          Response.json(body, { status: 200, headers: { "x-github-request-id": "AB12:CD34" } }),
        ),
      );
      const read = () =>
        field === "codespaces"
          ? client.listOwned("ghu_private")
          : field === "machines"
            ? client.listMachines(
                "ghu_private",
                { id: "201", fullName: "person/project", private: true },
                "main",
              )
            : field === "installations"
              ? client.listInstallations("ghu_private")
              : client.listInstallationRepositories("ghu_private", "901");
      for (body of [{}, { [field]: {} }])
        await expect(read()).rejects.toMatchObject({
          providerFailure: {
            kind: "reply_invalid",
            phase: "projection",
            status: 200,
            githubRequestId: "AB12:CD34",
          },
        });
      body = { [field]: [] };
      await expect(read()).resolves.toEqual([]);
    },
  );

  test("reads grants beyond the former page ceiling, but refuses a cyclic continuation before resending credentials", async () => {
    const fetchImpl = jest.fn<typeof fetch>(async (url) => {
      const page = Number(new URL(String(url)).searchParams.get("page") ?? 1);
      return Response.json(
        { installations: [] },
        {
          headers:
            page < 21
              ? {
                  Link: `<https://api.github.com/user/installations?per_page=100&page=${page + 1}>; rel="next"`,
                }
              : {},
        },
      );
    });
    const client = new HttpGitHubCodespaceClient(config, fetchImpl);
    await expect(client.listInstallations("ghu_access")).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(21);
    fetchImpl.mockClear();
    fetchImpl.mockImplementation(async () =>
      Response.json(
        { installations: [] },
        {
          headers: { Link: '<https://api.github.com/user/installations?per_page=100>; rel="next"' },
        },
      ),
    );
    await expect(client.listInstallations("ghu_access")).rejects.toMatchObject({ status: 502 });
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
    ["a hyphenated token echo", JSON.stringify({ message: "ghu_private-original was rejected" })],
    ["a shortened refresh token", JSON.stringify({ message: "ghr_short was rejected" })],
    ["a partially echoed installation token", JSON.stringify({ message: "ghs_ab was rejected" })],
    ["a shortened fine-grained token", JSON.stringify({ message: "github_pat_ab was rejected" })],
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

    await expect(client.getUser("ghu_secret")).rejects.toMatchObject({
      status: 403,
      providerMessage: "Codespaces are disabled for this repository",
    });
  });
});
