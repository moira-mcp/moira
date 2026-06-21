/**
 * Admin Token API Tests
 * Tests admin list (with filtering/search/pagination) and admin revoke operations
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

const TEST_USER_A = {
  email: `admin-tokens-a-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Token User A",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

const TEST_USER_B = {
  email: `admin-tokens-b-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Token User B",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let adminCookie: string;
let userACookie: string;
let userBCookie: string;
let userAId: string;
let userBId: string;
let tokenIdA1: string; // user A active token
let tokenIdA2: string; // user A token to be revoked
let tokenIdB1: string; // user B token

async function createAndVerifyUser(
  userData: typeof TEST_USER_A,
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

  await fetch(`${BASE_URL}/api/admin/users/${signUpData.user.id}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
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

async function createToken(cookie: string, name: string, expiresIn?: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name, expiresIn }),
  });
  const json = (await res.json()) as any;
  return json.data.id;
}

beforeAll(async () => {
  // Login as admin first (needed for user verification)
  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  adminCookie = adminLoginRes.headers.get("set-cookie") || "";

  // Create test users
  const userA = await createAndVerifyUser(TEST_USER_A);
  userACookie = userA.cookie;
  userAId = userA.userId;

  const userB = await createAndVerifyUser(TEST_USER_B);
  userBCookie = userB.cookie;
  userBId = userB.userId;

  // Create tokens for test data
  tokenIdA1 = await createToken(userACookie, "User A Active Token");
  tokenIdA2 = await createToken(userACookie, "User A Revokable Token");
  tokenIdB1 = await createToken(userBCookie, "User B Token");
});

describe("GET /api/admin/tokens - List all tokens", () => {
  test("returns tokens with user info", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens`, {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.tokens)).toBe(true);
    expect(json.data.total).toBeGreaterThanOrEqual(3);
    expect(json.data.limit).toBeDefined();
    expect(json.data.offset).toBeDefined();

    // Tokens should include user info
    const token = json.data.tokens.find((t: any) => t.id === tokenIdA1);
    expect(token).toBeDefined();
    expect(token.userEmail).toBe(TEST_USER_A.email);
    expect(token.userName).toBe(TEST_USER_A.name);
    expect(token.userId).toBe(userAId);
    // Should have enriched fields
    expect(token.isExpired).toBe(false);
    expect(token.isRevoked).toBe(false);
  });

  test("filters by userId", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens?userId=${userAId}`, {
      headers: { Cookie: adminCookie },
    });

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    // All tokens should belong to user A
    for (const token of json.data.tokens) {
      expect(token.userId).toBe(userAId);
    }
    expect(json.data.tokens.length).toBeGreaterThanOrEqual(2);
  });

  test("filters by status=active", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens?status=active`, {
      headers: { Cookie: adminCookie },
    });

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    for (const token of json.data.tokens) {
      expect(token.isRevoked).toBe(false);
      expect(token.isExpired).toBe(false);
    }
  });

  test("searches by token name", async () => {
    const res = await fetch(
      `${BASE_URL}/api/admin/tokens?search=${encodeURIComponent("User A Active")}`,
      { headers: { Cookie: adminCookie } },
    );

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.tokens.length).toBeGreaterThanOrEqual(1);
    const found = json.data.tokens.find((t: any) => t.id === tokenIdA1);
    expect(found).toBeDefined();
  });

  test("searches by user email", async () => {
    const res = await fetch(
      `${BASE_URL}/api/admin/tokens?search=${encodeURIComponent(TEST_USER_B.email)}`,
      { headers: { Cookie: adminCookie } },
    );

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.tokens.length).toBeGreaterThanOrEqual(1);
    for (const token of json.data.tokens) {
      expect(token.userEmail).toBe(TEST_USER_B.email);
    }
  });

  test("paginates with limit and offset", async () => {
    const res1 = await fetch(
      `${BASE_URL}/api/admin/tokens?limit=1&offset=0&sort=createdAt&sortOrder=asc`,
      {
        headers: { Cookie: adminCookie },
      },
    );
    const json1 = (await res1.json()) as any;
    expect(json1.data.tokens.length).toBe(1);
    expect(json1.data.limit).toBe(1);
    expect(json1.data.offset).toBe(0);

    const res2 = await fetch(
      `${BASE_URL}/api/admin/tokens?limit=1&offset=1&sort=createdAt&sortOrder=asc`,
      {
        headers: { Cookie: adminCookie },
      },
    );
    const json2 = (await res2.json()) as any;
    expect(json2.data.tokens.length).toBe(1);
    expect(json2.data.offset).toBe(1);

    // Different tokens on different pages
    expect(json1.data.tokens[0].id).not.toBe(json2.data.tokens[0].id);
  });

  test("sorts by name ascending", async () => {
    const res = await fetch(
      `${BASE_URL}/api/admin/tokens?sort=name&sortOrder=asc&userId=${userAId}`,
      {
        headers: { Cookie: adminCookie },
      },
    );

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    const names = json.data.tokens.map((t: any) => t.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  test("rejects invalid status", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens?status=invalid`, {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(400);
  });

  test("rejects invalid sort field", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens?sort=invalid`, {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(400);
  });

  test("requires admin access", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens`, {
      headers: { Cookie: userACookie },
    });

    // Non-admin should get 403
    expect(res.status).toBe(403);
  });

  test("requires authentication", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens`);

    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/admin/tokens/:id - Admin revoke", () => {
  test("admin revokes any user token", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens/${tokenIdA2}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.id).toBe(tokenIdA2);
    expect(json.data.revoked).toBe(true);
    expect(json.data.revokedAt).toBeDefined();
  });

  test("revoke is idempotent", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens/${tokenIdA2}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.revoked).toBe(true);
  });

  test("revoked token shows in list with revoked status", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens?status=revoked&userId=${userAId}`, {
      headers: { Cookie: adminCookie },
    });

    const json = (await res.json()) as any;
    const revoked = json.data.tokens.find((t: any) => t.id === tokenIdA2);
    expect(revoked).toBeDefined();
    expect(revoked.isRevoked).toBe(true);
  });

  test("returns 404 for non-existent token", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens/nonexistent-id`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(404);
  });

  test("requires admin access", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens/${tokenIdB1}`, {
      method: "DELETE",
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(403);
  });

  test("requires authentication", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/tokens/${tokenIdB1}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(401);
  });
});
