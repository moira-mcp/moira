import { expect, test } from "@jest/globals";
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
