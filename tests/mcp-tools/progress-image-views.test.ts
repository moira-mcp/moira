/**
 * The baked server has no paired file owner. Progress export reports that operational
 * precondition through MCP and HTTP, while authored view validation remains available.
 * Real owner-rendered PNGs and token lifetimes belong to the controller integration scenario.
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import {
  callMCPToolRaw,
  createAuthenticatedMCPClient,
  signInUser,
  startWorkflowExecutionState,
  type RunningWorkflowExecution,
} from "../utils/mcp-auth.js";
import { getAdminCredentials, getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

describe("progress image export views", () => {
  let client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  let cleanup: () => Promise<void>;
  let cookie: string;
  let run: RunningWorkflowExecution;

  beforeAll(async () => {
    const credentials = getAdminCredentials();
    const authenticated = await createAuthenticatedMCPClient();
    client = authenticated.client;
    cleanup = authenticated.cleanup;
    cookie = await signInUser(getTestFetchUrl(), credentials.email, credentials.password);
    run = await startWorkflowExecutionState(client, "moira/software-development-flow", {
      skipTelegramCheck: true,
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  test("MCP reports an unavailable file owner for valid export views and still refuses invalid options", async () => {
    for (const options of [
      {},
      { view: "process" },
      { view: "process", hide: ["health", "notify-plan-approval"], collapse: ["finalize"] },
    ]) {
      const result = await client.callTool({
        name: "execution",
        arguments: {
          action: "progress-image-token",
          executionId: run.processId,
          viewportWidth: 960,
          ...options,
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        success: false,
        code: "COMMUNICATION_OWNER_UNAVAILABLE",
        error: expect.stringMatching(/owner.*unavailable|available.*owner/i),
      });
      expect(result.structuredContent).not.toHaveProperty("downloadUrl");
    }

    const unknown = await callMCPToolRaw(client, "execution", {
      action: "progress-image-token",
      executionId: run.processId,
      hide: ["no-such-block"],
    });
    expect(unknown).toMatch(/hide names no block or node.*no-such-block/);
    await expect(
      callMCPToolRaw(client, "execution", {
        action: "progress-image-token",
        executionId: run.processId,
        view: "sepia",
      }),
    ).rejects.toMatchObject({ code: 400 });
  });

  test("HTTP distinguishes unavailable owner from invalid export parameters", async () => {
    const mintHttp = async (body: Record<string, unknown>) =>
      fetch(`${BASE_URL}/api/executions/${run.processId}/progress-image-token`, {
        method: "POST",
        headers: {
          Cookie: `better-auth.session_token=${cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const invalid = await mintHttp({ view: "process", hide: "health" });
    expect(invalid.status).toBe(400);
    const unknown = await mintHttp({ hide: ["no-such-block"] });
    expect(unknown.status).toBe(400);

    const unavailable = await mintHttp({
      view: "process",
      hide: ["health"],
      collapse: ["intake"],
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      success: false,
      error: {
        code: "COMMUNICATION_OWNER_UNAVAILABLE",
        message: expect.stringMatching(/owner.*unavailable|available.*owner/i),
      },
    });
  });
});
