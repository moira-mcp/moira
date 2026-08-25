import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import fs from "fs";
import os from "os";
import {
  AuditAction,
  AccountApprovalRepository,
  AuditRepository,
  UserRepository,
  UserService,
  auditLog,
  user,
} from "@mcp-moira/shared";
import * as schema from "../../packages/shared/src/database/schema.js";
import { and, eq } from "drizzle-orm";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");
const TSX_PATH = path.join(process.cwd(), "node_modules/.bin/tsx");
const DOWNGRADE_SCRIPT_PATH = path.join(
  process.cwd(),
  "scripts/prepare-account-approval-downgrade.ts",
);

describe("account approval migration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-approval-migration-"));
    dbPath = path.join(tempDir, "legacy.db");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should backfill legacy users while new users remain pending across restart", () => {
    let sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL,
        handle TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO user (id, email, handle, createdAt, updatedAt)
      VALUES ('legacy', 'legacy@example.com', 'legacy', datetime('now'), datetime('now'));
    `);
    sqlite.exec(fs.readFileSync(path.join(MIGRATIONS_PATH, "0014_account_approval.sql"), "utf8"));

    const legacy = sqlite.prepare("SELECT approvedAt FROM user WHERE id = 'legacy'").get() as {
      approvedAt: string | null;
    };
    expect(legacy.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    sqlite
      .prepare(
        "INSERT INTO user (id, email, handle, createdAt, updatedAt) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
      )
      .run("fresh", "fresh@example.com", "fresh");
    expect(
      (
        sqlite.prepare("SELECT approvedAt FROM user WHERE id = 'fresh'").get() as {
          approvedAt: string | null;
        }
      ).approvedAt,
    ).toBeNull();

    sqlite.close();
    sqlite = new Database(dbPath);
    expect(
      (
        sqlite.prepare("SELECT approvedAt FROM user WHERE id = 'fresh'").get() as {
          approvedAt: string | null;
        }
      ).approvedAt,
    ).toBeNull();
    sqlite.close();
  });

  it("should require confirmation, then block pending users and revoke only their credentials", () => {
    let sqlite = new Database(dbPath);
    sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: MIGRATIONS_PATH });

    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO user (id, email, handle, approvedAt, blocked, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run("pending", "pending@example.com", "pending-downgrade", null, now, now);
    sqlite
      .prepare(
        `INSERT INTO user (id, email, handle, approvedAt, blocked, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run("approved", "approved@example.com", "approved-downgrade", now, now, now);

    const insertSession = sqlite.prepare(
      `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertSession.run("pending-session", now, "pending-session-token", now, now, "pending");
    insertSession.run("approved-session", now, "approved-session-token", now, now, "approved");
    sqlite
      .prepare(
        `INSERT INTO apiToken (id, name, tokenPrefix, tokenHash, userId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("pending-api-token", "pending", "mcp_pending", "pending-hash", "pending", now);
    sqlite
      .prepare(
        `INSERT INTO apiToken (id, name, tokenPrefix, tokenHash, userId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("approved-api-token", "approved", "mcp_approved", "approved-hash", "approved", now);
    sqlite
      .prepare(
        `INSERT INTO oauthAccessToken
           (id, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt,
            clientId, userId, scopes, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "pending-oauth-token",
        "pending-access-token",
        "pending-refresh-token",
        now,
        now,
        "client",
        "pending",
        "openid",
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT INTO oauthAccessToken
           (id, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt,
            clientId, userId, scopes, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "approved-oauth-token",
        "approved-access-token",
        "approved-refresh-token",
        now,
        now,
        "client",
        "approved",
        "openid",
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("pending-consent", "client", "pending", "openid", now, now);
    sqlite
      .prepare(
        `INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("approved-consent", "client", "approved", "openid", now, now);
    sqlite.close();

    expect(() =>
      execFileSync(TSX_PATH, [DOWNGRADE_SCRIPT_PATH], {
        env: { ...process.env, DB_PATH: dbPath },
        stdio: "pipe",
      }),
    ).toThrow();

    sqlite = new Database(dbPath);
    expect(
      sqlite
        .prepare("SELECT blocked, blockedAt, blockedReason FROM user WHERE id = 'pending'")
        .get(),
    ).toEqual({ blocked: 0, blockedAt: null, blockedReason: null });
    for (const userId of ["pending", "approved"]) {
      for (const table of ["session", "apiToken", "oauthAccessToken", "oauthConsent"]) {
        expect(
          (
            sqlite
              .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE userId = ?`)
              .get(userId) as {
              count: number;
            }
          ).count,
        ).toBe(1);
      }
    }
    sqlite.close();

    const output = execFileSync(
      TSX_PATH,
      [DOWNGRADE_SCRIPT_PATH, "--confirm-block-pending-users"],
      {
        encoding: "utf8",
        env: { ...process.env, DB_PATH: dbPath },
      },
    );
    expect(output).toContain("Pending users blocked: 1");
    expect(output).toContain("Sessions revoked: 1");
    expect(output).toContain("API and OAuth credentials revoked");

    sqlite = new Database(dbPath);
    const pending = sqlite
      .prepare("SELECT blocked, blockedAt, blockedReason FROM user WHERE id = 'pending'")
      .get() as { blocked: number; blockedAt: string | null; blockedReason: string | null };
    expect(pending.blocked).toBe(1);
    expect(pending.blockedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pending.blockedReason).toBe(
      "Blocked before rollback to a version without account approval",
    );

    for (const table of ["session", "apiToken", "oauthAccessToken", "oauthConsent"]) {
      expect(
        (
          sqlite
            .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE userId = 'pending'`)
            .get() as {
            count: number;
          }
        ).count,
      ).toBe(0);
    }
    expect(
      (
        sqlite.prepare("SELECT blocked FROM user WHERE id = 'approved'").get() as {
          blocked: number;
        }
      ).blocked,
    ).toBe(0);
    for (const table of ["session", "apiToken", "oauthAccessToken", "oauthConsent"]) {
      expect(
        (
          sqlite
            .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE userId = 'approved'`)
            .get() as {
            count: number;
          }
        ).count,
      ).toBe(1);
    }
    sqlite.close();
  });
});

describe("UserService account approval", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let service: UserService;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    const now = new Date().toISOString();
    await db.insert(user).values([
      {
        id: "admin",
        email: "admin@example.com",
        name: "Admin",
        handle: "admin-test",
        isAdmin: true,
        approvedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "pending",
        email: "pending@example.com",
        name: "Pending",
        handle: "pending-test",
        approvedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    service = new UserService(
      new UserRepository(db),
      new AuditRepository(db),
      new AccountApprovalRepository(sqlite),
    );
  });

  afterEach(() => {
    sqlite.close();
  });

  it("should preserve one timestamp and one audit event under overlapping requests", async () => {
    const [first, second] = await Promise.all([
      service.approveAccount("admin", "pending"),
      service.approveAccount("admin", "pending"),
    ]);

    expect([first.status, second.status].sort()).toEqual(["already-approved", "approved"]);
    expect(first.approvedAt).toBe(second.approvedAt);

    const [stored] = await db
      .select({ approvedAt: user.approvedAt })
      .from(user)
      .where(eq(user.id, "pending"));
    expect(stored.approvedAt).toBe(first.approvedAt);

    const events = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, AuditAction.ADMIN_APPROVE_USER),
          eq(auditLog.resourceId, "pending"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe("admin");
  });

  it("should return not-found without creating an audit event", async () => {
    await expect(service.approveAccount("admin", "missing")).resolves.toEqual({
      status: "not-found",
      approvedAt: null,
    });
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});
