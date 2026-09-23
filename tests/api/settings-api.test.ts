/**
 * Settings API Integration Tests
 * Tests settings CRUD operations with real database via Docker
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  createTestUserViaApi,
  formatSessionCookie,
  getAdminSessionCookie,
  signInUser,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const TEST_USER = {
  email: `settings-api-test-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Settings Test User",
};

let authCookie: string;
let adminCookie: string;

// A user-level definition the tests own, so they exercise the per-key routes without depending on
// which built-in settings the product seeds.
const probeCategory = `test_probe_${Date.now()}`;
const probeKey = `${probeCategory}.tone`;

beforeAll(async () => {
  await createTestUserViaApi(BASE_URL, TEST_USER.email, TEST_USER.password, TEST_USER.name);
  authCookie = formatSessionCookie(
    BASE_URL,
    await signInUser(BASE_URL, TEST_USER.email, TEST_USER.password),
  );
  adminCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));
  const created = await fetch(`${BASE_URL}/api/admin/settings/definitions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      key: probeKey,
      type: "string",
      category: probeCategory,
      label: "Probe tone",
      defaultValue: "calm",
      validation: JSON.stringify({ type: "string", enum: ["calm", "loud"] }),
    }),
  });
  expect(created.status).toBe(200);
});

afterAll(async () => {
  await fetch(`${BASE_URL}/api/admin/settings/definitions/${probeKey}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie },
  });
});

async function putProbe(body: unknown) {
  return fetch(`${BASE_URL}/api/settings/${probeKey}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: authCookie },
    body: JSON.stringify(body),
  });
}

describe("Settings API", () => {
  test("GET /api/settings/definitions returns the seeded definitions and not the retired ui.theme", async () => {
    const res = await fetch(`${BASE_URL}/api/settings/definitions`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);

    const keys = json.data.map((d: any) => d.key);
    expect(keys).toContain("telegram.bot_token");
    expect(keys).toContain("codespaces.idle_timeout_minutes");
    // It never controlled the theme (the browser keeps it); the migration retired it.
    expect(keys).not.toContain("ui.theme");
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
    const res = await putProbe({ value: "loud" });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.updated).toBe(true);
  });

  test("GET /api/settings/:category returns user settings", async () => {
    await putProbe({ value: "loud" });

    const res = await fetch(`${BASE_URL}/api/settings/${probeCategory}`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data[probeKey]).toBe("loud");
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
    const res = await putProbe({}); // Missing value

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
    await putProbe({ value: "loud" });

    const delRes = await fetch(`${BASE_URL}/api/settings/${probeKey}`, {
      method: "DELETE",
      headers: { Cookie: authCookie },
    });

    expect(delRes.status).toBe(200);

    const json = (await delRes.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);

    // Get settings - should return default value now
    const getRes = await fetch(`${BASE_URL}/api/settings/${probeCategory}`, {
      headers: { Cookie: authCookie },
    });

    const settings = (await getRes.json()) as any;
    expect(settings.data[probeKey]).toBe("calm"); // Default value
  });

  test("PUT /api/settings/:key validates enum values", async () => {
    const res = await putProbe({ value: "invalid-tone" }); // Not in enum

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
    adminCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));

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

  test("Bulk PUT saves what a non-admin may write and names what it refused", async () => {
    // Required state: one request, and the caller knows from its answer what landed. Plausible wrong
    // states, all of which also answer non-200 or 200: the whole body is refused (the ordinary key
    // is not saved), the admin key is written anyway, or the answer complains without naming the
    // key so the caller must diff the settings to find out. The storage is read for both keys and
    // the body is read for the name, which is what tells these apart.
    const ordinaryKey = "profile.display_name";
    const ordinaryValue = `saved-alongside-a-refusal-${Date.now()}`;

    const res = await fetch(`${BASE_URL}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      // The refused key comes first: what is saved must not depend on the order of the body.
      body: JSON.stringify({
        [adminOnlyKey]: "written-by-a-regular-user",
        [ordinaryKey]: ordinaryValue,
      }),
    });

    expect(res.status).toBe(207);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.saved).toEqual({ [ordinaryKey]: ordinaryValue });
    expect(body.data.refused).toEqual([
      { key: adminOnlyKey, reason: "Admin permission required for this setting" },
    ]);

    const stored = await fetch(`${BASE_URL}/api/settings`, { headers: { Cookie: authCookie } });
    const storedJson = (await stored.json()) as any;
    expect(storedJson.data[ordinaryKey]).toBe(ordinaryValue);
    expect(storedJson.data[adminOnlyKey]).toBeUndefined();
  });

  test("Bulk PUT without a refused key answers as an ordinary save", async () => {
    // The 207 must mean "part of this was refused", not "this endpoint changed": a body the caller
    // may write entirely still answers 200 with an empty refusal list.
    const value = `plain-save-${Date.now()}`;
    const res = await fetch(`${BASE_URL}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ "profile.display_name": value }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.refused).toEqual([]);
    expect(body.data.saved).toEqual({ "profile.display_name": value });

    const stored = await fetch(`${BASE_URL}/api/settings`, { headers: { Cookie: authCookie } });
    expect(((await stored.json()) as any).data["profile.display_name"]).toBe(value);
  });

  test("Bulk PUT keeps saving after a key that cannot be stored, and names it", async () => {
    // The refusal class is wider than the admin flag: an unknown key throws inside the repository.
    // Required state: the rest of the body is still saved and the failing key is named. Plausible
    // wrong state: the write loop abandons the request at the first throw, so what survived depends
    // on the position of the bad key and the caller is told nothing about either group. The failing
    // key is sent first, so a loop that stops would save nothing at all.
    const goodKey = "profile.display_name";
    const goodValue = `saved-after-a-bad-key-${Date.now()}`;
    const unknownKey = `test.not_a_defined_setting_${Date.now()}`;

    const res = await fetch(`${BASE_URL}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ [unknownKey]: "whatever", [goodKey]: goodValue }),
    });

    expect(res.status).toBe(207);
    const body = (await res.json()) as any;
    expect(body.data.saved).toEqual({ [goodKey]: goodValue });
    expect(body.data.refused.map((entry: { key: string }) => entry.key)).toEqual([unknownKey]);
    expect(body.data.refused[0].reason).toContain(unknownKey);

    const stored = await fetch(`${BASE_URL}/api/settings`, { headers: { Cookie: authCookie } });
    const storedJson = (await stored.json()) as any;
    expect(storedJson.data[goodKey]).toBe(goodValue);
    expect(storedJson.data[unknownKey]).toBeUndefined();
  });

  test("Bulk PUT stores the adminOnly key for an administrator", async () => {
    const value = `written-by-admin-${Date.now()}`;
    const res = await fetch(`${BASE_URL}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ [adminOnlyKey]: value }),
    });

    expect(res.status).toBe(200);
    const response = (await res.json()) as any;
    expect(response.data.refused).toEqual([]);
    expect(response.data.saved).toEqual({ [adminOnlyKey]: value });

    // The user settings surface omits admin-only definitions for administrators too, so it must
    // not leak the otherwise writable value in the page's bulk read response.
    const stored = await fetch(`${BASE_URL}/api/settings`, { headers: { Cookie: adminCookie } });
    expect(((await stored.json()) as any).data[adminOnlyKey]).toBeUndefined();
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
    adminCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));
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

  test("Admin can get deployment-neutral system status", async () => {
    const res = await fetch(`${BASE_URL}/api/admin/system-status`, {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data).toHaveProperty("totalDefinitions");
    expect(json.data).toHaveProperty("systemHealth.workflowReconciliation");
  });
});
