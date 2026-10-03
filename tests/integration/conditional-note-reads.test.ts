import { expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, inArray, and } from "drizzle-orm";
import express from "express";
import request from "supertest";
import {
  getDatabase,
  getSqliteInstance,
  getNoteService,
  NoteService,
  NoteRepository,
  AuditRepository,
  AuditAction,
} from "@mcp-moira/shared";
import * as schema from "../../packages/shared/src/database/schema.js";
import { auth } from "../../packages/web-backend/src/auth.js";
import { requireAuth } from "../../packages/web-backend/src/middleware/auth-middleware.js";
import { notesRoutes } from "../../packages/web-backend/src/routes/notes.js";
import { nodeTypesRoutes } from "../../packages/web-backend/src/routes/node-types.js";

test("authenticated conditional reads preserve note audit and see changes from a second SQLite connection", async () => {
  const app = express();
  app.use("/api/notes", requireAuth, notesRoutes);
  app.use("/api/node-types", requireAuth, nodeTypesRoutes);
  const db = getDatabase();
  const ids: string[] = [];
  const noteIds: string[] = [];
  let second: Database.Database | undefined;
  const register = async () => {
    const response = await auth.handler(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `conditional-${randomUUID()}@example.test`,
          name: "Conditional Reader",
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
      .set({ approvedAt: new Date().toISOString(), emailVerified: true })
      .where(eq(schema.user.id, body.user.id));
    return { id: body.user.id, cookie: response.headers.get("set-cookie")!.split(";")[0] };
  };
  try {
    const reader = await register();
    const another = await register();
    noteIds.push(
      (await getNoteService().save(reader.id, { key: "current", value: "first", tags: ["one"] }))
        .id,
    );
    const auditCount = async () =>
      (
        await db
          .select()
          .from(schema.auditLog)
          .where(
            and(
              eq(schema.auditLog.userId, reader.id),
              eq(schema.auditLog.action, AuditAction.NOTE_LIST),
            ),
          )
      ).length;
    const first = await request(app).get("/api/notes").set("Cookie", reader.cookie);
    expect(first.status).toBe(200);
    expect(first.body.timestamp).toEqual(expect.any(String));
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    expect(first.headers.vary).toContain("Cookie");
    expect(first.headers.vary).toContain("Authorization");
    const count = await auditCount();
    const warm = await request(app)
      .get("/api/notes")
      .set("Cookie", reader.cookie)
      .set("If-None-Match", first.headers.etag);
    expect(warm.status).toBe(304);
    expect(warm.text).toBe("");
    expect(await auditCount()).toBe(count + 1);
    // The same service seam used by MCP writes, through a different connection to the actual DB.
    second = new Database(getSqliteInstance().name);
    const otherDb = drizzle(second, { schema });
    await new NoteService(new NoteRepository(otherDb), new AuditRepository(otherDb)).save(
      reader.id,
      { key: "current", value: "changed elsewhere", tags: ["two"] },
    );
    const changed = await request(app)
      .get("/api/notes")
      .set("Cookie", reader.cookie)
      .set("If-None-Match", first.headers.etag);
    expect(changed.status).toBe(200);
    expect(changed.body.data.notes[0]).toMatchObject({
      preview: "changed elsewhere",
      currentVersion: 2,
      tags: ["two"],
    });
    expect(changed.headers.etag).not.toBe(first.headers.etag);
    const refresh = await request(app)
      .get("/api/notes")
      .set("Cookie", reader.cookie)
      .set("If-None-Match", changed.headers.etag)
      .set("Cache-Control", "no-cache");
    expect(refresh.status).toBe(200);
    const catalog = await request(app).get("/api/node-types").set("Cookie", reader.cookie);
    const otherCatalog = await request(app)
      .get("/api/node-types")
      .set("Cookie", another.cookie)
      .set("If-None-Match", catalog.headers.etag);
    expect(otherCatalog.status).toBe(200);
    expect(otherCatalog.body.data).toEqual(catalog.body.data);
    expect(otherCatalog.headers.etag).not.toBe(catalog.headers.etag);
    expect(
      (await request(app).get("/api/notes").set("If-None-Match", changed.headers.etag)).status,
    ).toBe(401);
    await db.update(schema.user).set({ blocked: true }).where(eq(schema.user.id, reader.id));
    expect(
      (
        await request(app)
          .get("/api/notes")
          .set("Cookie", reader.cookie)
          .set("If-None-Match", changed.headers.etag)
      ).status,
    ).toBe(403);
  } finally {
    second?.close();
    if (noteIds.length)
      await db
        .delete(schema.entityRevision)
        .where(inArray(schema.entityRevision.entityId, noteIds));
    if (ids.length) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.userId, ids));
      await db.delete(schema.user).where(inArray(schema.user.id, ids));
    }
  }
});
