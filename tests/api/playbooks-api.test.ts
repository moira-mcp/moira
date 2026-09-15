/**
 * Playbooks API.
 *
 * Covers the full life of a playbook through HTTP: writing revisions, reading a past one,
 * comparing, restoring, publishing, and what another person may do with it before and after
 * publication.
 *
 * Runs against Docker by default (localhost:DOCKER_PORT from .env).
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createTestUserViaApi, formatSessionCookie, signInUser } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

let ownerCookie: string;
let ownerHandle: string;
let readerCookie: string;
const name = `review-standard-${Date.now()}`;

async function api(
  path: string,
  init: RequestInit & { cookie: string },
): Promise<{ status: number; body: { success?: boolean; data?: Record<string, unknown> } }> {
  const { cookie, ...rest } = init;
  const res = await fetch(`${BASE_URL}/api/playbooks${path}`, {
    ...rest,
    headers: { Cookie: cookie, "Content-Type": "application/json", ...(rest.headers ?? {}) },
  });
  const body = res.status === 204 ? {} : await res.json();
  return {
    status: res.status,
    body: body as { success?: boolean; data?: Record<string, unknown> },
  };
}

describe("Playbooks API", () => {
  beforeAll(async () => {
    const ownerEmail = `playbook-owner-${Date.now()}@example.com`;
    const readerEmail = `playbook-reader-${Date.now()}@example.com`;
    const password = "TestUser123!";

    await createTestUserViaApi(BASE_URL, ownerEmail, password, "Playbook Owner");
    ownerCookie = formatSessionCookie(BASE_URL, await signInUser(BASE_URL, ownerEmail, password));

    await createTestUserViaApi(BASE_URL, readerEmail, password, "Playbook Reader");
    readerCookie = formatSessionCookie(BASE_URL, await signInUser(BASE_URL, readerEmail, password));

    const profile = await fetch(`${BASE_URL}/api/user/profile`, {
      headers: { Cookie: ownerCookie },
    });
    const parsed = (await profile.json()) as { data?: { handle?: string } };
    ownerHandle = parsed.data?.handle ?? "";
    expect(ownerHandle).not.toBe("");
  });

  afterAll(async () => {
    await api(`/${name}`, { method: "DELETE", cookie: ownerCookie });
  });

  test("writes revisions and reads a past one back", async () => {
    const first = await api(`/${name}`, {
      method: "PUT",
      cookie: ownerCookie,
      body: JSON.stringify({ content: "Read the diff.", title: "Review standard" }),
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ revision: 1 });

    const second = await api(`/${name}`, {
      method: "PUT",
      cookie: ownerCookie,
      body: JSON.stringify({ content: "Read the diff, not the summary." }),
    });
    expect(second.body.data).toMatchObject({ revision: 2 });

    const current = await api(`/${name}`, { cookie: ownerCookie });
    expect(current.body.data).toMatchObject({
      content: "Read the diff, not the summary.",
      revision: 2,
    });

    const past = await api(`/${name}?revision=1`, { cookie: ownerCookie });
    expect(past.body.data).toMatchObject({ content: "Read the diff.", revision: 1 });
  });

  test("lists the revisions and the difference between two of them", async () => {
    const history = await api(`/${name}/history`, { cookie: ownerCookie });
    expect((history.body.data?.revisions as unknown[]).length).toBe(2);

    const comparison = await api(`/${name}/compare?from=1&to=2`, { cookie: ownerCookie });
    const parts = comparison.body.data?.parts as Array<{ value: string; added: boolean }>;
    expect(parts.some((part) => part.added)).toBe(true);
  });

  test("restores a past revision as a new one", async () => {
    const restored = await api(`/${name}/restore`, {
      method: "POST",
      cookie: ownerCookie,
      body: JSON.stringify({ revision: 1 }),
    });
    expect(restored.body.data).toMatchObject({ revision: 3 });

    const current = await api(`/${name}`, { cookie: ownerCookie });
    expect(current.body.data).toMatchObject({ content: "Read the diff." });
  });

  test("hides a private playbook from another person and shows a published one", async () => {
    const before = await api(`/${name}?owner=${ownerHandle}`, { cookie: readerCookie });
    expect(before.status).toBe(404);

    const published = await api(`/${name}/visibility`, {
      method: "PUT",
      cookie: ownerCookie,
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(published.body.data).toMatchObject({ visibility: "public" });

    const after = await api(`/${name}?owner=${ownerHandle}`, { cookie: readerCookie });
    expect(after.status).toBe(200);
    expect(after.body.data).toMatchObject({ content: "Read the diff." });
  });

  test("a reader writing the same name gets their own playbook, not the author's", async () => {
    // Playbook names are per account, as note keys are: writing under a name somebody else also
    // uses creates your own playbook rather than changing theirs.
    const written = await api(`/${name}`, {
      method: "PUT",
      cookie: readerCookie,
      body: JSON.stringify({ content: "The reader's own wording." }),
    });
    expect(written.status).toBe(200);
    expect(written.body.data).toMatchObject({ revision: 1 });

    const authors = await api(`/${name}`, { cookie: ownerCookie });
    expect(authors.body.data).toMatchObject({ content: "Read the diff.", revision: 3 });

    const readers = await api(`/${name}`, { cookie: readerCookie });
    expect(readers.body.data).toMatchObject({ content: "The reader's own wording." });

    await api(`/${name}`, { method: "DELETE", cookie: readerCookie });
  });
});
