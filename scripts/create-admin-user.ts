#!/usr/bin/env node

/**
 * Create admin user with proper password hashing
 * Uses Better Auth password hashing format
 * Console output is intentional for CLI script
 */

import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";

const dbPath = path.resolve(process.env.DB_PATH || "./data/moira.db");
const db = new Database(dbPath);

const ADMIN_ID = "system-admin";
const ADMIN_EMAIL = "admin@moira.local";
const ADMIN_PASSWORD = "AdminTest123";

// Better Auth uses bcrypt-like format but actually stores as salt:hash
// Generate salt and hash using pbkdf2
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 10000, 64, "sha256").toString("hex");
const hashedPassword = `${salt}:${hash}`;

// Check if user exists
const existingUser = db.prepare("SELECT id FROM user WHERE id = ?").get(ADMIN_ID);

if (!existingUser) {
  // Create user
  db.prepare(
    `
    INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `,
  ).run(ADMIN_ID, ADMIN_EMAIL, "Admin User", 1);

  console.log("✅ Admin user created");
} else {
  console.log("ℹ️  Admin user already exists");
}

// Check if account exists
const existingAccount = db
  .prepare("SELECT id FROM account WHERE userId = ? AND providerId = ?")
  .get(ADMIN_ID, "credential");

if (!existingAccount) {
  // Create account with password
  db.prepare(
    `
    INSERT INTO account (id, userId, accountId, providerId, password, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `,
  ).run(crypto.randomUUID(), ADMIN_ID, ADMIN_EMAIL, "credential", hashedPassword);

  console.log("✅ Admin account created with password");
} else {
  console.log("ℹ️  Admin account already exists");
}

console.log("");
console.log("Admin credentials:");
console.log("  Email:", ADMIN_EMAIL);
console.log("  Password:", ADMIN_PASSWORD);
console.log("  User ID:", ADMIN_ID);

db.close();
