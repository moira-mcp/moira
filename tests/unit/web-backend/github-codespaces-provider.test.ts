import { describe, expect, jest, test } from "@jest/globals";
import type { WorkspaceGitHubConfigStatus } from "@mcp-moira/shared";
import { HttpGitHubWorkspaceClient } from "../../../packages/web-backend/src/services/github-workspace-client.js";

const config: Extract<WorkspaceGitHubConfigStatus, { state: "available" }> = {
  state: "available",
  clientId: "Iv23abcdefgh1234",
  clientSecret: "github-app-client-secret-value-1234567890",
  callbackUrl: "https://moira.example.com/api/integrations/github/callback",
  installationUrl: "https://github.com/apps/moira/installations/new",
  vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
  vaultKeyVersion: "v1",
  settingsUrl: "https://moira.example.com/settings#integrations-github",
};

function codespace(overrides: Record<string, unknown> = {}) {
  return {
    name: "silver-space-123",
    display_name: "moira-operation",
    owner: { id: 101 },
    billable_owner: { id: 101 },
    repository: { id: 301, full_name: "owner/repository" },
    git_status: { ref: "refs/heads/main" },
    state: "Available",
    machine: {
      name: "basicLinux32gb",
      display_name: "Basic Linux",
      operating_system: "linux",
      cpus: 2,
      memory_in_bytes: 8 * 1024 ** 3,
      storage_in_bytes: 32 * 1024 ** 3,
    },
    created_at: "2026-09-07T05:00:00.000Z",
    ...overrides,
  };
}

describe("GitHub Codespaces provider edge", () => {
  test("discovers machines and follows bounded same-origin user Codespace pagination", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ machines: [codespace().machine] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ codespaces: [codespace()] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: '<https://api.github.com/user/codespaces?per_page=100&page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ codespaces: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const client = new HttpGitHubWorkspaceClient(config, fetchImpl);
    await expect(
      client.listMachines("ghu_secret", {
        id: "301",
        fullName: "owner/repository",
        private: true,
      }),
    ).resolves.toEqual([
      {
        name: "basicLinux32gb",
        displayName: "Basic Linux",
        operatingSystem: "linux",
        cpuCores: 2,
        memoryBytes: 8 * 1024 ** 3,
        storageBytes: 32 * 1024 ** 3,
      },
    ]);
    await expect(client.listOwned("ghu_secret")).resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("rejects foreign pagination, invalid ownership and unknown server failures without body leakage", async () => {
    const foreignPagination = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ codespaces: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Link: '<https://attacker.example/steal>; rel="next"',
        },
      }),
    );
    await expect(
      new HttpGitHubWorkspaceClient(config, foreignPagination).listOwned("ghu_secret"),
    ).rejects.toThrow(/pagination left/);

    const invalidOwner = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(codespace({ owner: { id: "not-an-id" } })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      new HttpGitHubWorkspaceClient(config, invalidOwner).getExact(
        "ghu_secret",
        "silver-space-123",
      ),
    ).rejects.toThrow(/invalid identifier/);

    const failed = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("provider echoed ghu_secret", { status: 500 }));
    const request = new HttpGitHubWorkspaceClient(config, failed).create("ghu_secret", {
      repository: {
        id: "301",
        fullName: "owner/repository",
        private: true,
      },
      ref: "refs/heads/main",
      machine: {
        name: "basic",
        displayName: "Basic",
        operatingSystem: "linux",
        cpuCores: 2,
        memoryBytes: 4,
        storageBytes: 8,
      },
      operationMarker: "moira-operation",
      idleTimeoutMinutes: 30,
      retentionMinutes: 30,
    });
    await expect(request).rejects.toThrow("GitHub API request failed");
    await expect(request).rejects.not.toThrow(/ghu_secret/);
  });

  test("refuses pagination beyond its bound and malformed immutable resource facts", async () => {
    const endless = jest.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ codespaces: [] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: '<https://api.github.com/user/codespaces?per_page=100&page=2>; rel="next"',
          },
        }),
    );
    await expect(
      new HttpGitHubWorkspaceClient(config, endless).listOwned("ghu_secret"),
    ).rejects.toThrow(/pagination exceeded/);
    expect(endless).toHaveBeenCalledTimes(20);

    const malformed = [
      { billable_owner: { id: 0 } },
      { repository: { id: "invalid", full_name: "owner/repository" } },
      { machine: { ...codespace().machine, cpus: 0 } },
      { created_at: "not-a-time" },
    ];
    for (const override of malformed) {
      const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(codespace(override)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await expect(
        new HttpGitHubWorkspaceClient(config, fetchImpl).getExact("ghu_secret", "silver-space-123"),
      ).rejects.toBeInstanceOf(Error);
    }

    const unknownState = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(codespace({ state: "FutureProviderState" })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      new HttpGitHubWorkspaceClient(config, unknownState).getExact(
        "ghu_secret",
        "silver-space-123",
      ),
    ).resolves.toMatchObject({ state: "provisioning" });
  });

  test("pins explicit machine/marker and parses personal ownership from accepted create", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(codespace()), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new HttpGitHubWorkspaceClient(config, fetchImpl);
    const result = await client.create("ghu_secret", {
      repository: {
        id: "301",
        fullName: "owner/repository",
        private: true,
      },
      ref: "refs/heads/main",
      machine: {
        name: "basicLinux32gb",
        displayName: "Basic Linux",
        operatingSystem: "linux",
        cpuCores: 2,
        memoryBytes: 8 * 1024 ** 3,
        storageBytes: 32 * 1024 ** 3,
      },
      operationMarker: "moira-operation",
      idleTimeoutMinutes: 120,
      retentionMinutes: 120,
    });

    expect(result).toMatchObject({
      outcome: "accepted",
      resource: { ownerId: "101", billableOwnerId: "101", repositoryId: "301" },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/owner/repository/codespaces");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      machine: "basicLinux32gb",
      display_name: "moira-operation",
      retention_period_minutes: 120,
    });
    expect(String(url)).not.toContain("ghu_secret");
  });

  test("keeps accepted-background distinct and sanitizes definitive provider rejection", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response("provider echoed secret", { status: 422 }));
    const client = new HttpGitHubWorkspaceClient(config, fetchImpl);
    const input = {
      repository: {
        id: "301",
        fullName: "owner/repository",
        private: true,
      },
      ref: "refs/heads/main",
      machine: {
        name: "basic",
        displayName: "Basic",
        operatingSystem: "linux",
        cpuCores: 2,
        memoryBytes: 4,
        storageBytes: 8,
      },
      operationMarker: "moira-operation",
      idleTimeoutMinutes: 30,
      retentionMinutes: 30,
    } as const;
    await expect(client.create("ghu_secret", input)).resolves.toEqual({
      outcome: "accepted",
      resource: null,
    });
    await expect(client.create("ghu_secret", input)).resolves.toEqual({
      outcome: "rejected",
      reason: "github_status_422",
    });
  });

  test("uses exact lifecycle paths and treats only exact 404 as absence", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const client = new HttpGitHubWorkspaceClient(config, fetchImpl);
    await expect(client.getExact("ghu_secret", "silver-space-123")).resolves.toBeNull();
    await expect(client.stopExact("ghu_secret", "silver-space-123")).resolves.toBe("accepted");
    await expect(client.deleteExact("ghu_secret", "silver-space-123")).resolves.toBe("accepted");
    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"])).toEqual(
      [
        ["https://api.github.com/user/codespaces/silver-space-123", "GET"],
        ["https://api.github.com/user/codespaces/silver-space-123/stop", "POST"],
        ["https://api.github.com/user/codespaces/silver-space-123", "DELETE"],
      ],
    );
  });
});
