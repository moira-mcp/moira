import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import {
  callMCPTool,
  callMCPToolRaw,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  formatSessionCookie,
  getAdminSessionCookie,
  signInUser,
} from "../utils/mcp-auth.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

describe("workflow content history across MCP and HTTP", () => {
  let client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  let cleanup: () => Promise<void>;
  let cookie: string;
  let foreignCookie: string;
  let workflowId: string;

  const request = async (
    suffix: string,
    options: { body?: unknown; who?: string; method?: string; identifier?: string } = {},
  ) => {
    const response = await fetch(
      `${BASE_URL}/api/workflows/${options.identifier ?? workflowId}${suffix}`,
      {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers: {
          Cookie: options.who ?? cookie,
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      },
    );
    return { status: response.status, json: (await response.json()) as any };
  };
  const historyRequest = (
    suffix: string,
    options: {
      body?: unknown;
      who?: string;
      method?: string;
      identity?: { kind: "by-id" | "by-slug" | "by-reference"; value: string };
    } = {},
  ) => {
    const identity = options.identity ?? { kind: "by-id", value: workflowId };
    return request(suffix, {
      ...options,
      identifier: `${identity.kind}/${identity.value}`,
    });
  };
  const get = () => callMCPTool<any>(client, "manage", { action: "get", workflowId });

  beforeAll(async () => {
    const auth = await createAuthenticatedMCPClient();
    client = auth.client;
    cleanup = auth.cleanup;
    cookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(getTestFetchUrl()));
    const email = `history-reader-${randomUUID()}@example.test`;
    const password = `Fixture-${randomUUID()}-Aa!`;
    const created = await createTestUserViaApi(
      getTestFetchUrl(),
      email,
      password,
      "History reader",
      true,
    );
    const features = (await (await fetch(`${getTestFetchUrl()}/api/features`)).json()) as any;
    if (features.data.features.accountApproval) {
      const approval = await fetch(
        `${getTestFetchUrl()}/api/admin/users/${created.userId}/approve`,
        { method: "POST", headers: { Cookie: cookie } },
      );
      expect(approval.status).toBe(200);
    }
    foreignCookie = formatSessionCookie(
      BASE_URL,
      await signInUser(getTestFetchUrl(), email, password),
    );
  });

  beforeEach(async () => {
    const result = await callMCPTool<any>(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: `History ${randomUUID()}`,
          description: "First description",
          version: "1.0.0",
        },
        variableRegistry: {
          tone: { type: "string", description: "Writing tone", default: "plain" },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "work" } },
          {
            id: "work",
            type: "agent-directive",
            directive: "Write in a {{tone}} tone",
            completionCondition: "Written",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      },
    });
    expect(result.success).toBe(true);
    workflowId = result.workflowId;
  });

  afterEach(async () => {
    if (workflowId) {
      const deleted = await fetch(`${BASE_URL}/api/admin/workflows/${workflowId}/hard-delete`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(deleted.status).toBe(200);
    }
  });

  afterAll(async () => cleanup());

  test.each(["history", "compare", "revisions"])(
    "definition readers preserve the legal slug %s independently of history operations",
    async (slug) => {
      expect((await request("", { identifier: `by-slug/${slug}` })).status).toBe(404);
      const renamed = await request("/slug", { method: "PATCH", body: { slug } });
      expect(renamed.status).toBe(200);
      const detail = await request("");
      const reference = `${encodeURIComponent(detail.json.data.fileInfo.ownerHandle)}/${slug}`;
      const reads = await Promise.all(
        [reference, `by-reference/${reference}`, `by-slug/${slug}`].map((identifier) =>
          request("", { identifier }),
        ),
      );
      expect(reads.map((read) => read.status)).toEqual([200, 200, 200]);
      for (const read of reads) {
        expect(read.json.data.workflow).toMatchObject({
          id: workflowId,
          metadata: { description: "First description" },
          nodes: expect.arrayContaining([expect.objectContaining({ id: "work" })]),
        });
      }
      for (const identity of [
        { kind: "by-id", value: workflowId },
        { kind: "by-reference", value: reference },
        { kind: "by-slug", value: slug },
      ] as const) {
        const history = await historyRequest("/history", { identity });
        expect(history.status).toBe(200);
        expect(history.json.data.revisions.map((row: any) => row.revision)).toEqual([1]);
        const stored = await historyRequest("/revisions/1", { identity });
        expect(stored.status).toBe(200);
        expect(JSON.parse(stored.json.data.content).id).toBe(workflowId);
        const comparison = await historyRequest("/compare?from=1&to=1", { identity });
        expect(comparison.status).toBe(200);
        expect(comparison.json.data.parts.every((part: any) => !part.added && !part.removed)).toBe(
          true,
        );
      }
      expect(
        (await historyRequest("/history", { identity: { kind: "by-id", value: slug } })).status,
      ).toBe(400);
      for (const identity of [
        { kind: "by-id", value: workflowId },
        { kind: "by-reference", value: reference },
        { kind: "by-slug", value: slug },
      ] as const) {
        const current = await get();
        const restored = await historyRequest("/rollback", {
          identity,
          body: { revision: 1, expectedRevision: current.revision },
        });
        expect(restored.status).toBe(200);
        expect(restored.json.data).toMatchObject({
          workflowId,
          revision: current.revision + 1,
          restoredFrom: 1,
        });
      }
    },
  );

  test("MCP exposes immutable content snapshots from non-edit mutations and restores one with its write guard", async () => {
    const first = await callMCPTool<any>(client, "manage", {
      action: "get-revision",
      workflowId,
      revision: 1,
    });
    expect(JSON.parse(first.content).variableRegistry.tone.default).toBe("plain");
    await callMCPTool(client, "manage", {
      action: "set-variable",
      workflowId,
      variableName: "tone",
      variableValue: "warm",
    });
    const current = await get();
    const history = await callMCPTool<any>(client, "manage", { action: "history", workflowId });
    expect(history.revisions.map((item: any) => item.revision)).toEqual([2, 1]);
    const difference = await callMCPTool<any>(client, "manage", {
      action: "compare-revisions",
      workflowId,
      fromRevision: 1,
      toRevision: 2,
    });
    expect(difference.parts.some((part: any) => part.added && part.value.includes("warm"))).toBe(
      true,
    );
    const restored = await callMCPTool<any>(client, "manage", {
      action: "rollback",
      workflowId,
      revision: 1,
      expectedRevision: current.revision,
    });
    expect(restored).toMatchObject({
      workflowId,
      restoredFrom: 1,
      historyRevision: 3,
      revision: current.revision + 1,
    });
    expect((await get()).variableRegistry.tone.default).toBe("plain");
    const firstAfter = await callMCPTool<any>(client, "manage", {
      action: "get-revision",
      workflowId,
      revision: 1,
    });
    expect(firstAfter.content).toBe(first.content);
    const stale = await callMCPToolRaw(client, "manage", {
      action: "rollback",
      workflowId,
      revision: 2,
      expectedRevision: current.revision,
    });
    expect(stale).toContain("WORKFLOW_REVISION_CONFLICT");
  });

  test("HTTP history supports canonical references, distinguishes absent revisions and applies guarded rollback", async () => {
    const edited = await callMCPTool<any>(client, "manage", {
      action: "edit",
      workflowId,
      changes: { metadata: { description: "Second description" } },
    });
    const detail = await request("");
    const reference = `${encodeURIComponent(detail.json.data.fileInfo.ownerHandle)}/${encodeURIComponent(detail.json.data.fileInfo.slug)}`;
    const listed = await historyRequest("/history", {
      identity: { kind: "by-reference", value: reference },
    });
    expect(listed.status).toBe(200);
    expect(listed.json.data.revisions.map((row: any) => row.revision)).toEqual([2, 1]);
    const stored = await historyRequest("/revisions/1");
    expect(stored.status).toBe(200);
    expect(JSON.parse(stored.json.data.content).metadata.description).toBe("First description");
    expect((await historyRequest("/revisions/999")).status).toBe(404);
    expect((await historyRequest("/revisions/0")).status).toBe(400);
    expect((await historyRequest("/compare?from=1&to=999")).status).toBe(404);
    const equal = await historyRequest("/compare?from=1&to=1");
    expect(equal.status).toBe(200);
    expect(equal.json.data.parts.every((part: any) => !part.added && !part.removed)).toBe(true);
    expect((await historyRequest("/rollback", { body: { revision: 1 } })).status).toBe(400);
    const restored = await historyRequest("/rollback", {
      identity: { kind: "by-reference", value: reference },
      body: { revision: 1, expectedRevision: edited.revision },
    });
    expect(restored.status).toBe(200);
    expect(restored.json.data).toMatchObject({
      workflowId,
      revision: edited.revision + 1,
      historyRevision: 3,
      restoredFrom: 1,
    });
    const historyBeforeConflict = (await historyRequest("/history")).json.data;
    const definitionBeforeConflict = await get();
    const stale = await historyRequest("/rollback", {
      body: { revision: 1, expectedRevision: edited.revision },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.details).toMatchObject({
      code: "WORKFLOW_REVISION_CONFLICT",
      workflowId,
      expectedRevision: edited.revision,
      currentRevision: restored.json.data.revision,
    });
    const definitionAfterConflict = await get();
    expect(definitionAfterConflict.metadata.description).toBe("First description");
    expect(definitionAfterConflict.revision).toBe(restored.json.data.revision);
    expect(definitionAfterConflict).toEqual(definitionBeforeConflict);
    expect((await historyRequest("/history")).json.data).toEqual(historyBeforeConflict);
  });

  test("publishing the current workflow does not expose private past definitions or rollback authority", async () => {
    expect((await historyRequest("/history", { who: foreignCookie })).status).toBe(404);
    await callMCPTool(client, "manage", {
      action: "set-visibility",
      workflowId,
      visibility: "public",
    });
    expect((await request("", { who: foreignCookie })).status).toBe(200);
    expect((await historyRequest("/history", { who: foreignCookie })).status).toBe(403);
    expect((await historyRequest("/revisions/1", { who: foreignCookie })).status).toBe(403);
    expect((await historyRequest("/compare?from=1&to=1", { who: foreignCookie })).status).toBe(403);
    expect(
      (
        await historyRequest("/rollback", {
          who: foreignCookie,
          body: { revision: 1, expectedRevision: 0 },
        })
      ).status,
    ).toBe(403);
    expect((await get()).revision).toBe(0);
  });
});
