import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as schema from "../../packages/shared/src/database/schema.js";
import { recoverOrdinaryUserWithTemporaryPassword } from "../../packages/web-backend/src/services/temporary-password-recovery.js";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

describe("temporary-password recovery serialization", () => {
  let tempDir: string;
  let sqlite: Database.Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-recovery-serialization-"));
    sqlite = new Database(path.join(tempDir, "moira.db"));
    sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_PATH });

    const now = "2026-08-22T09:00:00.000Z";
    sqlite
      .prepare(
        `INSERT INTO user
           (id, email, name, handle, emailVerified, isAdmin, approvedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run("recovery-admin", "admin@example.test", "Admin", "recovery-admin", 1, now, now, now);
    sqlite
      .prepare(
        `INSERT INTO user
           (id, email, name, handle, emailVerified, isAdmin, approvedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      )
      .run("recovery-target", "target@example.test", "Target", "recovery-target", now, now, now);
    sqlite
      .prepare(
        `INSERT INTO account
           (id, accountId, providerId, userId, password, createdAt, updatedAt)
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
      )
      .run(
        "credential-account",
        "recovery-target",
        "recovery-target",
        "original-password-hash",
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT INTO account
           (id, accountId, providerId, userId, accessToken, refreshToken, idToken, createdAt, updatedAt)
         VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "linked-account",
        "linked-target",
        "recovery-target",
        "linked-access",
        "linked-refresh",
        "linked-id",
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT INTO session
           (id, expiresAt, token, createdAt, updatedAt, userId)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "target-session",
        "2026-08-23T09:00:00.000Z",
        "session-token",
        now,
        now,
        "recovery-target",
      );
    sqlite
      .prepare(
        `INSERT INTO apiToken
           (id, name, tokenPrefix, tokenHash, userId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("target-api-token", "Target API", "prefix", "hash", "recovery-target", now);
    sqlite
      .prepare(
        `INSERT INTO oauthAccessToken
           (id, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt,
            clientId, userId, scopes, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "target-oauth-token",
        "oauth-access",
        "oauth-refresh",
        "2026-08-23T09:00:00.000Z",
        "2026-08-24T09:00:00.000Z",
        "oauth-client",
        "recovery-target",
        "openid profile",
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT INTO oauthConsent
           (id, clientId, userId, scopes, createdAt, updatedAt, consentGiven)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      .run("target-oauth-consent", "oauth-client", "recovery-target", "openid profile", now, now);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects without mutation when promotion completes after recovery starts but before its transaction", async () => {
    const database = drizzle(sqlite, { schema });
    const stateBefore = snapshotRecoveryAuthority(sqlite);
    let markHasherStarted!: () => void;
    let releaseHasher!: () => void;
    const hasherStarted = new Promise<void>((resolve) => {
      markHasherStarted = resolve;
    });
    const hasherRelease = new Promise<void>((resolve) => {
      releaseHasher = resolve;
    });

    const recovery = recoverOrdinaryUserWithTemporaryPassword(
      {
        userId: "recovery-target",
        requestedBy: "recovery-admin",
        temporaryPassword: "replacement-password",
        audit: { source: "test" },
      },
      {
        database,
        hash: async () => {
          markHasherStarted();
          await hasherRelease;
          return "replacement-password-hash";
        },
        now: () => "2026-08-22T09:05:00.000Z",
      },
    );

    await hasherStarted;
    sqlite.prepare("UPDATE user SET isAdmin = 1 WHERE id = 'recovery-target'").run();
    releaseHasher();

    await expect(recovery).rejects.toThrow(
      "Temporary-password recovery is limited to non-admin users",
    );
    expect(sqlite.prepare("SELECT isAdmin FROM user WHERE id = 'recovery-target'").get()).toEqual({
      isAdmin: 1,
    });
    expect(snapshotRecoveryAuthority(sqlite)).toEqual(stateBefore);
  });
});

function snapshotRecoveryAuthority(sqlite: Database.Database) {
  return {
    user: sqlite
      .prepare(
        `SELECT passwordResetRequired, passwordResetRequestedAt, passwordResetRequestedBy
         FROM user WHERE id = 'recovery-target'`,
      )
      .get(),
    accounts: sqlite
      .prepare(
        `SELECT id, password, accessToken, refreshToken, idToken
         FROM account WHERE userId = 'recovery-target' ORDER BY id`,
      )
      .all(),
    sessions: sqlite
      .prepare("SELECT id, token FROM session WHERE userId = 'recovery-target' ORDER BY id")
      .all(),
    apiTokens: sqlite
      .prepare("SELECT id, revokedAt FROM apiToken WHERE userId = 'recovery-target' ORDER BY id")
      .all(),
    oauthTokens: sqlite
      .prepare(
        `SELECT id, accessToken, refreshToken
         FROM oauthAccessToken WHERE userId = 'recovery-target' ORDER BY id`,
      )
      .all(),
    oauthConsents: sqlite
      .prepare("SELECT id FROM oauthConsent WHERE userId = 'recovery-target' ORDER BY id")
      .all(),
  };
}
