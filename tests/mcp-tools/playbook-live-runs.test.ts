/**
 * How many running processes read a playbook, asked before the text is changed.
 *
 * Content resolves at every step, so an edit reaches processes that are already under way. The
 * number has to be true before saving, and it cannot be worked out in the browser: a process stores
 * a workflow id, while the reference lives inside the workflow definition. This covers the
 * distinction that matters — a process that references the playbook is counted and one that does
 * not is left out — because a count that simply returns "all my running processes" would look the
 * same on a single process.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  callMCPTool,
  callMCPToolRaw,
  createAuthenticatedMCPClient,
  formatSessionCookie,
  signInUser,
  DEFAULT_ADMIN_CREDENTIALS,
} from "../utils/mcp-auth.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const BASE_URL = getTestBaseUrl();
const stamp = Date.now();
const playbookName = `live-runs-standard-${stamp}`;

interface UsageResponse {
  name: string;
  executions: number;
  workflows: { workflowId: string; name: string; executions: number }[];
  complete: boolean;
}

async function readUsage(cookie: string, name: string): Promise<UsageResponse> {
  const response = await fetch(`${BASE_URL}/api/playbooks/${encodeURIComponent(name)}/usage`, {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: UsageResponse };
  return body.data;
}

async function createFlow(
  client: Client,
  name: string,
  directive: string,
): Promise<{ workflowId: string }> {
  return (await callMCPTool(client, "manage", {
    action: "create",
    workflow: {
      metadata: { name, version: "1.0.0", description: "Live-run counting" },
      nodes: [
        { id: "start", type: "start", connections: { default: "work" } },
        {
          id: "work",
          type: "agent-directive",
          directive,
          completionCondition: "Done.",
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    },
  })) as { workflowId: string };
}

async function startRun(client: Client, workflowId: string): Promise<string> {
  const prepared = await callMCPToolRaw(client, "start", {
    action: "prepare",
    workflowId,
    parentExecutionId: "none",
  });
  const startAttemptId = prepared.match(/Start attempt ID:\s*([a-f0-9-]+)/i)?.[1];
  expect(startAttemptId).toBeDefined();
  const started = await callMCPToolRaw(client, "start", { action: "execute", startAttemptId });
  const processId = started.match(/Process ID:\s*([a-f0-9-]+)/i)?.[1];
  expect(processId).toBeDefined();
  return processId!;
}

describe("playbook live-run count", () => {
  let client: Client;
  let cleanup: (() => Promise<void>) | undefined;
  let cookie: string;
  const created: string[] = [];
  const runs: string[] = [];

  beforeAll(async () => {
    const authenticated = await createAuthenticatedMCPClient();
    client = authenticated.client;
    cleanup = authenticated.cleanup;
    cookie = formatSessionCookie(
      BASE_URL,
      await signInUser(
        BASE_URL,
        DEFAULT_ADMIN_CREDENTIALS.email,
        DEFAULT_ADMIN_CREDENTIALS.password,
      ),
    );
  }, 120000);

  afterAll(async () => {
    for (const processId of runs) {
      try {
        await callMCPTool(client, "session", {
          action: "cancel-execution",
          executionId: processId,
          reason: "test cleanup",
        });
      } catch {
        // Cleanup failures are not the subject of this test.
      }
    }
    for (const workflowId of created) {
      try {
        await callMCPTool(client, "manage", { action: "delete", workflowId });
      } catch {
        // Same.
      }
    }
    try {
      await callMCPTool(client, "playbooks", { action: "delete", name: playbookName });
    } catch {
      // Same.
    }
    await cleanup?.();
  });

  test("counts the running processes that reference the playbook and no others", async () => {
    await callMCPTool(client, "playbooks", {
      action: "save",
      name: playbookName,
      content: "Read the whole diff.",
    });

    // Nothing runs on it yet.
    expect((await readUsage(cookie, playbookName)).executions).toBe(0);

    const referencing = await createFlow(
      client,
      `Live runs referencing ${stamp}`,
      `Follow this: {{playbook:${playbookName}}}`,
    );
    const unrelated = await createFlow(
      client,
      `Live runs unrelated ${stamp}`,
      "Do the work without any named standard.",
    );
    created.push(referencing.workflowId, unrelated.workflowId);

    runs.push(await startRun(client, referencing.workflowId));
    runs.push(await startRun(client, unrelated.workflowId));

    const usage = await readUsage(cookie, playbookName);
    expect(usage.executions).toBe(1);
    expect(usage.workflows.map((entry) => entry.workflowId)).toEqual([referencing.workflowId]);
    expect(usage.complete).toBe(true);
  }, 180000);

  test("counts a reference that names the owner by handle", async () => {
    // The owner may be spelled by handle in a definition and is stored by id; a count that compared
    // the spelling would call this run somebody else's and show zero.
    const profile = await fetch(`${BASE_URL}/api/user/profile`, { headers: { Cookie: cookie } });
    const handle = ((await profile.json()) as { data?: { handle?: string } }).data?.handle;
    expect(handle).toBeTruthy();

    const byHandle = await createFlow(
      client,
      `Live runs by handle ${stamp}`,
      `Follow this: {{playbook:@${handle}/${playbookName}}}`,
    );
    created.push(byHandle.workflowId);
    runs.push(await startRun(client, byHandle.workflowId));

    const usage = await readUsage(cookie, playbookName);
    expect(usage.workflows.map((entry) => entry.workflowId)).toContain(byHandle.workflowId);
  }, 180000);

  test("does not count a reference the author escaped", async () => {
    const documenting = await createFlow(
      client,
      `Live runs documenting ${stamp}`,
      `Write a reference as \\{{playbook:${playbookName}}} to mean the text itself.`,
    );
    created.push(documenting.workflowId);
    runs.push(await startRun(client, documenting.workflowId));

    const usage = await readUsage(cookie, playbookName);
    expect(usage.workflows.map((entry) => entry.workflowId)).not.toContain(documenting.workflowId);
  }, 180000);
});
