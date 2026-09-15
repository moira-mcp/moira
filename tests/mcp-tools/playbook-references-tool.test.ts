/**
 * Playbook references from an agent's side.
 *
 * A workflow that names a playbook the caller cannot read is refused before the run is created, and
 * accepted once the playbook exists; a step that names one presents its text rather than a
 * reference.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { callMCPTool, callMCPToolRaw, createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP Playbook References E2E", () => {
  let client: Client;
  let cleanup: (() => Promise<void>) | undefined;
  const playbookName = `reference-standard-${Date.now()}`;
  let workflowId = "";

  beforeAll(async () => {
    const authenticated = await createAuthenticatedMCPClient();
    client = authenticated.client;
    cleanup = authenticated.cleanup;
  });

  afterAll(async () => {
    if (workflowId) {
      try {
        await callMCPTool(client, "manage", { action: "delete", workflowId });
      } catch {
        // Cleanup failures are not the subject of this test.
      }
    }
    try {
      await callMCPTool(client, "playbooks", { action: "delete", name: playbookName });
    } catch {
      // Same.
    }
    await cleanup?.();
  });

  test("a definition naming an unknown playbook is refused while editing", async () => {
    const response = await callMCPToolRaw(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: `Playbook Reference Flow ${Date.now()}`,
          version: "1.0.0",
          description: "Names a playbook that does not exist yet",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "work" } },
          {
            id: "work",
            type: "agent-directive",
            directive: `Follow this: {{playbook:${playbookName}}}`,
            completionCondition: "Done.",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      },
    });

    expect(response).toContain(playbookName);
    expect(response.toLowerCase()).toContain("not available to you");
  });

  test("a run is refused when the playbook disappears after the definition was accepted", async () => {
    const vanishing = `vanishing-standard-${Date.now()}`;
    await callMCPTool(client, "playbooks", {
      action: "save",
      name: vanishing,
      content: "This will be removed.",
    });

    const created = (await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: `Vanishing Playbook Flow ${Date.now()}`,
          version: "1.0.0",
          description: "Names a playbook that is removed before the run starts",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "work" } },
          {
            id: "work",
            type: "agent-directive",
            directive: `Follow this: {{playbook:${vanishing}}}`,
            completionCondition: "Done.",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      },
    })) as { workflowId: string };

    const prepared = await callMCPToolRaw(client, "start", {
      action: "prepare",
      workflowId: created.workflowId,
      parentExecutionId: "none",
    });
    const startAttemptId = prepared.match(/Start attempt ID:\s*([a-f0-9-]+)/i)?.[1];

    // The definition was accepted while the playbook existed; the run is attempted after it is gone.
    await callMCPTool(client, "playbooks", { action: "delete", name: vanishing });

    const refused = await callMCPToolRaw(client, "start", {
      action: "execute",
      startAttemptId,
    });

    expect(refused).toContain("START_PRECONDITION_CHANGED");
    expect(refused).toContain(vanishing);

    await callMCPTool(client, "manage", { action: "delete", workflowId: created.workflowId });
  });

  test("the same definition is accepted once the playbook exists, and its text reaches the step", async () => {
    await callMCPTool(client, "playbooks", {
      action: "save",
      name: playbookName,
      content: "State the observable consequence.",
    });

    const created = (await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: `Playbook Reference Flow ${Date.now()}`,
          version: "1.0.0",
          description: "Names a playbook that now exists",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "work" } },
          {
            id: "work",
            type: "agent-directive",
            directive: `Follow this: {{playbook:${playbookName}}}`,
            completionCondition: "Done.",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      },
    })) as { workflowId: string };
    workflowId = created.workflowId;

    const prepared = await callMCPToolRaw(client, "start", {
      action: "prepare",
      workflowId,
      parentExecutionId: "none",
    });
    const startAttemptId = prepared.match(/Start attempt ID:\s*([a-f0-9-]+)/i)?.[1];
    expect(startAttemptId).toBeTruthy();

    const started = await callMCPToolRaw(client, "start", {
      action: "execute",
      startAttemptId,
    });

    expect(started).toContain("State the observable consequence.");
    expect(started).not.toContain("{{playbook:");
  });
});
