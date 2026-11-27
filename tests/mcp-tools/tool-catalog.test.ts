import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Ajv } from "ajv";
import { encodeReference } from "@mcp-moira/shared/workspace-references";
import { getToolReferenceModel } from "../../packages/mcp-server/src/tools/tool-definitions.js";
import { MCP_TEST_WORKFLOWS } from "../fixtures/mcp-workflows.js";
import { MCP_TEST_DATA } from "../fixtures/mcp-test-data.js";
import {
  advanceWorkflowExecution,
  callMCPTool,
  createAuthenticatedMCPClient,
  deleteOwnedTestWorkflow,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";
import { getTestFetchUrl } from "../utils/test-config.js";

describe("MCP tool catalog", () => {
  let client: Client;
  const claude = new Client({ name: "claude-code", version: "2.1.311" });
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const authenticated = await createAuthenticatedMCPClient();
    client = authenticated.client;
    cleanup = authenticated.cleanup;
    await claude.connect(
      new StreamableHTTPClientTransport(new URL(`${getTestFetchUrl()}/mcp`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${authenticated.accessToken}`,
            "User-Agent": "claude-code/2.1.311 (cli)",
          },
        },
      }),
    );
  });

  afterAll(async () => {
    await claude.close();
    await cleanup?.();
  });

  test("Claude Code discovers every tool and action with root object schemas", async () => {
    const tools = (await claude.listTools()).tools;
    const reference = getToolReferenceModel();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      reference.map((tool) => tool.name).sort(),
    );
    const ajv = new Ajv({ strict: false, validateFormats: false });
    for (const entry of reference) {
      const tool = tools.find((tool) => tool.name === entry.name)!;
      expect(tool.inputSchema.type).toBe("object");
      expect(
        Object.keys(tool.inputSchema).filter((key) => ["anyOf", "oneOf", "allOf"].includes(key)),
      ).toEqual([]);
      expect(tool._meta).toEqual(entry.metadata);
      if (entry.operations.length) {
        const action = ajv.compile(tool.inputSchema.properties!.action as object);
        expect(entry.operations.filter((operation) => !action(operation))).toEqual([]);
        expect(action("not-a-moira-action")).toBe(false);
      }
    }
    const workflow = tools.find((tool) => tool.name === "workflow")!.inputSchema;
    const accepts = ajv.compile(workflow);
    expect(accepts({ action: "get-revision", workflowId: "moira/quick-task", revision: 1 })).toBe(
      true,
    );
    expect(
      accepts({
        action: "reconciliation_resolve",
        reference: "catalog-item",
        revision: "a".repeat(64),
        selection: "current",
        rationale: "Keep the current graph",
      }),
    ).toBe(true);
    const terminal = tools.find((tool) => tool.name === "codespace_terminal")!;
    expect(terminal.inputSchema.properties!.stdin_file).toMatchObject({
      properties: { file_id: expect.anything(), download_url: expect.anything() },
    });
  });

  test("Claude Code lists workflows, completes a process and retains strict call admission", async () => {
    const { metadata, nodes } = MCP_TEST_WORKFLOWS.SIMPLE_LINEAR.workflow;
    const { workflowId } = await callMCPTool<{ workflowId: string }>(claude, "workflow", {
      action: "create",
      workflow: { metadata: { ...metadata, name: "Claude Code catalog test" }, nodes },
    });
    try {
      const listed = await callMCPTool(claude, "workflow", {
        action: "list",
        search: "Claude Code catalog test",
      });
      expect(listed.workflows).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "Claude Code catalog test" })]),
      );
      const run = await startWorkflowExecutionState(claude, workflowId);
      const inputs = MCP_TEST_DATA.EXECUTION_INPUTS;
      expect(await advanceWorkflowExecution(claude, run, inputs.STEP1_SIMPLE)).toContain(
        "Complete step 2",
      );
      expect(await advanceWorkflowExecution(claude, run, inputs.STEP2_SIMPLE)).toContain(
        "Workflow completed",
      );
      const processes = await callMCPTool(claude, "execution", {
        action: "executions",
        workflowId,
        status: ["completed"],
      });
      expect(processes.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ executionId: run.processId, status: "completed" }),
        ]),
      );
      await expect(
        claude.callTool({ name: "execution", arguments: { action: "execute", workflowId } }),
      ).rejects.toThrow(/Invalid tool action parameters/);
    } finally {
      await deleteOwnedTestWorkflow(client, workflowId);
    }
  });

  test("publishes strict action branches and supports root-only native client rewriting", async () => {
    const tools = (await client.listTools()).tools;

    for (const entry of getToolReferenceModel()) {
      const tool = tools.find((tool) => tool.name === entry.name)!;
      expect(tool.inputSchema).toEqual(entry.inputSchema);
      expect(tool._meta).toEqual(entry.metadata);
    }

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "artifacts",
      "codespace",
      "codespace_download",
      "codespace_edit",
      "codespace_git",
      "codespace_read",
      "codespace_search",
      "codespace_terminal",
      "codespace_upload",
      "communication",
      "execution",
      "help",
      "notes",
      "playbooks",
      "settings",
      "workflow",
    ]);
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const execution = ajv.compile(tools.find((tool) => tool.name === "execution")!.inputSchema);
    expect(
      execution({ action: "prepare", workflowId: "moira/quick-task", parentExecutionId: "none" }),
    ).toBe(true);
    expect(
      execution({ action: "execute", startAttemptId: "00000000-0000-4000-8000-000000000001" }),
    ).toBe(true);
    expect(execution({ action: "execute", workflowId: "moira/quick-task" })).toBe(false);
    expect(execution({ action: "user", executionId: "00000000-0000-4000-8000-000000000001" })).toBe(
      false,
    );

    const terminal = tools.find((tool) => tool.name === "codespace_terminal")!;
    const schema = structuredClone(terminal.inputSchema);
    // Native hosts replace only the root file property with a local path. A second object
    // restriction inside an action branch would make this otherwise valid request impossible.
    schema.properties!.stdin_file = { type: "string" };
    const masked = ajv.compile(schema);
    const command = {
      command: { argv: ["cat"] },
      workspace: encodeReference("workspace", {
        resourceId: "00000000-0000-4000-8000-000000000162",
        provider: "github-codespaces",
        generation: 1,
      }),
    };
    expect(masked({ ...command, action: "run" })).toBe(true);
    expect(masked({ ...command, action: "run_native", stdin_file: "/tmp/input.txt" })).toBe(true);
    expect(masked({ ...command, action: "run_native" })).toBe(false);
    expect(masked({ ...command, action: "run", stdin_file: "/tmp/input.txt" })).toBe(false);
  });
});
