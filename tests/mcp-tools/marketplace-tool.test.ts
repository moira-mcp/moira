/**
 * MCP E2E Tests — `marketplace` tool + library `list()` semantics.
 * Covers the agent path: publish → search → info → add → list(added) → start, plus
 * rate and the self-rating guard. Two fresh users (auto-assigned handles) so the
 * publisher/consumer split is real.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  createAuthenticatedMCPClient,
  callMCPTool,
  createTestUserViaApi,
} from "../utils/mcp-auth.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "TestPass123!";

function simpleWorkflow(name: string) {
  return {
    metadata: { name, version: "1.0.0", description: "marketplace tool test" },
    nodes: [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
    ],
  };
}

describe("MCP Marketplace Tool E2E", () => {
  let publisher: Client;
  let consumer: Client;
  const cleanups: Array<() => Promise<void>> = [];

  const flowName = `MP-Tool-Flow-${Date.now()}`;
  const publisherEmail = `mp-publisher-${Date.now()}@example.com`;
  const consumerEmail = `mp-consumer-${Date.now()}@example.com`;
  let ref = ""; // "handle/slug" of the published flow

  beforeAll(async () => {
    await createTestUserViaApi(BASE_URL, publisherEmail, PASSWORD, "MP Publisher");
    await createTestUserViaApi(BASE_URL, consumerEmail, PASSWORD, "MP Consumer");

    const pub = await createAuthenticatedMCPClient({ email: publisherEmail, password: PASSWORD });
    publisher = pub.client;
    cleanups.push(pub.cleanup);

    const con = await createAuthenticatedMCPClient({ email: consumerEmail, password: PASSWORD });
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

  test("publish produced a handle/slug reference", () => {
    expect(ref).toMatch(/^[^/]+\/[^/]+$/);
  });

  test("search finds the published flow", async () => {
    const res = await callMCPTool<{ results: Array<{ ref: string; title: string }> }>(
      consumer,
      "marketplace",
      { action: "search", q: flowName },
    );
    const hit = res.results.find((r) => r.ref === ref);
    expect(hit).toBeDefined();
    expect(hit?.title).toBe(flowName);
  });

  test("info returns accessible detail for the flow", async () => {
    const info = await callMCPTool<{
      ref: string;
      title: string;
      entitlement: { hasAccess: boolean };
    }>(consumer, "marketplace", { action: "info", ref });
    expect(info.ref).toBe(ref);
    expect(info.title).toBe(flowName);
    expect(info.entitlement.hasAccess).toBe(true);
  });

  test("add adopts the flow and it appears in the consumer's library", async () => {
    const added = await callMCPTool<{ added: boolean; kind: string }>(consumer, "marketplace", {
      action: "add",
      ref,
    });
    expect(added.added).toBe(true);
    expect(added.kind).toBe("reference");

    const lib = await callMCPTool<{ workflows: Array<{ id: string; origin: string }> }>(
      consumer,
      "list",
      { source: "added" },
    );
    const found = lib.workflows.find((w) => w.id === ref);
    expect(found).toBeDefined();
    expect(found?.origin).toBe("added");
  });

  test("start runs the added flow by its ref", async () => {
    const result = await callMCPTool<string>(consumer, "start", {
      workflowId: ref,
      parentExecutionId: "none",
    });
    const text = typeof result === "string" ? result : JSON.stringify(result);
    expect(text).not.toMatch(/^Error/);
  });

  test("rate records a rating from the consumer", async () => {
    const rated = await callMCPTool<{ rated: boolean; ratingAvg: number }>(
      consumer,
      "marketplace",
      {
        action: "rate",
        ref,
        stars: 5,
        review: "useful",
      },
    );
    expect(rated.rated).toBe(true);
    expect(rated.ratingAvg).toBeGreaterThan(0);
  });

  test("the author cannot rate their own flow", async () => {
    const res = await callMCPTool<string>(publisher, "marketplace", {
      action: "rate",
      ref,
      stars: 4,
    });
    const text = typeof res === "string" ? res : JSON.stringify(res);
    expect(text.toLowerCase()).toMatch(/own|self|cannot|forbidden|denied/);
  });

  test("list(source:official) returns the seeded official base flows startable by their id", async () => {
    const official = await callMCPTool<{ workflows: Array<{ id: string; origin: string }> }>(
      consumer,
      "list",
      { source: "official" },
    );
    expect(official.workflows.length).toBeGreaterThan(0);
    // The official base flows are seeded library entries (origin "added") owned by system-moira.
    expect(official.workflows.every((w) => w.origin === "added")).toBe(true);
    // They carry a "moira/<slug>" id — it must be startable.
    const first = official.workflows[0];
    expect(first.id).toMatch(/^moira\//);
    const started = await callMCPTool<string>(consumer, "start", {
      workflowId: first.id,
      parentExecutionId: "none",
    });
    const text = typeof started === "string" ? started : JSON.stringify(started);
    expect(text).not.toMatch(/^Error/);
  });
});
