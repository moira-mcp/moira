import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../packages/shared/src/database/schema.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  AccountCredentialRetirementRequiredError,
  AccountResourceRetirementRequiredError,
  deleteUserAccount,
  CodespaceConnectionRepository,
  CodespaceConnectionService,
  CodespaceCredentialVault,
  GitHubResourceRepository,
  LocalResourceRepository,
  CODESPACE_PROVIDER_GITHUB,
  type ScopedCredentialState,
  type CodespaceGitHubConfigStatus,
} from "@mcp-moira/shared";
let sqlite: Database.Database,
  db: BetterSQLite3Database<typeof schema>,
  repository: CodespaceConnectionRepository;
const vault = new CodespaceCredentialVault(
  "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
  "v1",
);
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve("packages/web-backend/drizzle") });
  sqlite
    .prepare(
      "INSERT INTO user(id,email,name,handle,blocked,createdAt,updatedAt) VALUES ('owner','owner@example.test','Owner','owner',1,'now','now')",
    )
    .run();
  repository = new CodespaceConnectionRepository(sqlite);
});
afterEach(() => {
  sqlite.close();
});
function child(state: ScopedCredentialState) {
  const id = randomUUID(),
    envelope = vault.encryptScoped("owner", CODESPACE_PROVIDER_GITHUB, id, 1, {
      token: state === "live" || state === "dispose_pending" ? "ghu_child" : null,
      expiresAt: 2_000_000,
    });
  repository.reserveScopedCredential({
    id,
    userId: "owner",
    provider: CODESPACE_PROVIDER_GITHUB,
    requestId: "ws1-" + randomUUID(),
    scopeMetadata: "{}",
    envelope,
    now: 1,
  });
  if (state !== "issuing")
    repository.updateScopedCredential({
      id,
      userId: "owner",
      provider: CODESPACE_PROVIDER_GITHUB,
      expectedState: "issuing",
      state,
      envelope,
      now: 2,
    });
  return id;
}
function parentService(reserved = false) {
  if (!reserved) reserveParentConnection();
  const config: Extract<CodespaceGitHubConfigStatus, { state: "available" }> = {
    state: "available",
    clientId: "Iv23abcdefgh1234",
    clientSecret: "fixture-app-secret",
    callbackUrl: "https://moira.example/callback",
    installationUrl: "https://github.com/apps/moira/installations/new",
    vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
    vaultKeyVersion: "v1",
    settingsUrl: "https://moira.example/settings",
  };
  const revoked: string[] = [];
  let retiredChildren = 0,
    physicalCleanup = 0;
  const unused = async () => {
    throw new Error("Unexpected provider operation");
  };
  const service = new CodespaceConnectionService({
    repository,
    config: () => config,
    now: () => 1_000_000,
    beforeDisconnect: async () => {
      physicalCleanup++;
      throw new Error("Blocked account cannot start business cleanup");
    },
    beforeCredentialRetirement: async () => {
      retiredChildren++;
    },
    client: () => ({
      exchangeCode: unused,
      refreshToken: unused,
      getUser: unused,
      listInstallations: unused,
      listInstallationRepositories: unused,
      revokeToken: unused,
      revokeGrant: async (token) => {
        revoked.push(token);
      },
    }),
  });
  const envelope = vault.encrypt("owner", CODESPACE_PROVIDER_GITHUB, "parent", 1, {
    accessToken: "ghu_parent",
    refreshToken: "ghr_parent",
    accessTokenExpiresAt: 2_000_000,
    refreshTokenExpiresAt: 3_000_000,
  });
  repository.completeConnection({
    connectionId: "parent",
    userId: "owner",
    provider: CODESPACE_PROVIDER_GITHUB,
    externalAccountId: "101",
    externalLogin: "person",
    status: "connected",
    envelope,
    installations: [],
    repositories: [],
    now: 1,
  });
  return {
    service,
    revoked,
    retiredChildren: () => retiredChildren,
    physicalCleanup: () => physicalCleanup,
  };
}
function reserveParentConnection() {
  // completeConnection commits the credential into an already reserved owned connection.
  sqlite
    .prepare(
      "INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt) VALUES ('parent','owner','github-codespaces','101','person','connecting',1,1,1)",
    )
    .run();
}
function resource(id: string, userId: string, connectionId: string, state: string) {
  sqlite
    .prepare(
      `INSERT INTO codespaceResource
    (id,userId,connectionId,provider,repositoryId,repositoryFullName,requestedRef,operationMarker,
    providerResourceName,machineName,machineDisplayName,machineOperatingSystem,machineCpuCores,
    machineMemoryBytes,machineStorageBytes,state,createDeadlineAt,remoteExpiresAt,createdAt,updatedAt)
    VALUES (?,?,?,'github-codespaces','101','person/private','main',?,?,'basic','Basic','linux',2,
    4096,8192,?,1,2,1,1)`,
    )
    .run(id, userId, connectionId, id + "-marker", id + "-provider", state);
}
function operation(resourceId: string, state: string, cleanupPending: number) {
  sqlite
    .prepare(
      `INSERT INTO codespaceOperation
    (id,userId,resourceId,resourceGeneration,authorizationGeneration,provider,providerResourceName,
    remoteMarker,kind,state,inputBytes,stdoutLimitBytes,stderrLimitBytes,remoteCleanupPending,
    deadlineAt,createdAt,updatedAt)
    VALUES ('operation','owner',?,1,1,'github-codespaces','history-provider','op-marker','exec',?,
    0,1024,1024,?,2,1,1)`,
    )
    .run(resourceId, state, cleanupPending);
}
function historicalFixture(seed: () => void) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moira-account-upgrade-")),
    migrations = path.resolve("packages/web-backend/drizzle");
  sqlite.close();
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  db = drizzle(sqlite, { schema });
  try {
    fs.cpSync(migrations, temp, { recursive: true });
    const journalPath = path.join(temp, "meta/_journal.json"),
      journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      },
      index = journal.entries.findIndex((row) => row.tag === "0063_github_controller_authority");
    expect(index).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, index);
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    migrate(db, { migrationsFolder: temp });
    sqlite
      .prepare(
        "INSERT INTO user(id,email,name,handle,blocked,createdAt,updatedAt) VALUES ('owner','owner@example.test','Owner','owner',1,'now','now')",
      )
      .run();
    reserveParentConnection();
    seed();
    const originalOperation = sqlite
      .prepare("SELECT * FROM codespaceOperation WHERE id='operation'")
      .get();
    migrate(db, { migrationsFolder: migrations });
    repository = new CodespaceConnectionRepository(sqlite);
    expect(
      sqlite.prepare("SELECT * FROM archiveCodespaceOperation WHERE id='operation'").get(),
    ).toEqual(originalOperation);
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('codespaceOperation','codespaceProviderMutation','codespaceLifecycleCapability')",
        )
        .all(),
    ).toEqual([]);
    return { ...parentService(true), originalOperation };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
function repositoryRequest(state: string) {
  sqlite
    .prepare(
      "INSERT INTO codespaceLocalDevice(id,userId,connectionId,label,generation,status,credentialDigest,createdAt,updatedAt) VALUES ('device','owner','parent','Device',1,'revoked','device-hash',1,1)",
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO codespaceRepositoryRequest
    (requestId,userId,deviceId,deviceGeneration,localConnectionId,githubConnectionId,githubUserId,
    owner,credentialGeneration,repositoryName,installationId,fingerprint,delegation,marker,
    admissionRequestId,state,createdAt,updatedAt)
    VALUES ('repo-request','owner','device',1,'parent','parent','101','person',1,'private','1',
    'fingerprint','{}','repository-marker','admission',?,1,1)`,
    )
    .run(state);
}
describe("account deletion preserves unresolved credential custody", () => {
  test("deleted resource history and retired connection metadata close atomically without touching another owner's live resource", async () => {
    const f = historicalFixture(() => {
      resource("history", "owner", "parent", "deleted");
      operation("history", "completed", 0);
      sqlite
        .prepare(
          "INSERT INTO codespaceProviderMutation(id,resourceId,userId,provider,generation,kind,attempt,createdAt) VALUES ('mutation','history','owner','github-codespaces',1,'delete',1,1)",
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO codespaceLifecycleCapability(resourceId,userId,capabilityHash,createdAt) VALUES ('history','owner','cap-hash',1)",
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO workspaceAgentCredential(resourceId,userId,credentialDigest,resourceGeneration,authorizationGeneration,environmentIdentity,createdAt) VALUES ('history','owner','agent-hash',1,1,'env',1)",
        )
        .run();
      repositoryRequest("rejected");
      sqlite
        .prepare(
          "INSERT INTO codespaceLocalResourceBinding(resourceId,userId,deviceId,deviceGeneration,repositoryId,profileId,revokedAt) VALUES ('history','owner','device',1,'101','local-approved',1)",
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO codespaceLocalPairing(id,userId,tokenDigest,deviceId,expiresAt,createdAt) VALUES ('pair','owner','pair-hash','device',2,1)",
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO user(id,email,name,handle,createdAt,updatedAt) VALUES ('other','other@example.test','Other','other','now','now')",
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,createdAt,updatedAt) VALUES ('other-parent','other','github-codespaces','202','other','connected',1,1)",
        )
        .run();
      resource("other-live", "other", "other-parent", "stopped");
    });
    await f.service.disconnect("owner", { securityOnly: true });
    deleteUserAccount(db, "owner");
    expect(sqlite.prepare("SELECT 1 FROM user WHERE id='owner'").get()).toBeUndefined();
    for (const table of [
      "workspaceAgentCredential",
      "codespaceLocalResourceBinding",
      "codespaceLocalPairing",
      "codespaceLocalDevice",
      "codespaceRepositoryRequest",
    ])
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT userId,retirement FROM githubResourceIdentity").all()).toEqual([
      { userId: "other", retirement: "owned" },
    ]);
    expect(
      sqlite.prepare("SELECT * FROM archiveCodespaceOperation WHERE id='operation'").get(),
    ).toEqual(f.originalOperation);
    expect(sqlite.prepare("SELECT id FROM codespaceConnection").all()).toEqual([
      { id: "other-parent" },
    ]);
  });
  test("unknown historical command bytes remain archived after deleted resource metadata closes without replay", async () => {
    const f = historicalFixture(() => {
      resource("history", "owner", "parent", "deleted");
      operation("history", "unknown", 1);
    });
    await f.service.disconnect("owner", { securityOnly: true });
    deleteUserAccount(db, "owner");
    expect(
      sqlite.prepare("SELECT * FROM archiveCodespaceOperation WHERE id='operation'").get(),
    ).toEqual(f.originalOperation);
    expect(() =>
      sqlite
        .prepare("UPDATE archiveCodespaceOperation SET state='completed' WHERE id='operation'")
        .run(),
    ).toThrow("Read-only historical archive");
    expect(f.physicalCleanup()).toBe(0);
    expect(
      sqlite.prepare("SELECT 1 FROM githubResourceIdentity WHERE id='history'").get(),
    ).toBeUndefined();
    expect(
      sqlite.prepare("SELECT 1 FROM codespaceConnection WHERE id='parent'").get(),
    ).toBeUndefined();
    expect(sqlite.prepare("SELECT 1 FROM user WHERE id='owner'").get()).toBeUndefined();
  });
  test("unknown external repository creation keeps the whole account metadata transaction unchanged", async () => {
    const f = historicalFixture(() => {
      resource("history", "owner", "parent", "deleted");
      operation("history", "unknown", 1);
      repositoryRequest("unknown");
    });
    await f.service.disconnect("owner", { securityOnly: true });
    expect(() => deleteUserAccount(db, "owner")).toThrow(AccountResourceRetirementRequiredError);
    expect(
      sqlite
        .prepare("SELECT state FROM codespaceRepositoryRequest WHERE requestId='repo-request'")
        .get(),
    ).toEqual({ state: "unknown" });
    expect(
      sqlite.prepare("SELECT retirement FROM githubResourceIdentity WHERE id='history'").get(),
    ).toEqual({
      retirement: "retired",
    });
    expect(
      sqlite.prepare("SELECT * FROM archiveCodespaceOperation WHERE id='operation'").get(),
    ).toEqual(f.originalOperation);
    expect(f.physicalCleanup()).toBe(0);
    expect(sqlite.prepare("SELECT blocked FROM user WHERE id='owner'").get()).toEqual({
      blocked: 1,
    });
  });
  test("a stopped persistent resource preserves parent keys and routing until explicit resource deletion", async () => {
    const f = parentService();
    new GitHubResourceRepository(sqlite).reserve({
      id: "persistent",
      userId: "owner",
      connectionId: "parent",
      authorizationGeneration: 1,
      repositoryId: "101",
      repositoryFullName: "person/private",
      requestedRef: "main",
      devcontainerPath: null,
      operationMarker: "persistent-marker",
      providerResourceName: "persistent-provider",
      externalOwnerId: "101",
      billableOwnerId: "101",
      deviceId: null,
      deviceGeneration: null,
      deviceConnectionId: null,
      generation: 1,
      retirement: "owned",
      revokedAt: null,
      createdAt: 1,
    });
    await expect(f.service.disconnect("owner", { securityOnly: true })).rejects.toThrow(
      AccountResourceRetirementRequiredError,
    );
    expect(f.revoked).toEqual([]);
    expect(f.physicalCleanup()).toBe(0);
    expect(repository.getCredential("owner", CODESPACE_PROVIDER_GITHUB)).not.toBeNull();
    expect(() => deleteUserAccount(db, "owner")).toThrow(AccountResourceRetirementRequiredError);
    expect(
      sqlite
        .prepare("SELECT providerResourceName FROM githubResourceIdentity WHERE id='persistent'")
        .get(),
    ).toEqual({ providerResourceName: "persistent-provider" });
    sqlite
      .prepare("UPDATE githubResourceIdentity SET retirement='retired' WHERE id='persistent'")
      .run();
    await f.service.disconnect("owner", { securityOnly: true });
    expect(f.revoked).toEqual(["ghu_parent"]);
    expect(repository.getCredential("owner", CODESPACE_PROVIDER_GITHUB)).toBeNull();
  });
  test("revoking a Local binding cannot erase unresolved disk custody during account deletion", async () => {
    const f = parentService(),
      local = new LocalResourceRepository(sqlite);
    sqlite
      .prepare(
        "INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt) VALUES('local','owner','local-sandboxes','owner','Local','disconnected',1,1,1)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO codespaceLocalDevice(id,userId,connectionId,label,generation,status,credentialDigest,createdAt,updatedAt) VALUES('local-device','owner','local','Revoked device',2,'revoked','old-device-digest',1,2)",
      )
      .run();
    local.reserve({
      id: "local-disk",
      userId: "owner",
      connectionId: "local",
      authorizationGeneration: 1,
      repositoryId: "local-target",
      repositoryFullName: "person/private",
      requestedRef: "main",
      operationMarker: "local-original-marker",
      routeGeneration: 1,
      createdAt: 1,
      retiredAt: null,
      retiredGeneration: null,
      retiredRequestId: null,
    });
    sqlite
      .prepare(
        "INSERT INTO codespaceLocalResourceBinding(resourceId,userId,deviceId,deviceGeneration,repositoryId,profileId,revokedAt) VALUES('local-disk','owner','local-device',1,'local-repository','local-approved',2)",
      )
      .run();
    expect(() => deleteUserAccount(db, "owner")).toThrow(AccountResourceRetirementRequiredError);
    await expect(f.service.disconnect("owner", { securityOnly: true })).rejects.toThrow(
      AccountResourceRetirementRequiredError,
    );
    expect(f.revoked).toEqual([]);
    expect(local.getOwned("owner", "local-disk")).toMatchObject({
      retiredAt: null,
      operationMarker: "local-original-marker",
    });
    local.retire("owner", "local-disk", {
      requestId: "ws1-" + randomUUID(),
      resourceGeneration: 5,
      retiredAt: 3,
    });
    await f.service.disconnect("owner", { securityOnly: true });
    deleteUserAccount(db, "owner");
    expect(sqlite.prepare("SELECT 1 FROM user WHERE id='owner'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT * FROM localResourceIdentity").all()).toEqual([]);
  });
  test("security-only retirement closes the parent after an account fence without business cleanup or unblocking", async () => {
    const f = parentService();
    await f.service.disconnect("owner", { securityOnly: true });
    expect(f.physicalCleanup()).toBe(0);
    expect(f.retiredChildren()).toBe(1);
    expect(f.revoked).toEqual(["ghu_parent"]);
    expect(sqlite.prepare("SELECT blocked FROM user WHERE id='owner'").get()).toEqual({
      blocked: 1,
    });
    deleteUserAccount(db, "owner");
    expect(sqlite.prepare("SELECT 1 FROM user WHERE id='owner'").get()).toBeUndefined();
  });
  test("security-only retirement cannot erase an uncertain submitted parent refresh", async () => {
    const f = parentService();
    sqlite
      .prepare(
        "UPDATE codespaceConnection SET lastErrorCode='AUTH_GRANT_REVOCATION_REQUIRED',refreshLeaseId='inflight',refreshLeaseExpiresAt=2000000 WHERE id='parent'",
      )
      .run();
    await f.service.disconnect("owner", { securityOnly: true });
    expect(f.revoked).toEqual([]);
    expect(repository.getCredential("owner", CODESPACE_PROVIDER_GITHUB)).not.toBeNull();
    expect(() => deleteUserAccount(db, "owner")).toThrow(AccountCredentialRetirementRequiredError);
  });
  test.each(["issuing", "unconfirmed", "live", "dispose_pending"] as const)(
    "%s child forbids the foreign-key cascade and preserves the fenced account",
    (state) => {
      const id = child(state);
      expect(() => deleteUserAccount(db, "owner")).toThrow(
        AccountCredentialRetirementRequiredError,
      );
      expect(sqlite.prepare("SELECT blocked FROM user WHERE id='owner'").get()).toEqual({
        blocked: 1,
      });
      expect(
        repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, { credentialId: id })
          ?.state,
      ).toBe(state);
    },
  );
  test("parent vault or pending parent revocation forbids account deletion", () => {
    reserveParentConnection();
    const envelope = vault.encrypt("owner", CODESPACE_PROVIDER_GITHUB, "parent", 1, {
      accessToken: "ghu_parent",
      refreshToken: "ghr_parent",
      accessTokenExpiresAt: 2_000_000,
      refreshTokenExpiresAt: 3_000_000,
    });
    repository.completeConnection({
      connectionId: "parent",
      userId: "owner",
      provider: CODESPACE_PROVIDER_GITHUB,
      externalAccountId: "101",
      externalLogin: "person",
      status: "connected",
      envelope,
      installations: [],
      repositories: [],
      now: 1,
    });
    expect(() => deleteUserAccount(db, "owner")).toThrow(AccountCredentialRetirementRequiredError);
    repository.beginDisconnect("owner", CODESPACE_PROVIDER_GITHUB, 2);
    repository.completeDisconnect("owner", "parent", 3);
    repository.storePendingRevocation({
      id: randomUUID(),
      userId: "owner",
      provider: CODESPACE_PROVIDER_GITHUB,
      envelope,
      now: 4,
    });
    expect(() => deleteUserAccount(db, "owner")).toThrow(AccountCredentialRetirementRequiredError);
  });
  test("parent external-revocation recovery cannot silently discard unresolved scoped children", () => {
    const id = child("unconfirmed");
    repository.abandonAfterExternalRevocation({
      userId: "owner",
      provider: CODESPACE_PROVIDER_GITHUB,
      now: 3,
    });
    expect(
      repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, { credentialId: id })
        ?.state,
    ).toBe("unconfirmed");
    expect(() => deleteUserAccount(db, "owner")).toThrow(AccountCredentialRetirementRequiredError);
  });
  test("an uncertain parent witness without a vault cannot be erased by account deletion", () => {
    sqlite
      .prepare(
        "INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,lastErrorCode,createdAt,updatedAt) VALUES ('unknown-parent','owner','github-codespaces','101','person','refresh_failed',1,'AUTH_GRANT_REVOCATION_REQUIRED',1,1)",
      )
      .run();
    expect(() => deleteUserAccount(db, "owner")).toThrow(AccountCredentialRetirementRequiredError);
    expect(
      sqlite
        .prepare("SELECT lastErrorCode FROM codespaceConnection WHERE id='unknown-parent'")
        .get(),
    ).toEqual({ lastErrorCode: "AUTH_GRANT_REVOCATION_REQUIRED" });
  });
  test("confirmed disposed/refused child tombstones permit the ordinary complete deletion", () => {
    child("disposed");
    child("refused");
    deleteUserAccount(db, "owner");
    expect(sqlite.prepare("SELECT 1 FROM user WHERE id='owner'").get()).toBeUndefined();
    expect(repository.getScopedCredentials("owner", CODESPACE_PROVIDER_GITHUB)).toEqual([]);
  });
});
