/**
 * A process that lost behaviour text says so on its own page.
 *
 * When a playbook a node names cannot be read, the step still runs — with a placeholder in place of
 * the text. For a reference inside a materialized file the placeholder never reaches the directive
 * at all, so the run page is the only place a person can learn the process went ahead without it.
 *
 * What this has to tell apart: a process that merely degraded must not look failed, and a
 * degradation must not be invisible. Both states show an unchanged step list, so the run page is
 * checked for both the named reference and the absence of an error count.
 */

import { test, expect } from "./fixtures.js";
import { login } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import {
  advanceWorkflowExecution,
  createAuthenticatedMCPClient,
  callMCPTool,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_USER = getAdminCredentials();

const stamp = Date.now();
const playbookName = `degradation-standard-${stamp}`;

/** A repair loop: the node routes back to itself until the work is reported done. */
function loopingWorkflow() {
  return {
    metadata: {
      name: `Degradation display ${stamp}`,
      version: "1.0.0",
      description: "A repair loop that names a playbook",
    },
    variableRegistry: {
      done: { type: "boolean", description: "Whether the work is finished", default: false },
    },
    nodes: [
      { type: "start", id: "start", connections: { default: "task" } },
      {
        type: "agent-directive",
        id: "task",
        directive: `Follow this standard: {{playbook:${playbookName}}}`,
        completionCondition: "The work follows the standard.",
        inputSchema: {
          type: "object",
          properties: { done: { type: "boolean" } },
          required: ["done"],
        },
        connections: { success: "check" },
      },
      {
        type: "condition",
        id: "check",
        cases: [
          { when: { operator: "eq", left: { contextPath: "done" }, right: true }, output: "true" },
        ],
        connections: { true: "end", default: "task" },
      },
      { type: "end", id: "end" },
    ],
  };
}

test.describe("Degradation on the run page", () => {
  let mcpClient: Client;
  let cleanup: () => Promise<void>;
  let executionId: string;
  let workflowId: string;

  test.beforeAll(async () => {
    const mcpResult = await createAuthenticatedMCPClient({
      email: ADMIN_USER.email,
      password: ADMIN_USER.password,
    });
    mcpClient = mcpResult.client;
    cleanup = mcpResult.cleanup;

    await callMCPTool(mcpClient, "playbooks", {
      action: "save",
      name: playbookName,
      content: "Read the whole diff before judging it.",
    });

    const created = (await callMCPTool(mcpClient, "manage", {
      action: "create",
      workflow: loopingWorkflow(),
    })) as { workflowId: string };
    workflowId = created.workflowId;

    const execution = await startWorkflowExecutionState(mcpClient, workflowId);
    executionId = execution.response.match(/Process ID: ([a-f0-9-]+)/)![1];

    // The playbook disappears mid-run; the next presentation of the same node degrades.
    await callMCPTool(mcpClient, "playbooks", { action: "delete", name: playbookName });
    await advanceWorkflowExecution(mcpClient, execution, { done: false });
  });

  test.afterAll(async () => {
    if (workflowId && mcpClient) {
      try {
        await callMCPTool(mcpClient, "manage", { action: "delete", workflowId });
      } catch {
        // Cleanup failures are not the subject of this test.
      }
    }
    await cleanup?.();
  });

  test("the run page names what the step ran without, and does not call it an error", async ({
    page,
  }) => {
    await login(page, ADMIN_USER.email, ADMIN_USER.password);

    await page.goto(`${BASE_URL}/executions/${executionId}`);
    await page.waitForLoadState("domcontentloaded");

    // The tab carries a degradation count and no error count.
    await expect(page.getByTestId("degradations-count-badge")).toBeVisible();
    await expect(page.getByTestId("errors-count-badge")).toBeHidden();

    await page.getByRole("tab", { name: /Errors|Ошибки/ }).click();

    const degradations = page.getByTestId("execution-degradations");
    await expect(degradations).toBeVisible();
    await expect(degradations).toContainText(playbookName);
    await expect(page.getByTestId("degradation-count")).toHaveText("1");

    // The error card stays empty: a degraded process has not failed.
    await expect(page.getByText(/No errors recorded|Ошибок не зафиксировано/)).toBeVisible();
  });

  test("a materialized file that lost its text is visible on the run page too", async ({
    page,
  }) => {
    const name = `materialize-standard-${Date.now()}`;
    await callMCPTool(mcpClient, "playbooks", {
      action: "save",
      name,
      content: "Judge the diff, not the intent.",
    });

    const created = (await callMCPTool(mcpClient, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: `Materialize degradation ${Date.now()}`,
          version: "1.0.0",
          description: "Delivers a file whose text comes from a playbook",
        },
        variableRegistry: {
          workspace_path: {
            type: "string",
            description: "Where files are delivered",
            default: "/tmp/moira-materialize-degradation",
          },
          review_standard: {
            type: "string",
            description: "The standard the delivered file carries",
            default: `Follow this: {{playbook:${name}}}`,
          },
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "deliver" } },
          {
            type: "materialize",
            id: "deliver",
            basePath: "{{workspace_path}}",
            files: [{ path: "standards/review.md", from: "review_standard" }],
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      },
    })) as { workflowId: string };

    const execution = await startWorkflowExecutionState(mcpClient, created.workflowId);
    const runId = execution.response.match(/Process ID: ([a-f0-9-]+)/)![1];
    // The directive carries an already-quoted command; the grant URL inside it is what the agent
    // would download.
    const url = execution.response.match(/'(https?:\/\/[^']+)'/)![1];

    // The playbook disappears between the grant being issued and the file being fetched. The
    // placeholder then sits inside the downloaded file, where nobody would ever see it.
    await callMCPTool(mcpClient, "playbooks", { action: "delete", name });
    const delivered = await fetch(url);
    expect(delivered.status).toBe(200);

    await login(page, ADMIN_USER.email, ADMIN_USER.password);
    await page.goto(`${BASE_URL}/executions/${runId}`);
    await page.waitForLoadState("domcontentloaded");

    await expect(page.getByTestId("degradations-count-badge")).toBeVisible();
    await page.getByRole("tab", { name: /Errors|Ошибки/ }).click();
    const degradations = page.getByTestId("execution-degradations");
    await expect(degradations).toBeVisible();
    await expect(degradations).toContainText(name);

    try {
      await callMCPTool(mcpClient, "manage", { action: "delete", workflowId: created.workflowId });
    } catch {
      // Cleanup failures are not the subject of this test.
    }
  });
});
