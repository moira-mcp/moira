/**
 * MCP E2E (Step 10, D-O3) — the marketplace surface driven over the headless
 * persistent-token transport (NOT interactive OAuth). A persistent API token (`moira_…`)
 * is created via REST and used as the `/mcp` Bearer, so the marketplace MCP tools are
 * exercisable in CI without a browser OAuth flow.
 *
 * Verifies: the server EXPOSES the full marketplace tool set in tools/list (guards the
 * deployment-lag observation O2); and the marketplace tool actions + the `list` source
 * filter work end-to-end over the token transport with asserted responses, including the
 * self-install guard (D-N5) over MCP.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  createTestUserViaApi,
  createApiToken,
  createPersistentTokenMCPClient,
  callMCPTool,
  callMCPToolRaw,
} from "../utils/mcp-auth.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "TestPass123!";

// Every MCP tool the server must expose; the marketplace re-sync depends on these.
const EXPECTED_TOOLS = [
  "list",
  "start",
  "step",
  "manage",
  "help",
  "settings",
  "token",
  "session",
  "notes",
  "artifacts",
  "marketplace",
  "lock",
];

function simpleWorkflow(name: string) {
  return {
    metadata: { name, version: "1.0.0", description: "marketplace token-transport test" },
    nodes: [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
    ],
  };
}

describe("MCP marketplace over the persistent-token transport (Step 10)", () => {
  let publisher: Client;
  let consumer: Client;
  const cleanups: Array<() => Promise<void>> = [];

  const flowName = `MP-Token-Flow-${Date.now()}`;
  const publisherEmail = `mp-tok-pub-${Date.now()}@example.com`;
  const consumerEmail = `mp-tok-con-${Date.now()}@example.com`;
  let ref = "";

  beforeAll(async () => {
    await createTestUserViaApi(BASE_URL, publisherEmail, PASSWORD, "MP Token Publisher");
    await createTestUserViaApi(BASE_URL, consumerEmail, PASSWORD, "MP Token Consumer");

    // The dev/test token path: persistent API token → MCP Bearer (no OAuth).
    const pubToken = await createApiToken(BASE_URL, publisherEmail, PASSWORD, "mp-pub-token");
    const conToken = await createApiToken(BASE_URL, consumerEmail, PASSWORD, "mp-con-token");

    const pub = await createPersistentTokenMCPClient(pubToken.token);
    publisher = pub.client;
    cleanups.push(pub.cleanup);
    const con = await createPersistentTokenMCPClient(conToken.token);
    consumer = con.client;
    cleanups.push(con.cleanup);

    const created = await callMCPTool<{ workflowId: string }>(publisher, "manage", {
      action: "create",
      workflow: simpleWorkflow(flowName),
      overwrite: false,
    });
    const published = await callMCPTool<{ ref: string }>(publisher, "marketplace", {
      action: "publish",
      workflowId: created.workflowId,
      category: "development",
    });
    ref = published.ref;
  });

  afterAll(async () => {
    for (const c of cleanups) await c();
  });

  test("the server exposes the full marketplace tool set over the token transport", async () => {
    const listed = await consumer.listTools();
    const names = listed.tools.map((t) => t.name);
    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
    // The marketplace tool specifically (the re-sync's primary surface) is present.
    expect(names).toContain("marketplace");
  });

  test("marketplace search + info work over the token transport", async () => {
    const search = await callMCPTool<{ results: Array<{ ref: string; title: string }> }>(
      consumer,
      "marketplace",
      { action: "search", q: flowName },
    );
    expect(search.results.find((r) => r.ref === ref)?.title).toBe(flowName);

    const info = await callMCPTool<{ ref: string; entitlement: { hasAccess: boolean } }>(
      consumer,
      "marketplace",
      { action: "info", ref },
    );
    expect(info.ref).toBe(ref);
    expect(info.entitlement.hasAccess).toBe(true);
  });

  test("add + the list source filter work over the token transport", async () => {
    const added = await callMCPTool<{ added: boolean; kind: string }>(consumer, "marketplace", {
      action: "add",
      ref,
    });
    expect(added.added).toBe(true);

    // The `list` source filter partitions the library over the token transport.
    const addedList = await callMCPTool<{ workflows: Array<{ id: string; origin: string }> }>(
      consumer,
      "list",
      { source: "added" },
    );
    expect(addedList.workflows.find((w) => w.id === ref)?.origin).toBe("added");

    const official = await callMCPTool<{ workflows: Array<{ origin: string }> }>(consumer, "list", {
      source: "official",
    });
    expect(official.workflows.length).toBeGreaterThan(0);

    // The adopted reference is NOT owned by the consumer, so it is absent from `mine`.
    const mine = await callMCPTool<{ workflows: Array<{ id: string }> }>(consumer, "list", {
      source: "mine",
    });
    expect(mine.workflows.find((w) => w.id === ref)).toBeUndefined();
  });

  test("the author cannot install their own listing over the token transport (D-N5)", async () => {
    const res = await callMCPToolRaw(publisher, "marketplace", { action: "add", ref });
    expect(res.toLowerCase()).toMatch(/own|self|install|forbidden|denied/);
  });
});
