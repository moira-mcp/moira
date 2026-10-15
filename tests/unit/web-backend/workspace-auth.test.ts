import { expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { WorkspaceAuthRepository } from "../../../packages/shared/src/codespaces/workspace-auth-repository.js";
import { LocalDeviceRepository } from "../../../packages/shared/src/codespaces/local-device-repository.js";
import { LocalDeviceService } from "../../../packages/shared/src/codespaces/local-device-service.js";
import { LocalResourceRepository } from "../../../packages/shared/src/codespaces/local-resource-repository.js";
import { GitHubResourceRepository } from "../../../packages/shared/src/codespaces/github-resource-repository.js";
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
import { once } from "node:events";
import express from "express";
import supertest from "supertest";
import { createWorkspacePublicationHandler } from "../../../packages/mcp-server/src/workspace-publication-route.js";
import { WORKSPACE_UPGRADE } from "../../../packages/shared/src/codespaces/workspace-transport.js";
import { CODESPACE_PROVIDER_GITHUB } from "../../../packages/shared/src/codespaces/types.js";

let authorityDb: Database.Database;
let providerEnabled = true;
jest.unstable_mockModule("@mcp-moira/shared", () => ({
  LocalResourceRepository,
  GitHubResourceRepository,
  CODESPACE_PROVIDER_GITHUB,
  CodespaceResourceError,
  CODESPACE_PROVIDER_LOCAL,
  localPublicPolicySchema,
  getAccountAccessDenial,
  WorkspaceAuthRepository,
  LocalDeviceRepository,
  LocalDeviceService,
  getSqliteInstance: () => authorityDb,
  getCodespaceResourcePolicy: () => ({ enabled: providerEnabled }),
  getBaseUrl: () => "https://workspace.example.test",
}));

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

test.each([
  "current enrollment",
  "resource generation",
  "authorization generation",
  "expired credential",
  "missing enrollment",
  "revoked resource",
  "disabled provider",
  "owner disconnect after publication authorization",
] as const)(
  "production router requires current live enrollment (%s) without lifecycle or bootstrap effects",
  async (change) => {
    authorityDb = new Database(":memory:");
    providerEnabled = true;
    const directory = await mkdtemp(join(tmpdir(), "workspace-authority-"));
    const socketPath = join(directory, "control.sock");
    const sockets = new Set<Duplex>();
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const {
      getWorkspaceRouter,
      issueWorkspaceAgentCredential,
      stopWorkspaceRouter,
      authorizeWorkspacePublication,
    } = await import("../../../packages/web-backend/src/services/workspace-services.js");
    const userId = randomUUID(),
      resourceId = randomUUID(),
      connectionId = randomUUID(),
      deviceId = randomUUID(),
      deviceConnectionId = randomUUID();
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
          "INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt) VALUES(?,?,'local-sandboxes','local','local','connected',1,1,1)",
        )
        .run(deviceConnectionId, userId);
      authorityDb
        .prepare(
          "INSERT INTO codespaceLocalDevice(id,userId,connectionId,label,generation,status,credentialDigest,createdAt,updatedAt) VALUES(?,?,?,'Controller',1,'active',?,1,1)",
        )
        .run(deviceId, userId, deviceConnectionId, "a".repeat(64));
      new GitHubResourceRepository(authorityDb).reserve({
        id: resourceId,
        userId,
        connectionId,
        authorizationGeneration: 1,
        repositoryId: "301",
        repositoryFullName: "owner/project",
        requestedRef: "main",
        devcontainerPath: null,
        operationMarker: "moira-" + "a".repeat(24),
        providerResourceName: "owned-workspace",
        externalOwnerId: "101",
        billableOwnerId: "101",
        deviceId,
        deviceGeneration: 1,
        deviceConnectionId,
        generation: 1,
        retirement: "owned",
        revokedAt: null,
        createdAt: 1,
      });
      const router = getWorkspaceRouter();
      router.attach(server);
      let ownerSocket: Duplex | undefined;
      server.on("upgrade", (_request, socket) => {
        ownerSocket = socket;
      });
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(socketPath, done);
      });
      let observeDispatch!: () => void;
      const dispatch = new Promise<void>((resolve) => {
        observeDispatch = resolve;
      });
      const dispatched = jest.fn((_callId: string) => observeDispatch());
      async function connectControl(remote: { credential: string; environmentIdentity: string }) {
        return new Promise<void>((done, reject) => {
          const req = httpRequest({
            socketPath,
            path: "/api/workspaces/connect",
            headers: {
              connection: "Upgrade",
              upgrade: WORKSPACE_UPGRADE,
              authorization: `Bearer ${remote.credential}`,
              "x-moira-endpoint-kind": "workspace",
              "x-moira-endpoint-identity": remote.environmentIdentity,
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
      const originalDigest = createHash("sha256").update(original.credential).digest("hex");
      if (change === "resource generation")
        authorityDb
          .prepare("UPDATE githubResourceIdentity SET generation=2 WHERE id=?")
          .run(resourceId);
      else if (change === "authorization generation") {
        authorityDb
          .prepare("UPDATE codespaceConnection SET authorityGeneration=2 WHERE id=?")
          .run(connectionId);
        authorityDb
          .prepare("UPDATE githubResourceIdentity SET authorizationGeneration=2 WHERE id=?")
          .run(resourceId);
      } else if (change === "expired credential")
        authorityDb
          .prepare("UPDATE workspaceAgentCredential SET expiresAt=0 WHERE resourceId=?")
          .run(resourceId);
      else if (change === "missing enrollment")
        new WorkspaceAuthRepository(authorityDb).revoke(resourceId);
      else if (change === "revoked resource")
        authorityDb
          .prepare("UPDATE githubResourceIdentity SET revokedAt=1 WHERE id=?")
          .run(resourceId);
      else if (change === "disabled provider") providerEnabled = false;
      if (change === "current enrollment") {
        const abort = new AbortController();
        const outcome = router
          .request(userId, resourceId, { method: "GET", path: "/v1/health" }, abort.signal)
          .catch((error: unknown) => error);
        await dispatch;
        abort.abort(new Error("Fixture observer closed after authorized dispatch"));
        expect(await outcome).toBeInstanceOf(Error);
      } else if (change === "owner disconnect after publication authorization") {
        const app = express();
        let disconnectedAfterAuthorization = false;
        app.get(
          "/api/codespaces/files/:resourceId/:token",
          createWorkspacePublicationHandler({
            async authorize(id) {
              const owner = authorizeWorkspacePublication(id);
              expect(owner).toBe(userId);
              if (!ownerSocket) throw new Error("Missing actual owner control");
              const closed = once(ownerSocket, "close");
              ownerSocket.destroy();
              await closed;
              expect(
                router.isConnected({
                  kind: "workspace",
                  ...new WorkspaceAuthRepository(authorityDb).getOwned(userId, resourceId)!,
                }),
              ).toBe(false);
              disconnectedAfterAuthorization = true;
              return owner;
            },
            workspace: router,
          }),
        );
        const response = await supertest(app).get(
          `/api/codespaces/files/${resourceId}/${"A".repeat(43)}`,
        );
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: "workspace_publication_unavailable" });
        expect(disconnectedAfterAuthorization).toBe(true);
      } else {
        await expect(
          router.request(userId, resourceId, { method: "GET", path: "/v1/health" }),
        ).rejects.toMatchObject({
          code:
            change === "resource generation" || change === "authorization generation"
              ? "CODESPACE_GENERATION_CONFLICT"
              : change === "revoked resource"
                ? "CODESPACE_AUTHORIZATION_REQUIRED"
                : change === "disabled provider"
                  ? "CODESPACE_PROVIDER_DISABLED"
                  : "CODESPACE_PROVIDER_UNAVAILABLE",
        });
      }
      expect(dispatched).toHaveBeenCalledTimes(change === "current enrollment" ? 1 : 0);
      const current = new WorkspaceAuthRepository(authorityDb).getOwned(userId, resourceId);
      if (change === "missing enrollment") expect(current).toBeNull();
      else expect(current?.credentialDigest).toBe(originalDigest);
      authorityDb.prepare("UPDATE user SET blocked=1 WHERE id=?").run(userId);
      await expect(
        router.request(userId, resourceId, { method: "GET", path: "/v1/health" }),
      ).rejects.toMatchObject({ code: "CODESPACE_AUTHORIZATION_REQUIRED" });
    } finally {
      for (const socket of sockets) socket.destroy();
      await stopWorkspaceRouter();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      authorityDb.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
