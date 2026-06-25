/**
 * API Tests — GET /api/workflows `ownedOnly` scope.
 *
 * The unified Workflows home's "Mine" origin lists only the user's OWN workflows. This is
 * driven by `?ownedOnly=true`, which must return ONLY the caller's own workflows (both
 * visibilities) and exclude other users' public workflows. The default (no `ownedOnly`)
 * preserves the legacy browse-all behavior (own + others' public + shared).
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();
const STAMP = Date.now();

interface ListItem {
  slug: string;
  metadata: { name: string };
  accessType: "owner" | "public" | "shared";
  visibility: "public" | "private";
  ownerHandle: string | null;
}

const A_PUBLIC = `OwnedScope A Public ${STAMP}`;
const A_PRIVATE = `OwnedScope A Private ${STAMP}`;
const B_PUBLIC = `OwnedScope B Public ${STAMP}`;

let cookieA = "";
let cookieB = "";

async function provisionUser(label: string): Promise<string> {
  const adminLogin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const adminCookie = adminLogin.headers.get("set-cookie") || "";

  const user = {
    email: `owned-scope-${label}-${STAMP}-${Math.random().toString(36).slice(2, 7)}@example.com`,
    password: "TestPass123!",
    name: `Owned Scope ${label}`,
    acceptedTermsAt: new Date().toISOString(),
    acceptedNotRussianResidentAt: new Date().toISOString(),
  };
  const signUp = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(user),
  });
  const id = ((await signUp.json()) as { user?: { id: string } }).user?.id;
  await fetch(`${BASE_URL}/api/admin/users/${id}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });
  const login = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  return login.headers.get("set-cookie") || "";
}

async function createWorkflow(cookie: string, name: string, visibility: "public" | "private") {
  const res = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      visibility,
      workflow: {
        metadata: { name, version: "1.0.0", description: "owned-scope test" },
        nodes: [
          { type: "start", id: "start", connections: { default: "end" } },
          { type: "end", id: "end" },
        ],
      },
    }),
  });
  expect(res.status).toBe(200);
}

async function listWorkflows(cookie: string, query: string): Promise<ListItem[]> {
  const res = await fetch(`${BASE_URL}/api/workflows?limit=100${query}`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  // Responses are wrapped: { success, data: { workflows }, timestamp }.
  const body = (await res.json()) as { data: { workflows: ListItem[] } };
  return body.data.workflows;
}

const names = (items: ListItem[]) => items.map((w) => w.metadata.name);

describe("GET /api/workflows — ownedOnly scope", () => {
  beforeAll(async () => {
    cookieA = await provisionUser("a");
    cookieB = await provisionUser("b");
    await createWorkflow(cookieA, A_PUBLIC, "public");
    await createWorkflow(cookieA, A_PRIVATE, "private");
    await createWorkflow(cookieB, B_PUBLIC, "public");
  });

  test("ownedOnly=true returns ONLY the caller's own workflows (both visibilities)", async () => {
    const items = await listWorkflows(cookieA, "&ownedOnly=true");
    const got = names(items);
    // A's own public + private are present; B's public is excluded.
    expect(got).toContain(A_PUBLIC);
    expect(got).toContain(A_PRIVATE);
    expect(got).not.toContain(B_PUBLIC);
    // Every returned item is owned by the caller (no public/shared rows leak in).
    expect(items.every((w) => w.accessType === "owner")).toBe(true);
  });

  test("default (no ownedOnly) preserves browse-all: includes another user's public flow", async () => {
    const items = await listWorkflows(cookieA, "");
    const got = names(items);
    expect(got).toContain(A_PUBLIC);
    expect(got).toContain(B_PUBLIC); // other user's public workflow visible by default
    expect(items.some((w) => w.accessType === "public")).toBe(true);
  });

  test("ownedOnly=true honors the visibility sub-filter (public only → own public)", async () => {
    const items = await listWorkflows(cookieA, "&ownedOnly=true&visibility=public");
    const got = names(items);
    expect(got).toContain(A_PUBLIC);
    expect(got).not.toContain(A_PRIVATE); // private excluded by the sub-filter
    expect(got).not.toContain(B_PUBLIC); // other user's public still excluded by ownedOnly
    expect(items.every((w) => w.accessType === "owner" && w.visibility === "public")).toBe(true);
  });
});
