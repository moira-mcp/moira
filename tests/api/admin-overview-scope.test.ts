import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  createTestUserViaApi,
  formatSessionCookie,
  getAdminSessionCookie,
  signInUser,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
let adminCookie: string;
let userCookie: string;
let userId: string;
const email = `analytics-scope-${Date.now()}@example.com`;
async function read(path: string, cookie = adminCookie) {
  return fetch(`${BASE_URL}${path}`, { headers: { Cookie: cookie } });
}
describe("Administrator overview HTTP scope boundary", () => {
  beforeAll(async () => {
    adminCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));
    ({ userId } = await createTestUserViaApi(
      BASE_URL,
      email,
      "AnalyticsScope123!",
      "Scope fixture",
    ));
    userCookie = formatSessionCookie(
      BASE_URL,
      await signInUser(BASE_URL, email, "AnalyticsScope123!"),
    );
  });
  afterAll(async () => {
    if (userId)
      await fetch(`${BASE_URL}/api/admin/users/${userId}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
  });
  test.each(["overview", "users", "registrations", "attention", "top-workflows"])(
    "enforces administrator role and bounded returned scope for %s",
    async (endpoint) => {
      expect((await read(`/api/admin/analytics/${endpoint}`, userCookie)).status).toBe(403);
      const response = await read(
        `/api/admin/analytics/${endpoint}?range=week&excludeUserIds=&limit=2`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        success: boolean;
        data: {
          scope: {
            timeRange: string;
            startAt: number;
            endAt: number;
            asOf: number;
            exclusions: { mode: string; userIds: string[]; effectiveCount: number };
          };
          users?: unknown[];
          activePeople?: unknown[];
          executions?: unknown[];
          workflows?: unknown[];
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.scope.exclusions).toEqual({
        mode: "custom",
        userIds: [],
        effectiveCount: 0,
      });
      expect(body.data.scope.timeRange).toBe("week");
      expect(body.data.scope.endAt).toBe(body.data.scope.asOf);
      expect(body.data.scope.endAt - body.data.scope.startAt).toBe(604800000);
      const samples =
        body.data.users ??
        body.data.activePeople ??
        body.data.executions ??
        body.data.workflows ??
        [];
      expect(samples.length).toBeLessThanOrEqual(2);
    },
  );
  test("custom exclusions remove a known registration while complete management lookup retains it", async () => {
    const included = await read(
      "/api/admin/analytics/registrations?range=week&excludeUserIds=&limit=100",
    );
    const includedBody = (await included.json()) as { data: { total: number } };
    const excluded = await read(
      `/api/admin/analytics/registrations?range=week&excludeUserIds=${encodeURIComponent(userId)}&limit=100`,
    );
    const excludedBody = (await excluded.json()) as {
      data: {
        total: number;
        users: Array<{ userId: string }>;
        scope: { exclusions: { effectiveCount: number } };
      };
    };
    expect(excluded.status).toBe(200);
    expect(excludedBody.data.total).toBe(includedBody.data.total - 1);
    expect(excludedBody.data.users.map((user) => user.userId)).not.toContain(userId);
    expect(excludedBody.data.scope.exclusions.effectiveCount).toBe(1);
    const management = await read(`/api/admin/users?ids=${encodeURIComponent(userId)}&limit=100`);
    const managementBody = (await management.json()) as {
      data: { total: number; users: Array<{ id: string; email: string }> };
    };
    expect(managementBody.data).toMatchObject({ total: 1, users: [{ id: userId, email }] });
    const empty = await read("/api/admin/users?ids=&limit=100");
    expect(await empty.json()).toMatchObject({ data: { total: 0, users: [] } });
  });
  test("omission selects dynamic administrator exclusions instead of explicit custom empty selection", async () => {
    const response = await read("/api/admin/analytics/overview");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { scope: { exclusions: { mode: string; effectiveCount: number; userIds?: string[] } } };
    };
    expect(body.data.scope.exclusions.mode).toBe("default-admins");
    expect(body.data.scope.exclusions.effectiveCount).toBeGreaterThanOrEqual(1);
    expect(body.data.scope.exclusions).not.toHaveProperty("userIds");
  });
  test.each([
    "range=invalid",
    "range=week&range=month",
    "excludeUserIds=a&excludeUserIds=b",
    "limit=0",
  ])("returns a validation error for malformed query %s", async (query) => {
    const response = await read(`/api/admin/analytics/overview?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "VALIDATION_FAILED" },
    });
  });
});
