import { expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { AuditAction, getDatabase } from "@mcp-moira/shared";
import * as schema from "../../packages/shared/src/database/schema.js";
import { UserRepository } from "../../packages/shared/src/database/repositories/user-repository.js";
import { auth } from "../../packages/web-backend/src/auth.js";
import { requireAuth } from "../../packages/web-backend/src/middleware/auth-middleware.js";
import { requireAdmin } from "../../packages/web-backend/src/middleware/admin-middleware.js";
import { apiLimiter } from "../../packages/web-backend/src/middleware/rate-limit-middleware.js";
import { setupErrorMiddleware } from "../../packages/web-backend/src/middleware/error-middleware.js";
import { adminRoutes } from "../../packages/web-backend/src/routes/admin.js";

test("admin file-size override persists, omitted fields survive and reset returns effective inheritance", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", apiLimiter, requireAuth, requireAdmin, adminRoutes);
  app.use(setupErrorMiddleware());
  const db = getDatabase();
  const registration = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `artifact-quota-${randomUUID()}@example.test`,
        name: "Artifact quota administrator",
        password: "QuotaProtocol123!",
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      }),
    }),
  );
  expect(registration.status).toBe(200);
  const owner = (await registration.json()) as { user: { id: string } };
  const id = owner.user.id;
  const cookie = registration.headers.get("set-cookie")!.split(";")[0];
  const url = `/api/admin/users/${id}/artifact-quota`;
  try {
    await db
      .update(schema.user)
      .set({ isAdmin: true, approvedAt: new Date().toISOString(), emailVerified: true })
      .where(eq(schema.user.id, id));
    const before = await request(app).get(url).set("Cookie", cookie);
    expect(before.status).toBe(200);
    expect(before.body.data.overrides.maxFileSizeMb).toBeNull();
    const saved = await request(app)
      .put(url)
      .set("Cookie", cookie)
      .send({ quotaMb: 120, maxFiles: 17, maxFileSizeMb: 7.5 });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ maxFileSizeMb: 7.5, maxFileSizeBytes: 7_864_320 });
    const reload = await request(app).get(url).set("Cookie", cookie);
    expect(reload.body.data.overrides).toEqual({ quotaMb: 120, maxFiles: 17, maxFileSizeMb: 7.5 });
    expect(reload.body.data.effective.maxFileSizeBytes).toBe(7_864_320);
    const omitted = await request(app).put(url).set("Cookie", cookie).send({ quotaMb: 121 });
    expect(omitted.status).toBe(200);
    expect(omitted.body.data).toMatchObject({ quotaMb: 121, maxFiles: 17, maxFileSizeMb: 7.5 });
    for (const invalid of [0, -1, "7", 0.1, Number.MAX_SAFE_INTEGER]) {
      expect(
        (await request(app).put(url).set("Cookie", cookie).send({ maxFileSizeMb: invalid })).status,
      ).toBe(400);
    }
    expect(
      (await request(app).get(url).set("Cookie", cookie)).body.data.overrides.maxFileSizeMb,
    ).toBe(7.5);
    const reset = await request(app).put(url).set("Cookie", cookie).send({ maxFileSizeMb: null });
    expect(reset.status).toBe(200);
    expect(reset.body.data.maxFileSizeBytes).toBe(before.body.data.effective.maxFileSizeBytes);
    const inherited = await request(app).get(url).set("Cookie", cookie);
    expect(inherited.body.data.overrides).toEqual({
      quotaMb: 121,
      maxFiles: 17,
      maxFileSizeMb: null,
    });
    expect(inherited.body.data.effective.maxFileSizeBytes).toBe(
      before.body.data.effective.maxFileSizeBytes,
    );
    const logs = await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, id));
    const quotaLogs = logs.filter((row) => row.action === AuditAction.ADMIN_ARTIFACT_QUOTA_UPDATE);
    expect(quotaLogs).toHaveLength(3);
    expect(quotaLogs.map((row) => JSON.parse(row.metadata!))).toEqual([
      expect.objectContaining({ previousMaxFileSizeMb: null, newMaxFileSizeMb: 7.5 }),
      expect.objectContaining({ previousMaxFileSizeMb: 7.5, newMaxFileSizeMb: 7.5 }),
      expect.objectContaining({ previousMaxFileSizeMb: 7.5, newMaxFileSizeMb: null }),
    ]);
    expect((await request(app).get(url)).status).toBe(401);
    await db.update(schema.user).set({ isAdmin: false }).where(eq(schema.user.id, id));
    expect(
      (await request(app).put(url).set("Cookie", cookie).send({ maxFileSizeMb: 9 })).status,
    ).toBe(403);
  } finally {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, id));
    await db.delete(schema.user).where(eq(schema.user.id, id));
  }
});

test("file-size migration preserves populated users and their existing quota settings", async () => {
  const root = path.resolve("packages/web-backend/drizzle");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-artifact-size-migration-"));
  const sqlite = new Database(":memory:");
  try {
    fs.cpSync(root, directory, { recursive: true });
    const journalPath = path.join(directory, "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const boundary = journal.entries.findIndex(
      (entry) => entry.tag === "0066_artifact_file_size_override",
    );
    if (boundary < 1) throw new Error("File-size migration is missing");
    journal.entries = journal.entries.slice(0, boundary);
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: directory });
    sqlite
      .prepare(
        "INSERT INTO user(id,email,handle,createdAt,updatedAt,artifactQuotaMb,artifactMaxFiles) VALUES(?,?,?,?,?,?,?)",
      )
      .run("legacy", "legacy@example.test", "legacy", "2026-10-01", "2026-10-02", 321, 19);
    migrate(db, { migrationsFolder: root });
    const users = new UserRepository(db);
    expect(await users.getArtifactQuota("legacy")).toEqual({
      artifactQuotaMb: 321,
      artifactMaxFiles: 19,
      artifactMaxFileSizeMb: null,
    });
    await users.updateArtifactQuota("legacy", 321, 19, 7.5);
    expect(
      sqlite
        .prepare("SELECT email,createdAt,artifactMaxFileSizeMb FROM user WHERE id='legacy'")
        .get(),
    ).toEqual({
      email: "legacy@example.test",
      createdAt: "2026-10-01",
      artifactMaxFileSizeMb: 7.5,
    });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    sqlite.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
