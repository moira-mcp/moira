#!/usr/bin/env node

/**
 * Prepare account state before rolling application code back to a version that
 * does not enforce user.approvedAt. Pending users are blocked using the legacy
 * authorization fact and all of their active credentials are revoked.
 */

import Database from "better-sqlite3";
import path from "node:path";

const CONFIRMATION_ARGUMENT = "--confirm-block-pending-users";

if (!process.argv.includes(CONFIRMATION_ARGUMENT)) {
  throw new Error(
    `Refusing to change account state without ${CONFIRMATION_ARGUMENT}. Back up the database first.`,
  );
}

const dbPath = path.resolve(process.env.DB_PATH || "./data/moira.db");
const sqlite = new Database(dbPath);

try {
  const columns = sqlite.prepare("PRAGMA table_info(user)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "approvedAt")) {
    throw new Error(
      "user.approvedAt is absent; run this command on the approval-aware version before rollback",
    );
  }

  const prepareDowngrade = sqlite.transaction(() => {
    const pendingUsers = (
      sqlite.prepare("SELECT COUNT(*) AS count FROM user WHERE approvedAt IS NULL").get() as {
        count: number;
      }
    ).count;
    const sessions = sqlite
      .prepare("DELETE FROM session WHERE userId IN (SELECT id FROM user WHERE approvedAt IS NULL)")
      .run().changes;
    const apiTokens = sqlite
      .prepare(
        "DELETE FROM apiToken WHERE userId IN (SELECT id FROM user WHERE approvedAt IS NULL)",
      )
      .run().changes;
    const oauthTokens = sqlite
      .prepare(
        "DELETE FROM oauthAccessToken WHERE userId IN (SELECT id FROM user WHERE approvedAt IS NULL)",
      )
      .run().changes;
    const oauthConsents = sqlite
      .prepare(
        "DELETE FROM oauthConsent WHERE userId IN (SELECT id FROM user WHERE approvedAt IS NULL)",
      )
      .run().changes;
    const timestamp = new Date().toISOString();
    sqlite
      .prepare(
        `UPDATE user
         SET blocked = 1,
             blockedAt = COALESCE(blockedAt, ?),
             blockedReason = CASE
               WHEN blockedReason IS NULL OR blockedReason = ''
                 THEN 'Blocked before rollback to a version without account approval'
               ELSE blockedReason
             END,
             updatedAt = ?
         WHERE approvedAt IS NULL`,
      )
      .run(timestamp, timestamp);

    return { pendingUsers, sessions, apiTokens, oauthTokens, oauthConsents };
  });

  const result = prepareDowngrade();
  console.log("Account-approval downgrade preparation complete:");
  console.log(`  Pending users blocked: ${result.pendingUsers}`);
  console.log(`  Sessions revoked: ${result.sessions}`);
  console.log("  API and OAuth credentials revoked");
} finally {
  sqlite.close();
}
