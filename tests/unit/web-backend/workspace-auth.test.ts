import { expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { WorkspaceAuthRepository } from "../../../packages/shared/src/codespaces/workspace-auth-repository.js";
import { CodespaceResourceRepository } from "../../../packages/shared/src/codespaces/resource-repository.js";
import { CodespaceResourceError } from "../../../packages/shared/src/codespaces/resource-types.js";
import { getAccountAccessDenial } from "../../../packages/shared/src/auth/account-admission.js";
import {
  CODESPACE_PROVIDER_LOCAL,
  localPublicPolicySchema,
} from "../../../packages/shared/src/codespaces/local-device-types.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";

let authorityDb: Database.Database;
const ensureRunning = jest.fn<(userId: string, resourceId: string) => Promise<void>>();
jest.unstable_mockModule("@mcp-moira/shared", () => ({
  CodespaceResourceRepository,
  CodespaceResourceError,
  CODESPACE_PROVIDER_LOCAL,
  localPublicPolicySchema,
  getAccountAccessDenial,
  WorkspaceAuthRepository,
  getSqliteInstance: () => authorityDb,
  getCodespaceResourcePolicy: () => ({ enabled: true }),
  getBaseUrl: () => "https://workspace.example.test",
}));
jest.unstable_mockModule(
  "../../../packages/web-backend/src/services/codespace-services.js",
  () => ({
    getCodespaceProviderServices: () => ({ resource: { ensureRunning } }),
    getCodespaceConnectionService: () => ({ getAccessToken: async () => "fixture-provider-token" }),
    bootstrapLocalWorkspace: async () => {
      throw new Error("Unexpected Local bootstrap");
    },
  }),
);

test("opaque workspace credentials rotate one scoped binding without persisting clear credentials", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys=ON");
    db.exec(
      "CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE codespaceResource(id TEXT PRIMARY KEY);",
    );
    db.exec(readFileSync("packages/web-backend/drizzle/0060_workspace_agent_auth.sql", "utf8"));
    const userId = randomUUID(),
      resourceId = randomUUID();
    db.prepare("INSERT INTO user VALUES(?)").run(userId);
    db.prepare("INSERT INTO codespaceResource VALUES(?)").run(resourceId);
    const repo = new WorkspaceAuthRepository(db);
    const binding = {
      userId,
      resourceId,
      resourceGeneration: 7,
      authorizationGeneration: 3,
      environmentIdentity: "a".repeat(64),
    };
    const first = repo.issue(binding, null);
    expect(repo.authenticate(first)).toMatchObject(binding);
    const stored = db.prepare("SELECT * FROM workspaceAgentCredential").get() as Record<
      string,
      unknown
    >;
    expect(stored.credentialDigest).toBe(createHash("sha256").update(first).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(first);
    const second = repo.issue(
      { ...binding, environmentIdentity: "b".repeat(64) },
      Date.now() + 60_000,
    );
    expect(second).not.toBe(first);
    expect(() => repo.authenticate(first)).toThrow();
    expect(repo.authenticate(second)).toMatchObject({
      ...binding,
      environmentIdentity: "b".repeat(64),
    });
    expect(repo.getOwned(randomUUID(), resourceId)).toBeNull();
    expect(
      (db.prepare("SELECT COUNT(*) count FROM workspaceAgentCredential").get() as { count: number })
        .count,
    ).toBe(1);
    db.prepare("UPDATE workspaceAgentCredential SET expiresAt=0").run();
    expect(() => repo.authenticate(second)).toThrow();
    repo.revoke(resourceId);
    expect(repo.getOwned(userId, resourceId)).toBeNull();
  } finally {
    db.close();
  }
});

test.each(["start generation", "authorization generation", "expired credential"] as const)(
  "production router refreshes a connected stale binding after %s before dispatch",
  async (change) => {
    authorityDb = new Database(":memory:");
    const directory = await mkdtemp(join(tmpdir(), "workspace-authority-"));
    const socketPath = join(directory, "control.sock");
    const sockets = new Set<Duplex>();
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const { getWorkspaceRouter, issueWorkspaceAgentCredential, stopWorkspaceRouter } =
      await import("../../../packages/web-backend/src/services/workspace-services.js");
    const { GitHubCodespacesConnector } =
      await import("../../../packages/web-backend/src/services/github-codespaces-connector.js");
    const userId = randomUUID(),
      resourceId = randomUUID(),
      connectionId = randomUUID();
    let probe: ReturnType<typeof jest.spyOn> | undefined;
    let install: ReturnType<typeof jest.spyOn> | undefined;
    try {
      authorityDb.pragma("foreign_keys=ON");
      migrate(drizzle(authorityDb), { migrationsFolder: resolve("packages/web-backend/drizzle") });
      authorityDb
        .prepare(
          "INSERT INTO user(id,email,handle,createdAt,updatedAt,approvedAt,emailVerified) VALUES(?,?,?,'now','now','approved',1)",
        )
        .run(userId, `${userId}@example.test`, userId);
      authorityDb
        .prepare(
          "INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt) VALUES(?,?,'github-codespaces','101','owner','connected',1,1,1)",
        )
        .run(connectionId, userId);
      authorityDb
        .prepare(
          "INSERT INTO codespaceConnectionRepository(connectionId,externalInstallationId,externalRepositoryId,fullName,private,createdAt) VALUES(?,'201','301','owner/project',1,1)",
        )
        .run(connectionId);
      authorityDb
        .prepare(
          `INSERT INTO codespaceResource(id,userId,connectionId,authorizationGeneration,provider,repositoryId,repositoryFullName,requestedRef,operationMarker,machineName,machineDisplayName,machineOperatingSystem,machineCpuCores,machineMemoryBytes,machineStorageBytes,state,retentionPolicy,desiredState,observedState,generation,providerResourceName,externalOwnerId,billableOwnerId,createDeadlineAt,remoteExpiresAt,createdAt,updatedAt)
        VALUES(?,?,?,1,'github-codespaces','301','owner/project','main','moira-aaaaaaaaaaaaaaaaaaaaaaaa','machine','machine','linux',2,1024,1024,'usable','persistent','running','running',1,'owned-workspace','101','101',1,1,1,1)`,
        )
        .run(resourceId, userId, connectionId);
      const router = getWorkspaceRouter();
      router.attach(server);
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(socketPath, done);
      });
      let dispatched!: (callId: string) => void;
      const dispatch = new Promise<string>((done) => {
        dispatched = done;
      });
      async function connectControl(remote: { credential: string; environmentIdentity: string }) {
        return new Promise<void>((done, reject) => {
          const req = httpRequest({
            socketPath,
            path: "/api/workspaces/connect",
            headers: {
              connection: "Upgrade",
              upgrade: "moira-workspace/1",
              authorization: `Bearer ${remote.credential}`,
              "x-moira-environment-identity": remote.environmentIdentity,
            },
          });
          req.once("error", reject);
          req.once("response", (response) => {
            response.resume();
            reject(new Error(`Control refused (${response.statusCode})`));
          });
          req.once("upgrade", (_response, socket, head) => {
            sockets.add(socket);
            let pending = "";
            const frames = (bytes: Buffer) => {
              pending += bytes.toString("utf8");
              for (;;) {
                const end = pending.indexOf("\n");
                if (end < 0) break;
                const frame = JSON.parse(pending.slice(0, end)) as {
                  connectionId?: string;
                  callId?: string;
                };
                pending = pending.slice(end + 1);
                if (frame.connectionId) done();
                if (frame.callId) dispatched(frame.callId);
              }
            };
            socket.on("data", frames);
            if (head.length) frames(head);
            socket.resume();
          });
          req.end();
        });
      }
      const original = issueWorkspaceAgentCredential(userId, resourceId, "a".repeat(64));
      await connectControl(original);
      if (change === "start generation")
        authorityDb
          .prepare(
            "UPDATE codespaceResource SET state='stopped',desiredState='stopped',generation=2 WHERE id=?",
          )
          .run(resourceId);
      ensureRunning.mockImplementation(async () => {
        if (change === "start generation")
          authorityDb
            .prepare(
              "UPDATE codespaceResource SET state='usable',desiredState='running',generation=3 WHERE id=?",
            )
            .run(resourceId);
        else if (change === "authorization generation") {
          authorityDb
            .prepare("UPDATE codespaceConnection SET credentialGeneration=2 WHERE id=?")
            .run(connectionId);
          authorityDb
            .prepare("UPDATE codespaceResource SET authorizationGeneration=2 WHERE id=?")
            .run(resourceId);
        } else
          authorityDb
            .prepare("UPDATE workspaceAgentCredential SET expiresAt=0 WHERE resourceId=?")
            .run(resourceId);
      });
      probe = jest.spyOn(GitHubCodespacesConnector.prototype, "probeWorkspace").mockResolvedValue({
        environmentIdentity: "a".repeat(64),
        architecture: "x64",
        rootBase64: Buffer.from("/workspaces/project").toString("base64"),
      });
      install = jest
        .spyOn(GitHubCodespacesConnector.prototype, "bootstrapWorkspace")
        .mockImplementation(async (_token, _name, input) => {
          if (!input.remote || typeof input.remote !== "object")
            throw new Error("Missing bootstrap credential");
          const remote = input.remote as Record<string, unknown>;
          if (
            typeof remote.credential !== "string" ||
            typeof remote.environmentIdentity !== "string"
          )
            throw new Error("Invalid bootstrap credential");
          await connectControl({
            credential: remote.credential,
            environmentIdentity: remote.environmentIdentity,
          });
          return {
            version: 1,
            environmentIdentity: remote.environmentIdentity,
            repositoryFullName: input.repositoryFullName,
          };
        });
      const abort = new AbortController();
      const refusal = router
        .request(userId, resourceId, { method: "GET", path: "/v1/health" }, abort.signal)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(await dispatch).toMatch(/^[a-f0-9-]{36}$/);
      abort.abort(new Error("Observer closed after current authorized dispatch"));
      expect(await refusal).toBeInstanceOf(Error);
      const current = new WorkspaceAuthRepository(authorityDb).getOwned(userId, resourceId)!;
      expect(current.credentialDigest).not.toBe(
        createHash("sha256").update(original.credential).digest("hex"),
      );
      expect(current.resourceGeneration).toBe(change === "start generation" ? 3 : 1);
      expect(current.authorizationGeneration).toBe(change === "authorization generation" ? 2 : 1);
      expect(router.isConnected(current)).toBe(true);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(install).toHaveBeenCalledTimes(1);
      authorityDb.prepare("UPDATE user SET blocked=1 WHERE id=?").run(userId);
      await expect(
        router.request(userId, resourceId, { method: "GET", path: "/v1/health" }),
      ).rejects.toMatchObject({ code: "CODESPACE_AUTHORIZATION_REQUIRED" });
      expect(install).toHaveBeenCalledTimes(1);
    } finally {
      probe?.mockRestore();
      install?.mockRestore();
      ensureRunning.mockReset();
      for (const socket of sockets) socket.destroy();
      await stopWorkspaceRouter();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      authorityDb.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
