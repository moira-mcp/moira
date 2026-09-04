/**
 * Self-host authentication contracts against the real container.
 *
 * Self-host proves the complete headless lifecycle: public registration creates
 * a pending account; only status and sign-out are available; product, persistent
 * token, and OAuth-token access are denied; one concurrent admin transition
 * unlocks the account and creates exactly one audit event.
 */

import { describe, test, expect, beforeAll, afterEach } from "@jest/globals";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getTestBaseUrl, getAdminCredentials } from "../../utils/test-config.js";
import { execSqliteInDocker } from "../../utils/docker-command.js";

const BASE_URL = getTestBaseUrl();
const OAUTH_REDIRECT_URI = "http://localhost:3333/oauth/callback";

function cookieFrom(response: Response): string {
  return (response.headers.get("set-cookie") || "").split(";")[0];
}

async function signInAdmin(): Promise<string> {
  const { email, password } = getAdminCredentials();
  const response = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

async function expectAuditActor(
  adminCookie: string,
  action: string,
  resourceId: string,
  expectedUserId: string,
): Promise<void> {
  const response = await fetch(
    `${BASE_URL}/api/admin/audit-log?action=${encodeURIComponent(action)}&resourceId=${resourceId}`,
    { headers: { Cookie: adminCookie } },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { entries: Array<{ userId: string | null; resourceId: string }> };
  };
  expect(body.data.entries).toEqual(
    expect.arrayContaining([expect.objectContaining({ userId: expectedUserId, resourceId })]),
  );
}

function countVerificationRowsFor(...targets: string[]): string {
  const clauses = targets.flatMap((target) => {
    const escaped = target.replace(/'/g, "''");
    return [`instr(identifier, '${escaped}') > 0`, `instr(value, '${escaped}') > 0`];
  });
  return execSqliteInDocker(`SELECT COUNT(*) FROM verification WHERE ${clauses.join(" OR ")}`);
}

function countEmailLogsFor(userId: string): string {
  const escaped = userId.replace(/'/g, "''");
  return execSqliteInDocker(`SELECT COUNT(*) FROM emailLog WHERE userId = '${escaped}'`);
}

describe("deployment-mode auth behavior", () => {
  const createdUserIds = new Set<string>();
  const createdTokenIds = new Set<string>();

  beforeAll(async () => {
    const response = await fetch(`${BASE_URL}/api/features`);
    expect(response.status).toBe(200);
    expect(
      (await response.json()) as {
        data: { deploymentMode: string; emailDelivery: { state: string; available: boolean } };
      },
    ).toMatchObject({
      data: {
        deploymentMode: "self-host",
        emailDelivery: { state: "unavailable", available: false },
      },
    });
  });

  afterEach(async () => {
    if (createdUserIds.size === 0 && createdTokenIds.size === 0) return;

    const adminCookie = await signInAdmin();
    for (const tokenId of createdTokenIds) {
      const response = await fetch(`${BASE_URL}/api/tokens/${tokenId}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      expect([200, 404]).toContain(response.status);
    }
    for (const userId of createdUserIds) {
      const response = await fetch(`${BASE_URL}/api/admin/users/${userId}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      expect([200, 404]).toContain(response.status);
    }
    createdTokenIds.clear();
    createdUserIds.clear();
  });

  test("should enforce the pending-to-approved self-host admission contract", async () => {
    const email = `approval-flow-${Date.now()}@example.com`;
    const signup = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "testpassword123", name: "Approval Flow" }),
    });

    expect(signup.status).toBe(200);
    const userCookie = cookieFrom(signup);
    expect(userCookie).toBeTruthy();

    const statusBefore = await fetch(`${BASE_URL}/api/user/me`, {
      headers: { Cookie: userCookie },
    });
    expect(statusBefore.status).toBe(200);
    const statusBody = (await statusBefore.json()) as {
      data: {
        id: string;
        emailVerified: boolean;
        approvedAt: string | null;
        accountApproved: boolean;
        accountApprovalRequired: boolean;
      };
    };
    expect(statusBody.data).toMatchObject({
      emailVerified: false,
      approvedAt: null,
      accountApproved: false,
      accountApprovalRequired: true,
    });
    const userId = statusBody.data.id;
    createdUserIds.add(userId);

    const sessionBefore = await fetch(`${BASE_URL}/api/auth/get-session`, {
      headers: { Cookie: userCookie },
    });
    expect(sessionBefore.status).toBe(200);

    const pendingAuthCapabilities = [
      {
        path: "/api/auth/update-user",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userCookie, Origin: BASE_URL },
          body: JSON.stringify({ name: "Pending Mutation Must Fail" }),
        },
      },
      {
        path: "/api/auth/list-sessions",
        init: { headers: { Cookie: userCookie } },
      },
    ];
    for (const request of pendingAuthCapabilities) {
      const response = await fetch(`${BASE_URL}${request.path}`, request.init);
      expect(response.status).toBe(403);
      expect((await response.json()) as { code?: string }).toMatchObject({
        code: "ACCOUNT_APPROVAL_REQUIRED",
      });
    }

    const productBefore = await fetch(`${BASE_URL}/api/workflows`, {
      headers: { Cookie: userCookie },
    });
    expect(productBefore.status).toBe(403);
    expect((await productBefore.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: "ACCOUNT_APPROVAL_REQUIRED" },
    });

    const adminBefore = await fetch(`${BASE_URL}/api/admin/users/${userId}/approve`, {
      method: "POST",
      headers: { Cookie: userCookie },
    });
    expect(adminBefore.status).toBe(403);
    expect((await adminBefore.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: "ACCOUNT_APPROVAL_REQUIRED" },
    });

    const persistentTokenBefore = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie, Origin: BASE_URL },
      body: JSON.stringify({ name: "pending-must-not-create" }),
    });
    expect(persistentTokenBefore.status).toBe(403);
    expect((await persistentTokenBefore.json()) as { error?: { code?: string } }).toMatchObject({
      error: { code: "ACCOUNT_APPROVAL_REQUIRED" },
    });

    // Seed a pre-existing token to prove the MCP request boundary itself denies
    // pending identities, independently from the token-creation API gate.
    const pendingMcpToken = `moira_${randomBytes(20).toString("hex")}`;
    const tokenHash = createHash("sha256").update(pendingMcpToken).digest("hex");
    execSqliteInDocker(
      `INSERT INTO apiToken (id, name, tokenPrefix, tokenHash, userId, createdAt) VALUES ('${randomUUID()}', 'pending-mcp-proof', '${pendingMcpToken.slice(0, 12)}', '${tokenHash}', '${userId}', '${new Date().toISOString()}')`,
    );
    const mcpBefore = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pendingMcpToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "pending-admission-test", version: "1.0.0" },
        },
      }),
    });
    expect(mcpBefore.status).toBe(403);
    expect((await mcpBefore.json()) as { error_code?: string }).toMatchObject({
      error_code: "ACCOUNT_APPROVAL_REQUIRED",
    });

    const registerClient = await fetch(`${BASE_URL}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: `approval-flow-${Date.now()}`,
        redirect_uris: [OAUTH_REDIRECT_URI],
        grant_types: ["authorization_code"],
      }),
    });
    expect(registerClient.status).toBe(201);
    const client = (await registerClient.json()) as {
      client_id: string;
      client_secret: string;
    };

    // A refresh token minted before an account became pending must be denied
    // independently from the authorization-code lookup below.
    const pendingAccessToken = randomUUID();
    const pendingRefreshToken = randomUUID();
    const oauthCreatedAt = new Date().toISOString();
    execSqliteInDocker(
      `INSERT INTO oauthAccessToken (id, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, clientId, userId, scopes, createdAt, updatedAt) VALUES ('${randomUUID()}', '${pendingAccessToken}', '${pendingRefreshToken}', '${new Date(Date.now() + 300_000).toISOString()}', '${new Date(Date.now() + 600_000).toISOString()}', '${client.client_id}', '${userId}', 'openid email profile', '${oauthCreatedAt}', '${oauthCreatedAt}')`,
    );
    const pendingOAuthMcp = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${pendingAccessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 2,
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "pending-oauth-admission-test", version: "1.0.0" },
        },
      }),
    });
    expect(pendingOAuthMcp.status).toBe(403);
    expect(await pendingOAuthMcp.json()).toMatchObject({
      error_code: "ACCOUNT_APPROVAL_REQUIRED",
    });
    const introspectionBefore = await fetch(`${BASE_URL}/api/auth/mcp/get-session`, {
      headers: { Authorization: `Bearer ${pendingAccessToken}` },
    });
    expect(introspectionBefore.status).toBe(403);
    expect(await introspectionBefore.json()).toMatchObject({
      code: "ACCOUNT_APPROVAL_REQUIRED",
    });
    const refreshBefore = await fetch(`${BASE_URL}/api/auth/mcp/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: pendingRefreshToken,
        client_id: client.client_id,
        client_secret: client.client_secret,
      }),
    });
    expect(refreshBefore.status).toBe(403);
    expect(await refreshBefore.json()).toMatchObject({
      code: "ACCOUNT_APPROVAL_REQUIRED",
    });

    const authorizeUrl = new URL(`${BASE_URL}/api/auth/mcp/authorize`);
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", "approval-flow");
    authorizeUrl.searchParams.set("scope", "openid email profile");
    const authorize = await fetch(authorizeUrl, {
      headers: { Cookie: userCookie },
      redirect: "manual",
    });
    expect(authorize.status).toBe(403);
    expect((await authorize.json()) as { code?: string }).toMatchObject({
      code: "ACCOUNT_APPROVAL_REQUIRED",
    });

    // A code minted by an older deployment must still be rejected at token
    // exchange. The hook rejects before plugin consumption, so this same code
    // proves successful issuance after the account is approved.
    const code = randomUUID();
    const codeVerifier = randomUUID();
    const verificationValue = JSON.stringify({
      clientId: client.client_id,
      redirectURI: OAUTH_REDIRECT_URI,
      userId,
      scope: ["openid", "email", "profile"],
      codeChallenge: codeVerifier,
      codeChallengeMethod: "plain",
    }).replace(/'/g, "''");
    execSqliteInDocker(
      `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES ('${randomUUID()}', '${code}', '${verificationValue}', '${new Date(Date.now() + 300_000).toISOString()}', '${new Date().toISOString()}', '${new Date().toISOString()}')`,
    );

    const exchange = () =>
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
    const oauthBefore = await exchange();
    expect(oauthBefore.status).toBe(403);
    expect((await oauthBefore.json()) as { code?: string }).toMatchObject({
      code: "ACCOUNT_APPROVAL_REQUIRED",
    });

    const adminCookie = await signInAdmin();
    const adminStatus = await fetch(`${BASE_URL}/api/user/me`, {
      headers: { Cookie: adminCookie },
    });
    expect(adminStatus.status).toBe(200);
    const adminId = ((await adminStatus.json()) as { data: { id: string } }).data.id;
    const selfBlock = await fetch(`${BASE_URL}/api/admin/users/${adminId}/block`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ reason: "self-block-must-fail" }),
    });
    expect(selfBlock.status).toBe(400);

    const pendingList = await fetch(
      `${BASE_URL}/api/admin/users?search=${encodeURIComponent(email)}`,
      {
        headers: { Cookie: adminCookie },
      },
    );
    expect(pendingList.status).toBe(200);
    expect(
      (await pendingList.json()) as { data: { users: Array<{ id: string; approvedAt: null }> } },
    ).toMatchObject({ data: { users: [{ id: userId, approvedAt: null }] } });

    const missingApproval = await fetch(`${BASE_URL}/api/admin/users/missing-account/approve`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(missingApproval.status).toBe(404);

    const approve = () =>
      fetch(`${BASE_URL}/api/admin/users/${userId}/approve`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
    const [approvalOne, approvalTwo] = await Promise.all([approve(), approve()]);
    expect(approvalOne.status).toBe(200);
    expect(approvalTwo.status).toBe(200);
    const approvalBodies = (await Promise.all([approvalOne.json(), approvalTwo.json()])) as Array<{
      data: { approvedAt: string; alreadyApproved: boolean };
    }>;
    expect(approvalBodies[0].data.approvedAt).toBe(approvalBodies[1].data.approvedAt);
    expect(approvalBodies.map((body) => body.data.alreadyApproved).sort()).toEqual([false, true]);

    const audit = await fetch(
      `${BASE_URL}/api/admin/audit-log?action=admin%3Aapprove_user&resourceId=${userId}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(audit.status).toBe(200);
    const auditBody = (await audit.json()) as {
      data: {
        total: number;
        entries: Array<{ userId: string; resourceId: string; source: string; changes: string }>;
      };
    };
    expect(auditBody).toMatchObject({
      data: { total: 1 },
    });
    expect(auditBody.data.entries).toHaveLength(1);
    expect(auditBody.data.entries[0]).toMatchObject({
      userId: "system-admin",
      resourceId: userId,
      source: "web",
    });
    expect(JSON.parse(auditBody.data.entries[0].changes)).toEqual([
      {
        field: "approvedAt",
        oldValue: null,
        newValue: approvalBodies[0].data.approvedAt,
      },
    ]);

    const statusAfter = await fetch(`${BASE_URL}/api/user/me`, {
      headers: { Cookie: userCookie },
    });
    expect(statusAfter.status).toBe(200);
    const afterBody = (await statusAfter.json()) as {
      data: { approvedAt: string | null; accountApproved: boolean };
    };
    expect(afterBody.data.accountApproved).toBe(true);
    expect(afterBody.data.approvedAt).toBe(approvalBodies[0].data.approvedAt);

    const productAfter = await fetch(`${BASE_URL}/api/workflows`, {
      headers: { Cookie: userCookie },
    });
    expect(productAfter.status).toBe(200);

    const profileVerificationRowsBefore = countVerificationRowsFor(email, userId);
    const profileEmailLogsBefore = countEmailLogsFor(userId);
    const profileResendWithoutDelivery = await fetch(`${BASE_URL}/api/user/resend-verification`, {
      method: "POST",
      headers: { Cookie: userCookie },
    });
    expect(profileResendWithoutDelivery.status).toBe(400);
    expect(await profileResendWithoutDelivery.json()).toMatchObject({
      error: { details: { code: "EMAIL_DELIVERY_UNAVAILABLE" } },
    });
    expect(countVerificationRowsFor(email, userId)).toBe(profileVerificationRowsBefore);
    expect(countEmailLogsFor(userId)).toBe(profileEmailLogsBefore);

    const updateAfter = await fetch(`${BASE_URL}/api/auth/update-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie, Origin: BASE_URL },
      body: JSON.stringify({ name: "Approved Mutation" }),
    });
    expect(updateAfter.status).toBe(200);

    const oauthAfter = await exchange();
    expect(oauthAfter.status).toBe(200);
    expect((await oauthAfter.json()) as { access_token?: string }).toMatchObject({
      access_token: expect.any(String),
    });

    const introspectionAfter = await fetch(`${BASE_URL}/api/auth/mcp/get-session`, {
      headers: { Authorization: `Bearer ${pendingAccessToken}` },
    });
    expect(introspectionAfter.status).toBe(200);
    expect(await introspectionAfter.json()).toMatchObject({
      userId,
      accessToken: pendingAccessToken,
    });

    const tokenAfter = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ name: `approved-${Date.now()}` }),
    });
    expect(tokenAfter.status).toBe(201);

    const nonAdminApproval = await fetch(`${BASE_URL}/api/admin/users/${userId}/approve`, {
      method: "POST",
      headers: { Cookie: userCookie },
    });
    expect(nonAdminApproval.status).toBe(403);

    const block = await fetch(`${BASE_URL}/api/admin/users/${userId}/block`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ reason: "approval-independence-proof" }),
    });
    expect(block.status).toBe(200);

    const approvalWhileBlocked = await approve();
    expect(approvalWhileBlocked.status).toBe(200);
    expect(await approvalWhileBlocked.json()).toMatchObject({
      data: {
        approvedAt: approvalBodies[0].data.approvedAt,
        alreadyApproved: true,
      },
    });

    const blockedDetail = await fetch(`${BASE_URL}/api/admin/users/${userId}`, {
      headers: { Cookie: adminCookie },
    });
    expect(blockedDetail.status).toBe(200);
    expect(await blockedDetail.json()).toMatchObject({
      data: {
        user: {
          approvedAt: approvalBodies[0].data.approvedAt,
          blocked: true,
          blockedBy: adminId,
          emailVerified: false,
        },
      },
    });
    await expectAuditActor(adminCookie, "admin:block_user", userId, adminId);
  });

  test("should expose unavailable email honestly while keeping manual admin actions independent", async () => {
    const email = `pending-logout-${Date.now()}@example.com`;
    const signup = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "testpassword123",
        name: "Pending Logout",
      }),
    });
    expect(signup.status).toBe(200);
    const userCookie = cookieFrom(signup);
    const status = await fetch(`${BASE_URL}/api/user/me`, { headers: { Cookie: userCookie } });
    const userId = ((await status.json()) as { data: { id: string } }).data.id;
    createdUserIds.add(userId);

    const adminCookie = await signInAdmin();
    const unknownResetEmail = `unknown-${Date.now()}@example.com`;
    const verificationRowsBefore = countVerificationRowsFor(email, userId, unknownResetEmail);
    const emailLogsBefore = countEmailLogsFor(userId);
    const sendVerification = await fetch(
      `${BASE_URL}/api/admin/users/${userId}/send-verification`,
      { method: "POST", headers: { Cookie: adminCookie } },
    );
    expect(sendVerification.status).toBe(400);
    expect(await sendVerification.json()).toMatchObject({
      error: {
        details: {
          code: "EMAIL_DELIVERY_UNAVAILABLE",
          delivery: { state: "unavailable", available: false },
        },
      },
    });
    const adminStatus = await fetch(`${BASE_URL}/api/user/me`, {
      headers: { Cookie: adminCookie },
    });
    const adminId = ((await adminStatus.json()) as { data: { id: string } }).data.id;

    const sendReset = await fetch(`${BASE_URL}/api/admin/users/${userId}/send-reset`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(sendReset.status).toBe(400);
    expect(await sendReset.json()).toMatchObject({
      error: { details: { code: "EMAIL_DELIVERY_UNAVAILABLE" } },
    });

    const publicReset = await fetch(`${BASE_URL}/api/auth/request-password-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ email: unknownResetEmail }),
    });
    expect(publicReset.status).toBe(400);
    expect(await publicReset.json()).toMatchObject({ code: "EMAIL_DELIVERY_UNAVAILABLE" });

    const directVerification = await fetch(`${BASE_URL}/api/auth/send-verification-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ email, callbackURL: `${BASE_URL}/app` }),
    });
    expect(directVerification.status).toBe(400);
    expect(await directVerification.json()).toMatchObject({
      code: "EMAIL_DELIVERY_UNAVAILABLE",
    });

    expect(countVerificationRowsFor(email, userId, unknownResetEmail)).toBe(verificationRowsBefore);
    expect(countEmailLogsFor(userId)).toBe(emailLogsBefore);

    const signout = await fetch(`${BASE_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: { Cookie: userCookie, Origin: BASE_URL },
    });
    expect(signout.status).toBe(200);

    // Manual administrator mutations do not depend on an email provider.
    const verifyEmail = await fetch(`${BASE_URL}/api/admin/users/${userId}/verify-email`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(verifyEmail.status).toBe(200);
    await expectAuditActor(adminCookie, "admin:verify_email", userId, adminId);

    const forceReset = await fetch(`${BASE_URL}/api/admin/users/${userId}/force-password-reset`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(forceReset.status).toBe(200);
    expect(await forceReset.json()).toMatchObject({
      data: { requestedBy: adminId },
    });
    await expectAuditActor(adminCookie, "admin:force_password_reset", userId, adminId);

    const detail = await fetch(`${BASE_URL}/api/admin/users/${userId}`, {
      headers: { Cookie: adminCookie },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      data: { user: { approvedAt: null, emailVerified: true } },
    });
  });

  test("should let the approved bootstrap admin issue a token", async () => {
    const adminCookie = await signInAdmin();
    const token = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ name: `bootstrap-admin-${Date.now()}` }),
    });
    expect(token.status).toBe(201);
    const tokenBody = (await token.json()) as { data?: { id?: string; token?: string } };
    expect(tokenBody).toMatchObject({
      data: { token: expect.stringMatching(/^moira_/) },
    });
    if (tokenBody.data?.id) {
      createdTokenIds.add(tokenBody.data.id);
    }
  });
});
