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
  LocalDeviceError,
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
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

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
  LocalDeviceError,
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
    expect(() => repo.authenticate(first)).toThrow(CodespaceResourceError);
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
    expect(() => repo.authenticate(second)).toThrow(CodespaceResourceError);
    repo.revoke(resourceId);
    expect(repo.getOwned(userId, resourceId)).toBeNull();
  } finally {
    db.close();
  }
});

test("workspace credential store failure is not a confirmed credential refusal", () => {
  const db = new Database(":memory:");
  const repo = new WorkspaceAuthRepository(db);
  db.close();
  let failure: unknown;
  try {
    repo.authenticate("a".repeat(43));
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ message: "The database connection is not open" });
  expect(failure).not.toBeInstanceOf(CodespaceResourceError);
});

test.each([
  "current enrollment",
  "temporary credential store failure",
  "resource generation",
  "authorization generation",
  "expired credential",
  "missing enrollment",
  "revoked resource",
  "disabled provider",
  "owner disconnect after publication authorization",
  "publication from another process",
  "controller authorization from another process",
  "offline actor from another process",
] as const)(
  "production routing requires current enrollment while actor authentication survives disconnection (%s)",
  async (change) => {
    providerEnabled = true;
    const directory = await mkdtemp(join(tmpdir(), "workspace-authority-"));
    authorityDb = new Database(
      change.endsWith("from another process") ? join(directory, "test-authority.db") : ":memory:",
    );
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
        .run(
          deviceId,
          userId,
          deviceConnectionId,
          createHash("sha256").update("c".repeat(43)).digest("hex"),
        );
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
      const { WORKSPACE_ROUTER_SOCKET } =
        await import("../../../packages/web-backend/src/services/workspace-client.js");
      await router.listenPrivate(WORKSPACE_ROUTER_SOCKET);
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
      async function connectControl(remote: {
        credential: string;
        environmentIdentity: string;
        kind?: "workspace" | "controller";
      }) {
        return new Promise<void>((done, reject) => {
          const req = httpRequest({
            socketPath,
            path: "/api/workspaces/connect",
            headers: {
              connection: "Upgrade",
              upgrade: WORKSPACE_UPGRADE,
              authorization: `Bearer ${remote.credential}`,
              "x-moira-endpoint-kind": remote.kind ?? "workspace",
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
      if (change === "temporary credential store failure") {
        const unavailable = jest
          .spyOn(WorkspaceAuthRepository.prototype, "authenticate")
          .mockImplementationOnce(() => {
            throw new Error("Injected unavailable workspace credential store");
          });
        try {
          await expect(connectControl(original)).rejects.toThrow("Control refused (503)");
        } finally {
          unavailable.mockRestore();
        }
        await connectControl(original);
        new WorkspaceAuthRepository(authorityDb).revoke(resourceId);
        await expect(connectControl(original)).rejects.toThrow("Control refused (403)");
        // Restore exactly the original credential for the normal dispatch and
        // blocked-account assertions below; this is not a replacement enrollment.
        new WorkspaceAuthRepository(authorityDb).issue(
          {
            userId,
            resourceId,
            resourceGeneration: original.resourceGeneration,
            authorizationGeneration: original.authorizationGeneration,
            environmentIdentity: original.environmentIdentity,
          },
          null,
          original.credential,
        );
      }
      const originalDigest = createHash("sha256").update(original.credential).digest("hex");
      if (change.endsWith("from another process")) {
        const controller = change === "controller authorization from another process";
        if (controller)
          await connectControl({
            credential: "c".repeat(43),
            environmentIdentity: deviceConnectionId,
            kind: "controller",
          });
        const module = pathToFileURL(
          resolve("packages/web-backend/src/services/workspace-services.ts"),
        ).href;
        const authorityModule = pathToFileURL(
          resolve("packages/web-backend/src/services/communication-owner-authority.ts"),
        ).href;
        const scope = controller
          ? {
              kind: "controller",
              userId,
              deviceId,
              deviceGeneration: 1,
              connectionId: deviceConnectionId,
            }
          : {
              kind: "workspace",
              resourceId,
              resourceGeneration: 1,
              authorizationGeneration: 1,
              environmentIdentity: original.environmentIdentity,
            };
        if (change === "offline actor from another process") {
          if (!ownerSocket) throw new Error("Missing actual owner control");
          const closed = once(ownerSocket, "close");
          ownerSocket.destroy();
          await closed;
          expect(router.isConnected({ kind: "workspace", ...original, userId })).toBe(false);
        }
        const program = `
          const {authorizeWorkspacePublication}=await import(${JSON.stringify(module)});
          const {authorizeControllerPublication,authorizeCommunicationOwner,authenticateCommunicationOwner}=await import(${JSON.stringify(authorityModule)});
          const scope=${JSON.stringify(scope)},credential=${JSON.stringify(controller ? "c".repeat(43) : original.credential)};
          const refused=async(candidate,token=credential)=>{
            try{await authorizeCommunicationOwner(token,candidate);return false;}
            catch{return true;}
          };
          try{
            const userId=await ${controller ? `authorizeControllerPublication(${JSON.stringify(deviceId)})` : `authorizeWorkspacePublication(${JSON.stringify(resourceId)})`};
            const actor=await authorizeCommunicationOwner(credential,scope);
            await authenticateCommunicationOwner(credential);
            const changedIdentityRefused=await refused({...scope,...(scope.kind==='workspace'?{environmentIdentity:'b'.repeat(64)}:{connectionId:${JSON.stringify(randomUUID())}})});
            const changedGenerationRefused=await refused({...scope,...(scope.kind==='workspace'?{resourceGeneration:2}:{deviceGeneration:2})});
            const changedAuthorizationRefused=await refused({...scope,...(scope.kind==='workspace'?{authorizationGeneration:2}:{userId:${JSON.stringify(randomUUID())}})});
            const foreignCredentialRefused=await refused(scope,'z'.repeat(43));
            process.send({userId,actor,changedIdentityRefused,changedGenerationRefused,changedAuthorizationRefused,foreignCredentialRefused});
          }catch(error){process.send({error:error.code??error.message});}
        `;
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", program],
          {
            env: {
              ...process.env,
              NODE_ENV: "test",
              DB_PATH: authorityDb.name,
              CODESPACE_CODESPACES_ENABLED: "true",
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        let diagnostic = "";
        child.stderr!.on("data", (bytes) => {
          diagnostic += String(bytes);
        });
        const outcome = new Promise<unknown>((done, reject) => {
          child.once("message", done);
          child.once("error", reject);
          child.once("exit", (code) =>
            reject(new Error(`Authority caller exited (${code}): ${diagnostic}`)),
          );
        });
        try {
          expect(await outcome).toEqual({
            userId,
            actor: userId,
            changedIdentityRefused: true,
            changedGenerationRefused: true,
            changedAuthorizationRefused: true,
            foreignCredentialRefused: true,
          });
        } finally {
          if (child.exitCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGTERM");
            await exited;
          }
        }
      }
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
      if (
        change === "current enrollment" ||
        change === "temporary credential store failure" ||
        (change.endsWith("from another process") && change !== "offline actor from another process")
      ) {
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
              const owner = await authorizeWorkspacePublication(id);
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
      expect(dispatched).toHaveBeenCalledTimes(
        change === "current enrollment" ||
          change === "temporary credential store failure" ||
          (change.endsWith("from another process") &&
            change !== "offline actor from another process")
          ? 1
          : 0,
      );
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
