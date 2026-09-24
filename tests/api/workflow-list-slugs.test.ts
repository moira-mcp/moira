/**
 * GET /api/workflows?slugs=… — a caller that knows which catalog entries it wants (the app's
 * recommended flows) fetches exactly those in one request. Slugs are exact, not a search: a slug
 * that only contains another one does not match, a slug nobody has is simply absent, and a list
 * of nothing but values that cannot be slugs under the shared slug rule matches nothing rather
 * than everything.
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl } from "../utils/test-config.js";
import { formatSessionCookie, getAdminSessionCookie } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

type ListItem = { slug: string; ownerHandle: string };

describe("GET /api/workflows?slugs=", () => {
  let authCookie: string;

  beforeAll(async () => {
    authCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));
  });

  async function list(query: string): Promise<{ workflows: ListItem[]; totalWorkflows: number }> {
    const response = await fetch(`${BASE_URL}/api/workflows?${query}`, {
      headers: { Cookie: authCookie },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { workflows: ListItem[]; totalWorkflows: number } })
      .data;
  }

  test("returns exactly the named catalog flows, not those whose slug merely contains one", async () => {
    // `example-one-choice` is contained in `example-one-choice-ru`; only the exact slug matches.
    const result = await list(
      "slugs=example-one-choice,quick-task,no-such-flow-248&visibility=public&limit=50",
    );
    expect(result.workflows.map((w) => `${w.ownerHandle}/${w.slug}`).sort()).toEqual([
      "moira/example-one-choice",
      "moira/quick-task",
    ]);
    expect(result.totalWorkflows).toBe(2);
  });

  test("a list of nothing but values no slug can be matches nothing", async () => {
    // A path, a phrase with a space, a wildcard, and a value shorter than the shortest slug the
    // shared slug rule allows.
    const result = await list(`slugs=${encodeURIComponent("../etc,QUICK TASK,%,ab")}`);
    expect(result.workflows).toEqual([]);
    expect(result.totalWorkflows).toBe(0);
  });
});
