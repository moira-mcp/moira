/**
 * Settings API Integration Tests
 * Tests settings CRUD operations with real database via Docker
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();
const TEST_USER = {
  email: `settings-api-test-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Settings Test User",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let authCookie: string;
let testUserId: string;

beforeAll(async () => {
  // Create test user
  const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(TEST_USER),
  });
  const signUpData = (await signUpRes.json()) as any;
  if (!signUpData || !signUpData.user) {
    throw new Error(`Failed to create test user: ${JSON.stringify(signUpData)}`);
  }
  testUserId = signUpData.user.id;

  // Login as admin to verify email
  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  const adminCookies = adminLoginRes.headers.get("set-cookie");

  // Verify test user email
  await fetch(`${BASE_URL}/api/admin/users/${testUserId}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookies || "" },
  });

  // Login as test user to get auth cookie
  const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: TEST_USER.email,
      password: TEST_USER.password,
    }),
  });

  const cookies = loginRes.headers.get("set-cookie");
  authCookie = cookies || "";
});

describe("Settings API", () => {
  test("GET /api/settings/definitions returns all definitions", async () => {
    const res = await fetch(`${BASE_URL}/api/settings/definitions`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThan(0);

    // Check initial definitions exist
    const keys = json.data.map((d: any) => d.key);
    expect(keys).toContain("telegram.bot_token");
    expect(keys).toContain("ui.theme");
  });

  test("GET /api/settings/definitions?category=notifications filters by category", async () => {
    const res = await fetch(`${BASE_URL}/api/settings/definitions?category=notifications`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);

    const notificationDefs = json.data.filter((d: any) => d.category === "notifications");
    expect(notificationDefs.length).toBe(json.data.length); // All should be notifications category
  });

  test("PUT /api/settings/:key saves setting value", async () => {
    const res = await fetch(`${BASE_URL}/api/settings/ui.theme`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ value: "dark" }),
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.updated).toBe(true);
  });

  test("GET /api/settings/:category returns user settings", async () => {
    // Set a value first
    await fetch(`${BASE_URL}/api/settings/ui.theme`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ value: "light" }),
    });

    // Get settings
    const res = await fetch(`${BASE_URL}/api/settings/ui`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data["ui.theme"]).toBe("light");
  });

  test("PUT /api/settings/:key encrypts sensitive values", async () => {
    const testToken = "test-bot-token-12345";

    const res = await fetch(`${BASE_URL}/api/settings/telegram.bot_token`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ value: testToken }),
    });

    expect(res.status).toBe(200);

    // Get settings - should be masked
    const getRes = await fetch(`${BASE_URL}/api/settings/notifications`, {
      headers: { Cookie: authCookie },
    });

    const json = (await getRes.json()) as any;
    expect(json.data["telegram.bot_token"]).not.toBe(testToken); // Should be masked
    expect(json.data["telegram.bot_token"]).toContain("●"); // Masked format
  });

  test("Unauthorized request returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/settings/definitions`);
    expect(res.status).toBe(401);
  });

  test("PUT /api/settings/:key validates required value", async () => {
    const res = await fetch(`${BASE_URL}/api/settings/ui.theme`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({}), // Missing value
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("required");
  });

  test("PUT /api/settings/:key returns 404 for unknown setting", async () => {
    const res = await fetch(`${BASE_URL}/api/settings/unknown.setting`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ value: "test" }),
    });

    expect(res.status).toBe(404);

    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("not found");
  });

  test("DELETE /api/settings/:key deletes user value", async () => {
    // Set a value first
    await fetch(`${BASE_URL}/api/settings/ui.theme`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ value: "dark" }),
    });

    // Delete it
    const delRes = await fetch(`${BASE_URL}/api/settings/ui.theme`, {
      method: "DELETE",
      headers: { Cookie: authCookie },
    });

    expect(delRes.status).toBe(200);

    const json = (await delRes.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);

    // Get settings - should return default value now
    const getRes = await fetch(`${BASE_URL}/api/settings/ui`, {
      headers: { Cookie: authCookie },
    });

    const settings = (await getRes.json()) as any;
    expect(settings.data["ui.theme"]).toBe("system"); // Default value
  });

  test("PUT /api/settings/:key validates enum values", async () => {
    const res = await fetch(`${BASE_URL}/api/settings/ui.theme`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ value: "invalid-theme" }), // Not in enum
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("must be one of");
  });
});

describe("Settings Definitions adminOnly Filtering", () => {
  let adminCookie: string;
  const adminOnlyKey = `test.admin_only_setting_${Date.now()}`;

  beforeAll(async () => {
    // Login as admin
    const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });
    adminCookie = loginRes.headers.get("set-cookie") || "";

    // Create adminOnly definition for testing
    await fetch(`${BASE_URL}/api/admin/settings/definitions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        key: adminOnlyKey,
        type: "string",
        category: "test",
        label: "Admin Only Test Setting",
        adminOnly: true,
      }),
    });
  });

  afterAll(async () => {
    // Cleanup: delete the test definition
    await fetch(`${BASE_URL}/api/admin/settings/definitions/${adminOnlyKey}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
  });

  test("Non-admin user does NOT see adminOnly definitions in user settings", async () => {
    const res = await fetch(`${BASE_URL}/api/settings/definitions`, {
      headers: { Cookie: authCookie }, // Non-admin user
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);

    // Should NOT contain adminOnly definitions
    const adminOnlyDefs = json.data.filter((d: any) => d.adminOnly === true);
    expect(adminOnlyDefs.length).toBe(0);

    // Specifically should not contain our test adminOnly key
    const keys = json.data.map((d: any) => d.key);
    expect(keys).not.toContain(adminOnlyKey);
  });

  test("Admin user also does NOT see adminOnly definitions in user settings endpoint", async () => {
    // /api/settings/definitions is for USER settings page
    // adminOnly settings are managed via /api/admin/* routes, not shown in user settings
    const res = await fetch(`${BASE_URL}/api/settings/definitions`, {
      headers: { Cookie: adminCookie }, // Admin user
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);

    // Should NOT contain adminOnly definitions - this is user settings endpoint
    const adminOnlyDefs = json.data.filter((d: any) => d.adminOnly === true);
    expect(adminOnlyDefs.length).toBe(0);

    // Should not contain our test adminOnly key
    const keys = json.data.map((d: any) => d.key);
    expect(keys).not.toContain(adminOnlyKey);
  });

  test("Admin CAN see adminOnly definitions via admin endpoint", async () => {
    // Admin settings are available via /api/admin/settings/definitions
    const res = await fetch(`${BASE_URL}/api/admin/settings/definitions`, {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);

    // Should contain our test adminOnly key
    const keys = json.data.map((d: any) => d.key);
    expect(keys).toContain(adminOnlyKey);
  });
});

describe("Admin Settings API", () => {
  let adminCookie: string;
  const testKey = `test.admin_setting_${Date.now()}`;

  beforeAll(async () => {
    // Login as admin user (created by migration with isAdmin=1)
    const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });

    const cookies = loginRes.headers.get("set-cookie");
    adminCookie = cookies || "";
  });

  test("Non-admin cannot create definition", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/settings/definitions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie, // Non-admin user
      },
      body: JSON.stringify({
        key: "test.new_setting",
        type: "string",
        category: "test",
        label: "Test Setting",
      }),
    });

    expect(res.status).toBe(403); // Forbidden

    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    // Error can be either string (legacy) or object (unified error architecture)
    const errorMessage = typeof json.error === "string" ? json.error : json.error?.message;
    expect(errorMessage).toContain("Admin permission");
  });

  test("Admin can create definition", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/settings/definitions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        key: testKey,
        type: "string",
        category: "test",
        label: "Admin Test Setting",
        defaultValue: "default_value",
      }),
    });

    if (res.status !== 200) {
      const errorText = await res.text();
      console.error("Create definition failed:", res.status, errorText);
    }

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.created).toBe(true);
  });

  test("Admin can update definition", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/settings/definitions/${testKey}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        label: "Updated Label",
        description: "Updated description",
      }),
    });

    if (res.status !== 200) {
      const errorText = await res.text();
      console.error("Update definition failed:", res.status, errorText);
    }

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.updated).toBe(true);
  });

  test("Admin can delete definition", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/settings/definitions/${testKey}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });

    if (res.status !== 200) {
      const errorText = await res.text();
      console.error("Delete definition failed:", res.status, errorText);
    }

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);
  });

  test("Admin can get system stats", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/stats`, {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data).toHaveProperty("totalWorkflows");
    expect(json.data).toHaveProperty("totalExecutions");
    expect(json.data).toHaveProperty("totalDefinitions");
  });
});
