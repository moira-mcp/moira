import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { symmetricEncrypt } from "better-auth/crypto";
import { oauthTokenDigest } from "../packages/shared/src/auth/oauth-token.js";

interface LegacyClient {
  id: string;
  name: string;
  icon: string | null;
  metadata: string | null;
  clientId: string;
  clientSecret: string | null;
  redirectUrls: string;
  type: string;
  disabled: number;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
}
interface LegacyGrant {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string | null;
  clientId: string;
  userId: string;
  scopes: string;
  toolsVersion: string | null;
  createdAt: string;
  updatedAt: string;
}
interface LegacyConsent {
  id: string;
  clientId: string;
  userId: string;
  scopes: string;
  createdAt: string;
  updatedAt: string;
  consentGiven: number;
}

const scopes = (value: string) => JSON.stringify(value.split(/[\s,]+/).filter(Boolean));

type LegacyTable = "legacyOAuthApplication" | "legacyOAuthAccessToken" | "legacyOAuthConsent";

function* readRows<T extends { id: string }>(
  sqlite: Database.Database,
  table: LegacyTable,
): Generator<T> {
  const first = sqlite.prepare("SELECT * FROM " + table + " ORDER BY id LIMIT 256");
  const next = sqlite.prepare("SELECT * FROM " + table + " WHERE id > ? ORDER BY id LIMIT 256");
  let rows = first.all() as T[];
  while (rows.length) {
    yield* rows;
    rows = next.all(rows[rows.length - 1].id) as T[];
  }
}

/** Convert 1.6 credentials in one write transaction; the renamed inputs survive a failed attempt. */
export async function migrateOAuthProvider(
  sqlite: Database.Database,
  secret: string,
  resource: string,
) {
  const pending = () =>
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacyOAuthApplication'")
      .get();
  if (!pending()) return;
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    if (!pending()) {
      sqlite.exec("COMMIT");
      return;
    }
    const existingUser = sqlite.prepare("SELECT 1 FROM user WHERE id=?");
    const existingClient = sqlite.prepare("SELECT 1 FROM oauthClient WHERE clientId=?");
    const audit = sqlite.prepare(
      "INSERT INTO auditLog (id,action,resource,resourceId,source,metadata,createdAt) VALUES (?, 'oauth:migration_unresolved', ?, ?, 'system', ?, ?)",
    );
    function unresolved(
      row: { id: string; clientId: string; userId: string | null },
      model: string,
      reason: string,
    ) {
      audit.run(
        randomUUID(),
        model,
        row.id,
        JSON.stringify({ reason, clientId: row.clientId, originalUserId: row.userId }),
        Date.now(),
      );
    }
    function missingOwner(row: { clientId: string; userId: string }) {
      if (!existingClient.get(row.clientId)) return "missing_client";
      if (!existingUser.get(row.userId)) return "missing_user";
      return null;
    }
    const resourceId = randomUUID();
    sqlite
      .prepare(
        "INSERT INTO oauthResource (id,identifier,name) VALUES (?,?,?) ON CONFLICT(identifier) DO NOTHING",
      )
      .run(resourceId, resource, "Moira MCP");
    const grantResource = sqlite.prepare(
      "INSERT INTO oauthClientResource (id,clientId,resourceId) VALUES (?,?,?)",
    );
    const insertClient = sqlite.prepare(`INSERT INTO oauthClient
      (id, clientId, clientSecret, name, icon, metadata, redirectUris, disabled, userId,
       tokenEndpointAuthMethod, grantTypes, responseTypes, requirePKCE, scopes, createdAt, updatedAt, legacyAuthMethod)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '["authorization_code","refresh_token"]', '["code"]', 1, '["openid","profile","email","offline_access"]', ?, ?, 1)`);
    for (const c of readRows<LegacyClient>(sqlite, "legacyOAuthApplication")) {
      const isPublic = c.type === "public";
      if ((c.userId !== null && !existingUser.get(c.userId)) || (!isPublic && !c.clientSecret)) {
        unresolved(
          c,
          "oauth_client",
          c.userId !== null && !existingUser.get(c.userId)
            ? "missing_user"
            : "missing_client_secret",
        );
        continue;
      }
      const storedSecret =
        !isPublic && c.clientSecret
          ? await symmetricEncrypt({ key: secret, data: c.clientSecret })
          : null;
      insertClient.run(
        c.id,
        c.clientId,
        storedSecret,
        c.name,
        c.icon,
        c.metadata,
        JSON.stringify(
          c.redirectUrls
            .split(",")
            .map((uri) => uri.trim())
            .filter(Boolean),
        ),
        c.disabled ?? 0,
        c.userId,
        isPublic ? "none" : "client_secret_basic",
        c.createdAt,
        c.updatedAt,
      );
      grantResource.run(c.id, c.clientId, resource);
    }
    const addRefresh = sqlite.prepare(`INSERT INTO oauthRefreshToken
      (id, token, clientId, userId, resources, scopes, expiresAt, createdAt, toolsVersion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addAccess = sqlite.prepare(`INSERT INTO oauthAccessToken
      (id, token, clientId, userId, resources, scopes, expiresAt, createdAt, toolsVersion, refreshId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const grant of readRows<LegacyGrant>(sqlite, "legacyOAuthAccessToken")) {
      const reason = missingOwner(grant);
      if (reason) {
        unresolved(grant, "oauth_grant", reason);
        continue;
      }
      const refreshUsable = !!grant.refreshToken && !!grant.refreshTokenExpiresAt;
      if (grant.refreshToken && !refreshUsable)
        unresolved(grant, "oauth_refresh_token", "missing_expiry");
      const values = [
        grant.clientId,
        grant.userId,
        JSON.stringify([resource]),
        scopes(grant.scopes),
      ];
      if (refreshUsable && grant.refreshToken)
        addRefresh.run(
          grant.id,
          oauthTokenDigest(grant.refreshToken),
          ...values,
          grant.refreshTokenExpiresAt,
          grant.createdAt,
          grant.toolsVersion,
        );
      addAccess.run(
        grant.id,
        oauthTokenDigest(grant.accessToken),
        ...values,
        grant.accessTokenExpiresAt,
        grant.createdAt,
        grant.toolsVersion,
        refreshUsable ? grant.id : null,
      );
    }
    const addConsent = sqlite.prepare(
      "INSERT INTO oauthConsent (id,clientId,userId,scopes,resources,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)",
    );
    for (const c of readRows<LegacyConsent>(sqlite, "legacyOAuthConsent")) {
      const reason = missingOwner(c);
      if (reason) {
        unresolved(c, "oauth_consent", reason);
        continue;
      }
      if (!c.consentGiven) continue;
      addConsent.run(
        c.id,
        c.clientId,
        c.userId,
        scopes(c.scopes),
        JSON.stringify([resource]),
        c.createdAt,
        c.updatedAt,
      );
    }
    sqlite.exec(
      "DROP TABLE legacyOAuthAccessToken; DROP TABLE legacyOAuthConsent; DROP TABLE legacyOAuthApplication",
    );
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}
