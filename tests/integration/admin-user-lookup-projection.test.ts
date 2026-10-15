import { expect, jest, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { getDatabase, getSqliteInstance } from "@mcp-moira/shared";
import * as schema from "../../packages/shared/src/database/schema.js";
import { auth } from "../../packages/web-backend/src/auth.js";
import { requireAuth } from "../../packages/web-backend/src/middleware/auth-middleware.js";
import { requireAdmin } from "../../packages/web-backend/src/middleware/admin-middleware.js";
import { setupErrorMiddleware } from "../../packages/web-backend/src/middleware/error-middleware.js";
import { adminRoutes } from "../../packages/web-backend/src/routes/admin.js";
import { getScopedCredentialService } from "../../packages/web-backend/src/services/scoped-credential-factory.js";
import { getCodespaceConnectionService } from "../../packages/web-backend/src/services/codespace-services.js";

test("admin user lookup stays compact, revalidates current identity and never bypasses current admin authorization", async () => {
  const app = express();
  app.use("/api/admin", requireAuth, requireAdmin, adminRoutes);
  app.use(setupErrorMiddleware());
  const db = getDatabase();
  const ids: string[] = [];
  let second: Database.Database | undefined;
  const register = async (isAdmin: boolean) => {
    const response = await auth.handler(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `lookup-${randomUUID()}@example.test`,
          name: "Lookup Reader",
          password: "ReadProtocol123!",
          acceptedTermsAt: new Date().toISOString(),
          acceptedNotRussianResidentAt: new Date().toISOString(),
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    ids.push(body.user.id);
    await db
      .update(schema.user)
      .set({ isAdmin, approvedAt: new Date().toISOString(), emailVerified: true })
      .where(eq(schema.user.id, body.user.id));
    return { id: body.user.id, cookie: response.headers.get("set-cookie")!.split(";")[0] };
  };
  try {
    const reader = await register(true);
    const otherAdmin = await register(true);
    const member = await register(false);
    const url = `/api/admin/users?projection=lookup&ids=${ids.join(",")}&limit=100&sort=email&sortOrder=asc`;
    const first = await request(app).get(url).set("Cookie", reader.cookie);
    expect(first.status).toBe(200);
    expect(first.body.data.total).toBe(3);
    expect(first.body.data.users).toHaveLength(3);
    for (const row of first.body.data.users)
      expect(Object.keys(row).sort()).toEqual(["email", "id", "isAdmin", "name"]);
    expect(first.body).not.toHaveProperty("timestamp");
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const warm = await request(app)
      .get(url)
      .set("Cookie", reader.cookie)
      .set("If-None-Match", first.headers.etag);
    expect(warm.status).toBe(304);
    expect(warm.text).toBe("");
    const scoped = await request(app)
      .get(url)
      .set("Cookie", otherAdmin.cookie)
      .set("If-None-Match", first.headers.etag);
    expect(scoped.status).toBe(200);
    expect(scoped.headers.etag).not.toBe(first.headers.etag);
    second = new Database(getSqliteInstance().name);
    second
      .prepare("UPDATE user SET name=?,isAdmin=1 WHERE id=?")
      .run("Current external identity", member.id);
    const changed = await request(app)
      .get(url)
      .set("Cookie", reader.cookie)
      .set("If-None-Match", first.headers.etag);
    expect(changed.status).toBe(200);
    expect(
      changed.body.data.users.find((row: { id: string }) => row.id === member.id),
    ).toMatchObject({ name: "Current external identity", isAdmin: true });
    expect(changed.headers.etag).not.toBe(first.headers.etag);
    const full = await request(app)
      .get(url.replace("projection=lookup&", ""))
      .set("Cookie", reader.cookie);
    expect(full.status).toBe(200);
    expect(full.body.data.users[0]).toHaveProperty("workflowsCount");
    expect(full.body.data.users[0]).toHaveProperty("lastActivityAt");
    expect(full.body.timestamp).toEqual(expect.any(String));
    expect(Buffer.byteLength(changed.text)).toBeLessThan(Buffer.byteLength(full.text));
    expect(
      (await request(app).get("/api/admin/users?projection=unknown").set("Cookie", reader.cookie))
        .status,
    ).toBe(400);
    expect((await request(app).get(url).set("If-None-Match", changed.headers.etag)).status).toBe(
      401,
    );
    second.prepare("UPDATE user SET isAdmin=0 WHERE id=?").run(reader.id);
    expect(
      (
        await request(app)
          .get(url)
          .set("Cookie", reader.cookie)
          .set("If-None-Match", changed.headers.etag)
      ).status,
    ).toBe(403);
  } finally {
    second?.close();
    if (ids.length) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.userId, ids));
      await db.delete(schema.user).where(inArray(schema.user.id, ids));
    }
  }
});

test("admin block and deletion fence access before retirement and retain pending parent custody", async () => {
  const db = getDatabase();
  const ids: string[] = [];
  const app = express();
  app.use(express.json());
  app.use("/api/admin", requireAuth, requireAdmin, adminRoutes);
  app.use(setupErrorMiddleware());
  const register = async (isAdmin: boolean) => {
    const response = await auth.handler(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `retirement-${randomUUID()}@example.test`,
          name: "Credential retirement",
          password: "RetirementProtocol123!",
          acceptedTermsAt: new Date().toISOString(),
          acceptedNotRussianResidentAt: new Date().toISOString(),
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    ids.push(body.user.id);
    await db
      .update(schema.user)
      .set({ isAdmin, emailVerified: true, approvedAt: new Date().toISOString() })
      .where(eq(schema.user.id, body.user.id));
    return { id: body.user.id, cookie: response.headers.get("set-cookie")!.split(";")[0] };
  };
  const issuer = getScopedCredentialService();
  const connection = getCodespaceConnectionService();
  const originalDisconnect = connection.disconnect.bind(connection);
  const retirement = jest.spyOn(issuer, "disposeUser");
  const disconnect = jest.spyOn(connection, "disconnect");
  const resourceId = randomUUID();
  try {
    const admin = await register(true);
    const target = await register(false);
    const connectionId = randomUUID();
    await db.insert(schema.codespaceConnection).values({
      id: connectionId,
      userId: target.id,
      provider: "github-codespaces",
      externalAccountId: "fixture-account",
      externalLogin: "fixture",
      status: "connected",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.codespaceCredentialVault).values({
      connectionId,
      envelopeVersion: 2,
      keyVersion: "fixture",
      iv: "fixture-iv",
      authTag: "fixture-tag",
      ciphertext: "retained-private-parent",
      generation: 1,
      updatedAt: new Date(),
    });
    const fenced = async () => {
      expect(
        (await db.select().from(schema.user).where(eq(schema.user.id, target.id)))[0].blocked,
      ).toBe(true);
      expect(
        await db.select().from(schema.session).where(eq(schema.session.userId, target.id)),
      ).toHaveLength(0);
    };
    retirement.mockImplementation(async (id) => {
      expect(id).toBe(target.id);
      await fenced();
      throw new Error("provider-secret-must-not-escape");
    });
    const blocked = await request(app)
      .post(`/api/admin/users/${target.id}/block`)
      .set("Cookie", admin.cookie)
      .send({ reason: "security retirement" });
    expect(blocked.status).toBe(503);
    expect(blocked.body.data).toMatchObject({ blocked: true, credentialRetirementPending: true });
    expect(blocked.text).not.toContain("provider-secret-must-not-escape");
    expect(disconnect).not.toHaveBeenCalled();
    const failedChild = await request(app)
      .delete(`/api/admin/users/${target.id}`)
      .set("Cookie", admin.cookie);
    expect(failedChild.status).toBe(409);
    expect(failedChild.body.data.deleted).toBe(false);
    expect(
      (
        await db
          .select()
          .from(schema.codespaceCredentialVault)
          .where(eq(schema.codespaceCredentialVault.connectionId, connectionId))
      )[0].ciphertext,
    ).toBe("retained-private-parent");
    retirement.mockImplementation(async () => {
      await fenced();
    });
    await db.insert(schema.githubResourceIdentity).values({
      id: resourceId,
      userId: target.id,
      connectionId,
      authorizationGeneration: 1,
      repositoryId: "201",
      repositoryFullName: "fixture/project",
      requestedRef: "main",
      operationMarker: randomUUID(),
      providerResourceName: `fixture-stopped-${resourceId}`,
      externalOwnerId: "101",
      billableOwnerId: "101",
      generation: 1,
      retirement: "owned",
      createdAt: Date.now(),
    });
    disconnect.mockImplementation(async (id, options) => {
      expect(options).toEqual({ securityOnly: true });
      await fenced();
      return originalDisconnect(id, options);
    });
    const pendingResource = await request(app)
      .delete(`/api/admin/users/${target.id}`)
      .set("Cookie", admin.cookie);
    expect(pendingResource.status).toBe(409);
    expect(pendingResource.body.error.code).toBe("ACCOUNT_RESOURCE_RETIREMENT_PENDING");
    expect(pendingResource.body.data).toMatchObject({
      blocked: true,
      deleted: false,
      resourceRetirementPending: true,
    });
    expect(
      (
        await db
          .select()
          .from(schema.githubResourceIdentity)
          .where(eq(schema.githubResourceIdentity.id, resourceId))
      )[0].retirement,
    ).toBe("owned");
    expect(
      (
        await db
          .select()
          .from(schema.codespaceCredentialVault)
          .where(eq(schema.codespaceCredentialVault.connectionId, connectionId))
      )[0].ciphertext,
    ).toBe("retained-private-parent");
    // Simulate the separately authorized existing workspace deletion, not an account API effect.
    await db
      .update(schema.githubResourceIdentity)
      .set({ retirement: "retired" })
      .where(eq(schema.githubResourceIdentity.id, resourceId));
    disconnect.mockImplementation(async (id, options) => {
      expect(id).toBe(target.id);
      expect(options).toEqual({ securityOnly: true });
      await fenced();
      return { state: "revocation_pending" } as ReturnType<typeof connection.getStatus>;
    });
    const pendingParent = await request(app)
      .delete(`/api/admin/users/${target.id}`)
      .set("Cookie", admin.cookie);
    expect(pendingParent.status).toBe(409);
    expect(pendingParent.body.data).toMatchObject({
      blocked: true,
      deleted: false,
      credentialRetirementPending: true,
    });
    expect(await db.select().from(schema.user).where(eq(schema.user.id, target.id))).toHaveLength(
      1,
    );
    expect(
      await db
        .select()
        .from(schema.codespaceCredentialVault)
        .where(eq(schema.codespaceCredentialVault.connectionId, connectionId)),
    ).toHaveLength(1);
    disconnect.mockImplementation(async () => {
      await fenced();
      await db
        .delete(schema.codespaceCredentialVault)
        .where(eq(schema.codespaceCredentialVault.connectionId, connectionId));
      await db
        .update(schema.codespaceConnection)
        .set({ status: "disconnected" })
        .where(eq(schema.codespaceConnection.id, connectionId));
      return { state: "disconnected" } as ReturnType<typeof connection.getStatus>;
    });
    const deleted = await request(app)
      .delete(`/api/admin/users/${target.id}`)
      .set("Cookie", admin.cookie);
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.deleted).toBe(true);
    expect(await db.select().from(schema.user).where(eq(schema.user.id, target.id))).toHaveLength(
      0,
    );
  } finally {
    retirement.mockRestore();
    disconnect.mockRestore();
    if (ids.length) {
      await db
        .delete(schema.githubResourceIdentity)
        .where(eq(schema.githubResourceIdentity.id, resourceId));
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.userId, ids));
      await db.delete(schema.user).where(inArray(schema.user.id, ids));
    }
  }
});
