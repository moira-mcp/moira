/**
 * Public MCP lock-node start behavior.
 * Successful trusted delivery and persisted re-entry use an injected sender in
 * repository integration tests; public runtime must fail closed without one.
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  callMCPToolRaw,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
} from "../utils/mcp-auth.js";
import { getTestFetchUrl } from "../utils/test-config.js";

function buildLockTestWorkflow() {
  return {
    metadata: {
      name: `Lock Step Integration ${Date.now()}`,
      version: "1.0.0",
      description: "Tests mandatory trusted delivery for lock nodes",
    },
    nodes: [
      { type: "start", id: "start", connections: { default: "lock-gate" } },
      {
        type: "lock",
        id: "lock-gate",
        reason: "Approval required before proceeding",
        connections: { unlocked: "end-success" },
      },
      { type: "end", id: "end-success" },
    ],
  };
}

describe("MCP Lock Step Integration", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let workflowId = "";
  const testUserEmail = `lock-step-${Date.now()}@test.local`;
  const testUserPassword = "LockStepTest123!";

  beforeAll(async () => {
    await createTestUserViaApi(
      getTestFetchUrl(),
      testUserEmail,
      testUserPassword,
      "Lock Step Test User",
    );
    const authenticated = await createAuthenticatedMCPClient({
      email: testUserEmail,
      password: testUserPassword,
    });
    client = authenticated.client;
    cleanup = authenticated.cleanup;

    const created = JSON.parse(
      await callMCPToolRaw(client, "manage", {
        action: "create",
        workflow: buildLockTestWorkflow(),
      }),
    );
    workflowId = created.workflowId;
  });

  afterAll(async () => {
    await cleanup();
  });

  test("lock workflow refuses to start without trusted Telegram delivery", async () => {
    const response = await callMCPToolRaw(client, "start", {
      workflowId,
      parentExecutionId: "none",
    });

    expect(response).toContain("lock nodes");
    expect(response).toContain("Telegram");
    expect(response).not.toContain("Process ID:");
    expect(response).not.toContain("lock_created");
  });

  test("skipTelegramCheck cannot bypass mandatory lock PIN delivery", async () => {
    const response = await callMCPToolRaw(client, "start", {
      workflowId,
      parentExecutionId: "none",
      skipTelegramCheck: true,
    });

    expect(response).toContain("skipTelegramCheck cannot bypass");
    expect(response).not.toContain("skipTelegramCheck: true");
    expect(response).not.toContain("Process ID:");
  });
});
