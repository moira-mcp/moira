/**
 * API: the self-host offline transfer endpoints (Step 16), over HTTP against the
 * Docker container.
 *
 *   - GET  /api/workflows/:id/export   downloads a flow as a JSON attachment.
 *   - POST /api/marketplace/import     imports an uploaded flow file into the library
 *                                      (no cloud call); the copy lands in the library.
 *
 * Round-trips a flow through export → import and asserts the imported copy is an
 * independent workflow that appears in the caller's library.
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();
const stamp = Date.now();

const USER = {
  email: `api-xfer-${stamp}@example.com`,
  password: "TestPass123!",
  name: "API Transfer User",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let cookie = "";

async function adminCookie(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  return res.headers.get("set-cookie") || "";
}

async function createWorkflow(name: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      workflow: {
        metadata: { name, version: "1.0.0", description: "transfer test flow" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    }),
  });
  const data = (await res.json()) as { data?: { workflowId?: string } };
  return data.data?.workflowId ?? "";
}

beforeAll(async () => {
  const admin = await adminCookie();
  const signUp = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(USER),
  });
  const data = (await signUp.json()) as { user?: { id: string } };
  await fetch(`${BASE_URL}/api/admin/users/${data.user?.id}/verify-email`, {
    method: "POST",
    headers: { Cookie: admin },
  });
  const signIn = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: USER.email, password: USER.password }),
  });
  cookie = signIn.headers.get("set-cookie") || "";
});

describe("Workflow export + import (self-host file transfer)", () => {
  test("GET /api/workflows/:id/export downloads the flow as a JSON attachment", async () => {
    const name = `Export Me ${stamp}`;
    const workflowId = await createWorkflow(name);

    const res = await fetch(`${BASE_URL}/api/workflows/${workflowId}/export`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename=".+\.moira\.json"/,
    );

    const graph = (await res.json()) as { metadata: { name: string }; nodes: unknown[] };
    expect(graph.metadata.name).toBe(name);
    expect(graph.nodes).toHaveLength(2);
  });

  test("export → import round-trips into an independent library copy", async () => {
    const name = `RoundTrip ${stamp}`;
    const sourceId = await createWorkflow(name);

    const exported = await fetch(`${BASE_URL}/api/workflows/${sourceId}/export`, {
      headers: { Cookie: cookie },
    });
    const fileText = await exported.text();

    const form = new FormData();
    form.append("workflow", new Blob([fileText], { type: "application/json" }), "flow.moira.json");
    const imported = await fetch(`${BASE_URL}/api/marketplace/import`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });
    expect(imported.status).toBe(201);
    const result = (await imported.json()) as {
      data: { workflowId: string; slug: string; name: string };
    };
    expect(result.data.name).toBe(name);
    // The import is an independent copy — a fresh workflow id, not the source.
    expect(result.data.workflowId).not.toBe(sourceId);

    // The imported copy appears in the caller's library.
    const lib = await fetch(`${BASE_URL}/api/marketplace/me/library`, {
      headers: { Cookie: cookie },
    });
    const items = ((await lib.json()) as { data: { items: Array<{ workflowId: string }> } }).data
      .items;
    expect(items.some((i) => i.workflowId === result.data.workflowId)).toBe(true);
  });

  test("rejects a non-JSON / non-workflow file with 400", async () => {
    const badJson = new FormData();
    badJson.append("workflow", new Blob(["not json"], { type: "application/json" }), "bad.json");
    const r1 = await fetch(`${BASE_URL}/api/marketplace/import`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: badJson,
    });
    expect(r1.status).toBe(400);

    const notFlow = new FormData();
    notFlow.append(
      "workflow",
      new Blob([JSON.stringify({ hello: "world" })], { type: "application/json" }),
      "notflow.json",
    );
    const r2 = await fetch(`${BASE_URL}/api/marketplace/import`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: notFlow,
    });
    expect(r2.status).toBe(400);
  });

  test("import requires authentication (401 without a session)", async () => {
    const form = new FormData();
    form.append(
      "workflow",
      new Blob([JSON.stringify({ metadata: { name: "x" }, nodes: [] })], {
        type: "application/json",
      }),
      "flow.json",
    );
    const res = await fetch(`${BASE_URL}/api/marketplace/import`, { method: "POST", body: form });
    expect(res.status).toBe(401);
  });
});
