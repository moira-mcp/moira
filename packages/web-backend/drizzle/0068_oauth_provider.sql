-- Preserve the populated 1.6 tables until the application migration has converted all credentials.
ALTER TABLE "oauthApplication" RENAME TO "legacyOAuthApplication";
--> statement-breakpoint
ALTER TABLE "oauthAccessToken" RENAME TO "legacyOAuthAccessToken";
--> statement-breakpoint
ALTER TABLE "oauthConsent" RENAME TO "legacyOAuthConsent";
--> statement-breakpoint
CREATE TABLE "oauthClient" (
  "id" text PRIMARY KEY NOT NULL,
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" integer,
  "skipConsent" integer,
  "enableEndSession" integer,
  "subjectType" text,
  "scopes" text,
  "clientCredentialsScopes" text,
  "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt" text,
  "updatedAt" text,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" text,
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" text NOT NULL,
  "postLogoutRedirectUris" text,
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" integer,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" text,
  "responseTypes" text,
  "requirePKCE" integer,
  "dpopBoundAccessTokens" integer,
  "referenceId" text,
  "metadata" text,
  "legacyAuthMethod" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" ("userId");
--> statement-breakpoint
CREATE TABLE "oauthResource" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" text,
  "customClaims" text,
  "dpopBoundAccessTokensRequired" integer,
  "disabled" integer,
  "createdAt" text,
  "updatedAt" text,
  "policyVersion" integer,
  "metadata" text
);
--> statement-breakpoint
CREATE TABLE "oauthClientResource" (
  "id" text PRIMARY KEY NOT NULL,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "resourceId" text NOT NULL REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE,
  "metadata" text,
  "createdAt" text
);
--> statement-breakpoint
CREATE INDEX "oauthClientResource_clientId_idx" ON "oauthClientResource" ("clientId");
--> statement-breakpoint
CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauthClientResource" ("resourceId");
--> statement-breakpoint
CREATE TABLE "oauthRefreshToken" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "expiresAt" text NOT NULL,
  "createdAt" text NOT NULL,
  "revoked" text,
  "rotatedAt" text,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" text,
  "authTime" text,
  "confirmation" text,
  "scopes" text NOT NULL,
  "toolsVersion" text
);
--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" ("clientId");
--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" ("sessionId");
--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" ("userId");
--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken" ("authorizationCodeId");
--> statement-breakpoint
CREATE TABLE "oauthAccessToken" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "refreshId" text REFERENCES "oauthRefreshToken" ("id") ON DELETE CASCADE,
  "expiresAt" text NOT NULL,
  "createdAt" text NOT NULL,
  "revoked" text,
  "confirmation" text,
  "scopes" text NOT NULL,
  "toolsVersion" text
);
--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
--> statement-breakpoint
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" ("sessionId");
--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
--> statement-breakpoint
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken" ("authorizationCodeId");
--> statement-breakpoint
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId");
--> statement-breakpoint
CREATE TABLE "oauthConsent" (
  "id" text PRIMARY KEY NOT NULL,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "resources" text,
  "requestedUserInfoClaims" text,
  "scopes" text NOT NULL,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
--> statement-breakpoint
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" ("userId");
--> statement-breakpoint
CREATE TABLE "oauthClientAssertion" (
  "id" text PRIMARY KEY NOT NULL,
  "expiresAt" text NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER oauth_access_catalog_revision AFTER UPDATE OF toolsVersion ON oauthAccessToken
WHEN NEW.refreshId IS NOT NULL
BEGIN
  UPDATE oauthRefreshToken SET toolsVersion = NEW.toolsVersion WHERE id = NEW.refreshId AND userId = NEW.userId AND clientId = NEW.clientId;
END;
