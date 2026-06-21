/**
 * MCP E2E Tests - Execution Audit Logging
 * Verifies that EXECUTION_STEP and EXECUTION_COMPLETE events are logged
 * during workflow execution via MCPEngine (Step 1 of audit-completion)
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  createAuthenticatedMCPClient,
  callMCPTool,
  getAdminSessionCookie,
} from "../utils/mcp-auth.js";
import { MCP_TEST_WORKFLOWS } from "../fixtures/mcp-workflows.js";
import { MCP_TEST_DATA } from "../fixtures/mcp-test-data.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();
const { SIMPLE_LINEAR } = MCP_TEST_WORKFLOWS;
const { EXECUTION_INPUTS } = MCP_TEST_DATA;

interface AuditLogEntry {
  id: string;
  userId: string;
  action: string;
  resource: string;
  resourceId: string;
  metadata: string | null;
  createdAt: number;
}

interface AuditLogApiResponse {
  success: boolean;
  data: {
    entries: AuditLogEntry[];
    totalCount: number;
    limit: number;
    offset: number;
  };
}

/**
 * Get the session cookie name based on the URL protocol.
 */
function getSessionCookieName(baseUrl: string): string {
  const isSecure = baseUrl.startsWith("https://");
  return isSecure ? "__Secure-better-auth.session_token" : "better-auth.session_token";
}

describe("MCP Execution Audit Logging E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let adminSessionCookie: string;
  let workflowId: string;
  const createdWorkflows: string[] = [];

  beforeAll(async () => {
    // Create authenticated MCP client
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;

    // Get admin session cookie for audit log API using shared helper
    adminSessionCookie = await getAdminSessionCookie(FETCH_URL);

    // Create test workflow - extract workflow without hardcoded id
    const { id: _unusedId, ...workflowWithoutId } = SIMPLE_LINEAR.workflow;
    const createResult = await callMCPTool<{ workflowId: string }>(client, "manage", {
      action: "create",
      workflow: workflowWithoutId,
    });
    workflowId = createResult.workflowId;
    createdWorkflows.push(workflowId);
  });

  afterAll(async () => {
    // Cleanup created workflows
    for (const workflowId of createdWorkflows) {
      try {
        await callMCPTool(client, "manage", {
          action: "edit",
          workflowId,
          changes: { removeNodes: ["*"] }, // This won't work, but we try
        });
      } catch {
        // Ignore cleanup errors
      }
    }
    await cleanup();
  });

  /**
   * Helper to wait for a condition with retry
   */
  async function waitFor<T>(
    fn: () => Promise<T>,
    predicate: (result: T) => boolean,
    { timeout = 5000, interval = 200 } = {},
  ): Promise<T> {
    const start = Date.now();
    let lastResult: T;

    while (Date.now() - start < timeout) {
      lastResult = await fn();
      if (predicate(lastResult)) {
        return lastResult;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    return lastResult!;
  }

  /**
   * Helper to fetch audit logs with filter
   */
  async function getAuditLogs(params: {
    action?: string;
    resourceId?: string;
    limit?: number;
  }): Promise<AuditLogEntry[]> {
    const searchParams = new URLSearchParams();
    if (params.action) searchParams.set("action", params.action);
    if (params.resourceId) searchParams.set("resourceId", params.resourceId);
    if (params.limit) searchParams.set("limit", String(params.limit));

    const cookieName = getSessionCookieName(FETCH_URL);
    const response = await fetch(`${FETCH_URL}/api/admin/audit-log?${searchParams.toString()}`, {
      headers: {
        Cookie: `${cookieName}=${adminSessionCookie}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch audit logs: ${response.status} - ${text}`);
    }

    const json = (await response.json()) as AuditLogApiResponse;
    if (!json.success) {
      throw new Error(`Audit log API returned error`);
    }

    return json.data.entries;
  }

  test("execution:start is logged when workflow starts", async () => {
    // Start workflow
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId,
    });

    // Extract process ID
    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    expect(processIdMatch).toBeDefined();
    const processId = processIdMatch![1];

    // Wait for audit log entry with retry (async logging may have delay)
    const auditLogs = await waitFor(
      () =>
        getAuditLogs({
          action: "execution:start",
          resourceId: processId,
          limit: 10,
        }),
      (logs) => logs.some((l) => l.resourceId === processId),
      { timeout: 5000, interval: 300 },
    );

    expect(auditLogs.length).toBeGreaterThan(0);
    const startLog = auditLogs.find((l) => l.resourceId === processId);
    expect(startLog).toBeDefined();
    expect(startLog!.action).toBe("execution:start");
    expect(startLog!.resource).toBe("execution");

    // Verify metadata
    const metadata = JSON.parse(startLog!.metadata || "{}");
    expect(metadata.workflowId).toBe(workflowId);

    console.log(`✓ execution:start logged for process ${processId}`);
  });

  test("execution:step is logged when node transitions", async () => {
    // Start workflow
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    expect(processIdMatch).toBeDefined();
    const processId = processIdMatch![1];

    // Execute step (should cause node transition)
    await callMCPTool<string>(client, "step", {
      processId,
      input: EXECUTION_INPUTS.STEP1_SIMPLE,
    });

    // Wait for execution:step audit log with retry
    const stepLogs = await waitFor(
      () =>
        getAuditLogs({
          action: "execution:step",
          resourceId: processId,
          limit: 10,
        }),
      (logs) => logs.some((l) => l.resourceId === processId),
      { timeout: 5000, interval: 300 },
    );

    expect(stepLogs.length).toBeGreaterThan(0);

    // Find the step log for this specific execution
    const stepLog = stepLogs.find((l) => l.resourceId === processId);
    expect(stepLog).toBeDefined();
    expect(stepLog!.action).toBe("execution:step");

    // Verify metadata contains node transition info
    const metadata = JSON.parse(stepLog!.metadata || "{}");
    expect(metadata.workflowId).toBe(workflowId);
    expect(metadata).toHaveProperty("fromNodeId");
    expect(metadata).toHaveProperty("toNodeId");

    // Verify input is recorded in metadata
    expect(metadata).toHaveProperty("input");
    expect(metadata.input).toEqual(EXECUTION_INPUTS.STEP1_SIMPLE);

    console.log(
      `✓ execution:step logged: ${metadata.fromNodeId} -> ${metadata.toNodeId}, input: ${JSON.stringify(metadata.input)}`,
    );
  });

  test("execution:complete is logged when workflow finishes", async () => {
    // Start workflow
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    expect(processIdMatch).toBeDefined();
    const processId = processIdMatch![1];

    // Execute step1
    await callMCPTool<string>(client, "step", {
      processId,
      input: EXECUTION_INPUTS.STEP1_SIMPLE,
    });

    // Execute step2 (should complete workflow)
    const step2Result = await callMCPTool<string>(client, "step", {
      processId,
      input: EXECUTION_INPUTS.STEP2_SIMPLE,
    });

    // Verify workflow completed
    expect(step2Result).toContain("Workflow completed");

    // Wait for execution:complete audit log with retry
    const auditLogs = await waitFor(
      () =>
        getAuditLogs({
          action: "execution:complete",
          resourceId: processId,
          limit: 10,
        }),
      (logs) => logs.some((l) => l.resourceId === processId),
      { timeout: 5000, interval: 300 },
    );

    expect(auditLogs.length).toBeGreaterThan(0);
    const completeLog = auditLogs.find((l) => l.resourceId === processId);
    expect(completeLog).toBeDefined();
    expect(completeLog!.action).toBe("execution:complete");

    // Verify metadata
    const metadata = JSON.parse(completeLog!.metadata || "{}");
    expect(metadata.workflowId).toBe(workflowId);
    expect(metadata).toHaveProperty("completedAt");

    console.log(`✓ execution:complete logged for process ${processId}`);
  });

  test("full workflow audit trail", async () => {
    // Run a complete workflow and verify full audit trail
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: workflowId,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    const processId = processIdMatch![1];

    // Execute both steps
    await callMCPTool<string>(client, "step", {
      processId,
      input: EXECUTION_INPUTS.STEP1_SIMPLE,
    });
    await callMCPTool<string>(client, "step", {
      processId,
      input: EXECUTION_INPUTS.STEP2_SIMPLE,
    });

    // Wait for all audit events with retry (need start, step, and complete)
    const allLogs = await waitFor(
      () =>
        getAuditLogs({
          resourceId: processId,
          limit: 100,
        }),
      (logs) => {
        const actions = logs.map((l) => l.action);
        return (
          actions.includes("execution:start") &&
          actions.includes("execution:step") &&
          actions.includes("execution:complete")
        );
      },
      { timeout: 5000, interval: 300 },
    );

    const actions = allLogs.map((l) => l.action).sort();

    // Should have: execution:start, execution:step (at least once), execution:complete
    expect(actions).toContain("execution:start");
    expect(actions).toContain("execution:step");
    expect(actions).toContain("execution:complete");

    console.log(`✓ Full audit trail verified: ${actions.join(", ")}`);
  });

  test("workflow:start_attempt is logged when workflow not found", async () => {
    // Try to start non-existent workflow
    const nonExistentWorkflowId = "non-existent-workflow-for-audit-test";

    try {
      await callMCPTool<string>(client, "start", {
        parentExecutionId: "none",
        workflowId: nonExistentWorkflowId,
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch {
      // Expected error - workflow not found
    }

    // Wait for audit log entry with retry
    const auditLogs = await waitFor(
      () =>
        getAuditLogs({
          action: "workflow:start_attempt",
          resourceId: nonExistentWorkflowId,
          limit: 10,
        }),
      (logs) => logs.some((l) => l.resourceId === nonExistentWorkflowId),
      { timeout: 5000, interval: 300 },
    );

    expect(auditLogs.length).toBeGreaterThan(0);
    const attemptLog = auditLogs.find((l) => l.resourceId === nonExistentWorkflowId);
    expect(attemptLog).toBeDefined();
    expect(attemptLog!.action).toBe("workflow:start_attempt");
    expect(attemptLog!.resource).toBe("workflow");

    // Verify metadata contains error info
    const metadata = JSON.parse(attemptLog!.metadata || "{}");
    expect(metadata.workflowId).toBe(nonExistentWorkflowId);
    expect(metadata.errorMessage).toContain("not found");

    console.log(`✓ workflow:start_attempt logged for non-existent workflow`);
  });

  test("execution:step_fail is logged when process not found", async () => {
    // Try to execute step with non-existent process ID
    const nonExistentProcessId = "00000000-0000-4000-8000-000000000000";

    try {
      await callMCPTool<string>(client, "step", {
        processId: nonExistentProcessId,
        input: { test: "data" },
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch {
      // Expected error - process not found
    }

    // Wait for audit log entry with retry
    const auditLogs = await waitFor(
      () =>
        getAuditLogs({
          action: "execution:step_fail",
          resourceId: nonExistentProcessId,
          limit: 10,
        }),
      (logs) => logs.some((l) => l.resourceId === nonExistentProcessId),
      { timeout: 5000, interval: 300 },
    );

    expect(auditLogs.length).toBeGreaterThan(0);
    const failLog = auditLogs.find((l) => l.resourceId === nonExistentProcessId);
    expect(failLog).toBeDefined();
    expect(failLog!.action).toBe("execution:step_fail");
    expect(failLog!.resource).toBe("execution");

    // Verify metadata contains error info
    const metadata = JSON.parse(failLog!.metadata || "{}");
    expect(metadata.errorMessage).toBeDefined();

    console.log(`✓ execution:step_fail logged for non-existent process`);
  });

  test("execution:step_attempt is logged when validation fails", async () => {
    // Create workflow with strict schema validation
    const { id: _unusedId, ...validationWorkflowWithoutId } =
      MCP_TEST_WORKFLOWS.VALIDATION_TEST.workflow;
    const createResult = await callMCPTool<{ workflowId: string }>(client, "manage", {
      action: "create",
      workflow: validationWorkflowWithoutId,
    });
    const validationWorkflowId = createResult.workflowId;
    createdWorkflows.push(validationWorkflowId);

    // Start workflow
    const startResult = await callMCPTool<string>(client, "start", {
      parentExecutionId: "none",
      workflowId: validationWorkflowId,
    });

    const processIdMatch = startResult.match(/Process ID: ([a-f0-9-]+)/);
    expect(processIdMatch).toBeDefined();
    const processId = processIdMatch![1];

    // Send invalid input - missing requiredNumber which is required by schema
    // This should trigger validation error and log execution:step_attempt
    const invalidResult = await callMCPTool<string>(client, "step", {
      processId,
      input: { requiredString: "abc" }, // missing requiredNumber
    });

    // Step 12: Validation error returns comprehensive agent-friendly format
    expect(invalidResult).toContain("❌ VALIDATION ERROR");
    expect(invalidResult).toContain("EXPECTED INPUT FORMAT:");
    expect(invalidResult).toContain("YOUR INPUT:");
    expect(invalidResult).toContain("ERRORS:");
    expect(invalidResult).toContain("ACTION REQUIRED:");

    // Wait for execution:step_attempt audit log
    const attemptLogs = await waitFor(
      () =>
        getAuditLogs({
          action: "execution:step_attempt",
          resourceId: processId,
          limit: 10,
        }),
      (logs) => logs.some((l) => l.resourceId === processId),
      { timeout: 5000, interval: 300 },
    );

    expect(attemptLogs.length).toBeGreaterThan(0);
    const attemptLog = attemptLogs.find((l) => l.resourceId === processId);
    expect(attemptLog).toBeDefined();
    expect(attemptLog!.action).toBe("execution:step_attempt");
    expect(attemptLog!.resource).toBe("execution");

    // Verify metadata contains validation error info
    const metadata = JSON.parse(attemptLog!.metadata || "{}");
    expect(metadata.workflowId).toBe(validationWorkflowId);
    expect(metadata.errorType).toBe("validation");
    expect(metadata.errorMessage).toBeDefined();
    expect(metadata).toHaveProperty("input"); // Input should be logged for debugging

    console.log(`✓ execution:step_attempt logged for validation error`);
    console.log(`  errorType: ${metadata.errorType}`);
    console.log(`  errorMessage: ${metadata.errorMessage.substring(0, 100)}...`);
  });

  test("mcp:workflow_list is logged when listing workflows", async () => {
    // Call list tool
    await callMCPTool(client, "list", {});

    // Wait for audit log entry with retry
    const auditLogs = await waitFor(
      () =>
        getAuditLogs({
          action: "mcp:workflow_list",
          limit: 10,
        }),
      (logs) => logs.length > 0,
      { timeout: 5000, interval: 300 },
    );

    expect(auditLogs.length).toBeGreaterThan(0);
    const listLog = auditLogs[0];
    expect(listLog.action).toBe("mcp:workflow_list");
    expect(listLog.resource).toBe("workflow");

    console.log(`✓ mcp:workflow_list logged`);
  });

  test("mcp:session_info is logged when getting session info", async () => {
    // Call session tool with user action
    await callMCPTool(client, "session", { action: "user" });

    // Wait for audit log entry with retry — find the specific "user" action log
    // (other session_info actions like "executions" use resource: "execution")
    const auditLogs = await waitFor(
      () =>
        getAuditLogs({
          action: "mcp:session_info",
          limit: 10,
        }),
      (logs) =>
        logs.some((l) => {
          const meta = JSON.parse(l.metadata || "{}");
          return meta.action === "user";
        }),
      { timeout: 5000, interval: 300 },
    );

    const sessionLog = auditLogs.find((l) => {
      const meta = JSON.parse(l.metadata || "{}");
      return meta.action === "user";
    });
    expect(sessionLog).toBeDefined();
    expect(sessionLog!.action).toBe("mcp:session_info");
    expect(sessionLog!.resource).toBe("session");

    // Verify metadata contains action type
    const metadata = JSON.parse(sessionLog!.metadata || "{}");
    expect(metadata.action).toBe("user");

    console.log(`✓ mcp:session_info logged for user action`);
  });

  test("mcp:settings_read is logged when reading settings", async () => {
    // Call settings tool with list action
    await callMCPTool(client, "settings", { action: "list" });

    // Wait for audit log entry with retry
    const auditLogs = await waitFor(
      () =>
        getAuditLogs({
          action: "mcp:settings_read",
          limit: 10,
        }),
      (logs) => logs.length > 0,
      { timeout: 5000, interval: 300 },
    );

    expect(auditLogs.length).toBeGreaterThan(0);
    const settingsLog = auditLogs[0];
    expect(settingsLog.action).toBe("mcp:settings_read");
    expect(settingsLog.resource).toBe("settings");

    console.log(`✓ mcp:settings_read logged`);
  });

  test("mcp:help_request is logged when requesting help", async () => {
    // Call help tool
    await callMCPTool(client, "help", {});

    // Wait for audit log entry with retry
    const auditLogs = await waitFor(
      () =>
        getAuditLogs({
          action: "mcp:help_request",
          limit: 10,
        }),
      (logs) => logs.length > 0,
      { timeout: 5000, interval: 300 },
    );

    expect(auditLogs.length).toBeGreaterThan(0);
    const helpLog = auditLogs[0];
    expect(helpLog.action).toBe("mcp:help_request");
    expect(helpLog.resource).toBe("help");

    console.log(`✓ mcp:help_request logged`);
  });

  test("mcp:token_create is logged when creating token", async () => {
    // Call token tool with upload action
    await callMCPTool(client, "token", { action: "upload" });

    // Wait for audit log entry with retry - filter by metadata.action to avoid race conditions
    // with other tests that may create download tokens
    const auditLogs = await waitFor(
      () =>
        getAuditLogs({
          action: "mcp:token_create",
          limit: 10,
        }),
      (logs) =>
        logs.some((l) => {
          const meta = JSON.parse(l.metadata || "{}");
          return meta.action === "upload";
        }),
      { timeout: 5000, interval: 300 },
    );

    // Find the upload token log specifically
    const tokenLog = auditLogs.find((l) => {
      const meta = JSON.parse(l.metadata || "{}");
      return meta.action === "upload";
    });

    expect(tokenLog).toBeDefined();
    expect(tokenLog!.action).toBe("mcp:token_create");
    expect(tokenLog!.resource).toBe("token");

    // Verify metadata contains action type
    const metadata = JSON.parse(tokenLog!.metadata || "{}");
    expect(metadata.action).toBe("upload");

    console.log(`✓ mcp:token_create logged for upload token`);
  });
});
