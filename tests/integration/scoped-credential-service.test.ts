import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import {
  CODESPACE_PROVIDER_GITHUB,
  GitHubResourceRepository,
  LocalDeviceRepository,
  LocalDeviceService,
  type LocalControllerClient,
  CodespaceConnectionRepository,
  CodespaceCredentialVault,
  ScopedCredentialError,
  scopedCredentialFailureOutcome,
  type CodespaceGitHubConfigStatus,
  type CodespaceConnectionService,
  type ScopedCredentialAcquire,
  type ScopedCredentialCandidate,
} from "@mcp-moira/shared";
import {
  ScopedCredentialService,
  type ScopedCredentialAuthority,
} from "../../packages/web-backend/src/services/scoped-credential-service.js";
import { createScopedCredentialRouter } from "../../packages/web-backend/src/routes/scoped-credentials.js";
import { GitHubResourceService } from "../../packages/web-backend/src/services/github-resource-service.js";
import { HttpGitHubCodespaceClient } from "../../packages/web-backend/src/services/github-codespace-client.js";

const config: Extract<CodespaceGitHubConfigStatus, { state: "available" }> = {
  state: "available",
  clientId: "Iv23abcdefgh1234",
  clientSecret: "github-app-client-secret-value-1234567890",
  callbackUrl: "https://moira.example/api/integrations/github/callback",
  installationUrl: "https://github.com/apps/moira/installations/new",
  vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
  vaultKeyVersion: "v1",
  settingsUrl: "https://moira.example/settings",
};
const now = 1_000_000,
  expiresAt = 2_000_000;
const privateBearer = "a".repeat(43);
describe("Scoped credential issuer custody", () => {
  let sqlite: Database.Database,
    repository: CodespaceConnectionRepository,
    service: ScopedCredentialService;
  let authority: ScopedCredentialAuthority,
    parent: Awaited<ReturnType<CodespaceConnectionService["getScopedCredentialParent"]>>,
    candidate: ScopedCredentialCandidate,
    input: ScopedCredentialAcquire;
  let create: ReturnType<
      typeof jest.fn<(token: string, input: unknown) => Promise<ScopedCredentialCandidate>>
    >,
    revoke: ReturnType<typeof jest.fn<(token: string) => Promise<void>>>,
    currentAuthority: ReturnType<
      typeof jest.fn<
        (authority: ScopedCredentialAuthority, request: ScopedCredentialAcquire) => Promise<boolean>
      >
    >;
  beforeEach(() => {
    sqlite = new Database(":memory:");
    migrate(drizzle(sqlite), {
      migrationsFolder: path.resolve(process.cwd(), "packages/web-backend/drizzle"),
    });
    sqlite
      .prepare(
        "INSERT INTO user(id,email,name,handle,createdAt,updatedAt) VALUES ('owner','owner@example.test','Owner','owner','now','now')",
      )
      .run();
    repository = new CodespaceConnectionRepository(sqlite);
    input = {
      resourceId: randomUUID(),
      resourceGeneration: 1,
      action: "fetch",
      requestId: "ws1-" + randomUUID(),
    };
    authority = {
      userId: "owner",
      repositoryFullName: "example-org/private",
      private: true,
      identity: "original-owner-life",
      useUntil: 1_900_000,
    };
    parent = {
      token: "ghu_parent",
      expiresAt: expiresAt,
      grantsVersion: 1,
      connection: {
        id: "parent-connection",
        userId: "owner",
        provider: CODESPACE_PROVIDER_GITHUB,
        externalAccountId: "101",
        externalLogin: "person",
        status: "connected",
        credentialGeneration: 2,
        lastErrorCode: null,
        installations: [{ externalInstallationId: "901", repositorySelection: "selected" }],
        repositories: [
          {
            externalInstallationId: "901",
            externalRepositoryId: "201",
            fullName: authority.repositoryFullName,
            private: true,
          },
        ],
      },
    };
    candidate = {
      token: "ghu_child",
      expiresAt,
      metadata: {
        app: { client_id: config.clientId },
        user: { id: 101, login: "person" },
        installation: {
          account: { login: "example-org", id: 900 },
          repository_selection: "selected",
          permissions: { metadata: "read", contents: "read" },
        },
        scopes: [],
      },
    };
    create = jest.fn(async () => candidate);
    revoke = jest.fn(async () => {});
    currentAuthority = jest.fn(async () => true);
    service = new ScopedCredentialService({
      repository,
      config: () => config,
      connection: {
        refreshGrants: async () => ({ refreshed: true, stale: false }),
        getScopedCredentialParent: async () => parent,
      },
      client: () => ({ createScopedToken: create, revokeScopedToken: revoke }),
      authenticate: (bearer) => {
        if (bearer !== "owner-bearer" && bearer !== privateBearer) throw new Error("refused");
        return "owner";
      },
      authorize: async () => authority,
      isAuthorityCurrent: currentAuthority,
      now: () => now,
    });
  });
  afterEach(() => {
    sqlite.close();
  });
  function privateWire() {
    const app = express();
    const globalError = jest.fn(
      (_error: unknown, _req: Request, res: Response, _next: NextFunction) => res.sendStatus(500),
    );
    app.use("/credentials", createScopedCredentialRouter(service));
    app.use(globalError);
    return { app, globalError };
  }
  test.each(["throw", "cas"] as const)(
    "unknown issuance with %s during outcome persistence retains original recovery through the private wire",
    async (failure) => {
      create.mockRejectedValueOnce(new Error("lost provider response SYNTHETIC_SECRET"));
      jest.spyOn(repository, "updateScopedCredential").mockImplementationOnce(() => {
        if (failure === "throw") throw new Error("disk failure SYNTHETIC_SECRET");
        return false;
      });
      const wire = privateWire();
      const response = await request(wire.app)
        .post("/credentials/acquire")
        .set("Authorization", "Bearer " + privateBearer)
        .send(input);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED");
      // This is the exact shared owner decision: uncertainty must remain eligible for original-ID collect.
      expect(scopedCredentialFailureOutcome(response.body.error.code)).toBe("unconfirmed");
      expect(response.text).not.toContain("SYNTHETIC_SECRET");
      expect(wire.globalError).not.toHaveBeenCalled();
      expect(
        repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, {
          requestId: input.requestId,
        })?.state,
      ).toBe("issuing");
      const collected = await request(wire.app)
        .post("/credentials/requests/" + input.requestId)
        .set("Authorization", "Bearer " + privateBearer)
        .send(input);
      expect(collected.status).toBe(200);
      expect(collected.body).toEqual({ state: "unconfirmed" });
      expect(create).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
    },
  );
  test.each([
    ["dispose_pending", "throw"],
    ["dispose_pending", "cas"],
    ["disposed", "throw"],
    ["disposed", "cas"],
  ] as const)(
    "%s custody %s keeps truthful disposal uncertainty and original encrypted recovery",
    async (failedState, failure) => {
      const child = await service.acquire("owner-bearer", input);
      const update = repository.updateScopedCredential.bind(repository);
      jest.spyOn(repository, "updateScopedCredential").mockImplementation((value) => {
        if (value.state === failedState) {
          if (failure === "throw") throw new Error("disk failure SYNTHETIC_SECRET");
          return false;
        }
        return update(value);
      });
      const wire = privateWire();
      const response = await request(wire.app)
        .post("/credentials/" + child.credentialId + "/release")
        .set("Authorization", "Bearer " + privateBearer)
        .send({ resourceId: input.resourceId, resourceGeneration: input.resourceGeneration });
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("SCOPED_CREDENTIAL_DISPOSAL_PENDING");
      expect(scopedCredentialFailureOutcome(response.body.error.code)).toBe("unconfirmed");
      expect(response.text).not.toContain("SYNTHETIC_SECRET");
      expect(response.text).not.toContain("ghu_child");
      expect(wire.globalError).not.toHaveBeenCalled();
      const retained = repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, {
        credentialId: child.credentialId,
      });
      expect(retained?.state).toBe(failedState === "dispose_pending" ? "live" : "dispose_pending");
      if (!retained) throw new Error("Original child custody was lost");
      expect(
        new CodespaceCredentialVault(config.vaultKeyHex, config.vaultKeyVersion).decryptScoped(
          "owner",
          CODESPACE_PROVIDER_GITHUB,
          retained.id,
          retained.envelope,
        ).token,
      ).toBe("ghu_child");
      expect(revoke).toHaveBeenCalledTimes(failedState === "disposed" ? 1 : 0);
      await expect(service.collect("owner-bearer", input)).resolves.toMatchObject({
        state: failedState === "dispose_pending" ? "live" : "unconfirmed",
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledTimes(failedState === "disposed" ? 1 : 0);
    },
  );
  function persistCurrentParent() {
    const connectionId = repository.reserveConnection({
      userId: "owner",
      provider: CODESPACE_PROVIDER_GITHUB,
      externalAccountId: parent.connection.externalAccountId,
      externalLogin: parent.connection.externalLogin,
      now,
    });
    const envelope = new CodespaceCredentialVault(
      config.vaultKeyHex,
      config.vaultKeyVersion,
    ).encrypt(
      "owner",
      CODESPACE_PROVIDER_GITHUB,
      connectionId,
      parent.connection.credentialGeneration,
      {
        accessToken: parent.token,
        refreshToken: "ghr_parent",
        accessTokenExpiresAt: parent.expiresAt,
        refreshTokenExpiresAt: 3_000_000,
      },
    );
    repository.completeConnection({
      connectionId,
      userId: "owner",
      provider: CODESPACE_PROVIDER_GITHUB,
      externalAccountId: parent.connection.externalAccountId,
      externalLogin: parent.connection.externalLogin,
      status: "connected",
      envelope,
      installations: parent.connection.installations,
      repositories: parent.connection.repositories,
      now,
    });
    const connection = repository.getConnection("owner", CODESPACE_PROVIDER_GITHUB);
    const grants = repository.grantSnapshot(connectionId);
    if (!connection || !grants) throw new Error("Current parent fixture was not persisted");
    parent = { ...parent, connection, grantsVersion: grants.version };
  }
  async function managedGitHubResource() {
    persistCurrentParent();
    const deviceId = randomUUID(),
      deviceConnectionId = randomUUID(),
      identities = new GitHubResourceRepository(sqlite);
    sqlite.prepare("UPDATE user SET approvedAt='now',emailVerified=1 WHERE id='owner'").run();
    sqlite
      .prepare(
        "INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt) VALUES(?,'owner','local-sandboxes','local','local','connected',1,1,1)",
      )
      .run(deviceConnectionId);
    sqlite
      .prepare(
        "INSERT INTO codespaceLocalDevice(id,userId,connectionId,label,generation,status,credentialDigest,createdAt,updatedAt) VALUES(?,'owner',?,'Controller',1,'active',?,1,1)",
      )
      .run(deviceId, deviceConnectionId, "a".repeat(64));
    let physical = true;
    const stop = jest.fn(async () => {}),
      remove = jest.fn(async () => {
        physical = false;
      });
    const controller: LocalControllerClient = {
      async json() {
        return {
          version: 1,
          userId: "owner",
          deviceId,
          deviceGeneration: 1,
          ownerConnectionId: deviceConnectionId,
          connectionId: deviceConnectionId,
          observedAt: now,
          local: { state: "unconfigured" },
          github: { resources: [] },
        };
      },
    };
    const resource = identities.reserve({
      id: input.resourceId,
      userId: "owner",
      connectionId: parent.connection.id,
      authorizationGeneration: repository.getAuthorityGeneration("owner", parent.connection.id),
      repositoryId: "201",
      repositoryFullName: authority.repositoryFullName,
      requestedRef: "main",
      devcontainerPath: null,
      operationMarker: "moira-" + "a".repeat(24),
      providerResourceName: "fixture-provider",
      externalOwnerId: "101",
      billableOwnerId: "101",
      deviceId,
      deviceGeneration: 1,
      deviceConnectionId,
      generation: 1,
      retirement: "owned",
      revokedAt: null,
      createdAt: now,
    });
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (init?.method === "POST") {
        await stop();
        return new Response(null, { status: 202 });
      }
      if (init?.method === "DELETE") {
        await remove();
        return new Response(null, { status: 202 });
      }
      if (!physical) return new Response(null, { status: 404 });
      return Response.json({
        name: "fixture-provider",
        display_name: resource.operationMarker,
        owner: { id: 101 },
        billable_owner: { id: 101 },
        repository: { id: 201, full_name: authority.repositoryFullName },
        git_status: { ref: "main" },
        state: "Available",
        created_at: "2026-10-14T00:00:00Z",
      });
    };
    const lifecycle = new GitHubResourceService(
      identities,
      {
        getAccessToken: async () => parent.token,
        getStatus: () => ({
          state: "connected",
          reason: null,
          settingsUrl: config.settingsUrl,
          installationUrl: config.installationUrl,
          account: { id: "101", login: "person" },
          installations: [],
          repositories: [],
          canConnect: true,
          canDisconnect: true,
        }),
      },
      new HttpGitHubCodespaceClient(config, fetchImpl),
      new LocalDeviceService(new LocalDeviceRepository(sqlite), () => now, controller),
      controller,
      (userId, resourceId, throughGeneration) =>
        service.disposeResource(userId, resourceId, throughGeneration),
      () => ({ enabled: true, persistentRetentionMs: 30 * 24 * 60 * 60_000 }),
      () => config,
    );
    authority = {
      ...authority,
      identity: JSON.stringify({
        resourceId: input.resourceId,
        resourceGeneration: 1,
        authorizationGeneration: resource.authorizationGeneration,
        environmentIdentity: "original-guest-life",
      }),
    };
    const auth = {
      userId: "owner",
      deviceId,
      deviceGeneration: 1,
      connectionId: deviceConnectionId,
    };
    const registration = {
      requestId: "ws1-" + randomUUID(),
      resourceGeneration: 2,
      authorizationGeneration: resource.authorizationGeneration,
      providerResourceName: resource.providerResourceName,
      retirement: "owned",
    };
    return { identities, lifecycle, stop, remove, auth, registration };
  }
  test.each(["stop", "delete"] as const)(
    "GitHub %s broker disposes a live child before publishing the admitted owner generation and physical dispatch",
    async (action) => {
      const f = await managedGitHubResource(),
        child = await service.acquire("owner-bearer", input);
      revoke.mockImplementation(async () => {
        expect(f.identities.getOwned("owner", input.resourceId)?.generation).toBe(1);
        expect(f.stop).not.toHaveBeenCalled();
        expect(f.remove).not.toHaveBeenCalled();
      });
      await f.lifecycle.advanceAuthority(f.auth, input.resourceId, f.registration);
      await f.lifecycle.providerAction(f.auth, input.resourceId, {
        requestId: f.registration.requestId,
        resourceGeneration: 2,
        action,
      });
      expect(
        repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, {
          credentialId: child.credentialId,
        })?.state,
      ).toBe("disposed");
      expect(action === "stop" ? f.stop : f.remove).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
    },
  );
  test("failed child disposal retains old publication and encrypted custody; a later explicit owner generation retires it before any provider effect", async () => {
    const f = await managedGitHubResource(),
      child = await service.acquire("owner-bearer", input);
    revoke.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(
      f.lifecycle.advanceAuthority(f.auth, input.resourceId, f.registration),
    ).rejects.toMatchObject({ code: "SCOPED_CREDENTIAL_DISPOSAL_PENDING" });
    expect(f.identities.getOwned("owner", input.resourceId)?.generation).toBe(1);
    const retained = repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, {
      credentialId: child.credentialId,
    });
    expect(retained?.state).toBe("dispose_pending");
    if (!retained) throw new Error("Missing retained custody");
    expect(
      new CodespaceCredentialVault(config.vaultKeyHex, config.vaultKeyVersion).decryptScoped(
        "owner",
        CODESPACE_PROVIDER_GITHUB,
        retained.id,
        retained.envelope,
      ).token,
    ).toBe("ghu_child");
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    const later = { ...f.registration, requestId: "ws1-" + randomUUID(), resourceGeneration: 3 };
    await f.lifecycle.advanceAuthority(f.auth, input.resourceId, later);
    expect(f.identities.getOwned("owner", input.resourceId)?.generation).toBe(3);
    await f.lifecycle.providerAction(f.auth, input.resourceId, {
      requestId: later.requestId,
      resourceGeneration: 3,
      action: "stop",
    });
    expect(
      repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, {
        credentialId: child.credentialId,
      })?.state,
    ).toBe("disposed");
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
  test("replaying a GitHub generation cutoff preserves children issued under a later guest generation", async () => {
    authority = {
      ...authority,
      identity: JSON.stringify({
        resourceId: input.resourceId,
        resourceGeneration: 1,
        environmentIdentity: "old",
      }),
    };
    const old = await service.acquire("owner-bearer", input);
    const laterInput = { ...input, requestId: "ws1-" + randomUUID(), resourceGeneration: 2 };
    authority = {
      ...authority,
      identity: JSON.stringify({
        resourceId: input.resourceId,
        resourceGeneration: 2,
        environmentIdentity: "later",
      }),
    };
    candidate = { ...candidate, token: "ghu_later" };
    const later = await service.acquire("owner-bearer", laterInput);
    await service.disposeResource("owner", input.resourceId, 1);
    await service.disposeResource("owner", input.resourceId, 1);
    expect(
      repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, {
        credentialId: old.credentialId,
      })?.state,
    ).toBe("disposed");
    expect(
      repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, {
        credentialId: later.credentialId,
      })?.state,
    ).toBe("live");
    expect(revoke.mock.calls.map(([token]) => token)).toEqual(["ghu_child"]);
  });
  test("startup recovery retains a current live child with its actual persisted parent and grants", async () => {
    persistCurrentParent();
    const child = await service.acquire("owner-bearer", input);
    await expect(service.recover()).resolves.toEqual({ disposed: 0, pending: 0 });
    expect(currentAuthority).toHaveBeenCalledWith(authority, input);
    expect(
      repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, {
        credentialId: child.credentialId,
      })?.state,
    ).toBe("live");
    expect(revoke).not.toHaveBeenCalled();
    await expect(service.collect("owner-bearer", input)).resolves.toEqual({
      state: "live",
      credential: child,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
  test("temporary owner unavailability during recovery preserves a live child without revocation or reissuance", async () => {
    persistCurrentParent();
    const child = await service.acquire("owner-bearer", input);
    currentAuthority.mockRejectedValueOnce(
      new ScopedCredentialError("SCOPED_CREDENTIAL_UNAVAILABLE", 503),
    );
    await expect(service.recover()).resolves.toEqual({ disposed: 0, pending: 1 });
    expect(
      repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, {
        credentialId: child.credentialId,
      })?.state,
    ).toBe("live");
    expect(revoke).not.toHaveBeenCalled();
    // Once the same owner is observable, recovery keeps the original child rather than minting another.
    await expect(service.recover()).resolves.toEqual({ disposed: 0, pending: 0 });
    await expect(service.collect("owner-bearer", input)).resolves.toEqual({
      state: "live",
      credential: child,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
  test("returns a repository/action child and same original ID recovers it without mint replay", async () => {
    const issued = await service.acquire("owner-bearer", input);
    expect(issued).toMatchObject({
      token: "ghu_child",
      repositoryFullName: "example-org/private",
      useUntil: 1_900_000,
    });
    expect(create).toHaveBeenCalledWith("ghu_parent", {
      repositoryId: 201,
      target: "example-org",
      permissions: { contents: "read", metadata: "read" },
    });
    expect(await service.acquire("owner-bearer", input)).toEqual(issued);
    expect(create).toHaveBeenCalledTimes(1);
    expect(repository.getPendingRevocations("owner", CODESPACE_PROVIDER_GITHUB)).toEqual([]);
    expect(
      JSON.stringify(sqlite.prepare("SELECT * FROM codespaceCredentialRevocation").all()),
    ).not.toContain("ghu_child");
    await service.release("owner-bearer", issued.credentialId, {
      resourceId: input.resourceId,
      resourceGeneration: 1,
    });
    await service.release("owner-bearer", issued.credentialId, {
      resourceId: input.resourceId,
      resourceGeneration: 1,
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    await expect(service.acquire("owner-bearer", input)).rejects.toMatchObject({
      code: "SCOPED_CREDENTIAL_UNAVAILABLE",
    });
  });
  test("unknown issuance fences only its original ID and never retries Git or mint", async () => {
    create.mockRejectedValueOnce(new Error("lost provider response"));
    await expect(service.acquire("owner-bearer", input)).rejects.toMatchObject({
      code: "SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED",
    });
    await expect(service.acquire("owner-bearer", input)).rejects.toMatchObject({
      code: "SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED",
    });
    expect(create).toHaveBeenCalledTimes(1);
    await expect(service.collect("owner-bearer", input)).resolves.toEqual({ state: "unconfirmed" });
    expect(create).toHaveBeenCalledTimes(1);
    await expect(
      service.acquire("owner-bearer", { ...input, requestId: "ws1-" + randomUUID() }),
    ).resolves.toMatchObject({ token: "ghu_child" });
    expect(create).toHaveBeenCalledTimes(2);
  });
  test("pure collect on an absent original request cannot mint a credential", async () => {
    await expect(service.collect("owner-bearer", input)).resolves.toEqual({ state: "absent" });
    expect(create).not.toHaveBeenCalled();
    expect(repository.getScopedCredentials("owner", CODESPACE_PROVIDER_GITHUB)).toEqual([]);
  });
  test("a changed action under original nonce refuses before another provider request", async () => {
    await service.acquire("owner-bearer", input);
    await expect(
      service.acquire("owner-bearer", { ...input, action: "push" }),
    ).rejects.toMatchObject({ code: "SCOPED_CREDENTIAL_CONFLICT" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });
  test("a custody write failure still disposes the known provider candidate and fences its original nonce", async () => {
    jest.spyOn(repository, "updateScopedCredential").mockImplementationOnce(() => {
      throw new Error("disk failure");
    });
    await expect(service.acquire("owner-bearer", input)).rejects.toMatchObject({
      code: "SCOPED_CREDENTIAL_CUSTODY_REFUSED",
    });
    expect(revoke).toHaveBeenCalledWith("ghu_child");
    await expect(service.acquire("owner-bearer", input)).rejects.toMatchObject({
      code: "SCOPED_CREDENTIAL_UNAVAILABLE",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
  test("expired owner authority refuses before creating an external credential", async () => {
    authority = { ...authority, useUntil: now };
    await expect(service.acquire("owner-bearer", input)).rejects.toMatchObject({
      code: "SCOPED_CREDENTIAL_AUTHORITY_REFUSED",
    });
    expect(create).not.toHaveBeenCalled();
  });
  test("recovery retains a refused disposal and continues disposing independent known children", async () => {
    await service.acquire("owner-bearer", input);
    candidate = { ...candidate, token: "ghu_second" };
    await service.acquire("owner-bearer", { ...input, requestId: "ws1-" + randomUUID() });
    revoke.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(service.recover()).resolves.toEqual({ disposed: 1, pending: 1 });
    expect(revoke).toHaveBeenCalledTimes(2);
  });
  test.each([
    "wrong-app",
    "wrong-user",
    "wrong-target",
    "broader-permissions",
    "unselected",
    "bad-expiry",
  ])("known %s candidate is retained before refused disposal", async (kind) => {
    const metadata = candidate.metadata as {
      app: { client_id: string };
      user: { id: number };
      installation: {
        account: { login: string };
        permissions: Record<string, string>;
        repository_selection: string;
      };
    };
    if (kind === "wrong-app") metadata.app.client_id = "another-app";
    if (kind === "wrong-user") metadata.user.id = 999;
    if (kind === "wrong-target") metadata.installation.account.login = "another-org";
    if (kind === "broader-permissions") metadata.installation.permissions.administration = "write";
    if (kind === "unselected") metadata.installation.repository_selection = "all";
    if (kind === "bad-expiry") candidate.expiresAt = null;
    revoke.mockImplementationOnce(async (token) => {
      const row = repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, {
        requestId: input.requestId,
      })!;
      expect(row.state).toBe("dispose_pending");
      expect(
        new CodespaceCredentialVault(config.vaultKeyHex, config.vaultKeyVersion).decryptScoped(
          "owner",
          CODESPACE_PROVIDER_GITHUB,
          row.id,
          row.envelope,
        ).token,
      ).toBe(token);
      throw new Error("disposal response lost");
    });
    await expect(service.acquire("owner-bearer", input)).rejects.toMatchObject({
      code: "SCOPED_CREDENTIAL_DISPOSAL_PENDING",
    });
    expect(
      repository.getScopedCredential("owner", CODESPACE_PROVIDER_GITHUB, {
        requestId: input.requestId,
      })?.state,
    ).toBe("dispose_pending");
    await service.disposeUser("owner");
    expect(revoke).toHaveBeenCalledTimes(2);
  });
  test("same retained ID rechecks owner life and disposes after authority changes", async () => {
    await service.acquire("owner-bearer", input);
    authority = { ...authority, identity: "new-life" };
    await expect(service.acquire("owner-bearer", input)).rejects.toMatchObject({
      code: "SCOPED_CREDENTIAL_AUTHORITY_REFUSED",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("ghu_child");
  });
  test("replaying an old resource or settings retirement preserves children issued under later owner authority", async () => {
    const deviceId = randomUUID();
    authority = {
      ...authority,
      identity: JSON.stringify({ deviceId, ownerResourceGeneration: 1, ownerAppliedRevision: 1 }),
    };
    await service.acquire("owner-bearer", input);
    authority = {
      ...authority,
      identity: JSON.stringify({ deviceId, ownerResourceGeneration: 2, ownerAppliedRevision: 1 }),
    };
    candidate = { ...candidate, token: "ghu_admitting" };
    await service.acquire("owner-bearer", { ...input, requestId: "ws1-" + randomUUID() });
    const later = { ...input, requestId: "ws1-" + randomUUID() };
    authority = {
      ...authority,
      identity: JSON.stringify({ deviceId, ownerResourceGeneration: 3, ownerAppliedRevision: 3 }),
    };
    candidate = { ...candidate, token: "ghu_later" };
    const latest = await service.acquire("owner-bearer", later);
    await service.disposeResource("owner", input.resourceId, 2);
    await service.disposeResource("owner", input.resourceId, 2);
    await service.disposeDevice("owner", deviceId, 1);
    expect(revoke.mock.calls.map(([token]) => token).sort()).toEqual([
      "ghu_admitting",
      "ghu_child",
    ]);
    await expect(service.collect("owner-bearer", later)).resolves.toEqual({
      state: "live",
      credential: latest,
    });
    // Parent retirement always closes every known child, independent of old owner cutoffs.
    await service.disposeUser("owner");
    expect(revoke.mock.calls.map(([token]) => token).sort()).toEqual([
      "ghu_admitting",
      "ghu_child",
      "ghu_later",
    ]);
    expect(create).toHaveBeenCalledTimes(3);
  });
  test("parent witness is taken after refresh, and a mid-issuance parent replacement disposes candidate", async () => {
    parent = {
      ...parent,
      token: "ghu_refreshed",
      connection: { ...parent.connection, credentialGeneration: 3 },
    };
    create.mockImplementationOnce(async () => {
      parent = { ...parent, connection: { ...parent.connection, credentialGeneration: 4 } };
      return candidate;
    });
    await expect(service.acquire("owner-bearer", input)).rejects.toMatchObject({
      code: "SCOPED_CREDENTIAL_SCOPE_REFUSED",
    });
    expect(create.mock.calls[0]?.[0]).toBe("ghu_refreshed");
    expect(revoke).toHaveBeenCalledWith("ghu_child");
  });
});
