import { expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { AuditAction, getArtifactService, getDatabase } from "@mcp-moira/shared";
import * as schema from "../../packages/shared/src/database/schema.js";
import { auth } from "../../packages/web-backend/src/auth.js";
import { requireAuth } from "../../packages/web-backend/src/middleware/auth-middleware.js";
import { requireAdmin } from "../../packages/web-backend/src/middleware/admin-middleware.js";
import { setupErrorMiddleware } from "../../packages/web-backend/src/middleware/error-middleware.js";
import { adminRoutes } from "../../packages/web-backend/src/routes/admin.js";

test("deleted admin route forwards date bounds before paging and retains email deletion attribution", async () => {
  const app = express();
  app.use("/api/admin", requireAuth, requireAdmin, adminRoutes);
  app.use(setupErrorMiddleware());
  const db = getDatabase();
  const registration = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `deleted-${randomUUID()}@example.test`,
        name: "Deletion Reader",
        password: "ReadProtocol123!",
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      }),
    }),
  );
  expect(registration.status).toBe(200);
  const owner = (await registration.json()) as { user: { id: string; email: string } };
  const cookie = registration.headers.get("set-cookie")!.split(";")[0];
  const nonce = randomUUID();
  const ids: string[] = [];
  try {
    await db
      .update(schema.user)
      .set({ isAdmin: true, approvedAt: new Date().toISOString(), emailVerified: true })
      .where(eq(schema.user.id, owner.user.id));
    for (const [suffix, deletedAt, deletedBy] of [
      ["newer", 201, owner.user.id],
      ["end", 200, owner.user.id],
      ["middle", 150, owner.user.id],
      ["start", 100, null],
      ["unknown", null, null],
      ["epoch", 0, owner.user.id],
    ] as const) {
      const id = `${nonce}-${suffix}`;
      ids.push(id);
      await db.insert(schema.workflow).values({
        id,
        slug: id,
        userId: owner.user.id,
        name: nonce,
        version: "1.0.0",
        graph: "{}",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deleted: true,
        deletedAt: deletedAt === null ? null : new Date(deletedAt),
        deletedBy,
      });
    }
    const filtered = await request(app)
      .get(`/api/admin/workflows/deleted?search=${nonce}&fromDate=100&toDate=200&limit=1&offset=1`)
      .set("Cookie", cookie);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toEqual({
      workflows: [
        { id: `${nonce}-middle`, name: nonce, deletedAt: 150, deletedBy: owner.user.email },
      ],
      total: 3,
      limit: 1,
      offset: 1,
    });
    const epoch = await request(app)
      .get(`/api/admin/workflows/deleted?search=${nonce}&fromDate=0&toDate=0`)
      .set("Cookie", cookie);
    expect(epoch.status).toBe(200);
    expect(epoch.body.data.total).toBe(1);
    expect(epoch.body.data.workflows[0]).toEqual({
      id: `${nonce}-epoch`,
      name: nonce,
      deletedAt: 0,
      deletedBy: owner.user.email,
    });
    for (const date of [0, 1]) {
      const id = `${nonce}-live-${date}`;
      ids.push(id);
      await db.insert(schema.workflow).values({
        id,
        slug: id,
        userId: owner.user.id,
        name: nonce,
        version: "1.0.0",
        graph: '{"metadata":{},"nodes":[]}',
        createdAt: new Date(0),
        updatedAt: new Date(date),
        deleted: false,
      });
    }
    const liveEpoch = await request(app)
      .get(`/api/admin/workflows?userId=${owner.user.id}&fromDate=0&toDate=0`)
      .set("Cookie", cookie);
    expect(liveEpoch.status).toBe(200);
    expect(liveEpoch.body.data.total).toBe(1);
    expect(liveEpoch.body.data.workflows.map((row: { id: string }) => row.id)).toEqual([
      `${nonce}-live-0`,
    ]);
    for (const date of [-1, 0, 1]) {
      await db.insert(schema.auditLog).values({
        id: `${nonce}-audit-${date}`,
        userId: owner.user.id,
        action: "zero-date-fixture",
        createdAt: new Date(date),
      });
    }
    const auditEpoch = await request(app)
      .get(
        `/api/admin/audit-log?userId=${owner.user.id}&action=zero-date-fixture&fromDate=0&toDate=0`,
      )
      .set("Cookie", cookie);
    expect(auditEpoch.status).toBe(200);
    expect(auditEpoch.body.data.total).toBe(1);
    expect(auditEpoch.body.data.entries.map((row: { createdAt: number }) => row.createdAt)).toEqual(
      [0],
    );
    const capped = await request(app)
      .get(`/api/admin/workflows/deleted?search=${nonce}&limit=999&offset=-1`)
      .set("Cookie", cookie);
    expect(capped.body.data.limit).toBe(100);
    expect(capped.body.data.offset).toBe(0);
    expect(capped.body.data.total).toBe(6);
    expect(
      (
        await request(app)
          .get("/api/admin/workflows/deleted?fromDate=invalid")
          .set("Cookie", cookie)
      ).status,
    ).toBe(400);
    expect((await request(app).get("/api/admin/workflows/deleted")).status).toBe(401);
    await db.update(schema.user).set({ isAdmin: false }).where(eq(schema.user.id, owner.user.id));
    expect(
      (await request(app).get("/api/admin/workflows/deleted").set("Cookie", cookie)).status,
    ).toBe(403);
  } finally {
    await db.delete(schema.workflow).where(inArray(schema.workflow.id, ids));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, owner.user.id));
    await db.delete(schema.user).where(eq(schema.user.id, owner.user.id));
  }
});

test("reported admin pages preserve read audit, validated takedown and active inventory totals", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", requireAuth, requireAdmin, adminRoutes);
  app.use(setupErrorMiddleware());
  const db = getDatabase();
  const registration = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `reported-${randomUUID()}@example.test`,
        name: "Abuse Reader",
        password: "ReadProtocol123!",
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      }),
    }),
  );
  expect(registration.status).toBe(200);
  const owner = (await registration.json()) as { user: { id: string } };
  const cookie = registration.headers.get("set-cookie")!.split(";")[0];
  const uuids: string[] = [];
  try {
    await db
      .update(schema.user)
      .set({ isAdmin: true, approvedAt: new Date().toISOString(), emailVerified: true })
      .where(eq(schema.user.id, owner.user.id));
    const service = getArtifactService();
    for (let index = 0; index < 3; index++) {
      const created = await service.create(owner.user.id, {
        name: `Report ${index}`,
        content: "<!DOCTYPE html><html><body>Reported</body></html>",
      });
      uuids.push(created.uuid);
      await db
        .update(schema.artifact)
        .set({ reportCount: 10000 + index, lastReportedAt: new Date(100) })
        .where(eq(schema.artifact.uuid, created.uuid));
    }
    const first = await request(app)
      .get("/api/admin/artifacts/reported?limit=1&offset=1")
      .set("Cookie", cookie);
    expect(first.status).toBe(200);
    expect(first.body.data.artifacts.map((item: { uuid: string }) => item.uuid)).toEqual([
      uuids[1],
    ]);
    const logs = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, owner.user.id));
    const readLog = logs.filter((row) => row.action === AuditAction.ADMIN_ARTIFACT_LIST_REPORTED);
    expect(readLog).toHaveLength(1);
    expect(JSON.parse(readLog[0].metadata!)).toEqual({
      resultCount: 1,
      totalCount: first.body.data.total,
    });
    expect(
      (
        await request(app)
          .post(`/api/admin/artifacts/${uuids[1]}/takedown`)
          .set("Cookie", cookie)
          .send({ reason: " " })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/admin/artifacts/${uuids[1]}/takedown`)
          .set("Cookie", cookie)
          .send({ reason: " Abuse " })
      ).status,
    ).toBe(200);
    expect(await service.getPublic(uuids[1])).toBeNull();
    const active = await request(app)
      .get("/api/admin/artifacts/reported?limit=1&offset=1&includeTakenDown=false")
      .set("Cookie", cookie);
    expect(active.body.data.total).toBe(first.body.data.total - 1);
    expect(active.body.data.artifacts.map((item: { uuid: string }) => item.uuid)).toEqual([
      uuids[0],
    ]);
    const inventory = await request(app)
      .get("/api/admin/artifacts/reported?limit=1&offset=1")
      .set("Cookie", cookie);
    expect(inventory.body.data.total).toBe(first.body.data.total);
    expect(inventory.body.data.artifacts[0]).toMatchObject({
      uuid: uuids[1],
      takenDown: true,
      takenDownReason: "Abuse",
      takenDownBy: owner.user.id,
    });
    expect(
      (await request(app).get("/api/admin/artifacts/reported?limit=NaN").set("Cookie", cookie))
        .status,
    ).toBe(400);
  } finally {
    await db.delete(schema.artifact).where(inArray(schema.artifact.uuid, uuids));
    await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, owner.user.id));
    await db.delete(schema.user).where(eq(schema.user.id, owner.user.id));
  }
});
