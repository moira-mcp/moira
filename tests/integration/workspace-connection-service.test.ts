import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as path from "node:path";
import {
  WorkspaceConnectionError,
  WorkspaceConnectionRepository,
  WorkspaceConnectionService,
  type GitHubWorkspaceClient,
  type WorkspaceConnectionAuditEvent,
  type WorkspaceGitHubConfigStatus,
} from "@mcp-moira/shared";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const key = "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805";
const config: Extract<WorkspaceGitHubConfigStatus, { state: "available" }> = {
  state: "available",
  clientId: "Iv23abcdefgh1234",
  clientSecret: "github-app-client-secret-value-1234567890",
  callbackUrl: "https://moira.example.com/api/integrations/github/callback",
  installationUrl: "https://github.com/apps/moira-workspaces/installations/new",
  vaultKeyHex: key,
  vaultKeyVersion: "v1",
  settingsUrl: "https://moira.example.com/app/settings#integrations-github",
};

class FakeGitHubClient implements GitHubWorkspaceClient {
  refreshCalls = 0;
  refreshFails = false;
  revokeFails = false;
  revokeTokenFails = false;
  revokeTokenFailureTokens = new Set<string>();
  revokedTokens: string[] = [];
  revokedGrants: string[] = [];
  repositoryListCalls = 0;
  refreshBarrier: Promise<void> | null = null;
  onRefreshStart: (() => void) | null = null;
  installations = [
    {
      id: "9001",
      accountId: "25282049",
      accountLogin: "witqq",
      targetType: "User",
      repositorySelection: "selected" as const,
    },
  ];

  async exchangeCode() {
    return {
      accessToken: "ghu_initial-secret",
      refreshToken: "ghr_initial-secret",
      accessTokenExpiresAt: 1_030_000,
      refreshTokenExpiresAt: 9_000_000,
    };
  }

  async refreshToken() {
    this.refreshCalls += 1;
    this.onRefreshStart?.();
    await (this.refreshBarrier ?? Promise.resolve());
    if (this.refreshFails) throw new Error("ambiguous GitHub refresh failure");
    return {
      accessToken: "ghu_refreshed-secret",
      refreshToken: "ghr_refreshed-secret",
      accessTokenExpiresAt: 2_000_000,
      refreshTokenExpiresAt: 10_000_000,
    };
  }

  async getUser() {
    return { id: "25282049", login: "witqq" };
  }

  async listInstallations() {
    return this.installations;
  }

  async listInstallationRepositories() {
    this.repositoryListCalls += 1;
    return [{ id: "101", fullName: "witqq/private-project", private: true }];
  }

  async revokeToken(accessToken: string) {
    this.revokedTokens.push(accessToken);
    if (this.revokeTokenFails || this.revokeTokenFailureTokens.has(accessToken)) {
      throw new Error("temporary token revocation failure");
    }
  }

  async revokeGrant(accessToken: string) {
    this.revokedGrants.push(accessToken);
    if (this.revokeFails) throw new Error("temporary GitHub failure");
  }
}

describe("WorkspaceConnectionService with real SQLite persistence", () => {
  let sqlite: Database.Database;
  let repository: WorkspaceConnectionRepository;
  let github: FakeGitHubClient;
  let now: number;
  let audits: WorkspaceConnectionAuditEvent[];
  let service: WorkspaceConnectionService;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite), { migrationsFolder: migrations });
    for (const [id, email] of [
      ["user-a", "a@example.test"],
      ["user-b", "b@example.test"],
    ]) {
      sqlite
        .prepare(
          `INSERT INTO user (id, email, name, handle, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, 'now', 'now')`,
        )
        .run(id, email, id, id);
    }
    repository = new WorkspaceConnectionRepository(sqlite);
    github = new FakeGitHubClient();
    now = 1_000_000;
    audits = [];
    service = new WorkspaceConnectionService({
      repository,
      config: () => config,
      client: () => github,
      now: () => now,
      randomState: () => "state_abcdefghijklmnopqrstuvwxyz0123456789",
      randomId: () => "refresh-lease",
      sleep: async () => undefined,
      audit: (event) => {
        audits.push(event);
      },
    });
  });

  afterEach(() => sqlite.close());

  async function connect(
    expectedState: "connected" | "installation_required" = "connected",
  ): Promise<void> {
    const authorizationUrl = await service.beginAuthorization("user-a", "web-session-a");
    const parsed = new URL(authorizationUrl);
    expect(parsed.origin).toBe("https://github.com");
    expect(parsed.searchParams.get("redirect_uri")).toBe(config.callbackUrl);

    await expect(
      service.completeAuthorization({
        userId: "user-a",
        sessionToken: "wrong-session",
        state: parsed.searchParams.get("state")!,
        code: "github-code-123",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });

    const result = await service.completeAuthorization({
      userId: "user-a",
      sessionToken: "web-session-a",
      state: parsed.searchParams.get("state")!,
      code: "github-code-123",
    });
    expect(result).toMatchObject({
      state: expectedState,
      account: { id: "25282049", login: "witqq" },
    });
    if (expectedState === "connected") {
      expect(result.repositories).toEqual([
        expect.objectContaining({ fullName: "witqq/private-project", private: true }),
      ]);
    }
  }

  test("stores only a state digest and one tenant-bound encrypted credential", async () => {
    await connect();

    const state = sqlite.prepare("SELECT * FROM workspaceAuthorizationState").get() as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(state)).not.toContain("state_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(state.consumedAt).toBe(now);

    const vault = sqlite.prepare("SELECT * FROM workspaceCredentialVault").get() as Record<
      string,
      unknown
    >;
    expect(vault).toMatchObject({ envelopeVersion: 1, keyVersion: "v1", generation: 1 });
    expect(JSON.stringify(vault)).not.toMatch(/ghu_initial-secret|ghr_initial-secret/);
    expect(repository.getCredential("user-b", "github-codespaces")).toBeNull();
    expect(service.getStatus("user-b")).toMatchObject({ state: "connection_required" });
    await expect(service.disconnect("user-b")).resolves.toMatchObject({
      state: "connection_required",
    });
    expect(repository.getCredential("user-a", "github-codespaces")).not.toBeNull();
    expect(JSON.stringify(audits)).not.toMatch(/ghu_|ghr_|web-session|github-code-123/);
  });

  test("rejects a replayed browser state without changing the connected account", async () => {
    await connect();
    await expect(
      service.completeAuthorization({
        userId: "user-a",
        sessionToken: "web-session-a",
        state: "state_abcdefghijklmnopqrstuvwxyz0123456789",
        code: "another-code-123",
      }),
    ).rejects.toBeInstanceOf(WorkspaceConnectionError);
    expect(service.getStatus("user-a")).toMatchObject({ state: "connected" });
    await expect(service.beginAuthorization("user-a", "web-session-a")).rejects.toMatchObject({
      code: "AUTHORIZATION_FAILED",
    });
  });

  test("a newer browser start invalidates an older unconsumed state for the same session", async () => {
    const states = [
      "state_old_abcdefghijklmnopqrstuvwxyz0123456789",
      "state_new_abcdefghijklmnopqrstuvwxyz0123456789",
    ];
    const isolated = new WorkspaceConnectionService({
      repository,
      config: () => config,
      client: () => github,
      now: () => now,
      randomState: () => states.shift()!,
    });
    const oldUrl = await isolated.beginAuthorization("user-a", "web-session-a");
    const newUrl = await isolated.beginAuthorization("user-a", "web-session-a");

    await expect(
      isolated.completeAuthorization({
        userId: "user-a",
        sessionToken: "web-session-a",
        state: new URL(oldUrl).searchParams.get("state")!,
        code: "github-code-old",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    await expect(
      isolated.completeAuthorization({
        userId: "user-a",
        sessionToken: "web-session-a",
        state: new URL(newUrl).searchParams.get("state")!,
        code: "github-code-new",
      }),
    ).resolves.toMatchObject({ state: "connected" });
  });

  test("an expired or cross-tenant browser state cannot create or consume a connection", async () => {
    const authorizationUrl = await service.beginAuthorization("user-a", "web-session-a");
    const state = new URL(authorizationUrl).searchParams.get("state")!;

    await expect(
      service.completeAuthorization({
        userId: "user-b",
        sessionToken: "web-session-b",
        state,
        code: "github-code-attacker",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(repository.getConnection("user-b", "github-codespaces")).toBeNull();

    now += 10 * 60 * 1000 + 1;
    await expect(
      service.completeAuthorization({
        userId: "user-a",
        sessionToken: "web-session-a",
        state,
        code: "github-code-expired",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(repository.getConnection("user-a", "github-codespaces")).toBeNull();
  });

  test("reauthorization after permission expansion revokes the superseded token", async () => {
    await connect();
    sqlite
      .prepare("UPDATE workspaceConnection SET status = 'installation_required' WHERE userId = ?")
      .run("user-a");
    github.exchangeCode = async () => ({
      accessToken: "ghu_successor-secret",
      refreshToken: "ghr_successor-secret",
      accessTokenExpiresAt: 2_000_000,
      refreshTokenExpiresAt: 9_000_000,
    });
    const reconnect = new WorkspaceConnectionService({
      repository,
      config: () => config,
      client: () => github,
      now: () => now,
      randomState: () => "state_reconnect_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    const authorizationUrl = await reconnect.beginAuthorization("user-a", "web-session-a");
    await reconnect.completeAuthorization({
      userId: "user-a",
      sessionToken: "web-session-a",
      state: new URL(authorizationUrl).searchParams.get("state")!,
      code: "github-code-reconnect",
    });

    expect(github.revokedTokens).toEqual(["ghu_initial-secret"]);
    expect(repository.getCredential("user-a", "github-codespaces")?.envelope.generation).toBe(2);
  });

  test("retains an encrypted exact retry when superseded-token revocation fails", async () => {
    await connect();
    sqlite
      .prepare("UPDATE workspaceConnection SET status = 'installation_required' WHERE userId = ?")
      .run("user-a");
    github.revokeTokenFails = true;
    const reconnectStates = [
      "state_reconnect_first_abcdefghijklmnopqrstuvwxyz0123456789",
      "state_reconnect_second_abcdefghijklmnopqrstuvwxyz0123456789",
    ];
    const reconnect = new WorkspaceConnectionService({
      repository,
      config: () => config,
      client: () => github,
      now: () => now,
      randomState: () => reconnectStates.shift()!,
      randomId: () => "pending-old-credential",
    });
    const authorizationUrl = await reconnect.beginAuthorization("user-a", "web-session-a");

    await expect(
      reconnect.completeAuthorization({
        userId: "user-a",
        sessionToken: "web-session-a",
        state: new URL(authorizationUrl).searchParams.get("state")!,
        code: "github-code-reconnect",
      }),
    ).rejects.toMatchObject({ code: "AUTH_REFRESH_FAILED" });

    expect(repository.getCredential("user-a", "github-codespaces")?.envelope.generation).toBe(1);
    const pending = sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all();
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toMatch(/ghu_initial-secret|ghr_initial-secret/);
    expect(reconnect.getStatus("user-a")).toMatchObject({ state: "refresh_failed" });
    expect(github.revokedTokens).toEqual(["ghu_initial-secret"]);

    github.revokeTokenFails = false;
    await expect(reconnect.beginAuthorization("user-a", "web-session-a")).resolves.toContain(
      "github.com/login/oauth/authorize",
    );
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toEqual([]);
    expect(github.revokedTokens).toEqual(["ghu_initial-secret", "ghu_initial-secret"]);
  });

  test("retains and later revokes a provisional credential after identity validation fails", async () => {
    github.getUser = async () => ({ id: "invalid", login: "witqq" });
    github.revokeTokenFails = true;
    const authorizationUrl = await service.beginAuthorization("user-a", "web-session-a");

    await expect(
      service.completeAuthorization({
        userId: "user-a",
        sessionToken: "web-session-a",
        state: new URL(authorizationUrl).searchParams.get("state")!,
        code: "github-code-invalid-identity",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(repository.getConnection("user-a", "github-codespaces")).toBeNull();
    expect(service.getStatus("user-a")).toMatchObject({
      state: "revocation_pending",
      canConnect: false,
    });
    const stored = JSON.stringify(
      sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all(),
    );
    expect(stored).not.toMatch(/ghu_initial-secret|ghr_initial-secret/);
    expect(github.revokedTokens).toEqual(["ghu_initial-secret"]);

    github.revokeTokenFails = false;
    await expect(service.disconnect("user-a")).resolves.toMatchObject({
      state: "connection_required",
    });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toEqual([]);
    expect(github.revokedTokens).toEqual(["ghu_initial-secret", "ghu_initial-secret"]);
  });

  test("disconnect revokes a different pending provisional credential before deleting its row", async () => {
    await connect();
    sqlite
      .prepare("UPDATE workspaceConnection SET status = 'installation_required' WHERE userId = ?")
      .run("user-a");
    github.exchangeCode = async () => ({
      accessToken: "ghu_provisional-secret",
      refreshToken: "ghr_provisional-secret",
      accessTokenExpiresAt: 2_000_000,
      refreshTokenExpiresAt: 9_000_000,
    });
    github.getUser = async () => ({ id: "invalid", login: "witqq" });
    github.revokeTokenFailureTokens.add("ghu_provisional-secret");
    const reauthorizing = new WorkspaceConnectionService({
      repository,
      config: () => config,
      client: () => github,
      now: () => now,
      randomState: () => "state_combined_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    const authorizationUrl = await reauthorizing.beginAuthorization("user-a", "web-session-a");

    await expect(
      reauthorizing.completeAuthorization({
        userId: "user-a",
        sessionToken: "web-session-a",
        state: new URL(authorizationUrl).searchParams.get("state")!,
        code: "github-code-provisional",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(github.revokedTokens).toEqual(["ghu_initial-secret", "ghu_provisional-secret"]);
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toHaveLength(1);

    await expect(reauthorizing.disconnect("user-a")).resolves.toMatchObject({
      state: "revocation_pending",
    });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toHaveLength(1);

    github.revokeTokenFailureTokens.delete("ghu_provisional-secret");
    await expect(reauthorizing.disconnect("user-a")).resolves.toMatchObject({
      state: "disconnected",
    });
    expect(github.revokedTokens).toEqual([
      "ghu_initial-secret",
      "ghu_provisional-secret",
      "ghu_provisional-secret",
      "ghu_provisional-secret",
    ]);
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toEqual([]);
  });

  test("rotates one-use tokens once for concurrent callers and commits one successor generation", async () => {
    await connect();
    const tokens = await Promise.all(
      Array.from({ length: 12 }, () => service.getAccessToken("user-a")),
    );

    expect(new Set(tokens)).toEqual(new Set(["ghu_refreshed-secret"]));
    expect(github.refreshCalls).toBe(1);
    const vault = sqlite.prepare("SELECT * FROM workspaceCredentialVault").get() as Record<
      string,
      unknown
    >;
    expect(vault.generation).toBe(2);
    expect(JSON.stringify(vault)).not.toMatch(/ghu_refreshed-secret|ghr_refreshed-secret/);
  });

  test("persists recovery authority before provider refresh and clears it after publication", async () => {
    await connect();
    let stateAtProviderEntry:
      { lastErrorCode: string | null; submissionInFlight: boolean } | undefined;
    github.onRefreshStart = () => {
      stateAtProviderEntry = {
        lastErrorCode: repository.getConnection("user-a", "github-codespaces")!.lastErrorCode,
        submissionInFlight: repository.isRefreshSubmissionInFlight(
          "user-a",
          "github-codespaces",
          now,
        ),
      };
    };

    await expect(service.getAccessToken("user-a")).resolves.toBe("ghu_refreshed-secret");

    expect(stateAtProviderEntry).toEqual({
      lastErrorCode: "AUTH_GRANT_REVOCATION_REQUIRED",
      submissionInFlight: true,
    });
    expect(repository.getConnection("user-a", "github-codespaces")).toMatchObject({
      status: "connected",
      credentialGeneration: 2,
      lastErrorCode: null,
    });
  });

  test("a second service instance waits for the durable refresh claim and reads its successor", async () => {
    await connect();
    let releaseRefresh!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    github.refreshBarrier = barrier;
    const secondService = new WorkspaceConnectionService({
      repository: new WorkspaceConnectionRepository(sqlite),
      config: () => config,
      client: () => github,
      now: () => now,
      randomId: () => "second-refresh-lease",
      sleep: async () => barrier,
    });

    const first = service.getAccessToken("user-a");
    const second = secondService.getAccessToken("user-a");
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "ghu_refreshed-secret",
      "ghu_refreshed-secret",
    ]);
    expect(github.refreshCalls).toBe(1);
  });

  test("an ambiguous or expired refresh fails closed without restoring the predecessor", async () => {
    await connect();
    github.refreshFails = true;
    await expect(service.getAccessToken("user-a")).rejects.toMatchObject({
      code: "AUTH_GRANT_REVOCATION_REQUIRED",
    });
    expect(service.getStatus("user-a")).toMatchObject({
      state: "refresh_failed",
      reason: "AUTH_GRANT_REVOCATION_REQUIRED",
      canConnect: false,
      canDisconnect: false,
    });
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: "refresh_failed",
        outcome: "external_grant_revocation_required",
      }),
    );
    expect(repository.getCredential("user-a", "github-codespaces")?.envelope.generation).toBe(1);
    await expect(service.getAccessToken("user-a")).rejects.toMatchObject({
      code: "AUTH_GRANT_REVOCATION_REQUIRED",
    });

    sqlite
      .prepare(
        "UPDATE workspaceConnection SET status = 'connected', lastErrorCode = NULL WHERE userId = ?",
      )
      .run("user-a");
    github.refreshFails = false;
    now = 9_000_000;
    await expect(service.getAccessToken("user-a")).rejects.toMatchObject({
      code: "AUTH_REFRESH_FAILED",
    });
    expect(github.refreshCalls).toBe(1);
    expect(service.getStatus("user-a")).toMatchObject({ state: "refresh_failed" });
  });

  test("an unreadable envelope is disabled before it can authorize work", async () => {
    await connect();
    sqlite.prepare("UPDATE workspaceCredentialVault SET authTag = 'tampered'").run();

    await expect(service.getAccessToken("user-a")).rejects.toMatchObject({
      code: "CREDENTIAL_UNREADABLE",
    });
    expect(service.getStatus("user-a")).toMatchObject({
      state: "refresh_failed",
      reason: "CREDENTIAL_UNREADABLE",
      canConnect: false,
    });
    expect(audits).toContainEqual(
      expect.objectContaining({ action: "refresh_failed", outcome: "credential_unreadable" }),
    );
    await expect(service.beginAuthorization("user-a", "web-session-a")).rejects.toMatchObject({
      code: "CREDENTIAL_UNREADABLE",
    });
    await expect(service.disconnect("user-a")).resolves.toMatchObject({
      state: "revocation_pending",
      reason: "CREDENTIAL_UNREADABLE",
    });
    await expect(service.confirmExternalRevocation("user-a", false)).rejects.toMatchObject({
      code: "CREDENTIAL_UNREADABLE",
    });
    await expect(service.confirmExternalRevocation("user-b", true)).rejects.toMatchObject({
      code: "AUTHORIZATION_FAILED",
    });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialVault").all()).toHaveLength(1);
    await expect(service.confirmExternalRevocation("user-a", true)).resolves.toMatchObject({
      state: "disconnected",
    });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialVault").all()).toEqual([]);
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: "disconnect",
        outcome: "external_revocation_confirmed",
      }),
    );
  });

  test("a vault key-version mismatch immediately exposes only external-revocation recovery", async () => {
    await connect();
    const rotated = new WorkspaceConnectionService({
      repository,
      config: () => ({ ...config, vaultKeyVersion: "v2" }),
      client: () => github,
      now: () => now,
    });

    expect(rotated.getStatus("user-a")).toMatchObject({
      state: "refresh_failed",
      reason: "CREDENTIAL_UNREADABLE",
      canConnect: false,
    });
    await expect(rotated.beginAuthorization("user-a", "web-session-a")).rejects.toMatchObject({
      code: "CREDENTIAL_UNREADABLE",
    });
    await expect(rotated.confirmExternalRevocation("user-a", true)).resolves.toMatchObject({
      state: "disconnected",
    });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialVault").all()).toEqual([]);
  });

  test("restoring the vault key rejects external abandon and restores exact disconnect", async () => {
    await connect();
    const wrongKey = new WorkspaceConnectionService({
      repository,
      config: () => ({ ...config, vaultKeyVersion: "v2" }),
      client: () => github,
      now: () => now,
    });

    await expect(wrongKey.getAccessToken("user-a")).rejects.toMatchObject({
      code: "CREDENTIAL_UNREADABLE",
    });
    expect(repository.getConnection("user-a", "github-codespaces")?.lastErrorCode).toBe(
      "CREDENTIAL_UNREADABLE",
    );

    expect(service.getStatus("user-a")).toMatchObject({
      state: "refresh_failed",
      reason: "AUTH_REFRESH_FAILED",
      canConnect: true,
      canDisconnect: true,
    });
    await expect(service.confirmExternalRevocation("user-a", true)).rejects.toMatchObject({
      code: "AUTHORIZATION_FAILED",
    });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialVault").all()).toHaveLength(1);

    await expect(service.disconnect("user-a")).resolves.toMatchObject({ state: "disconnected" });
    expect(github.revokedGrants).toEqual(["ghu_initial-secret"]);
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialVault").all()).toEqual([]);
  });

  test("an expired refresh lease fails closed instead of replaying the predecessor token", async () => {
    await connect();
    expect(
      repository.claimRefresh({
        userId: "user-a",
        connectionId: repository.getConnection("user-a", "github-codespaces")!.id,
        expectedGeneration: 1,
        leaseId: "crashed-worker-lease",
        now,
        leaseExpiresAt: now + 100,
      }),
    ).toBe(true);
    now += 101;

    await expect(service.getAccessToken("user-a")).rejects.toMatchObject({
      code: "AUTH_REFRESH_FAILED",
    });
    expect(github.refreshCalls).toBe(0);
    expect(service.getStatus("user-a")).toMatchObject({ state: "refresh_failed" });
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: "refresh_failed",
        outcome: "refresh_worker_abandoned",
      }),
    );
  });

  test("a waiter reports full-grant recovery when a submitted refresh lease expires", async () => {
    await connect();
    const connectionId = repository.getConnection("user-a", "github-codespaces")!.id;
    expect(
      repository.claimRefresh({
        userId: "user-a",
        connectionId,
        expectedGeneration: 1,
        leaseId: "submitted-crashed-worker",
        now,
        leaseExpiresAt: now + 100,
      }),
    ).toBe(true);
    expect(
      repository.markRefreshSubmitted({
        userId: "user-a",
        connectionId,
        expectedGeneration: 1,
        leaseId: "submitted-crashed-worker",
        now,
      }),
    ).toBe(true);
    const waiter = new WorkspaceConnectionService({
      repository: new WorkspaceConnectionRepository(sqlite),
      config: () => config,
      client: () => github,
      now: () => now,
      sleep: async () => {
        now += 101;
      },
    });

    await expect(waiter.getAccessToken("user-a")).rejects.toMatchObject({
      code: "AUTH_GRANT_REVOCATION_REQUIRED",
    });
    expect(github.refreshCalls).toBe(0);
    expect(waiter.getStatus("user-a")).toMatchObject({
      state: "refresh_failed",
      reason: "AUTH_GRANT_REVOCATION_REQUIRED",
      canConnect: false,
    });
  });

  test("a refresh successor remains pending when its generation compare-and-swap loses", async () => {
    await connect();
    repository.completeRefresh = () => false;

    await expect(service.getAccessToken("user-a")).rejects.toMatchObject({
      code: "AUTH_REFRESH_FAILED",
    });
    expect(service.getStatus("user-a")).toMatchObject({ state: "refresh_failed" });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toHaveLength(1);
    expect(
      JSON.stringify(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()),
    ).not.toMatch(/ghu_refreshed-secret|ghr_refreshed-secret/);

    await expect(service.disconnect("user-a")).resolves.toMatchObject({ state: "disconnected" });
    expect(github.revokedTokens).toEqual(["ghu_refreshed-secret"]);
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toEqual([]);
  });

  test("a refresh racing disconnect retains its successor until exact revocation", async () => {
    await connect();
    let releaseRefresh!: () => void;
    let reportRefreshStarted!: () => void;
    github.refreshBarrier = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      reportRefreshStarted = resolve;
    });
    github.onRefreshStart = reportRefreshStarted;

    const refreshing = service.getAccessToken("user-a");
    await refreshStarted;
    await expect(service.disconnect("user-a")).resolves.toMatchObject({ state: "disconnected" });
    releaseRefresh();
    await expect(refreshing).rejects.toMatchObject({ code: "AUTH_REFRESH_FAILED" });
    expect(service.getStatus("user-a")).toMatchObject({ state: "revocation_pending" });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toHaveLength(1);

    await expect(service.disconnect("user-a")).resolves.toMatchObject({ state: "disconnected" });
    expect(github.revokedTokens).toEqual(["ghu_refreshed-secret"]);
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toEqual([]);
  });

  test("keeps a failed revocation unusable and completes it on a later retry", async () => {
    await connect();
    github.revokeFails = true;
    await expect(service.disconnect("user-a")).resolves.toMatchObject({
      state: "revocation_pending",
      canConnect: false,
    });
    await expect(service.getAccessToken("user-a")).rejects.toMatchObject({
      code: "AUTH_REFRESH_FAILED",
    });

    github.revokeFails = false;
    await expect(service.disconnect("user-a")).resolves.toMatchObject({ state: "disconnected" });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialVault").all()).toEqual([]);
    expect(sqlite.prepare("SELECT * FROM workspaceConnectionRepository").all()).toEqual([]);
  });

  test("retains the credential but reports installation-required when no personal installation exists", async () => {
    github.installations = [];
    await connect("installation_required");
    expect(service.getStatus("user-a")).toMatchObject({
      state: "installation_required",
      installationUrl: config.installationUrl,
    });
    await expect(service.getAccessToken("user-a")).rejects.toMatchObject({
      code: "INSTALLATION_REQUIRED",
    });
  });

  test("rejects a different user's personal installation before repository enumeration", async () => {
    github.installations = [
      {
        id: "9002",
        accountId: "99999999",
        accountLogin: "another-user",
        targetType: "User",
        repositorySelection: "selected",
      },
    ];

    await connect("installation_required");

    expect(github.repositoryListCalls).toBe(0);
    expect(service.getStatus("user-a")).toMatchObject({
      state: "installation_required",
      installations: [],
      repositories: [],
    });
  });

  test("revokes a refresh successor immediately when durable staging fails", async () => {
    await connect();
    repository.storePendingRevocation = () => {
      throw new Error("injected pending-revocation persistence failure");
    };

    await expect(service.getAccessToken("user-a")).rejects.toMatchObject({
      code: "AUTH_REFRESH_FAILED",
    });

    expect(github.revokedTokens).toEqual(["ghu_refreshed-secret"]);
    expect(service.getStatus("user-a")).toMatchObject({ state: "refresh_failed" });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toEqual([]);
    expect(repository.getCredential("user-a", "github-codespaces")?.envelope.generation).toBe(1);
  });

  test("requires external full-grant recovery when successor staging and revocation both fail", async () => {
    await connect();
    repository.storePendingRevocation = () => {
      throw new Error("injected pending-revocation persistence failure");
    };
    github.revokeTokenFails = true;
    github.revokeFails = true;

    await expect(service.getAccessToken("user-a")).rejects.toMatchObject({
      code: "AUTH_GRANT_REVOCATION_REQUIRED",
    });
    expect(github.revokedTokens).toEqual(["ghu_refreshed-secret"]);
    expect(github.revokedGrants).toEqual(["ghu_refreshed-secret"]);
    expect(service.getStatus("user-a")).toMatchObject({
      state: "refresh_failed",
      reason: "AUTH_GRANT_REVOCATION_REQUIRED",
      canConnect: false,
      canDisconnect: false,
    });
    await expect(service.beginAuthorization("user-a", "web-session-a")).rejects.toMatchObject({
      code: "AUTH_GRANT_REVOCATION_REQUIRED",
    });
    await expect(service.disconnect("user-a")).resolves.toMatchObject({
      reason: "AUTH_GRANT_REVOCATION_REQUIRED",
    });
    await expect(service.confirmExternalRevocation("user-b", true)).rejects.toMatchObject({
      code: "AUTHORIZATION_FAILED",
    });
    await expect(service.confirmExternalRevocation("user-a", true)).resolves.toMatchObject({
      state: "disconnected",
    });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialVault").all()).toEqual([]);
  });

  test("recovers a pending-only unreadable credential only after tenant confirmation", async () => {
    github.getUser = async () => ({ id: "invalid", login: "witqq" });
    github.revokeTokenFails = true;
    const authorizationUrl = await service.beginAuthorization("user-a", "web-session-a");
    await expect(
      service.completeAuthorization({
        userId: "user-a",
        sessionToken: "web-session-a",
        state: new URL(authorizationUrl).searchParams.get("state")!,
        code: "github-code-pending-only",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(repository.getConnection("user-a", "github-codespaces")).toBeNull();
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toHaveLength(1);

    const rotated = new WorkspaceConnectionService({
      repository,
      config: () => ({ ...config, vaultKeyVersion: "v2" }),
      client: () => github,
      now: () => now,
    });
    expect(rotated.getStatus("user-a")).toMatchObject({
      state: "revocation_pending",
      reason: "CREDENTIAL_UNREADABLE",
      canConnect: false,
    });
    await expect(rotated.beginAuthorization("user-a", "web-session-a")).rejects.toMatchObject({
      code: "CREDENTIAL_UNREADABLE",
    });
    await expect(rotated.confirmExternalRevocation("user-b", true)).rejects.toMatchObject({
      code: "AUTHORIZATION_FAILED",
    });
    await expect(rotated.confirmExternalRevocation("user-a", true)).resolves.toMatchObject({
      state: "connection_required",
    });
    expect(sqlite.prepare("SELECT * FROM workspaceCredentialRevocation").all()).toEqual([]);
  });

  test("rejects a classic OAuth token instead of silently accepting a non-App fallback", async () => {
    github.exchangeCode = async () => ({
      accessToken: "gho_classic-oauth-token",
      refreshToken: "ghr_refresh-secret",
      accessTokenExpiresAt: 2_000_000,
      refreshTokenExpiresAt: 9_000_000,
    });
    const authorizationUrl = await service.beginAuthorization("user-a", "web-session-a");
    await expect(
      service.completeAuthorization({
        userId: "user-a",
        sessionToken: "web-session-a",
        state: new URL(authorizationUrl).searchParams.get("state")!,
        code: "github-code-123",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect(repository.getConnection("user-a", "github-codespaces")).toBeNull();
  });

  test("finishes the website-owned cleanup gate before revoking the GitHub grant", async () => {
    await connect();
    let cleanupCalls = 0;
    const gated = new WorkspaceConnectionService({
      repository,
      config: () => config,
      client: () => github,
      now: () => now,
      beforeDisconnect: async (userId) => {
        cleanupCalls += 1;
        expect(userId).toBe("user-a");
        expect(repository.getConnection(userId, "github-codespaces")?.status).toBe("connected");
        expect(github.revokedGrants).toEqual([]);
      },
    });

    await expect(gated.disconnect("user-a")).resolves.toMatchObject({ state: "disconnected" });
    expect(cleanupCalls).toBe(1);
    expect(github.revokedGrants).toEqual(["ghu_initial-secret"]);
  });
});
