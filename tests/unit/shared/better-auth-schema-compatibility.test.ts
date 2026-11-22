import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { migrateOAuthProvider } from "../../../scripts/migrate-oauth-provider.js";
import { oauthTokenDigest } from "../../../packages/shared/src/auth/oauth-token.js";
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

  test("preserves valid grants alongside unresolved legacy registrations, grants and consents", async () => {
    const now = new Date().toISOString();
    const resource = "https://resource.example/mcp";
    sqlite
      .prepare(
        "INSERT INTO user (id,email,handle,approvedAt,createdAt,updatedAt) VALUES ('owner','owner@example.test','owner',?,?,?)",
      )
      .run(now, now, now);
    const client = sqlite.prepare(
      "INSERT INTO legacyOAuthApplication (id,clientId,name,redirectUrls,type,userId,createdAt,updatedAt) VALUES (?,?,'fixture','https://client.example/callback','public',?,?,?)",
    );
    client.run("valid-client", "valid", null, now, now);
    client.run("deleted-owner-client", "deleted-owner", "missing-user", now, now);
    const grant = sqlite.prepare(
      "INSERT INTO legacyOAuthAccessToken (id,accessToken,refreshToken,accessTokenExpiresAt,refreshTokenExpiresAt,clientId,userId,scopes,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,'openid',?,?)",
    );
    grant.run(
      "survivor",
      "access-survivor",
      "refresh-survivor",
      now,
      now,
      "valid",
      "owner",
      now,
      now,
    );
    grant.run(
      "orphan-grant",
      "access-orphan",
      "refresh-orphan",
      now,
      now,
      "absent",
      "owner",
      now,
      now,
    );
    grant.run(
      "user-orphan",
      "access-user-orphan",
      "refresh-user-orphan",
      now,
      now,
      "valid",
      "absent-user",
      now,
      now,
    );
    const consent = sqlite.prepare(
      "INSERT INTO legacyOAuthConsent (id,clientId,userId,scopes,createdAt,updatedAt,consentGiven) VALUES (?,?,'owner','openid',?,?,1)",
    );
    consent.run("live-consent", "valid", now, now);
    consent.run("stale-consent", "absent", now, now);
    sqlite.pragma("foreign_keys = ON");
    await migrateOAuthProvider(sqlite, "synthetic-unit-secret", resource);
    await migrateOAuthProvider(sqlite, "synthetic-unit-secret", resource);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(sqlite.prepare("SELECT clientId FROM oauthClient").all()).toEqual([
      { clientId: "valid" },
    ]);
    expect(sqlite.prepare("SELECT token FROM oauthAccessToken").all()).toEqual([
      { token: oauthTokenDigest("access-survivor") },
    ]);
    expect(sqlite.prepare("SELECT token FROM oauthRefreshToken").all()).toEqual([
      { token: oauthTokenDigest("refresh-survivor") },
    ]);
    expect(sqlite.prepare("SELECT id FROM oauthConsent").all()).toEqual([{ id: "live-consent" }]);
    const audit = sqlite
      .prepare(
        "SELECT resourceId, json_extract(metadata,'$.reason') AS reason FROM auditLog WHERE action='oauth:migration_unresolved' ORDER BY resourceId",
      )
      .all();
    expect(audit).toEqual([
      { resourceId: "deleted-owner-client", reason: "missing_user" },
      { resourceId: "orphan-grant", reason: "missing_client" },
      { resourceId: "stale-consent", reason: "missing_client" },
      { resourceId: "user-orphan", reason: "missing_user" },
    ]);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM auditLog WHERE action='oauth:consent_grant'")
        .get(),
    ).toEqual({ count: 0 });
  });
});
