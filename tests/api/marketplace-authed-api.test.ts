/**
 * API tests for the authed + admin marketplace HTTP surface (mounted at
 * `/api/marketplace` behind requireAuth, admin under `/api/marketplace/admin`).
 * Verifies auth gating (401 without a session, 403 for non-admins on admin routes),
 * the response envelope, and domain-error → HTTP status mapping. Data behaviors
 * (publish/install/fork/entitlement/moderation) are covered by the service-level
 * integration tests.
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

const TEST_USER = {
  email: `marketplace-authed-user-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Marketplace Authed User",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let adminCookie = "";
let userCookie = "";

interface Envelope {
  success: boolean;
  data?: unknown;
  timestamp?: string;
}

beforeAll(async () => {
  const adminLogin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  adminCookie = adminLogin.headers.get("set-cookie") || "";

  const signUp = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(TEST_USER),
  });
  const signUpData = (await signUp.json()) as { user?: { id: string } };
  if (!signUpData?.user?.id) {
    throw new Error(`Failed to create test user: ${JSON.stringify(signUpData)}`);
  }
  await fetch(`${BASE_URL}/api/admin/users/${signUpData.user.id}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });
  const login = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_USER.email, password: TEST_USER.password }),
  });
  userCookie = login.headers.get("set-cookie") || "";
});

describe("Marketplace authed API - auth gating", () => {
  test("GET /api/marketplace/me/listings without a session → 401", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/me/listings`);
    expect(res.status).toBe(401);
  });

  test("GET /api/marketplace/me/library without a session → 401", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/me/library`);
    expect(res.status).toBe(401);
  });

  test("POST /api/marketplace/listings without a session → 401", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/listings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId: "whatever" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("Marketplace authed API - authenticated reads", () => {
  test("GET /api/marketplace/me/listings → 200 + envelope", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/me/listings`, {
      headers: { Cookie: userCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope & { data: { listings: unknown[] } };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.listings)).toBe(true);
  });

  test("GET /api/marketplace/me/library → 200 + envelope", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/me/library`, {
      headers: { Cookie: userCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope & { data: { items: unknown[] } };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
  });
});

describe("Marketplace authed API - error mapping", () => {
  test("POST /api/marketplace/listings with an unknown workflowId → 404", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/listings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ workflowId: "does-not-exist", category: "development" }),
    });
    expect(res.status).toBe(404);
  });

  test("DELETE /api/marketplace/listings/:id with an unknown id → 404", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/listings/does-not-exist`, {
      method: "DELETE",
      headers: { Cookie: userCookie },
    });
    expect(res.status).toBe(404);
  });

  test("GET /api/marketplace/listings/:id/entitlement with an unknown id → 404", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/listings/does-not-exist/entitlement`, {
      headers: { Cookie: userCookie },
    });
    expect(res.status).toBe(404);
  });
});

describe("Marketplace admin API - role gating", () => {
  test("GET /api/marketplace/admin/listings without a session → 401", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/admin/listings`);
    expect(res.status).toBe(401);
  });

  test("GET /api/marketplace/admin/listings as a non-admin → 403", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/admin/listings`, {
      headers: { Cookie: userCookie },
    });
    expect(res.status).toBe(403);
  });

  test("GET /api/marketplace/admin/listings as an admin → 200 + envelope", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/admin/listings?status=pending`, {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope & { data: { listings: unknown[] } };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.listings)).toBe(true);
  });

  test("POST /api/marketplace/admin/listings/:id/verify on unknown id as admin → 404", async () => {
    const res = await fetch(`${BASE_URL}/api/marketplace/admin/listings/does-not-exist/verify`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(404);
  });
});
