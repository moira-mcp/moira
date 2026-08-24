/**
 * SaaS authentication invariants against an explicitly SaaS-mode container.
 * This suite must fail instead of skipping when pointed at self-host.
 */

import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { getAdminCredentials, getTestBaseUrl } from "../../utils/test-config.js";
import { execSqliteInDocker, waitForDockerLog } from "../../utils/docker-command.js";

const BASE_URL = getTestBaseUrl();
const OAUTH_REDIRECT_URI = "http://localhost:3333/oauth/callback";
const createdUserIds = new Set<string>();
const createdVerificationCodes = new Set<string>();

function cookieFrom(response: Response): string {
  return (response.headers.get("set-cookie") || "").split(";")[0];
}

async function signInAdmin(): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(getAdminCredentials()),
  });
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

describe("SaaS authentication invariants", () => {
  beforeAll(async () => {
    const response = await fetch(`${BASE_URL}/api/features`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        deploymentMode: "saas",
        features: {
          openRegistration: true,
          accountApproval: false,
          legalConsents: true,
          emailVerificationGate: true,
          verificationEmailOnSignup: true,
        },
        emailDelivery: { state: "real", available: true },
      },
    });
  });

  afterEach(async () => {
    if (createdVerificationCodes.size > 0) {
      const identifiers = [...createdVerificationCodes].map((code) => `'${code}'`).join(", ");
      execSqliteInDocker(`DELETE FROM verification WHERE identifier IN (${identifiers})`);
      createdVerificationCodes.clear();
    }
    if (createdUserIds.size === 0) return;
    const adminCookie = await signInAdmin();
    for (const userId of createdUserIds) {
      const response = await fetch(`${BASE_URL}/api/admin/users/${userId}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      expect([200, 404]).toContain(response.status);
    }
    createdUserIds.clear();
  });

  test("should preserve consent, verification-email, and email-gate behavior", async () => {
    const withoutConsent = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `saas-no-consent-${Date.now()}@example.com`,
        password: "testpassword123",
        name: "SaaS No Consent",
      }),
    });
    expect(withoutConsent.status).toBe(400);
    expect(await withoutConsent.json()).toMatchObject({ code: "TERMS_NOT_ACCEPTED" });

    const email = `saas-invariants-${Date.now()}@example.com`;
    const withConsent = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "testpassword123",
        name: "SaaS Invariants",
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      }),
    });
    expect(withConsent.status).toBe(200);
    const userCookie = cookieFrom(withConsent);
    const verificationEmailLog = await waitForDockerLog(
      `grep -m 1 -E 'TEST MODE: Email logged \\(not sent\\).*Verify your email - MCP Moira.*${email}'`,
    );
    expect(verificationEmailLog).toContain(email);
    expect(verificationEmailLog).toContain("TEST MODE: Email logged (not sent)");

    const status = await fetch(`${BASE_URL}/api/user/me`, { headers: { Cookie: userCookie } });
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as {
      data: { id: string; emailVerified: boolean; accountApprovalRequired: boolean };
    };
    createdUserIds.add(statusBody.data.id);
    expect(statusBody.data).toMatchObject({
      emailVerified: false,
      accountApprovalRequired: false,
    });

    const firstResend = await fetch(`${BASE_URL}/api/user/resend-verification`, {
      method: "POST",
      headers: { Cookie: userCookie },
    });
    expect(firstResend.status).toBe(200);
    expect(await firstResend.json()).toMatchObject({
      success: true,
      cooldownSeconds: expect.any(Number),
    });
    const secondResend = await fetch(`${BASE_URL}/api/user/resend-verification`, {
      method: "POST",
      headers: { Cookie: userCookie },
    });
    expect(secondResend.status).toBe(429);
    expect(await secondResend.json()).toMatchObject({
      error: { details: { cooldownSeconds: expect.any(Number) } },
    });

    const emailAdminCookie = await signInAdmin();
    try {
      for (const endpoint of ["send-verification", "send-reset"] as const) {
        const subject =
          endpoint === "send-verification"
            ? "Verify your email - MCP Moira"
            : "Reset your password - MCP Moira";
        const deliveryEmail = `admin-${endpoint}-${Date.now()}@example.com`;
        execSqliteInDocker(
          `UPDATE user SET email = '${deliveryEmail}' WHERE id = '${statusBody.data.id}'`,
        );
        const delivery = await fetch(
          `${BASE_URL}/api/admin/users/${statusBody.data.id}/${endpoint}`,
          { method: "POST", headers: { Cookie: emailAdminCookie } },
        );
        expect(delivery.status).toBe(200);
        expect(await delivery.json()).toMatchObject({
          data: {
            emailSent: false,
            delivery: { state: "test", provider: "test", available: false },
          },
        });
        expect(
          await waitForDockerLog(
            `grep -m 1 -E 'TEST MODE: Email logged \\(not sent\\).*${subject}.*${deliveryEmail}'`,
          ),
        ).toContain(deliveryEmail);
      }
    } finally {
      execSqliteInDocker(`UPDATE user SET email = '${email}' WHERE id = '${statusBody.data.id}'`);
    }

    const updateProfile = await fetch(`${BASE_URL}/api/auth/update-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie, Origin: BASE_URL },
      body: JSON.stringify({ name: "SaaS Approval Invariant" }),
    });
    expect(updateProfile.status).toBe(200);

    const token = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ name: "saas-unverified-must-not-create" }),
    });
    expect(token.status).toBe(403);
    expect(await token.json()).toMatchObject({ error: { code: "EMAIL_NOT_VERIFIED" } });

    const registerClient = await fetch(`${BASE_URL}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: `saas-invariants-${Date.now()}`,
        redirect_uris: [OAUTH_REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
      }),
    });
    expect(registerClient.status).toBe(201);
    const client = (await registerClient.json()) as {
      client_id: string;
      client_secret: string;
    };

    const seedAuthorizationCode = () => {
      const code = randomUUID();
      createdVerificationCodes.add(code);
      const codeVerifier = randomUUID();
      const verificationValue = JSON.stringify({
        clientId: client.client_id,
        redirectURI: OAUTH_REDIRECT_URI,
        userId: statusBody.data.id,
        scope: ["openid", "email", "profile"],
        codeChallenge: codeVerifier,
        codeChallengeMethod: "plain",
      }).replace(/'/g, "''");
      const now = new Date().toISOString();
      execSqliteInDocker(
        `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES ('${randomUUID()}', '${code}', '${verificationValue}', '${new Date(Date.now() + 300_000).toISOString()}', '${now}', '${now}')`,
      );
      return { code, codeVerifier };
    };
    const seedOAuthToken = () => {
      const accessToken = randomUUID();
      const refreshToken = randomUUID();
      const now = new Date().toISOString();
      execSqliteInDocker(
        `INSERT INTO oauthAccessToken (id, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, clientId, userId, scopes, createdAt, updatedAt) VALUES ('${randomUUID()}', '${accessToken}', '${refreshToken}', '${new Date(Date.now() + 300_000).toISOString()}', '${new Date(Date.now() + 600_000).toISOString()}', '${client.client_id}', '${statusBody.data.id}', 'openid email profile offline_access', '${now}', '${now}')`,
      );
      return { accessToken, refreshToken };
    };
    const exchangeCode = ({ code, codeVerifier }: { code: string; codeVerifier: string }) =>
      fetch(`${BASE_URL}/api/auth/mcp/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          client_secret: client.client_secret,
          redirect_uri: OAUTH_REDIRECT_URI,
          code_verifier: codeVerifier,
        }),
      });
    const exchangeRefresh = (refreshToken: string) =>
      fetch(`${BASE_URL}/api/auth/mcp/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: client.client_id,
          client_secret: client.client_secret,
        }),
      });
    const callMcp = (accessToken: string) =>
      fetch(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
    const getMcpSession = (accessToken: string) =>
      fetch(`${BASE_URL}/api/auth/mcp/get-session`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

    const unverifiedCode = await exchangeCode(seedAuthorizationCode());
    expect(unverifiedCode.status).toBe(403);
    expect(await unverifiedCode.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    const unverifiedOAuthToken = seedOAuthToken();
    const unverifiedRefresh = await exchangeRefresh(unverifiedOAuthToken.refreshToken);
    expect(unverifiedRefresh.status).toBe(403);
    expect(await unverifiedRefresh.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    const unverifiedMcp = await callMcp(unverifiedOAuthToken.accessToken);
    expect(unverifiedMcp.status).toBe(403);
    expect(await unverifiedMcp.json()).toMatchObject({ error_code: "EMAIL_NOT_VERIFIED" });
    const unverifiedSession = await getMcpSession(unverifiedOAuthToken.accessToken);
    expect(unverifiedSession.status).toBe(403);
    expect(await unverifiedSession.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });

    const adminCookie = await signInAdmin();
    const block = await fetch(`${BASE_URL}/api/admin/users/${statusBody.data.id}/block`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ reason: "saas-oauth-block-precedence" }),
    });
    expect(block.status).toBe(200);

    const blockedCode = await exchangeCode(seedAuthorizationCode());
    expect(blockedCode.status).toBe(403);
    expect(await blockedCode.json()).toMatchObject({ code: "ACCOUNT_BLOCKED" });
    const blockedOAuthToken = seedOAuthToken();
    const blockedRefresh = await exchangeRefresh(blockedOAuthToken.refreshToken);
    expect(blockedRefresh.status).toBe(403);
    expect(await blockedRefresh.json()).toMatchObject({ code: "ACCOUNT_BLOCKED" });
    const blockedMcp = await callMcp(blockedOAuthToken.accessToken);
    expect(blockedMcp.status).toBe(403);
    expect(await blockedMcp.json()).toMatchObject({ error_code: "ACCOUNT_BLOCKED" });
    const blockedSession = await getMcpSession(blockedOAuthToken.accessToken);
    expect(blockedSession.status).toBe(403);
    expect(await blockedSession.json()).toMatchObject({ code: "ACCOUNT_BLOCKED" });

    const unblock = await fetch(`${BASE_URL}/api/admin/users/${statusBody.data.id}/unblock`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(unblock.status).toBe(200);
    const verifyEmail = await fetch(
      `${BASE_URL}/api/admin/users/${statusBody.data.id}/verify-email`,
      { method: "POST", headers: { Cookie: adminCookie } },
    );
    expect(verifyEmail.status).toBe(200);

    const verifiedCode = await exchangeCode(seedAuthorizationCode());
    expect(verifiedCode.status).toBe(200);
    const verifiedCodeBody = (await verifiedCode.json()) as { access_token?: string };
    expect(verifiedCodeBody.access_token).toEqual(expect.any(String));
    const verifiedMcp = await callMcp(verifiedCodeBody.access_token!);
    expect(verifiedMcp.status).toBe(200);
    const verifiedSession = await getMcpSession(verifiedCodeBody.access_token!);
    expect(verifiedSession.status).toBe(200);
    expect(await verifiedSession.json()).toMatchObject({
      userId: statusBody.data.id,
      accessToken: verifiedCodeBody.access_token,
    });

    const verifiedRefresh = await exchangeRefresh(seedOAuthToken().refreshToken);
    expect(verifiedRefresh.status).toBe(200);
    expect(await verifiedRefresh.json()).toMatchObject({ access_token: expect.any(String) });
  });
});
