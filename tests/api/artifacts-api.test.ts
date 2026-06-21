/**
 * Artifacts API Integration Tests
 * Tests artifacts CRUD operations and token-based upload via HTTP API
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

// Test users
const TEST_USER_A = {
  email: `artifacts-api-user-a-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Artifacts Test User A",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

const TEST_USER_B = {
  email: `artifacts-api-user-b-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Artifacts Test User B",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let userACookie: string;
let userBCookie: string;
let adminCookie: string;

// Track artifacts for cleanup
const createdUuids: { userA: string[]; userB: string[] } = { userA: [], userB: [] };

beforeAll(async () => {
  // Login as admin
  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  adminCookie = adminLoginRes.headers.get("set-cookie") || "";

  // Create and verify User A
  const signUpResA = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(TEST_USER_A),
  });
  const signUpDataA = (await signUpResA.json()) as { user?: { id: string } };
  if (!signUpDataA?.user?.id) {
    throw new Error(`Failed to create test user A: ${JSON.stringify(signUpDataA)}`);
  }

  await fetch(`${BASE_URL}/api/admin/users/${signUpDataA.user.id}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });

  const loginResA = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_USER_A.email, password: TEST_USER_A.password }),
  });
  userACookie = loginResA.headers.get("set-cookie") || "";

  // Create and verify User B
  const signUpResB = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(TEST_USER_B),
  });
  const signUpDataB = (await signUpResB.json()) as { user?: { id: string } };
  if (!signUpDataB?.user?.id) {
    throw new Error(`Failed to create test user B: ${JSON.stringify(signUpDataB)}`);
  }

  await fetch(`${BASE_URL}/api/admin/users/${signUpDataB.user.id}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });

  const loginResB = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_USER_B.email, password: TEST_USER_B.password }),
  });
  userBCookie = loginResB.headers.get("set-cookie") || "";
});

afterAll(async () => {
  // Cleanup artifacts for both users
  for (const uuid of createdUuids.userA) {
    await fetch(`${BASE_URL}/api/artifacts/${uuid}`, {
      method: "DELETE",
      headers: { Cookie: userACookie },
    });
  }
  for (const uuid of createdUuids.userB) {
    await fetch(`${BASE_URL}/api/artifacts/${uuid}`, {
      method: "DELETE",
      headers: { Cookie: userBCookie },
    });
  }
});

// ============================================
// Authenticated CRUD Tests
// ============================================

describe("Artifacts API - Basic CRUD", () => {
  let testArtifactUuid: string;

  test("POST /api/artifacts creates a new artifact", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        name: "test-artifact.html",
        content: "<html><body><h1>Test Artifact</h1></body></html>",
      }),
    });

    expect(res.status).toBe(201);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        uuid: string;
        url: string;
        name: string;
        size: number;
        expiresAt: string;
      };
    };
    expect(json.success).toBe(true);
    expect(json.data.uuid).toBeDefined();
    expect(json.data.url).toContain(json.data.uuid);
    // Subdomain-isolation mode: URL is the per-artifact origin {uuid}.static.<domain>/
    expect(json.data.url).toMatch(new RegExp(`//${json.data.uuid}\\.`));
    expect(json.data.name).toBe("test-artifact.html");
    expect(json.data.size).toBeGreaterThan(0);
    expect(json.data.expiresAt).toBeDefined();

    testArtifactUuid = json.data.uuid;
    createdUuids.userA.push(testArtifactUuid);
  });

  test("GET /api/artifacts/:uuid returns artifact metadata", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts/${testArtifactUuid}`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        uuid: string;
        url: string;
        name: string;
        size: number;
        mimeType: string;
        expiresAt: string;
        createdAt: string;
        updatedAt: string;
      };
    };
    expect(json.success).toBe(true);
    expect(json.data.uuid).toBe(testArtifactUuid);
    expect(json.data.url).toContain(testArtifactUuid);
    expect(json.data.name).toBe("test-artifact.html");
    expect(json.data.mimeType).toBe("text/html");
  });

  test("PUT /api/artifacts/:uuid updates artifact content", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts/${testArtifactUuid}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        content: "<html><body><h1>Updated Content</h1></body></html>",
      }),
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: { uuid: string; updated: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.uuid).toBe(testArtifactUuid);
    expect(json.data.updated).toBe(true);
  });

  test("DELETE /api/artifacts/:uuid soft deletes artifact", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts/${testArtifactUuid}`, {
      method: "DELETE",
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: { uuid: string; deleted: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);

    // Remove from cleanup list since it's deleted
    const idx = createdUuids.userA.indexOf(testArtifactUuid);
    if (idx > -1) createdUuids.userA.splice(idx, 1);
  });

  test("GET /api/artifacts/:uuid returns 404 after deletion", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts/${testArtifactUuid}`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(404);
  });
});

describe("Artifacts API - Listing", () => {
  const listTestUuids: string[] = [];

  beforeAll(async () => {
    // Create multiple artifacts for listing tests
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${BASE_URL}/api/artifacts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: userACookie,
        },
        body: JSON.stringify({
          name: `list-test-${i}.html`,
          content: `<html><body>List test ${i}</body></html>`,
        }),
      });
      const json = (await res.json()) as { data: { uuid: string } };
      listTestUuids.push(json.data.uuid);
      createdUuids.userA.push(json.data.uuid);
    }
  });

  test("GET /api/artifacts returns artifacts array", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        artifacts: Array<{ uuid: string; url: string; name: string; size: number }>;
        total: number;
      };
    };
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.artifacts)).toBe(true);
    expect(json.data.total).toBeGreaterThanOrEqual(3);
  });

  test("GET /api/artifacts?limit=2 respects pagination", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts?limit=2`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      data: { artifacts: Array<{ uuid: string }>; total: number };
    };
    expect(json.data.artifacts.length).toBeLessThanOrEqual(2);
    expect(json.data.total).toBeGreaterThanOrEqual(3);
  });

  test("GET /api/artifacts?offset=2 paginates correctly", async () => {
    const page1Res = await fetch(`${BASE_URL}/api/artifacts?limit=2&offset=0`, {
      headers: { Cookie: userACookie },
    });
    const page1 = (await page1Res.json()) as { data: { artifacts: Array<{ uuid: string }> } };

    const page2Res = await fetch(`${BASE_URL}/api/artifacts?limit=2&offset=2`, {
      headers: { Cookie: userACookie },
    });
    const page2 = (await page2Res.json()) as { data: { artifacts: Array<{ uuid: string }> } };

    // Different pages should have different artifacts
    if (page1.data.artifacts.length > 0 && page2.data.artifacts.length > 0) {
      expect(page1.data.artifacts[0].uuid).not.toBe(page2.data.artifacts[0].uuid);
    }
  });
});

describe("Artifacts API - Statistics", () => {
  test("GET /api/artifacts/stats returns usage statistics", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts/stats`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        totalArtifacts: number;
        totalSize: number;
        storageLimit: number;
        countLimit: number;
        storageUsedPercent: number;
        countUsedPercent: number;
      };
    };
    expect(json.success).toBe(true);
    expect(typeof json.data.totalArtifacts).toBe("number");
    expect(typeof json.data.totalSize).toBe("number");
    expect(typeof json.data.storageLimit).toBe("number");
    expect(typeof json.data.countLimit).toBe("number");
    expect(json.data.storageUsedPercent).toBeGreaterThanOrEqual(0);
    expect(json.data.storageUsedPercent).toBeLessThanOrEqual(100);
  });
});

describe("Artifacts API - User Isolation", () => {
  let userBArtifactUuid: string;

  beforeAll(async () => {
    // Create artifact for User B
    const res = await fetch(`${BASE_URL}/api/artifacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userBCookie,
      },
      body: JSON.stringify({
        name: "user-b-secret.html",
        content: "<html><body>User B secret content</body></html>",
      }),
    });
    const json = (await res.json()) as { data: { uuid: string } };
    userBArtifactUuid = json.data.uuid;
    createdUuids.userB.push(userBArtifactUuid);
  });

  test("User A cannot access User B artifacts", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts/${userBArtifactUuid}`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(404);
  });

  test("User A listing does not include User B artifacts", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts`, {
      headers: { Cookie: userACookie },
    });

    const json = (await res.json()) as { data: { artifacts: Array<{ uuid: string }> } };
    const found = json.data.artifacts.find((a) => a.uuid === userBArtifactUuid);
    expect(found).toBeUndefined();
  });

  test("User A cannot update User B artifacts", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts/${userBArtifactUuid}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        content: "<html><body>Hacked!</body></html>",
      }),
    });

    // 403 Forbidden (access denied) or 404 Not Found are both acceptable
    // depending on whether the system reveals artifact existence
    expect([403, 404]).toContain(res.status);
  });

  test("User A cannot delete User B artifacts", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts/${userBArtifactUuid}`, {
      method: "DELETE",
      headers: { Cookie: userACookie },
    });

    // 403 Forbidden (access denied) or 404 Not Found are both acceptable
    expect([403, 404]).toContain(res.status);
  });
});

describe("Artifacts API - Validation", () => {
  test("POST /api/artifacts rejects missing name", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        content: "<html><body>Content</body></html>",
      }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("Name is required");
  });

  test("POST /api/artifacts rejects missing content", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        name: "test.html",
      }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("Content is required");
  });

  test("POST /api/artifacts validates HTML content", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        name: "invalid.html",
        content: "this is not html",
      }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message.toLowerCase()).toContain("html");
  });

  test("PUT /api/artifacts/:uuid rejects missing content", async () => {
    // Create artifact first
    const createRes = await fetch(`${BASE_URL}/api/artifacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        name: "update-test.html",
        content: "<html><body>Original</body></html>",
      }),
    });
    const createJson = (await createRes.json()) as { data: { uuid: string } };
    createdUuids.userA.push(createJson.data.uuid);

    // Try to update without content
    const res = await fetch(`${BASE_URL}/api/artifacts/${createJson.data.uuid}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("Content is required");
  });
});

describe("Artifacts API - Authentication", () => {
  test("Unauthenticated request to list returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts`);
    expect(res.status).toBe(401);
  });

  test("Unauthenticated request to get returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts/some-uuid`);
    expect(res.status).toBe(401);
  });

  test("Unauthenticated request to create returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test.html", content: "<html></html>" }),
    });
    expect(res.status).toBe(401);
  });

  test("Unauthenticated request to stats returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/artifacts/stats`);
    expect(res.status).toBe(401);
  });
});

// ============================================
// Token-Based Upload Tests (Public Endpoint)
// ============================================

describe("Artifacts API - Token Upload", () => {
  let uploadToken: string;
  let uploadUrl: string;

  /**
   * Helper to get an upload token via MCP tool
   * Since tokens are created via MCP, we use the authenticated artifact create endpoint
   * to create an artifact, then use that pattern for token testing
   */
  async function createUploadToken(): Promise<{ token: string; uploadUrl: string }> {
    // Use the MCP artifacts tool to create a token
    // First, we need to simulate what the MCP tool does
    // For testing, we'll create a mock token flow

    // Actually, we should use the MCP client for this
    // But since this is an API test, let's test the HTTP endpoint directly

    // The token creation is via MCP, so for pure API testing we need to:
    // 1. Create a test that assumes a valid token format
    // 2. Or mock the token service

    // For now, let's test with invalid tokens to verify error handling
    // and leave full token flow testing to the MCP E2E tests

    return { token: "test-invalid-token", uploadUrl: "" };
  }

  test("POST /api/public/artifacts/upload/:token rejects invalid token", async () => {
    const res = await fetch(`${BASE_URL}/api/public/artifacts/upload/invalid-token-12345`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test.html",
        content: "<html><body>Test</body></html>",
      }),
    });

    expect(res.status).toBe(401);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("Invalid");
  });

  test("POST /api/public/artifacts/upload/:token rejects missing content", async () => {
    // Even with invalid token, validation should run
    const res = await fetch(`${BASE_URL}/api/public/artifacts/upload/some-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { message: string } };
    // Could be either validation failed (no content) or invalid token
    // Both are acceptable failure modes
    expect(res.status).toBeLessThan(500);
  });

  test("Public endpoint accepts requests without session cookie", async () => {
    // The public endpoint should process requests without session cookies
    // Token provides authorization, not session
    const res = await fetch(`${BASE_URL}/api/public/artifacts/upload/test-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test.html",
        content: "<html><body>Test</body></html>",
      }),
    });

    // Should get 401 for invalid token, not for missing session
    // The error message should mention "token", not "session" or "authentication required"
    expect(res.status).toBe(401);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message.toLowerCase()).toContain("token");
  });
});

// ============================================
// Admin Artifact Endpoints Tests
// ============================================

describe("Artifacts API - Admin Endpoints", () => {
  let adminUserBArtifactUuid: string;

  beforeAll(async () => {
    // Create artifact for User B that admin can manage
    const res = await fetch(`${BASE_URL}/api/artifacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userBCookie,
      },
      body: JSON.stringify({
        name: "admin-test-artifact.html",
        content: "<html><body>Admin test content</body></html>",
      }),
    });
    const json = (await res.json()) as { data: { uuid: string } };
    adminUserBArtifactUuid = json.data.uuid;
    createdUuids.userB.push(adminUserBArtifactUuid);
  });

  test("GET /api/admin/artifacts lists all artifacts (admin only)", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/artifacts`, {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        artifacts: Array<{
          uuid: string;
          userId: string;
          userEmail: string;
          name: string;
          size: number;
        }>;
        total: number;
      };
    };
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.artifacts)).toBe(true);
    expect(json.data.total).toBeGreaterThan(0);

    // Admin can see artifacts from different users
    const hasUserEmail = json.data.artifacts.some((a) => a.userEmail !== undefined);
    expect(hasUserEmail).toBe(true);
  });

  test("GET /api/admin/artifacts with userId filter", async () => {
    // First get user B's ID
    const usersRes = await fetch(
      `${BASE_URL}/api/admin/users?search=${encodeURIComponent(TEST_USER_B.email)}&limit=10`,
      {
        headers: { Cookie: adminCookie },
      },
    );
    const usersJson = (await usersRes.json()) as {
      data: { users: Array<{ id: string; email: string }> };
    };
    const userB = usersJson.data.users.find((u) => u.email === TEST_USER_B.email);
    expect(userB).toBeDefined();

    // Filter by user B
    const res = await fetch(`${BASE_URL}/api/admin/artifacts?userId=${userB!.id}`, {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      data: { artifacts: Array<{ uuid: string; userId: string }> };
    };

    // All results should be from user B
    json.data.artifacts.forEach((a) => {
      expect(a.userId).toBe(userB!.id);
    });
  });

  test("GET /api/admin/artifacts/stats returns system-wide stats", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/artifacts/stats`, {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        totalArtifacts: number;
        totalSize: number;
        totalUsers: number;
        expiredCount: number;
        deletedCount: number;
      };
    };
    expect(json.success).toBe(true);
    expect(typeof json.data.totalArtifacts).toBe("number");
    expect(typeof json.data.totalSize).toBe("number");
    expect(typeof json.data.totalUsers).toBe("number");
    expect(typeof json.data.expiredCount).toBe("number");
    expect(typeof json.data.deletedCount).toBe("number");
  });

  test("DELETE /api/admin/artifacts/:uuid deletes any artifact (admin only)", async () => {
    // Admin can delete User B's artifact
    const res = await fetch(`${BASE_URL}/api/admin/artifacts/${adminUserBArtifactUuid}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: { uuid: string; deleted: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);

    // Remove from cleanup list
    const idx = createdUuids.userB.indexOf(adminUserBArtifactUuid);
    if (idx > -1) createdUuids.userB.splice(idx, 1);
  });

  test("Non-admin cannot access admin artifact endpoints", async () => {
    const listRes = await fetch(`${BASE_URL}/api/admin/artifacts`, {
      headers: { Cookie: userACookie },
    });
    expect(listRes.status).toBe(403);

    const statsRes = await fetch(`${BASE_URL}/api/admin/artifacts/stats`, {
      headers: { Cookie: userACookie },
    });
    expect(statsRes.status).toBe(403);

    const deleteRes = await fetch(`${BASE_URL}/api/admin/artifacts/some-uuid`, {
      method: "DELETE",
      headers: { Cookie: userACookie },
    });
    expect(deleteRes.status).toBe(403);
  });
});

describe("Artifacts API - Admin Quota Management", () => {
  let testUserIdForQuota: string;

  beforeAll(async () => {
    // Get User A's ID for quota tests
    const usersRes = await fetch(
      `${BASE_URL}/api/admin/users?search=${encodeURIComponent(TEST_USER_A.email)}&limit=10`,
      {
        headers: { Cookie: adminCookie },
      },
    );
    const usersJson = (await usersRes.json()) as {
      data: { users: Array<{ id: string; email: string }> };
    };
    const userA = usersJson.data.users.find((u) => u.email === TEST_USER_A.email);
    expect(userA).toBeDefined();
    testUserIdForQuota = userA!.id;
  });

  test("GET /api/admin/users/:id/artifact-quota returns quota info", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/${testUserIdForQuota}/artifact-quota`, {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        userId: string;
        overrides: {
          quotaMb: number | null;
          maxFiles: number | null;
        };
        effective: {
          storageLimit: number;
          countLimit: number;
        };
        usage: {
          totalSize: number;
          totalArtifacts: number;
          storageUsedPercent: number;
          countUsedPercent: number;
        };
      };
    };
    expect(json.success).toBe(true);
    expect(json.data.userId).toBe(testUserIdForQuota);
    expect(json.data.overrides).toBeDefined();
    expect(json.data.effective).toBeDefined();
    expect(json.data.usage).toBeDefined();
  });

  test("PUT /api/admin/users/:id/artifact-quota updates quota overrides", async () => {
    // Set custom quota
    const res = await fetch(`${BASE_URL}/api/admin/users/${testUserIdForQuota}/artifact-quota`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        quotaMb: 200,
        maxFiles: 100,
      }),
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        userId: string;
        quotaMb: number;
        maxFiles: number;
        updated: boolean;
      };
    };
    expect(json.success).toBe(true);
    expect(json.data.quotaMb).toBe(200);
    expect(json.data.maxFiles).toBe(100);
    expect(json.data.updated).toBe(true);

    // Verify the change
    const verifyRes = await fetch(
      `${BASE_URL}/api/admin/users/${testUserIdForQuota}/artifact-quota`,
      {
        headers: { Cookie: adminCookie },
      },
    );
    const verifyJson = (await verifyRes.json()) as {
      data: { overrides: { quotaMb: number; maxFiles: number } };
    };
    expect(verifyJson.data.overrides.quotaMb).toBe(200);
    expect(verifyJson.data.overrides.maxFiles).toBe(100);
  });

  test("PUT /api/admin/users/:id/artifact-quota resets with null values", async () => {
    // Reset to global defaults
    const res = await fetch(`${BASE_URL}/api/admin/users/${testUserIdForQuota}/artifact-quota`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        quotaMb: null,
        maxFiles: null,
      }),
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        quotaMb: number | null;
        maxFiles: number | null;
        updated: boolean;
      };
    };
    expect(json.success).toBe(true);
    expect(json.data.quotaMb).toBeNull();
    expect(json.data.maxFiles).toBeNull();
  });

  test("PUT /api/admin/users/:id/artifact-quota validates input", async () => {
    // Negative values should be rejected
    const res = await fetch(`${BASE_URL}/api/admin/users/${testUserIdForQuota}/artifact-quota`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        quotaMb: -100,
      }),
    });

    expect(res.status).toBe(400);
  });

  test("Non-admin cannot update artifact quotas", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/${testUserIdForQuota}/artifact-quota`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        quotaMb: 500,
      }),
    });

    expect(res.status).toBe(403);
  });
});

describe("Artifacts API - Abuse Controls (report + takedown)", () => {
  let abuseUuid: string;

  // Artifacts are served in subdomain-isolation mode ({uuid}.static.localhost).
  // We reach the per-artifact origin by requesting the subdomain URL directly;
  // Node resolves any *.localhost to loopback, and the dev container is reached
  // on the same port. The create response returns the canonical subdomain origin.
  const origins = new Map<string, string>();
  const sub = (uuid: string) => origins.get(uuid)!.replace(/\/$/, "");

  async function createAbuseArtifact(name: string): Promise<string> {
    const res = await fetch(`${BASE_URL}/api/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userACookie },
      body: JSON.stringify({
        name,
        content: "<!DOCTYPE html><html><body><h1>abuse</h1></body></html>",
      }),
    });
    const json = (await res.json()) as { data: { uuid: string; url: string } };
    createdUuids.userA.push(json.data.uuid);
    origins.set(json.data.uuid, json.data.url);
    return json.data.uuid;
  }

  beforeAll(async () => {
    abuseUuid = await createAbuseArtifact("abuse-target.html");
  });

  test("POST report on the artifact subdomain records a report (public, no auth)", async () => {
    const res = await fetch(`${sub(abuseUuid)}/__report/${abuseUuid}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Thanks for the report");
  });

  test("GET report is not allowed (state change must be POST)", async () => {
    const res = await fetch(`${sub(abuseUuid)}/__report/${abuseUuid}`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  test("report succeeds even when no admin has Telegram configured (graceful)", async () => {
    // The report endpoint sends a best-effort Telegram push to every admin who
    // has Telegram configured. In this test no admin has telegram.bot_token/
    // chat_id set, so the notification is skipped — but the report itself must
    // still succeed (notification absence or failure must never block a report).
    const res = await fetch(`${sub(abuseUuid)}/__report/${abuseUuid}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Thanks for the report");
  });

  test("reported artifact appears in admin reported list with a report count", async () => {
    await fetch(`${sub(abuseUuid)}/__report/${abuseUuid}`, { method: "POST" });

    const res = await fetch(`${BASE_URL}/api/admin/artifacts/reported?limit=100`, {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { artifacts: Array<{ uuid: string; reportCount: number }>; total: number };
    };
    const entry = json.data.artifacts.find((a) => a.uuid === abuseUuid);
    expect(entry).toBeDefined();
    expect(entry!.reportCount).toBeGreaterThanOrEqual(1);
  });

  test("non-admin cannot access reported list", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/artifacts/reported`, {
      headers: { Cookie: userACookie },
    });
    expect(res.status).toBe(403);
  });

  test("admin takedown requires a reason", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/artifacts/${abuseUuid}/takedown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("path-based access to artifact content does not exist (subdomain only)", async () => {
    // Artifacts are reachable ONLY on their own subdomain — there is no path
    // route. A path request on the bare domain serves no artifact content.
    const uuid = await createAbuseArtifact("path-gone.html");
    const res = await fetch(`${BASE_URL}/static/${uuid}.html?ack=1`, { redirect: "manual" });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(302);
  });

  test("admin takedown stops the artifact from being served publicly", async () => {
    const uuid = await createAbuseArtifact("takedown-target.html");

    // Servable on its subdomain before takedown
    const before = await fetch(`${sub(uuid)}/?ack=1`);
    expect(before.status).toBe(200);

    const takedown = await fetch(`${BASE_URL}/api/admin/artifacts/${uuid}/takedown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ reason: "api test: abusive" }),
    });
    expect(takedown.status).toBe(200);

    // Not servable after (wrapper 404; frame 404 even as an iframe load)
    const afterWrapper = await fetch(`${sub(uuid)}/?ack=1`);
    expect(afterWrapper.status).toBe(404);
    const afterFrame = await fetch(`${sub(uuid)}/__frame/${uuid}`, {
      headers: { "Sec-Fetch-Dest": "iframe" },
    });
    expect(afterFrame.status).toBe(404);
  });

  test("top-level navigation to the frame redirects to the wrapper (no phishing surface)", async () => {
    const uuid = await createAbuseArtifact("frame-direct.html");
    const res = await fetch(`${sub(uuid)}/__frame/${uuid}`, {
      headers: { "Sec-Fetch-Dest": "document" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  test("frame serves JS-enabled, no-network CSP on the artifact subdomain (iframe load)", async () => {
    const uuid = await createAbuseArtifact("csp-check.html");
    const frame = await fetch(`${sub(uuid)}/__frame/${uuid}`, {
      headers: { "Sec-Fetch-Dest": "iframe" },
    });
    expect(frame.status).toBe(200);
    const csp = frame.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});
