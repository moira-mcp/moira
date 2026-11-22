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
  const clients = sqlite.prepare("SELECT * FROM legacyOAuthApplication").all() as LegacyClient[];
  const encrypted = new Map(
    await Promise.all(
      clients.map(
        async (client) =>
          [
            client.id,
            {
              original: client.clientSecret,
              value: client.clientSecret
                ? await symmetricEncrypt({ key: secret, data: client.clientSecret })
                : null,
            },
          ] as const,
      ),
    ),
  );
  sqlite
    .transaction(() => {
      if (!pending()) return;
      const resourceId = "moira-mcp-resource";
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
      for (const c of sqlite
        .prepare("SELECT * FROM legacyOAuthApplication")
        .iterate() as Iterable<LegacyClient>) {
        const secured = encrypted.get(c.id);
        if (!secured || secured.original !== c.clientSecret)
          throw new Error("OAuth client changed during migration; retry the migration");
        const isPublic = c.type === "public";
        if (!isPublic && !secured.value) throw new Error("Confidential OAuth client has no secret");
        insertClient.run(
          c.id,
          c.clientId,
          isPublic ? null : secured.value,
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
      for (const grant of sqlite
        .prepare("SELECT * FROM legacyOAuthAccessToken")
        .iterate() as Iterable<LegacyGrant>) {
        const values = [
          grant.clientId,
          grant.userId,
          JSON.stringify([resource]),
          scopes(grant.scopes),
        ];
        if (grant.refreshToken)
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
          grant.refreshToken ? grant.id : null,
        );
      }
      const addConsent = sqlite.prepare(
        "INSERT INTO oauthConsent (id,clientId,userId,scopes,resources,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)",
      );
      for (const c of sqlite
        .prepare("SELECT * FROM legacyOAuthConsent WHERE consentGiven=1")
        .iterate() as Iterable<LegacyConsent>) {
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
    })
    .immediate();
}
