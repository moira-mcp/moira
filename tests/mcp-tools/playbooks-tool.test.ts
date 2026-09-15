/**
 * MCP E2E Tests — Playbooks Tool
 *
 * An agent's view of the registry: writing reusable behaviour text, reading it back at a past
 * revision, seeing what changed, restoring, and publishing it for other accounts to read.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { callMCPTool, createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP Playbooks Tool E2E", () => {
  let client: Client;
  let cleanup: (() => Promise<void>) | undefined;
  const name = `agent-review-standard-${Date.now()}`;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
  });

  afterAll(async () => {
    try {
      await callMCPTool(client, "playbooks", { action: "delete", name });
    } catch {
      // The playbook may already be gone; cleanup failures are not the subject here.
    }
    await cleanup?.();
  });

  test("saves a playbook and reads it back", async () => {
    const saved = await callMCPTool(client, "playbooks", {
      action: "save",
      name,
      content: "State the observable consequence before asking for a change.",
      title: "Review standard",
    });
    expect(saved).toMatchObject({ revision: 1, created: true });

    const read = await callMCPTool(client, "playbooks", { action: "get", name });
    expect(read).toMatchObject({
      name,
      revision: 1,
      content: "State the observable consequence before asking for a change.",
    });
  });

  test("keeps every revision and can compare and restore them", async () => {
    await callMCPTool(client, "playbooks", {
      action: "save",
      name,
      content: "State the observable consequence.\nName the contract it violates.\n",
    });

    const history = (await callMCPTool(client, "playbooks", { action: "history", name })) as {
      revisions: Array<{ revision: number }>;
    };
    expect(history.revisions.map((entry) => entry.revision)).toEqual([2, 1]);

    const comparison = (await callMCPTool(client, "playbooks", {
      action: "compare",
      name,
      fromRevision: 1,
      toRevision: 2,
    })) as { parts: Array<{ value: string; added: boolean; removed: boolean }> };
    expect(comparison.parts.some((part) => part.added)).toBe(true);

    const restored = await callMCPTool(client, "playbooks", {
      action: "restore",
      name,
      revision: 1,
    });
    expect(restored).toMatchObject({ revision: 3, restoredFrom: 1 });
  });

  test("lists the playbooks of the calling account", async () => {
    const listed = (await callMCPTool(client, "playbooks", { action: "list" })) as {
      playbooks: Array<{ name: string }>;
      total: number;
    };
    expect(listed.playbooks.some((entry) => entry.name === name)).toBe(true);
    expect(listed.total).toBeGreaterThan(0);
  });

  test("publishes a playbook and makes it private again", async () => {
    const published = await callMCPTool(client, "playbooks", {
      action: "visibility",
      name,
      visibility: "public",
    });
    expect(published).toMatchObject({ visibility: "public" });

    const hidden = await callMCPTool(client, "playbooks", {
      action: "visibility",
      name,
      visibility: "private",
    });
    expect(hidden).toMatchObject({ visibility: "private" });
  });

  test("refuses a name a workflow node could not reference", async () => {
    // The tool answers with the refusal rather than throwing, as the other Moira tools do.
    const refused = await callMCPTool(client, "playbooks", {
      action: "save",
      name: "Not A Valid Name",
      content: "x",
    });
    expect(String(refused)).toMatch(/lower-case letters/);
  });
});
