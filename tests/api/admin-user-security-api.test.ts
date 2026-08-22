/**
 * Admin User Security API Integration Tests
 * Tests admin security management endpoints
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { execSqliteInDocker } from "../utils/docker-command.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

// Test users
let targetUserEmail: string;
let targetUserPassword: string;
let adminCookie: string;
let adminUserId: string;
let targetCookie: string;
let targetUserId: string;

describe("Admin User Security API", () => {
  beforeAll(async () => {
    // Create target user via API
    targetUserEmail = `target-security-${Date.now()}@example.com`;
    targetUserPassword = "TargetSecurity123!";

    const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: targetUserEmail,
        password: targetUserPassword,
        name: "Target Security Test",
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      }),
    });
    const signUpData = (await signUpRes.json()) as any;
    targetUserId = signUpData.user.id;

    // Login as admin to verify email and perform admin actions
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });
    const adminCookies = adminLoginRes.headers.get("set-cookie");
    adminCookie = adminCookies || "";
    const adminStatusRes = await fetch(`${BASE_URL}/api/user/me`, {
      headers: { Cookie: adminCookie },
    });
    expect(adminStatusRes.status).toBe(200);
    adminUserId = ((await adminStatusRes.json()) as { data: { id: string } }).data.id;

    // Verify test user email via admin API
    await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/verify-email`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    const featuresRes = await fetch(`${BASE_URL}/api/features`);
    const features = (await featuresRes.json()) as {
      data: { features: { accountApproval: boolean } };
    };
    if (features.data.features.accountApproval) {
      const approvalRes = await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/approve`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      expect(approvalRes.status).toBe(200);
    }

    // Login as target user
    const targetLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: targetUserEmail,
        password: targetUserPassword,
      }),
    });
    const targetCookies = targetLoginRes.headers.get("set-cookie");
    targetCookie = targetCookies || "";
  });

  describe("POST /api/admin/users/:id/force-password-reset", () => {
    test("admin can force password reset", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/force-password-reset`,
        {
          method: "POST",
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("userId", targetUserId);
      expect(json.data).toHaveProperty("passwordResetRequired", true);
      expect(json.data).toHaveProperty("requestedAt");
      expect(json.data).toHaveProperty("requestedBy", adminUserId);
    });

    test("force password reset revokes all user sessions", async () => {
      // Create multiple sessions for target user
      const session1 = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetUserEmail,
          password: targetUserPassword,
        }),
      });
      expect(session1.status).toBe(200);

      const session2 = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetUserEmail,
          password: targetUserPassword,
        }),
      });
      expect(session2.status).toBe(200);

      // Get sessions count before reset
      const sessionsBeforeRes = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/sessions`,
        {
          headers: { Cookie: adminCookie },
        },
      );
      const sessionsBeforeData = await sessionsBeforeRes.json();
      const sessionCountBefore = sessionsBeforeData.data.length;
      expect(sessionCountBefore).toBeGreaterThanOrEqual(2);

      // Force password reset
      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/force-password-reset`,
        {
          method: "POST",
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("sessionsRevoked");
      expect(json.data.sessionsRevoked).toBe(sessionCountBefore);

      // Verify all sessions revoked
      const sessionsAfterRes = await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/sessions`, {
        headers: { Cookie: adminCookie },
      });
      const sessionsAfterData = await sessionsAfterRes.json();
      expect(sessionsAfterData.data.length).toBe(0);
    });

    test("force password reset returns session count even if no sessions exist", async () => {
      // First revoke all sessions
      await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/sessions`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });

      // Force password reset with no sessions
      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/force-password-reset`,
        {
          method: "POST",
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("sessionsRevoked", 0);
    });

    test("non-admin cannot force password reset", async () => {
      // Re-login as target user to get fresh cookie (might have been revoked by previous tests)
      const targetLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetUserEmail,
          password: targetUserPassword,
        }),
      });
      const freshTargetCookie = targetLoginRes.headers.get("set-cookie") || "";

      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/force-password-reset`,
        {
          method: "POST",
          headers: { Cookie: freshTargetCookie },
        },
      );

      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/users/nonexistent-user-id/force-password-reset`,
        {
          method: "POST",
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /api/admin/users/:id/oauth-tokens", () => {
    test("admin can revoke all oauth tokens", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/oauth-tokens`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("userId", targetUserId);
      expect(json.data).toHaveProperty("tokensRevoked");
      expect(typeof json.data.tokensRevoked).toBe("number");
    });

    test("non-admin cannot revoke oauth tokens", async () => {
      // Re-login as target user to get fresh cookie (might have been revoked by previous tests)
      const targetLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetUserEmail,
          password: targetUserPassword,
        }),
      });
      const freshTargetCookie = targetLoginRes.headers.get("set-cookie") || "";

      const response = await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/oauth-tokens`, {
        method: "DELETE",
        headers: { Cookie: freshTargetCookie },
      });

      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent user", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/users/nonexistent-user-id/oauth-tokens`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/admin/users/:id/security-activity", () => {
    test("returns security activity stats", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/security-activity`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("sessionsCount");
      expect(json.data).toHaveProperty("oauthTokensCount");
      expect(json.data).toHaveProperty("passwordResetRequired");
      expect(json.data).toHaveProperty("passwordResetRequestedAt");
      expect(json.data).toHaveProperty("passwordResetRequestedBy");

      expect(typeof json.data.sessionsCount).toBe("number");
      expect(typeof json.data.oauthTokensCount).toBe("number");
      expect(typeof json.data.passwordResetRequired).toBe("boolean");
    });

    test("non-admin cannot access security activity", async () => {
      // Re-login as target user to get fresh cookie (might have been revoked by previous tests)
      const targetLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetUserEmail,
          password: targetUserPassword,
        }),
      });
      const freshTargetCookie = targetLoginRes.headers.get("set-cookie") || "";

      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/security-activity`,
        {
          headers: { Cookie: freshTargetCookie },
        },
      );

      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/users/nonexistent-user-id/security-activity`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/admin/users/:id/temporary-password", () => {
    test("rejects malformed credential boundaries without changing the account", async () => {
      const loginBefore = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetUserEmail, password: targetUserPassword }),
      });
      expect(loginBefore.status).toBe(200);
      const sessionCookie = loginBefore.headers.get("set-cookie") || "";
      const stateBeforeResponse = await fetch(`${BASE_URL}/api/user/me`, {
        headers: { Cookie: sessionCookie },
      });
      expect(stateBeforeResponse.status).toBe(200);
      const stateBefore = ((await stateBeforeResponse.json()) as any).data
        .passwordResetRequired as boolean;

      const invalidBodies = [
        {},
        { temporaryPassword: 12345678 },
        { temporaryPassword: "short" },
        { temporaryPassword: "x".repeat(129) },
      ];
      for (const body of invalidBodies) {
        const response = await fetch(
          `${BASE_URL}/api/admin/users/${targetUserId}/temporary-password`,
          {
            method: "POST",
            headers: { Cookie: adminCookie, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        expect(response.status).toBe(400);

        const stillAuthorized = await fetch(`${BASE_URL}/api/user/me`, {
          headers: { Cookie: sessionCookie },
        });
        expect(stillAuthorized.status).toBe(200);
        expect(((await stillAuthorized.json()) as any).data.passwordResetRequired).toBe(
          stateBefore,
        );
      }

      const loginAfter = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetUserEmail, password: targetUserPassword }),
      });
      expect(loginAfter.status).toBe(200);
    });

    test("recovers an ordinary account, revokes old access, and requires a new password", async () => {
      const temporaryPassword = `Temporary-${Date.now()}!`;
      const finalPassword = `Recovered-${Date.now()}!`;
      const oldSession = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetUserEmail, password: targetUserPassword }),
      });
      expect(oldSession.status).toBe(200);
      const oldSessionCookie = oldSession.headers.get("set-cookie") || "";
      const tokenResponse = await fetch(`${BASE_URL}/api/tokens`, {
        method: "POST",
        headers: { Cookie: oldSessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "temporary recovery proof", expiresIn: "30d" }),
      });
      expect(tokenResponse.status).toBe(201);
      const apiTokenData = ((await tokenResponse.json()) as any).data as {
        id: string;
        token: string;
      };
      const plaintextApiToken = apiTokenData.token;

      const oauthTokenId = randomUUID();
      const oauthAccessToken = randomUUID();
      const oauthRefreshToken = randomUUID();
      const oauthConsentId = randomUUID();
      const linkedAccountId = randomUUID();
      const oauthClientId = `temporary-recovery-${randomUUID()}`;
      const now = new Date().toISOString();
      execSqliteInDocker(
        `INSERT INTO oauthAccessToken (id, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, clientId, userId, scopes, createdAt, updatedAt) VALUES ('${oauthTokenId}', '${oauthAccessToken}', '${oauthRefreshToken}', '${new Date(Date.now() + 300_000).toISOString()}', '${new Date(Date.now() + 600_000).toISOString()}', '${oauthClientId}', '${targetUserId}', 'openid email profile', '${now}', '${now}')`,
      );
      execSqliteInDocker(
        `INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt, consentGiven) VALUES ('${oauthConsentId}', '${oauthClientId}', '${targetUserId}', 'openid email profile', '${now}', '${now}', 1)`,
      );
      execSqliteInDocker(
        `INSERT INTO account (id, accountId, providerId, userId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, createdAt, updatedAt) VALUES ('${linkedAccountId}', 'linked-${linkedAccountId}', 'github', '${targetUserId}', 'linked-access-secret', 'linked-refresh-secret', 'linked-id-secret', '${new Date(Date.now() + 300_000).toISOString()}', '${new Date(Date.now() + 600_000).toISOString()}', 'user:email', '${now}', '${now}')`,
      );

      const sessionsBefore = Number(
        execSqliteInDocker(`SELECT COUNT(*) FROM session WHERE userId = '${targetUserId}'`),
      );
      const oauthTokensBefore = Number(
        execSqliteInDocker(
          `SELECT COUNT(*) FROM oauthAccessToken WHERE userId = '${targetUserId}'`,
        ),
      );
      const oauthConsentsBefore = Number(
        execSqliteInDocker(`SELECT COUNT(*) FROM oauthConsent WHERE userId = '${targetUserId}'`),
      );
      const apiTokensBefore = Number(
        execSqliteInDocker(
          `SELECT COUNT(*) FROM apiToken WHERE userId = '${targetUserId}' AND revokedAt IS NULL`,
        ),
      );
      const oauthBefore = await fetch(`${BASE_URL}/api/auth/mcp/get-session`, {
        headers: { Authorization: `Bearer ${oauthAccessToken}` },
      });
      expect(oauthBefore.status).toBe(200);

      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/temporary-password`,
        {
          method: "POST",
          headers: { Cookie: adminCookie, "Content-Type": "application/json" },
          body: JSON.stringify({ temporaryPassword }),
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.data).toMatchObject({
        userId: targetUserId,
        passwordResetRequired: true,
        sessionsRevoked: sessionsBefore,
        oauthTokensRevoked: oauthTokensBefore,
        oauthConsentsRevoked: oauthConsentsBefore,
        apiTokensRevoked: apiTokensBefore,
      });

      const revokedSession = await fetch(`${BASE_URL}/api/user/me`, {
        headers: { Cookie: oldSessionCookie },
      });
      expect(revokedSession.status).toBe(401);
      const revokedApiToken = await fetch(`${BASE_URL}/api/tokens`, {
        headers: { Authorization: `Bearer ${plaintextApiToken}` },
      });
      expect(revokedApiToken.status).toBe(401);
      expect(
        execSqliteInDocker(
          `SELECT COUNT(*) FROM apiToken WHERE id = '${apiTokenData.id}' AND revokedAt IS NOT NULL`,
        ),
      ).toBe("1");

      const revokedOAuth = await fetch(`${BASE_URL}/api/auth/mcp/get-session`, {
        headers: { Authorization: `Bearer ${oauthAccessToken}` },
      });
      expect(revokedOAuth.status).toBe(401);
      const revokedRefresh = await fetch(`${BASE_URL}/api/auth/mcp/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: oauthRefreshToken,
          client_id: oauthClientId,
          client_secret: "revoked-client-secret",
        }),
      });
      expect(revokedRefresh.status).toBe(401);
      expect(await revokedRefresh.json()).toMatchObject({ code: "INVALID_TOKEN" });
      expect(
        execSqliteInDocker(`SELECT COUNT(*) FROM oauthAccessToken WHERE id = '${oauthTokenId}'`),
      ).toBe("0");
      expect(
        execSqliteInDocker(`SELECT COUNT(*) FROM oauthConsent WHERE id = '${oauthConsentId}'`),
      ).toBe("0");
      expect(
        execSqliteInDocker(
          `SELECT COUNT(*) FROM account WHERE id = '${linkedAccountId}' AND accessToken IS NULL AND refreshToken IS NULL AND idToken IS NULL AND accessTokenExpiresAt IS NULL AND refreshTokenExpiresAt IS NULL`,
        ),
      ).toBe("1");

      const oldLogin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetUserEmail, password: targetUserPassword }),
      });
      expect(oldLogin.status).toBe(401);

      const temporaryLogin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetUserEmail, password: temporaryPassword }),
      });
      expect(temporaryLogin.status).toBe(200);
      const temporaryCookie = temporaryLogin.headers.get("set-cookie") || "";

      const me = await fetch(`${BASE_URL}/api/user/me`, {
        headers: { Cookie: temporaryCookie },
      });
      expect(((await me.json()) as any).data.passwordResetRequired).toBe(true);

      const change = await fetch(`${BASE_URL}/api/user/change-password-forced`, {
        method: "POST",
        headers: { Cookie: temporaryCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: temporaryPassword, newPassword: finalPassword }),
      });
      expect(change.status).toBe(200);

      const finalLogin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetUserEmail, password: finalPassword }),
      });
      expect(finalLogin.status).toBe(200);
      targetUserPassword = finalPassword;

      const audit = await fetch(
        `${BASE_URL}/api/admin/audit-log?action=admin:force_password_reset&resourceId=${targetUserId}`,
        { headers: { Cookie: adminCookie } },
      );
      const auditJson = (await audit.json()) as any;
      const serializedAudit = JSON.stringify(auditJson.data.entries);
      expect(serializedAudit).toContain("temporary-password");
      expect(serializedAudit).not.toContain(temporaryPassword);
    });

    test.each(["final user update", "audit completion"])(
      "rolls back every recovery mutation when %s fails",
      async (failurePoint) => {
        const rollbackPassword = `Rollback-${Date.now()}!`;
        const oauthTokenId = randomUUID();
        const oauthConsentId = randomUUID();
        const linkedAccountId = randomUUID();
        const oauthClientId = `rollback-recovery-${randomUUID()}`;
        const triggerName = `rollback_recovery_${randomUUID().replaceAll("-", "")}`;
        const now = new Date().toISOString();

        const oldSession = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: targetUserEmail, password: targetUserPassword }),
        });
        expect(oldSession.status).toBe(200);
        const oldSessionCookie = oldSession.headers.get("set-cookie") || "";
        const oldSessionId = execSqliteInDocker(
          `SELECT id FROM session WHERE userId = '${targetUserId}' ORDER BY createdAt DESC LIMIT 1`,
        );

        const apiTokenResponse = await fetch(`${BASE_URL}/api/tokens`, {
          method: "POST",
          headers: { Cookie: oldSessionCookie, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "rollback recovery proof", expiresIn: "30d" }),
        });
        expect(apiTokenResponse.status).toBe(201);
        const rollbackApiToken = ((await apiTokenResponse.json()) as any).data as { id: string };

        execSqliteInDocker(
          `INSERT INTO oauthAccessToken (id, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, clientId, userId, scopes, createdAt, updatedAt) VALUES ('${oauthTokenId}', 'rollback-access', 'rollback-refresh', '${new Date(Date.now() + 300_000).toISOString()}', '${new Date(Date.now() + 600_000).toISOString()}', '${oauthClientId}', '${targetUserId}', 'openid email profile', '${now}', '${now}')`,
        );
        execSqliteInDocker(
          `INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt, consentGiven) VALUES ('${oauthConsentId}', '${oauthClientId}', '${targetUserId}', 'openid email profile', '${now}', '${now}', 1)`,
        );
        execSqliteInDocker(
          `INSERT INTO account (id, accountId, providerId, userId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, createdAt, updatedAt) VALUES ('${linkedAccountId}', 'linked-${linkedAccountId}', 'github', '${targetUserId}', 'rollback-linked-access', 'rollback-linked-refresh', 'rollback-linked-id', '${new Date(Date.now() + 300_000).toISOString()}', '${new Date(Date.now() + 600_000).toISOString()}', 'user:email', '${now}', '${now}')`,
        );

        const credentialBefore = execSqliteInDocker(
          `SELECT password FROM account WHERE userId = '${targetUserId}' AND providerId = 'credential'`,
        );
        const userBefore = execSqliteInDocker(
          `SELECT passwordResetRequired || '|' || COALESCE(passwordResetRequestedAt, '') || '|' || COALESCE(passwordResetRequestedBy, '') FROM user WHERE id = '${targetUserId}'`,
        );
        const auditBefore = execSqliteInDocker(
          `SELECT COUNT(*) FROM auditLog WHERE resourceId = '${targetUserId}' AND action = 'admin:force_password_reset'`,
        );

        const triggerSql =
          failurePoint === "final user update"
            ? `CREATE TRIGGER ${triggerName} BEFORE UPDATE OF passwordResetRequired ON user WHEN OLD.id = '${targetUserId}' BEGIN SELECT RAISE(ABORT, 'forced temporary-password rollback'); END`
            : `CREATE TRIGGER ${triggerName} BEFORE INSERT ON auditLog WHEN NEW.resourceId = '${targetUserId}' AND NEW.action = 'admin:force_password_reset' BEGIN SELECT RAISE(ABORT, 'forced temporary-password audit rollback'); END`;
        execSqliteInDocker(triggerSql);
        let response: Response;
        try {
          response = await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/temporary-password`, {
            method: "POST",
            headers: { Cookie: adminCookie, "Content-Type": "application/json" },
            body: JSON.stringify({ temporaryPassword: rollbackPassword }),
          });
        } finally {
          execSqliteInDocker(`DROP TRIGGER IF EXISTS ${triggerName}`);
        }

        try {
          expect(response.status).toBe(500);
          expect(
            execSqliteInDocker(
              `SELECT password FROM account WHERE userId = '${targetUserId}' AND providerId = 'credential'`,
            ),
          ).toBe(credentialBefore);
          expect(
            execSqliteInDocker(
              `SELECT passwordResetRequired || '|' || COALESCE(passwordResetRequestedAt, '') || '|' || COALESCE(passwordResetRequestedBy, '') FROM user WHERE id = '${targetUserId}'`,
            ),
          ).toBe(userBefore);
          expect(
            execSqliteInDocker(
              `SELECT COUNT(*) FROM session WHERE id = '${oldSessionId}' AND userId = '${targetUserId}'`,
            ),
          ).toBe("1");
          expect(
            execSqliteInDocker(
              `SELECT COUNT(*) FROM apiToken WHERE id = '${rollbackApiToken.id}' AND revokedAt IS NULL`,
            ),
          ).toBe("1");
          expect(
            execSqliteInDocker(
              `SELECT COUNT(*) FROM oauthAccessToken WHERE id = '${oauthTokenId}' AND accessToken = 'rollback-access' AND refreshToken = 'rollback-refresh'`,
            ),
          ).toBe("1");
          expect(
            execSqliteInDocker(`SELECT COUNT(*) FROM oauthConsent WHERE id = '${oauthConsentId}'`),
          ).toBe("1");
          expect(
            execSqliteInDocker(
              `SELECT COUNT(*) FROM account WHERE id = '${linkedAccountId}' AND accessToken = 'rollback-linked-access' AND refreshToken = 'rollback-linked-refresh' AND idToken = 'rollback-linked-id'`,
            ),
          ).toBe("1");
          expect(
            execSqliteInDocker(
              `SELECT COUNT(*) FROM auditLog WHERE resourceId = '${targetUserId}' AND action = 'admin:force_password_reset'`,
            ),
          ).toBe(auditBefore);

          const oldPasswordStillWorks = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: targetUserEmail, password: targetUserPassword }),
          });
          expect(oldPasswordStillWorks.status).toBe(200);
        } finally {
          execSqliteInDocker(`DELETE FROM session WHERE id = '${oldSessionId}'`);
          execSqliteInDocker(`DELETE FROM apiToken WHERE id = '${rollbackApiToken.id}'`);
          execSqliteInDocker(`DELETE FROM oauthAccessToken WHERE id = '${oauthTokenId}'`);
          execSqliteInDocker(`DELETE FROM oauthConsent WHERE id = '${oauthConsentId}'`);
          execSqliteInDocker(`DELETE FROM account WHERE id = '${linkedAccountId}'`);
        }
      },
    );

    test("rejects administrator targets, self-recovery, and non-admin callers", async () => {
      execSqliteInDocker(`UPDATE user SET isAdmin = 1 WHERE id = '${targetUserId}'`);
      try {
        const targetAdminSession = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: targetUserEmail, password: targetUserPassword }),
        });
        expect(targetAdminSession.status).toBe(200);
        const targetAdminCookie = targetAdminSession.headers.get("set-cookie") || "";

        const otherAdminResponse = await fetch(
          `${BASE_URL}/api/admin/users/${targetUserId}/temporary-password`,
          {
            method: "POST",
            headers: { Cookie: adminCookie, "Content-Type": "application/json" },
            body: JSON.stringify({ temporaryPassword: "MustNotBeUsed-123!" }),
          },
        );
        expect(otherAdminResponse.status).toBe(400);

        const targetAdminStillAuthorized = await fetch(`${BASE_URL}/api/user/me`, {
          headers: { Cookie: targetAdminCookie },
        });
        expect(targetAdminStillAuthorized.status).toBe(200);
        const targetAdminLoginAfter = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: targetUserEmail, password: targetUserPassword }),
        });
        expect(targetAdminLoginAfter.status).toBe(200);
      } finally {
        execSqliteInDocker(`UPDATE user SET isAdmin = 0 WHERE id = '${targetUserId}'`);
      }

      const selfResponse = await fetch(
        `${BASE_URL}/api/admin/users/${adminUserId}/temporary-password`,
        {
          method: "POST",
          headers: { Cookie: adminCookie, "Content-Type": "application/json" },
          body: JSON.stringify({ temporaryPassword: "MustNotBeUsed-123!" }),
        },
      );
      expect(selfResponse.status).toBe(400);

      const targetLogin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetUserEmail, password: targetUserPassword }),
      });
      const nonAdminResponse = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/temporary-password`,
        {
          method: "POST",
          headers: {
            Cookie: targetLogin.headers.get("set-cookie") || "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ temporaryPassword: "MustNotBeUsed-123!" }),
        },
      );
      expect(nonAdminResponse.status).toBe(403);
    });
  });
});
