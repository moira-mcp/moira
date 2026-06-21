/**
 * Notes API Integration Tests
 * Tests notes CRUD operations with real database via Docker
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

// Test users
const TEST_USER_A = {
  email: `notes-api-user-a-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Notes Test User A",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

const TEST_USER_B = {
  email: `notes-api-user-b-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Notes Test User B",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let userACookie: string;
let userBCookie: string;
let adminCookie: string;

// Unique test keys to avoid conflicts
const TEST_KEY_PREFIX = `test-${Date.now()}`;
const TEST_KEY_1 = `${TEST_KEY_PREFIX}-note1`;
const TEST_KEY_2 = `${TEST_KEY_PREFIX}-note2`;
const TEST_KEY_3 = `${TEST_KEY_PREFIX}-note3`;

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
  // Clean up test notes
  for (const key of [TEST_KEY_1, TEST_KEY_2, TEST_KEY_3]) {
    await fetch(`${BASE_URL}/api/notes/${key}`, {
      method: "DELETE",
      headers: { Cookie: userACookie },
    });
    await fetch(`${BASE_URL}/api/notes/${key}`, {
      method: "DELETE",
      headers: { Cookie: userBCookie },
    });
  }
});

describe("Notes API - Basic CRUD", () => {
  test("POST /api/notes creates a new note", async () => {
    const res = await fetch(`${BASE_URL}/api/notes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        key: TEST_KEY_1,
        value: "Test note content",
        tags: ["test", "api"],
      }),
    });

    expect(res.status).toBe(201);

    const json = (await res.json()) as {
      success: boolean;
      data: { id: string; key: string; version: number; created: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.key).toBe(TEST_KEY_1);
    expect(json.data.version).toBe(1);
    expect(json.data.created).toBe(true);
  });

  test("POST /api/notes returns error for duplicate key", async () => {
    const res = await fetch(`${BASE_URL}/api/notes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        key: TEST_KEY_1,
        value: "Duplicate content",
      }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { success: boolean; error: { message: string } };
    expect(json.success).toBe(false);
    expect(json.error.message).toContain("already exists");
  });

  test("GET /api/notes/:key returns the note", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${TEST_KEY_1}`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: { key: string; value: string; tags: string[]; version: number };
    };
    expect(json.success).toBe(true);
    expect(json.data.key).toBe(TEST_KEY_1);
    expect(json.data.value).toBe("Test note content");
    expect(json.data.tags).toEqual(["test", "api"]);
    expect(json.data.version).toBe(1);
  });

  test("PUT /api/notes/:key updates the note", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${TEST_KEY_1}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: userACookie,
      },
      body: JSON.stringify({
        value: "Updated content",
        tags: ["updated"],
      }),
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: { key: string; version: number; updated: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.version).toBe(2);
    expect(json.data.updated).toBe(true);
  });

  test("GET /api/notes/:key returns updated content", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${TEST_KEY_1}`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: { value: string; tags: string[]; version: number };
    };
    expect(json.data.value).toBe("Updated content");
    expect(json.data.tags).toEqual(["updated"]);
    expect(json.data.version).toBe(2);
  });

  test("DELETE /api/notes/:key soft deletes the note", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${TEST_KEY_1}`, {
      method: "DELETE",
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: { key: string; deleted: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);
  });

  test("GET /api/notes/:key returns 404 after deletion", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${TEST_KEY_1}`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(404);
  });

  test("POST /api/notes/:key/restore restores deleted note", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${TEST_KEY_1}/restore`, {
      method: "POST",
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: { key: string; restored: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.restored).toBe(true);
  });
});

describe("Notes API - Listing and Filtering", () => {
  beforeAll(async () => {
    // Create test notes for filtering
    await fetch(`${BASE_URL}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userACookie },
      body: JSON.stringify({ key: TEST_KEY_2, value: "Note 2", tags: ["alpha", "shared"] }),
    });

    await fetch(`${BASE_URL}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userACookie },
      body: JSON.stringify({ key: TEST_KEY_3, value: "Note 3", tags: ["beta", "shared"] }),
    });
  });

  test("GET /api/notes returns all user notes", async () => {
    const res = await fetch(`${BASE_URL}/api/notes`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        notes: Array<{ key: string }>;
        total: number;
        allTags: string[];
      };
    };
    expect(json.success).toBe(true);
    expect(json.data.notes.length).toBeGreaterThanOrEqual(3);
    expect(json.data.total).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(json.data.allTags)).toBe(true);
  });

  test("GET /api/notes returns allTags for autocomplete", async () => {
    const res = await fetch(`${BASE_URL}/api/notes`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      data: { allTags: string[] };
    };
    expect(json.data.allTags).toContain("alpha");
    expect(json.data.allTags).toContain("beta");
    expect(json.data.allTags).toContain("shared");
    expect(json.data.allTags).toContain("updated");
  });

  test("GET /api/notes?tag=shared filters by tag", async () => {
    const res = await fetch(`${BASE_URL}/api/notes?tag=shared`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      data: { notes: Array<{ key: string }> };
    };
    expect(json.data.notes.length).toBe(2);

    const keys = json.data.notes.map((n) => n.key);
    expect(keys).toContain(TEST_KEY_2);
    expect(keys).toContain(TEST_KEY_3);
    expect(keys).not.toContain(TEST_KEY_1);
  });

  test("GET /api/notes?keySearch=note filters by key prefix", async () => {
    const res = await fetch(`${BASE_URL}/api/notes?keySearch=${TEST_KEY_PREFIX}`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      data: { notes: Array<{ key: string }>; total: number };
    };
    expect(json.data.notes.length).toBe(3);
    expect(json.data.total).toBe(3);
  });

  test("GET /api/notes?limit=1&offset=1 paginates results", async () => {
    const res = await fetch(`${BASE_URL}/api/notes?keySearch=${TEST_KEY_PREFIX}&limit=1&offset=1`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      data: { notes: Array<{ key: string }>; total: number };
    };
    expect(json.data.notes.length).toBe(1);
    expect(json.data.total).toBe(3); // Total should still be 3
  });
});

describe("Notes API - Version History", () => {
  test("GET /api/notes/:key/history returns version history", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${TEST_KEY_1}/history`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: Array<{ version: number; size: number; createdAt: string; preview?: string }>;
    };
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBe(2); // Initial version + update

    // Check versions are in order
    const versions = json.data.map((v) => v.version);
    expect(versions).toContain(1);
    expect(versions).toContain(2);
  });

  test("GET /api/notes/:key?version=1 returns specific version", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${TEST_KEY_1}?version=1`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      data: { value: string; version: number };
    };
    expect(json.data.version).toBe(1);
    expect(json.data.value).toBe("Test note content"); // Original content
  });

  test("GET /api/notes/:key?version=999 returns 404 for non-existent version", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${TEST_KEY_1}?version=999`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(404);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("not found");
  });
});

describe("Notes API - Statistics", () => {
  test("GET /api/notes/stats returns user statistics", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/stats`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      success: boolean;
      data: {
        totalNotes: number;
        totalSize: number;
        limit: number;
        usedPercent: number;
      };
    };
    expect(json.success).toBe(true);
    expect(typeof json.data.totalNotes).toBe("number");
    expect(typeof json.data.totalSize).toBe("number");
    expect(typeof json.data.limit).toBe("number");
    expect(typeof json.data.usedPercent).toBe("number");
    expect(json.data.totalNotes).toBeGreaterThanOrEqual(3);
    expect(json.data.usedPercent).toBeGreaterThanOrEqual(0);
    expect(json.data.usedPercent).toBeLessThanOrEqual(100);
  });
});

describe("Notes API - User Isolation", () => {
  const USER_B_KEY = `${TEST_KEY_PREFIX}-user-b-note`;

  beforeAll(async () => {
    // Create a note for User B
    await fetch(`${BASE_URL}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userBCookie },
      body: JSON.stringify({ key: USER_B_KEY, value: "User B secret" }),
    });
  });

  afterAll(async () => {
    await fetch(`${BASE_URL}/api/notes/${USER_B_KEY}`, {
      method: "DELETE",
      headers: { Cookie: userBCookie },
    });
  });

  test("User A cannot access User B notes", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${USER_B_KEY}`, {
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(404);
  });

  test("User A listing does not include User B notes", async () => {
    const res = await fetch(`${BASE_URL}/api/notes`, {
      headers: { Cookie: userACookie },
    });

    const json = (await res.json()) as {
      data: { notes: Array<{ key: string }> };
    };
    const keys = json.data.notes.map((n) => n.key);
    expect(keys).not.toContain(USER_B_KEY);
  });

  test("User A cannot update User B notes", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${USER_B_KEY}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: userACookie },
      body: JSON.stringify({ value: "Hacked!" }),
    });

    expect(res.status).toBe(404);
  });

  test("User A cannot delete User B notes", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/${USER_B_KEY}`, {
      method: "DELETE",
      headers: { Cookie: userACookie },
    });

    expect(res.status).toBe(404);
  });
});

describe("Notes API - Validation", () => {
  test("POST /api/notes rejects invalid key", async () => {
    const res = await fetch(`${BASE_URL}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userACookie },
      body: JSON.stringify({ key: "invalid key with spaces", value: "test" }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("letters, numbers, underscores, and hyphens");
  });

  test("POST /api/notes rejects missing key", async () => {
    const res = await fetch(`${BASE_URL}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userACookie },
      body: JSON.stringify({ value: "test" }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("Key is required");
  });

  test("POST /api/notes rejects missing value", async () => {
    const res = await fetch(`${BASE_URL}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userACookie },
      body: JSON.stringify({ key: "test-key-no-value" }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("Value is required");
  });

  test("POST /api/notes rejects too many tags", async () => {
    const res = await fetch(`${BASE_URL}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userACookie },
      body: JSON.stringify({
        key: "test-too-many-tags",
        value: "test",
        tags: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
      }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("Too many tags");
  });
});

describe("Notes API - Authentication", () => {
  test("Unauthenticated request to list returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/notes`);
    expect(res.status).toBe(401);
  });

  test("Unauthenticated request to get returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/some-key`);
    expect(res.status).toBe(401);
  });

  test("Unauthenticated request to create returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "unauth-key", value: "test" }),
    });
    expect(res.status).toBe(401);
  });

  test("Unauthenticated request to stats returns 401", async () => {
    const res = await fetch(`${BASE_URL}/api/notes/stats`);
    expect(res.status).toBe(401);
  });
});
