/**
 * GET /api/workflows?access=… — the flow list's tabs: whose flows are listed. `mine` is what the
 * reader owns, `shared` what an explicit grant gives them and they do not own, `catalog` the public
 * flows of others. Each is one query, so the total and every page agree with the scope under any
 * sort, and the scope combines with the other filters. The status filter is part of the same query:
 * a page holds only flows of the chosen status and the total counts exactly those.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createTestUserViaApi, formatSessionCookie, signInUser } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "TestPass123!";

type Item = {
  id: string;
  slug: string;
  ownerHandle: string;
  visibility: string;
  accessType: string;
  metadata: { name: string };
  validation: { status: string };
};
type Page = { workflows: Item[]; totalWorkflows: number };

async function freshUser(label: string): Promise<{ cookie: string }> {
  const email = `list-access-${label}-${Date.now()}@example.com`;
  await createTestUserViaApi(BASE_URL, email, PASSWORD, `List ${label}`);
  return { cookie: formatSessionCookie(BASE_URL, await signInUser(BASE_URL, email, PASSWORD)) };
}

async function createFlow(cookie: string, name: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      visibility: "private",
      workflow: {
        metadata: { name, version: "1.0.0", description: `${name} for the list tabs` },
        nodes: [
          { type: "start", id: "start", connections: { default: "end" } },
          { type: "end", id: "end" },
        ],
      },
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { workflowId: string } }).data.workflowId;
}

async function list(cookie: string, query: string): Promise<Page> {
  const response = await fetch(`${BASE_URL}/api/workflows?${query}`, {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: Page }).data;
}

describe("GET /api/workflows?access=", () => {
  let reader: { cookie: string };
  let other: { cookie: string };
  const mine: string[] = [];
  let sharedId: string;
  const cleanup: Array<{ id: string; cookie: string }> = [];

  beforeAll(async () => {
    reader = await freshUser("reader");
    other = await freshUser("other");
    for (const name of ["Tab Alpha", "Tab Bravo", "Tab Charlie"]) {
      const id = await createFlow(reader.cookie, name);
      mine.push(id);
      cleanup.push({ id, cookie: reader.cookie });
    }
    sharedId = await createFlow(other.cookie, "Tab Shared");
    cleanup.push({ id: sharedId, cookie: other.cookie });
    const invite = (await (
      await fetch(`${BASE_URL}/api/workflows/${sharedId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: other.cookie },
        body: JSON.stringify({}),
      })
    ).json()) as { data: { invite: { token: string } } };
    const accepted = await fetch(`${BASE_URL}/api/invites/${invite.data.invite.token}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: reader.cookie },
    });
    expect(accepted.ok).toBe(true);
  });

  afterAll(async () => {
    for (const { id, cookie } of cleanup) {
      await fetch(`${BASE_URL}/api/workflows/${id}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
    }
  });

  test("mine is exactly the reader's flows, and two pages under name sort continue each other", async () => {
    const all = await list(reader.cookie, "access=mine&sort=name&sortOrder=asc&limit=50");
    expect(all.totalWorkflows).toBe(3);
    expect(all.workflows.map((w) => w.id).sort()).toEqual([...mine].sort());
    expect(all.workflows.map((w) => w.metadata.name)).toEqual([
      "Tab Alpha",
      "Tab Bravo",
      "Tab Charlie",
    ]);

    const first = await list(reader.cookie, "access=mine&sort=name&sortOrder=asc&limit=2&offset=0");
    const second = await list(
      reader.cookie,
      "access=mine&sort=name&sortOrder=asc&limit=2&offset=2",
    );
    expect(first.totalWorkflows).toBe(3);
    expect(second.totalWorkflows).toBe(3);
    expect([...first.workflows, ...second.workflows].map((w) => w.metadata.name)).toEqual([
      "Tab Alpha",
      "Tab Bravo",
      "Tab Charlie",
    ]);
  });

  test("shared is what a grant gives the reader, not what they own", async () => {
    const shared = await list(reader.cookie, "access=shared&limit=50");
    expect(shared.workflows.map((w) => w.id)).toEqual([sharedId]);
    expect(shared.totalWorkflows).toBe(1);
    expect(shared.workflows[0].accessType).toBe("shared");
  });

  test("catalog is the public flows of others, paged without overlap", async () => {
    const first = await list(
      reader.cookie,
      "access=catalog&sort=name&sortOrder=asc&limit=5&offset=0",
    );
    const second = await list(
      reader.cookie,
      "access=catalog&sort=name&sortOrder=asc&limit=5&offset=5",
    );
    expect(first.totalWorkflows).toBeGreaterThan(5);
    for (const item of [...first.workflows, ...second.workflows]) {
      expect(item.visibility).toBe("public");
      expect(mine).not.toContain(item.id);
      expect(item.id).not.toBe(sharedId);
    }
    const firstIds = new Set(first.workflows.map((w) => w.id));
    expect(second.workflows.some((w) => firstIds.has(w.id))).toBe(false);
    const quickTask = await list(reader.cookie, "access=catalog&slugs=quick-task");
    expect(quickTask.workflows.map((w) => `${w.ownerHandle}/${w.slug}`)).toEqual([
      "moira/quick-task",
    ]);
  });

  test("the scope combines with the other filters", async () => {
    const publicMine = await list(reader.cookie, "access=mine&visibility=public&limit=50");
    expect(publicMine.workflows).toEqual([]);
    expect(publicMine.totalWorkflows).toBe(0);
    const searched = await list(reader.cookie, "access=mine&search=Bravo&limit=50");
    expect(searched.workflows.map((w) => w.metadata.name)).toEqual(["Tab Bravo"]);
    expect(searched.totalWorkflows).toBe(1);
  });

  test.each(["valid", "invalid", "unknown"])(
    "the %s status filter holds on the page and in the total",
    async (status) => {
      const page = await list(reader.cookie, `validationStatus=${status}&limit=100`);
      expect(page.workflows.every((w) => w.validation.status === status)).toBe(true);
      expect(page.totalWorkflows).toBe(page.workflows.length);
    },
  );
});
