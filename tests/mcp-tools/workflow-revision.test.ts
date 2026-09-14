/**
 * The workflow definition revision across the agent and page paths: `manage get` and `edit`
 * carry it, `edit` with a stale `expectedRevision` is refused and without one still saves, a
 * file upload over the workflow and a non-`edit` mutation (`set-variable`) advance it, so a page save carrying the pre-mutation
 * revision is refused with 409; a stranger's save is refused (404 while private, 403 once public).
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import {
  callMCPTool,
  callMCPToolRaw,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  parseTokenResponse,
  signInUser,
} from "../utils/mcp-auth.js";
import { getAdminCredentials, getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

describe("workflow definition revision", () => {
  let client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  let cleanup: () => Promise<void>;
  let cookie: string;
  let foreignCookie: string;
  let workflowId: string;

  const put = async (who: string, body: Record<string, unknown>) => {
    const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      method: "PUT",
      headers: { Cookie: `better-auth.session_token=${who}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as any };
  };
  const get = () => callMCPTool<any>(client, "manage", { action: "get", workflowId });

  beforeAll(async () => {
    const credentials = getAdminCredentials();
    const authenticated = await createAuthenticatedMCPClient();
    client = authenticated.client;
    cleanup = authenticated.cleanup;
    cookie = await signInUser(getTestFetchUrl(), credentials.email, credentials.password);

    const foreignEmail = `workflow-revision-foreign-${randomUUID()}@example.com`;
    const foreignPassword = "TestPass123!";
    const foreignUser = await createTestUserViaApi(
      getTestFetchUrl(),
      foreignEmail,
      foreignPassword,
      "Workflow Revision Foreign User",
      true,
    );
    const features = (await (await fetch(`${getTestFetchUrl()}/api/features`)).json()) as {
      data: { features: { accountApproval: boolean } };
    };
    if (features.data.features.accountApproval) {
      const approval = await fetch(
        `${getTestFetchUrl()}/api/admin/users/${foreignUser.userId}/approve`,
        { method: "POST", headers: { Cookie: `better-auth.session_token=${cookie}` } },
      );
      expect(approval.status).toBe(200);
    }
    foreignCookie = await signInUser(getTestFetchUrl(), foreignEmail, foreignPassword);

    const created = await callMCPTool<any>(client, "manage", {
      action: "create",
      workflow: {
        metadata: { name: "Revision Test", version: "1.0.0", description: "revision guard" },
        variableRegistry: { tone: { type: "string", description: "Tone", default: "plain" } },
        nodes: [
          { type: "start", id: "start", connections: { default: "work" } },
          {
            type: "agent-directive",
            id: "work",
            directive: "Write in a {{tone}} tone",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      },
    });
    expect(created.success).toBe(true);
    workflowId = created.workflowId;
  });

  afterAll(async () => {
    if (workflowId) await callMCPTool(client, "manage", { action: "delete", workflowId });
    await cleanup();
  });

  test("get carries the revision; edit refuses a stale expectedRevision and saves without one", async () => {
    expect((await get()).revision).toBe(0);

    const stale = await callMCPToolRaw(client, "manage", {
      action: "edit",
      workflowId,
      expectedRevision: 5,
      changes: { metadata: { description: "must not land" } },
    });
    expect(stale).toMatch(/revision conflict/i);
    expect(stale).toContain("stored 0");
    expect((await get()).metadata.description).toBe("revision guard");

    const guarded = await callMCPTool<any>(client, "manage", {
      action: "edit",
      workflowId,
      expectedRevision: 0,
      changes: { metadata: { description: "guarded edit" } },
    });
    expect(guarded.success).toBe(true);
    expect(guarded.revision).toBe(1);

    const unguarded = await callMCPTool<any>(client, "manage", {
      action: "edit",
      workflowId,
      changes: { metadata: { description: "unguarded edit" } },
    });
    expect(unguarded.success).toBe(true);
    expect(unguarded.revision).toBe(2);
    expect((await get()).revision).toBe(2);
  });

  test("a file upload over an existing workflow is a graph write: the revision advances", async () => {
    const before = await get();
    const minted = parseTokenResponse(
      await callMCPTool<string>(client, "token", { action: "upload", ttlMinutes: 10 }),
    );
    const form = new FormData();
    form.append(
      "workflow",
      new Blob(
        [
          JSON.stringify({
            id: workflowId,
            metadata: { ...before.metadata, description: "uploaded over" },
            variableRegistry: before.variableRegistry,
            nodes: before.nodes,
          }),
        ],
        { type: "application/json" },
      ),
      "workflow.json",
    );
    form.append("visibility", "private");
    const uploaded = await fetch(minted.uploadUrl!, { method: "POST", body: form });
    expect(uploaded.status).toBe(200);
    const after = await get();
    expect(after.metadata.description).toBe("uploaded over");
    expect(after.revision).toBe(before.revision + 1);
  });

  test("a non-edit mutation advances the revision, so a page save prepared before it is refused", async () => {
    const before = await get();
    const pageGraph = {
      metadata: before.metadata,
      variableRegistry: before.variableRegistry,
      nodes: before.nodes,
    };

    const mutated = await callMCPTool<any>(client, "manage", {
      action: "set-variable",
      workflowId,
      variableName: "tone",
      variableValue: "warm",
    });
    expect(mutated.success).toBe(true);
    const after = await get();
    expect(after.revision).toBe(before.revision + 1);

    const stale = await put(cookie, { workflow: pageGraph, expectedRevision: before.revision });
    expect(stale.status).toBe(409);

    // A private workflow is invisible to a stranger (404); once public, the stranger may read it
    // but not save it (403). The visibility change writes no graph, so the revision holds.
    const hidden = await put(foreignCookie, {
      workflow: pageGraph,
      expectedRevision: after.revision,
    });
    expect(hidden.status).toBe(404);
    const published = await callMCPTool<any>(client, "manage", {
      action: "set-visibility",
      workflowId,
      visibility: "public",
    });
    expect(published.success).toBe(true);
    expect((await get()).revision).toBe(after.revision);
    const foreign = await put(foreignCookie, {
      workflow: pageGraph,
      expectedRevision: after.revision,
    });
    expect(foreign.status).toBe(403);

    const fresh = await put(cookie, {
      workflow: { ...pageGraph, variableRegistry: after.variableRegistry },
      expectedRevision: after.revision,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.json.data.revision).toBe(after.revision + 1);
    expect((await get()).revision).toBe(after.revision + 1);
  });
});
