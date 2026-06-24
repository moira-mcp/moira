/**
 * API tests for the public marketplace read endpoints (HTTP, against the running
 * container). Verifies the routes are mounted UNAUTHENTICATED behind /api/public,
 * the response envelope, the categories payload, the XML sitemap content-type, and
 * that unknown references map to 404. (Seeded-listing behaviors are covered by the
 * service-level integration tests; publishing over HTTP arrives in Step 5.)
 */

import { describe, test, expect } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ROOT = `${BASE_URL}/api/public/marketplace`;

describe("Public marketplace read API", () => {
  test("GET gallery is public (no auth) and returns the page envelope", async () => {
    const res = await fetch(ROOT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { items: unknown[]; total: number; limit: number; offset: number; sort: string };
      timestamp: string;
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(typeof body.data.total).toBe("number");
    expect(typeof body.data.limit).toBe("number");
    expect(body.data.sort).toBe("recent");
    expect(typeof body.timestamp).toBe("string");
  });

  test("GET gallery accepts sort/limit/offset query params", async () => {
    const res = await fetch(`${ROOT}?sort=trending&limit=5&offset=0`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { sort: string; limit: number } };
    expect(body.success).toBe(true);
    expect(body.data.sort).toBe("trending");
    expect(body.data.limit).toBe(5);
  });

  test("GET categories returns the fixed set", async () => {
    const res = await fetch(`${ROOT}/categories`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { categories: Array<{ id: string; label: string }> };
    };
    expect(body.success).toBe(true);
    const ids = body.data.categories.map((c) => c.id);
    expect(ids).toContain("development");
    expect(ids[ids.length - 1]).toBe("other");
  });

  test("GET sitemap.xml returns XML", async () => {
    const res = await fetch(`${ROOT}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const text = await res.text();
    expect(text).toContain("<?xml");
    expect(text).toContain("<urlset");
  });

  test("GET detail for an unknown reference is 404", async () => {
    const res = await fetch(`${ROOT}/listings/nobody/nothing`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
  });

  test("GET export for an unknown reference is 404", async () => {
    const res = await fetch(`${ROOT}/listings/nobody/nothing/export`);
    expect(res.status).toBe(404);
  });

  test("GET reviews for an unknown reference is 404", async () => {
    const res = await fetch(`${ROOT}/listings/nobody/nothing/reviews`);
    expect(res.status).toBe(404);
  });
});
