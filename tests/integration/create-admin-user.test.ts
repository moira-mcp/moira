import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyPassword } from "better-auth/crypto";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");
const TSX_PATH = path.join(process.cwd(), "node_modules/.bin/tsx");
const SCRIPT_PATH = path.join(process.cwd(), "scripts/create-admin-user.ts");

describe("create-admin-user recovery script", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-admin-recovery-"));
    dbPath = path.join(tempDir, "moira.db");
    const sqlite = new Database(dbPath);
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_PATH });
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO user
           (id, email, name, handle, emailVerified, isAdmin, approvedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, 'admin', 1, 1, ?, ?, ?)`,
      )
      .run("system-admin", "admin@moira.local", "Bootstrap Admin", now, now, now);
    sqlite.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("refuses recovery without an operator-supplied password", () => {
    const { ADMIN_PASSWORD: _removedPassword, ...environmentWithoutPassword } = process.env;
    let failure:
      | (Error & { status?: number | null; stderr?: string | Buffer; stdout?: string | Buffer })
      | undefined;

    try {
      execFileSync(TSX_PATH, [SCRIPT_PATH], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...environmentWithoutPassword,
          DB_PATH: dbPath,
          ADMIN_ID: "must-not-exist",
          ADMIN_EMAIL: "must-not-exist@example.com",
        },
      });
    } catch (error) {
      failure = error as typeof failure;
    }

    expect(failure).toBeDefined();
    expect(failure?.status).not.toBe(0);
    expect(String(failure?.stderr)).toContain("ADMIN_PASSWORD is required");

    const sqlite = new Database(dbPath);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM user WHERE id = ?").get("must-not-exist"),
    ).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM account WHERE userId = ?")
        .get("must-not-exist"),
    ).toEqual({ count: 0 });
    sqlite.close();
  });

  it("creates and recovers an approved admin with a Better Auth credential without logging it", async () => {
    const runRecovery = (password: string) =>
      execFileSync(TSX_PATH, [SCRIPT_PATH], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DB_PATH: dbPath,
          ADMIN_ID: "recovery-admin",
          ADMIN_EMAIL: "recovery@example.com",
          ADMIN_PASSWORD: password,
        },
      });

    const initialPassword = "first-recovery-secret";
    const initialOutput = runRecovery(initialPassword);
    expect(initialOutput).not.toContain(initialPassword);

    let sqlite = new Database(dbPath);
    const createdUser = sqlite
      .prepare(
        "SELECT id, email, handle, emailVerified, isAdmin, approvedAt FROM user WHERE id = ?",
      )
      .get("recovery-admin") as {
      id: string;
      email: string;
      handle: string;
      emailVerified: number;
      isAdmin: number;
      approvedAt: string | null;
    };
    const createdAccount = sqlite
      .prepare("SELECT accountId, providerId, password FROM account WHERE userId = ?")
      .get("recovery-admin") as {
      accountId: string;
      providerId: string;
      password: string;
    };
    expect(createdUser).toMatchObject({
      id: "recovery-admin",
      email: "recovery@example.com",
      handle: "recovery",
      emailVerified: 1,
      isAdmin: 1,
      approvedAt: expect.any(String),
    });
    expect(createdAccount).toMatchObject({
      accountId: "recovery@example.com",
      providerId: "credential",
    });
    expect(await verifyPassword({ hash: createdAccount.password, password: initialPassword })).toBe(
      true,
    );
    sqlite
      .prepare(
        `UPDATE user
         SET emailVerified = 0,
             isAdmin = 0,
             approvedAt = NULL,
             blocked = 1,
             blockedAt = ?,
             blockedReason = ?,
             blockedBy = id
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), "lost access", "recovery-admin");
    sqlite.exec(`
      CREATE TRIGGER fail_recovery_credential_update
      BEFORE UPDATE OF password ON account
      WHEN OLD.userId = 'recovery-admin'
      BEGIN
        SELECT RAISE(ABORT, 'credential replacement failed');
      END;
    `);
    sqlite.close();

    const replacementPassword = "replacement-recovery-secret";
    expect(() => runRecovery(replacementPassword)).toThrow();

    sqlite = new Database(dbPath);
    const interruptedUser = sqlite
      .prepare(
        `SELECT emailVerified, isAdmin, approvedAt, blocked, blockedAt, blockedReason, blockedBy
         FROM user WHERE id = 'recovery-admin'`,
      )
      .get();
    expect(interruptedUser).toMatchObject({
      emailVerified: 0,
      isAdmin: 0,
      approvedAt: null,
      blocked: 1,
      blockedAt: expect.any(String),
      blockedReason: "lost access",
      blockedBy: "recovery-admin",
    });
    const interruptedAccount = sqlite
      .prepare("SELECT password FROM account WHERE userId = ? AND providerId = 'credential'")
      .get("recovery-admin") as { password: string };
    expect(
      await verifyPassword({ hash: interruptedAccount.password, password: initialPassword }),
    ).toBe(true);
    expect(
      await verifyPassword({ hash: interruptedAccount.password, password: replacementPassword }),
    ).toBe(false);
    sqlite.exec("DROP TRIGGER fail_recovery_credential_update");
    sqlite.close();

    const replacementOutput = runRecovery(replacementPassword);
    expect(replacementOutput).not.toContain(replacementPassword);
    expect(replacementOutput).not.toContain(initialPassword);

    sqlite = new Database(dbPath);
    const recoveredAccount = sqlite
      .prepare("SELECT password FROM account WHERE userId = ? AND providerId = 'credential'")
      .get("recovery-admin") as { password: string };
    const recoveredUser = sqlite
      .prepare(
        `SELECT emailVerified, isAdmin, approvedAt, blocked, blockedAt, blockedReason, blockedBy
         FROM user WHERE id = 'recovery-admin'`,
      )
      .get() as {
      emailVerified: number;
      isAdmin: number;
      approvedAt: string | null;
      blocked: number;
      blockedAt: string | null;
      blockedReason: string | null;
      blockedBy: string | null;
    };
    expect(
      await verifyPassword({ hash: recoveredAccount.password, password: replacementPassword }),
    ).toBe(true);
    expect(
      await verifyPassword({ hash: recoveredAccount.password, password: initialPassword }),
    ).toBe(false);
    expect(recoveredUser).toMatchObject({
      emailVerified: 1,
      isAdmin: 1,
      approvedAt: expect.any(String),
      blocked: 0,
      blockedAt: null,
      blockedReason: null,
      blockedBy: null,
    });
    sqlite.close();
  });
});
