#!/usr/bin/env node

/**
 * Create admin user with proper password hashing
 * Uses Better Auth password hashing format
 * Console output is intentional for CLI script
 */

import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import { hashPassword } from "better-auth/crypto";
import {
  generateHandleFromEmail,
  generateRandomHandleSuffix,
} from "../packages/shared/src/validation/slug-handle.js";

const dbPath = path.resolve(process.env.DB_PATH || "./data/moira.db");

const ADMIN_ID = process.env.ADMIN_ID?.trim() || "system-admin";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim() || "admin@moira.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  throw new Error("ADMIN_PASSWORD is required; the recovery script never uses a default secret");
}

const hashedPassword = await hashPassword(ADMIN_PASSWORD);
const db = new Database(dbPath);

try {
  const recoverAdmin = db.transaction(() => {
    const existingUser = db.prepare("SELECT id FROM user WHERE id = ?").get(ADMIN_ID);
    const createdUser = !existingUser;

    if (createdUser) {
      const baseHandle = generateHandleFromEmail(ADMIN_EMAIL);
      let handle = baseHandle;
      for (let attempt = 0; attempt < 10; attempt++) {
        const collision = db.prepare("SELECT 1 FROM user WHERE handle = ?").get(handle);
        if (!collision) break;
        handle = `${baseHandle}-${generateRandomHandleSuffix()}`;
      }
      if (db.prepare("SELECT 1 FROM user WHERE handle = ?").get(handle)) {
        throw new Error("Failed to generate a unique administrator handle");
      }

      db.prepare(
        `INSERT INTO user
          (id, email, name, handle, emailVerified, isAdmin, approvedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), datetime('now'), datetime('now'))`,
      ).run(ADMIN_ID, ADMIN_EMAIL, "Admin User", handle, 1);
    } else {
      db.prepare(
        `UPDATE user
            SET email = ?, emailVerified = 1, isAdmin = 1,
                approvedAt = COALESCE(approvedAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                blocked = 0, blockedAt = NULL, blockedReason = NULL, blockedBy = NULL,
                updatedAt = datetime('now')
          WHERE id = ?`,
      ).run(ADMIN_EMAIL, ADMIN_ID);
    }

    const existingAccount = db
      .prepare("SELECT id FROM account WHERE userId = ? AND providerId = ?")
      .get(ADMIN_ID, "credential");
    const createdAccount = !existingAccount;

    if (createdAccount) {
      db.prepare(
        `INSERT INTO account (id, userId, accountId, providerId, password, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ).run(crypto.randomUUID(), ADMIN_ID, ADMIN_EMAIL, "credential", hashedPassword);
    } else {
      db.prepare(
        `UPDATE account
            SET accountId = ?, password = ?, updatedAt = datetime('now')
          WHERE userId = ? AND providerId = 'credential'`,
      ).run(ADMIN_EMAIL, hashedPassword, ADMIN_ID);
    }

    return { createdUser, createdAccount };
  });

  const result = recoverAdmin();
  console.log(result.createdUser ? "✅ Admin user created" : "ℹ️  Existing admin user recovered");
  console.log(
    result.createdAccount
      ? "✅ Admin account created with password"
      : "✅ Existing admin credential replaced",
  );

  console.log("");
  console.log("Admin recovery complete:");
  console.log("  Email:", ADMIN_EMAIL);
  console.log("  User ID:", ADMIN_ID);
} finally {
  db.close();
}
