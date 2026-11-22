import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "../../../packages/shared/src/database/schema.js";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

describe("Better Auth database schema compatibility", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: MIGRATIONS_PATH });
  });

  afterEach(() => {
    sqlite.close();
  });

  test("exposes the MCP redirect URL column with Better Auth's logical field name", () => {
    const columns = sqlite.prepare("PRAGMA table_info(oauthClient)").all() as Array<{
      name: string;
    }>;

    expect(columns.map((column) => column.name)).toContain("redirectUris");
    expect(columns.map((column) => column.name)).not.toContain("redirectURLs");

    const db = drizzle(sqlite, { schema });
    const now = new Date().toISOString();
    db.insert(schema.oauthClient)
      .values({
        id: "schema-contract-client",
        name: "Schema contract client",
        clientId: "schema-contract-client-id",
        clientSecret: "schema-contract-secret",
        redirectUris: '["http://localhost:3333/oauth/callback"]',
        disabled: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const stored = sqlite
      .prepare("SELECT * FROM oauthClient WHERE clientId = ?")
      .get("schema-contract-client-id") as Record<string, unknown>;
    expect(stored.redirectUris).toBe('["http://localhost:3333/oauth/callback"]');
    expect(stored.redirectURLs).toBeUndefined();
  });
});
