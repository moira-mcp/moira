#!/usr/bin/env node
/**
 * Workflow Schema Migration Runner
 * Creates workflow and workflowExecution tables in Better Auth database
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import path from "path";

const dbPath = path.resolve(process.env.DB_PATH || "./data/moira.db");
const schemaPath = path.resolve("./scripts/create-workflow-schema.sql");

console.log("Running workflow schema migration...");
console.log("Database:", dbPath);
console.log("Schema:", schemaPath);
console.log("");

const db = new Database(dbPath);
// WAL mode disabled - using standard journal for stability
db.pragma("foreign_keys = ON");

const schema = readFileSync(schemaPath, "utf-8");
db.exec(schema);

console.log("✅ Schema migration completed successfully");
console.log("");

// Verify tables created
const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workflow', 'workflowExecution')",
  )
  .all();
console.log("Tables created:", tables);

// Verify system admin user
const adminUser = db.prepare("SELECT id, email, name FROM user WHERE id='system-admin'").get();
console.log("System admin:", adminUser);

// Count existing workflows
const workflowCount = db.prepare("SELECT COUNT(*) as count FROM workflow").get() as {
  count: number;
};
console.log("Workflows in database:", workflowCount.count);

db.close();
console.log("");
console.log("Migration complete!");
