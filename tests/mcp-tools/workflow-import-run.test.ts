/**
 * MCP-tools: an imported flow is RUNNABLE (Step 16). One user exports a flow, imports
 * the file into their library via the HTTP endpoint (no cloud call), then starts the
 * imported workflow through the MCP `start` tool — proving the offline-adopted flow
 * runs exactly like any owned flow.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  createAuthenticatedMCPClient,
  callMCPTool,
  createTestUserViaApi,
  signInUser,
} from "../utils/mcp-auth.js";
import { getTestFetchUrl } from "../utils/test-config.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const FETCH_URL = getTestFetchUrl();
const stamp = Date.now();
const USER = { email: `mcp-import-${stamp}@example.com`, password: "TestPass123!" };

function cookieHeader(value: string): string {
  const name = FETCH_URL.startsWith("https://")
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
  return `${name}=${value}`;
}

describe("MCP: imported flow is runnable", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let cookie: string;

  beforeAll(async () => {
    await createTestUserViaApi(FETCH_URL, USER.email, USER.password, true);
    cookie = cookieHeader(await signInUser(FETCH_URL, USER.email, USER.password));
    const mcp = await createAuthenticatedMCPClient({
      email: USER.email,
      password: USER.password,
      verifyEmail: false,
    });
    client = mcp.client;
    cleanup = mcp.cleanup;
  });

  afterAll(async () => {
    await cleanup?.();
  });

  test("export → import → start runs the imported workflow", async () => {
    // Create a source flow and export it.
    const created = await fetch(`${FETCH_URL}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        workflow: {
          metadata: { name: `MCP Import Run ${stamp}`, version: "1.0.0", description: "d" },
          nodes: [
            { id: "start", type: "start", connections: { default: "end" } },
            { id: "end", type: "end" },
          ],
        },
      }),
    });
    const sourceId = ((await created.json()) as { data: { workflowId: string } }).data.workflowId;

    const exported = await fetch(`${FETCH_URL}/api/workflows/${sourceId}/export`, {
      headers: { Cookie: cookie },
    });
    const fileText = await exported.text();

    // Import the file into the library (offline adoption, no cloud call).
    const form = new FormData();
    form.append("workflow", new Blob([fileText], { type: "application/json" }), "flow.moira.json");
    const importRes = await fetch(`${FETCH_URL}/api/marketplace/import`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });
    expect(importRes.status).toBe(201);
    const importedId = ((await importRes.json()) as { data: { workflowId: string } }).data
      .workflowId;
    expect(importedId).not.toBe(sourceId);

    // Start the IMPORTED flow via MCP — it runs like any owned flow.
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: importedId,
    });
    expect(typeof startResult).toBe("string");
    expect(startResult.length).toBeGreaterThan(0);
    // The start response carries the new execution's process id.
    expect(startResult).toMatch(/process/i);
  });
});
