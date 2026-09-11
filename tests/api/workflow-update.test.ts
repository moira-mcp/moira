/**
 * API Tests - PUT /api/workflows/:id
 * Replacing an owned workflow's definition against its revision: the GET carries the revision,
 * a matching expectedRevision saves and advances it (the response carries the new revision and
 * the derived process), a create with `overwrite` advances it like any graph write, a stale one is
 * refused with 409 and an invalid graph with 400, neither touching the stored definition. Ownership refusal (403) is covered with a second user in the
 * MCP suite (`tests/mcp-tools/workflow-revision.test.ts`).
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

const definition = (directive: string) => ({
  metadata: { name: "Update Route Test", version: "1.0.0", description: "PUT workflow" },
  nodes: [
    { type: "start", id: "start", connections: { default: "work" } },
    {
      type: "agent-directive",
      id: "work",
      directive,
      completionCondition: "Done",
      connections: { success: "end" },
    },
    { type: "end", id: "end" },
  ],
});

describe("PUT /api/workflows/:id", () => {
  let authCookie: string;
  let workflowId: string;

  const get = async () => {
    const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as any).data;
  };
  const put = async (body: unknown) => {
    const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as any };
  };

  beforeAll(async () => {
    const signin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });
    authCookie = signin.headers.get("set-cookie")!;
    expect(authCookie).toBeTruthy();

    const created = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ visibility: "private", workflow: definition("First wording") }),
    });
    expect(created.status).toBe(200);
    workflowId = ((await created.json()) as any).data.workflowId;
  });

  afterAll(async () => {
    if (workflowId) {
      await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
        method: "DELETE",
        headers: { Cookie: authCookie },
      });
    }
  });

  test("saves against the current revision, advances it, and returns the derived process", async () => {
    const before = await get();
    expect(before.fileInfo.revision).toBe(0);

    const saved = await put({
      workflow: { ...before.workflow, ...definition("Second wording") },
      expectedRevision: before.fileInfo.revision,
    });
    expect(saved.status).toBe(200);
    expect(saved.json.data.revision).toBe(1);
    expect(saved.json.data.workflowId).toBe(workflowId);
    expect(saved.json.data).toHaveProperty("process");
    expect(saved.json.data.validation.isValid).toBe(true);

    const after = await get();
    expect(after.fileInfo.revision).toBe(1);
    expect(after.fileInfo.visibility).toBe("private");
    expect(after.workflow.nodes.find((n: any) => n.id === "work").directive).toBe("Second wording");
  });

  test("a create with overwrite is a graph write too: it advances the revision the page must then send", async () => {
    const before = await get();
    const overwritten = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({
        id: workflowId,
        overwrite: true,
        visibility: "private",
        workflow: { ...before.workflow, ...definition("Overwritten wording") },
      }),
    });
    expect(overwritten.status).toBe(200);
    const after = await get();
    expect(after.fileInfo.revision).toBe(before.fileInfo.revision + 1);

    const stale = await put({
      workflow: { ...after.workflow, ...definition("Second wording") },
      expectedRevision: before.fileInfo.revision,
    });
    expect(stale.status).toBe(409);
    const fresh = await put({
      workflow: { ...after.workflow, ...definition("Second wording") },
      expectedRevision: after.fileInfo.revision,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.json.data.revision).toBe(after.fileInfo.revision + 1);
  });

  test("refuses a stale revision with 409 and an invalid graph with 400, leaving the definition alone", async () => {
    const current = await get();
    const stale = await put({
      workflow: { ...current.workflow, ...definition("Stale wording") },
      expectedRevision: current.fileInfo.revision - 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.details.currentRevision).toBe(current.fileInfo.revision);

    const invalid = await put({
      workflow: {
        ...current.workflow,
        nodes: current.workflow.nodes.map((n: any) =>
          n.id === "start" ? { ...n, connections: { default: "missing" } } : n,
        ),
      },
      expectedRevision: current.fileInfo.revision,
    });
    expect(invalid.status).toBe(400);

    const missing = await put({ workflow: current.workflow });
    expect(missing.status).toBe(400);

    const after = await get();
    expect(after.fileInfo.revision).toBe(current.fileInfo.revision);
    expect(after.workflow.nodes.find((n: any) => n.id === "work").directive).toBe("Second wording");
  });
});
