/**
 * User Token API Tests
 * Tests create, list, and revoke operations for persistent API tokens
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

const TEST_USER = {
  email: `tokens-api-test-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Token Test User",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

const TEST_USER_2 = {
  email: `tokens-api-test2-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Token Test User 2",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let authCookie: string;
let authCookie2: string;
let testUserId: string;

async function createAndVerifyUser(
  userData: typeof TEST_USER,
): Promise<{ userId: string; cookie: string }> {
  const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(userData),
  });
  const signUpData = (await signUpRes.json()) as any;
  if (!signUpData?.user) {
    throw new Error(`Failed to create user: ${JSON.stringify(signUpData)}`);
  }

  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  const adminCookies = adminLoginRes.headers.get("set-cookie");

  await fetch(`${BASE_URL}/api/admin/users/${signUpData.user.id}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookies || "" },
  });

  const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: userData.email, password: userData.password }),
  });

  return {
    userId: signUpData.user.id,
    cookie: loginRes.headers.get("set-cookie") || "",
  };
}

beforeAll(async () => {
  const user1 = await createAndVerifyUser(TEST_USER);
  authCookie = user1.cookie;
  testUserId = user1.userId;

  const user2 = await createAndVerifyUser(TEST_USER_2);
  authCookie2 = user2.cookie;
});

describe("POST /api/tokens - Create token", () => {
  test("creates token and returns plaintext once", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ name: "Test Token" }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);

    const data = json.data;
    expect(data.id).toBeDefined();
    expect(data.name).toBe("Test Token");
    expect(data.token).toMatch(/^moira_[0-9a-f]{40}$/);
    expect(data.tokenPrefix).toBe(data.token.slice(0, 12));
    expect(data.expiresAt).toBeDefined(); // default 90d
    expect(data.createdAt).toBeDefined();
    expect(data.scopes).toBeNull();
  });

  test("creates token with custom expiration", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ name: "30d Token", expiresIn: "30d" }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    const expiresAt = new Date(json.data.expiresAt);
    const now = Date.now();
    // Should expire roughly 30 days from now (within 1 minute tolerance)
    const diffDays = (expiresAt.getTime() - now) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29);
    expect(diffDays).toBeLessThan(31);
  });

  test("creates token with never expiration", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ name: "Never Expires", expiresIn: "never" }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.data.expiresAt).toBeNull();
  });

  test("rejects missing name", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("rejects empty name", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ name: "   " }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects name over 100 characters", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ name: "x".repeat(101) }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects invalid expiresIn value", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ name: "Bad Exp", expiresIn: "7d" }),
    });

    expect(res.status).toBe(400);
  });

  test("requires authentication", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No Auth" }),
    });

    expect(res.status).toBe(401);
  });

  test("requires verified email", async () => {
    // Create unverified user
    const unverifiedEmail = `unverified-token-${Date.now()}@example.com`;
    await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: unverifiedEmail,
        password: "TestPass123!",
        name: "Unverified",
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      }),
    });

    const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: unverifiedEmail, password: "TestPass123!" }),
    });
    const unverifiedCookie = loginRes.headers.get("set-cookie") || "";

    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: unverifiedCookie },
      body: JSON.stringify({ name: "Unverified Token" }),
    });

    // Should be rejected (401 or 403)
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThanOrEqual(403);
  });
});

describe("GET /api/tokens - List tokens", () => {
  test("lists tokens without secrets", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.tokens)).toBe(true);
    expect(json.data.total).toBeGreaterThan(0);

    // Verify no secrets are exposed
    for (const token of json.data.tokens) {
      expect(token.id).toBeDefined();
      expect(token.name).toBeDefined();
      expect(token.tokenPrefix).toBeDefined();
      expect(token.tokenPrefix).toMatch(/^moira_/);
      expect(token.createdAt).toBeDefined();
      // Must NOT have full token or hash
      expect(token.token).toBeUndefined();
      expect(token.tokenHash).toBeUndefined();
      // Computed fields
      expect(typeof token.isExpired).toBe("boolean");
      expect(typeof token.isRevoked).toBe("boolean");
    }
  });

  test("only returns tokens for authenticated user", async () => {
    // User 2 should not see User 1's tokens
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      headers: { Cookie: authCookie2 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    // User 2 hasn't created any tokens
    expect(json.data.total).toBe(0);
  });

  test("requires authentication", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens`);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/tokens/:id - Revoke token", () => {
  let tokenToRevoke: string;

  beforeAll(async () => {
    // Create a token to revoke
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ name: "Token to Revoke" }),
    });
    const json = (await res.json()) as any;
    tokenToRevoke = json.data.id;
  });

  test("revokes token", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens/${tokenToRevoke}`, {
      method: "DELETE",
      headers: { Cookie: authCookie },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.id).toBe(tokenToRevoke);
    expect(json.data.revoked).toBe(true);
    expect(json.data.revokedAt).toBeDefined();
  });

  test("revoke is idempotent", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens/${tokenToRevoke}`, {
      method: "DELETE",
      headers: { Cookie: authCookie },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.revoked).toBe(true);
  });

  test("revoked token shows in list as revoked", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      headers: { Cookie: authCookie },
    });

    const json = (await res.json()) as any;
    const revoked = json.data.tokens.find((t: any) => t.id === tokenToRevoke);
    expect(revoked).toBeDefined();
    expect(revoked.isRevoked).toBe(true);
    expect(revoked.revokedAt).toBeDefined();
  });

  test("cannot revoke another user's token", async () => {
    // Create token as user 1
    const createRes = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ name: "User 1 Only" }),
    });
    const createJson = (await createRes.json()) as any;

    // Try to revoke as user 2
    const revokeRes = await fetch(`${BASE_URL}/api/tokens/${createJson.data.id}`, {
      method: "DELETE",
      headers: { Cookie: authCookie2 },
    });

    expect(revokeRes.status).toBe(404);
  });

  test("returns 404 for non-existent token", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens/non-existent-id`, {
      method: "DELETE",
      headers: { Cookie: authCookie },
    });

    expect(res.status).toBe(404);
  });

  test("requires authentication", async () => {
    const res = await fetch(`${BASE_URL}/api/tokens/${tokenToRevoke}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(401);
  });
});

describe("Token limit enforcement", () => {
  test("enforces 25 active token limit", async () => {
    // Create a fresh user to test limit
    const limitUser = {
      email: `token-limit-test-${Date.now()}@example.com`,
      password: "TestPass123!",
      name: "Limit Test",
      acceptedTermsAt: new Date().toISOString(),
      acceptedNotRussianResidentAt: new Date().toISOString(),
    };
    const { cookie } = await createAndVerifyUser(limitUser);

    // Create 25 tokens
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${BASE_URL}/api/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: `Limit Token ${i + 1}` }),
      });
      expect(res.status).toBe(201);
    }

    // 26th should fail
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Over Limit" }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error?.message || "").toContain("limit");
  });

  test("revoking a token frees up limit slot", async () => {
    const limitUser2 = {
      email: `token-limit-test2-${Date.now()}@example.com`,
      password: "TestPass123!",
      name: "Limit Test 2",
      acceptedTermsAt: new Date().toISOString(),
      acceptedNotRussianResidentAt: new Date().toISOString(),
    };
    const { cookie } = await createAndVerifyUser(limitUser2);

    // Create 25 tokens, keep track of first ID
    let firstTokenId: string = "";
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${BASE_URL}/api/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: `Token ${i + 1}` }),
      });
      const json = (await res.json()) as any;
      if (i === 0) firstTokenId = json.data.id;
    }

    // Revoke first token
    await fetch(`${BASE_URL}/api/tokens/${firstTokenId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    // Now should be able to create one more
    const res = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "After Revoke" }),
    });

    expect(res.status).toBe(201);
  });
});
