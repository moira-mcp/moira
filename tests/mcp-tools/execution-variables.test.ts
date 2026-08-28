import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import {
  callMCPTool,
  callMCPToolRaw,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
} from "../utils/mcp-auth.js";
import { signInUser } from "../utils/mcp-auth.js";
import { getAdminCredentials, getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";
import { randomUUID } from "node:crypto";

describe("runtime execution variables", () => {
  let client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  let cleanup: () => Promise<void>;
  let executionId: string;
  let cookie: string;
  let foreignClient: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  let foreignCleanup: () => Promise<void>;
  let foreignCookie: string;

  beforeAll(async () => {
    const authenticated = await createAuthenticatedMCPClient();
    client = authenticated.client;
    cleanup = authenticated.cleanup;
    const credentials = getAdminCredentials();
    cookie = await signInUser(getTestBaseUrl(), credentials.email, credentials.password);
    const creation = await callMCPToolRaw(client, "manage", {
      action: "create",
      overwrite: true,
      workflow: {
        metadata: {
          name: "Runtime Variable Test",
          version: "1.0.0",
          description: "Runtime variable policy",
        },
        variableRegistry: {
          editable_value: {
            type: "string",
            description: "Editable value",
            enum: ["old", "new"],
            default: "old",
          },
          denied_value: { type: "string", description: "Denied value", default: "old" },
          unset_value: { type: "number", description: "Unset number" },
          object_value: {
            type: "object",
            description: "Nested object",
            properties: {
              count: { type: "number" },
              sibling: { type: "string" },
            },
            required: ["count", "sibling"],
            additionalProperties: false,
            default: { count: 1, sibling: "keep" },
          },
        },
        runtimePolicy: {
          externalVariableWrites: {
            editable_value: { allowedNodeIds: ["task"] },
            denied_value: { allowedNodeIds: ["other"] },
            object_value: { allowedNodeIds: ["task"] },
          },
        },
        progress: {
          title: "Runtime progress",
          nodes: [
            { id: "first", label: "First", connections: { default: "second" } },
            { id: "second", label: "Second", connections: { default: "first" } },
          ],
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "task" } },
          {
            id: "task",
            type: "agent-directive",
            progressNodeId: "first",
            directive: "Wait",
            completionCondition: "Done",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            connections: { success: "other" },
          },
          {
            id: "other",
            type: "agent-directive",
            progressNodeId: "second",
            directive: "Other",
            completionCondition: "Done",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      },
    });
    if (creation.includes("Error:")) throw new Error(`Workflow creation failed: ${creation}`);
    const edited = await callMCPTool<any>(client, "manage", {
      action: "edit",
      workflowId: "runtime-variable-test",
      changes: {
        progress: {
          title: "Edited runtime progress",
          nodes: [
            { id: "first", label: "First", connections: { default: "second" } },
            { id: "second", label: "Second", connections: { default: "first" } },
          ],
        },
      },
    });
    expect(edited).toMatchObject({ success: true, validation: { valid: true } });
    const started = await callMCPToolRaw(client, "start", {
      workflowId: "runtime-variable-test",
      parentExecutionId: "none",
      skipTelegramCheck: true,
    });
    const id = started.match(/Process ID: ([a-f0-9-]+)/)?.[1];
    if (!id) throw new Error(`Process ID missing: ${started}`);
    executionId = id;

    const foreignEmail = `runtime-variable-foreign-${randomUUID()}@example.com`;
    const foreignPassword = "TestPass123!";
    const foreignUser = await createTestUserViaApi(
      getTestFetchUrl(),
      foreignEmail,
      foreignPassword,
      "Runtime Variable Foreign User",
      true,
    );
    const approval = await fetch(
      `${getTestFetchUrl()}/api/admin/users/${foreignUser.userId}/approve`,
      {
        method: "POST",
        headers: { Cookie: `better-auth.session_token=${cookie}` },
      },
    );
    expect(approval.status).toBe(200);
    const foreignAuthenticated = await createAuthenticatedMCPClient({
      email: foreignEmail,
      password: foreignPassword,
    });
    foreignClient = foreignAuthenticated.client;
    foreignCleanup = foreignAuthenticated.cleanup;
    foreignCookie = await signInUser(getTestFetchUrl(), foreignEmail, foreignPassword);
  });

  afterAll(async () => {
    await foreignCleanup();
    await cleanup();
  });

  test("filters effective editability and schema-valid mutation without exposing denied globals", async () => {
    const queried = await callMCPTool<any>(client, "session", {
      action: "variables",
      executionId,
      names: ["editable_value", "denied_value", "unset_value", "missing"],
      types: ["string", "number"],
    });
    expect(queried.unknownNames).toEqual(["missing"]);
    expect(queried.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "editable_value",
          editable: true,
          value: "old",
          writePhase: "current",
          externalWritePolicy: { allowedNodeIds: ["task"] },
        }),
        expect.objectContaining({
          name: "denied_value",
          editable: false,
          denialReason: "phase_denied",
        }),
        expect.objectContaining({ name: "unset_value", hasValue: false }),
      ]),
    );
    const currentPhase = await callMCPTool<any>(client, "session", {
      action: "variables",
      executionId,
      names: ["editable_value", "denied_value"],
      writePhase: "current",
    });
    expect(currentPhase.variables).toEqual([
      expect.objectContaining({ name: "editable_value", writePhase: "current" }),
    ]);
    expect(currentPhase.appliedFilters).toMatchObject({ writePhase: "current" });
    const otherPhase = await callMCPTool<any>(client, "session", {
      action: "variables",
      executionId,
      names: ["editable_value", "denied_value", "unset_value"],
      writePhase: "other",
    });
    expect(otherPhase.variables).toEqual([
      expect.objectContaining({ name: "denied_value", writePhase: "other" }),
    ]);
    const falseRuntimeFilters = await callMCPTool<any>(client, "session", {
      action: "variables",
      executionId,
      names: ["editable_value", "denied_value", "unset_value"],
      editable: false,
      hasValue: false,
    });
    expect(falseRuntimeFilters.variables).toEqual([
      expect.objectContaining({ name: "unset_value", editable: false, hasValue: false }),
    ]);
    expect(falseRuntimeFilters.appliedFilters).toMatchObject({ editable: false, hasValue: false });
    const changed = await callMCPTool<any>(client, "session", {
      action: "set-variable",
      executionId,
      variableName: "editable_value",
      variableValue: "new",
      expectedRevision: queried.revision,
    });
    expect(changed).toMatchObject({ name: "editable_value", value: "new" });
    const denied = await callMCPToolRaw(client, "session", {
      action: "set-variable",
      executionId,
      variableName: "denied_value",
      variableValue: "new",
      expectedRevision: changed.revision,
    });
    expect(denied).toContain("not externally editable");
    const invalid = await callMCPToolRaw(client, "session", {
      action: "set-variable",
      executionId,
      variableName: "editable_value",
      variableValue: "invalid",
      expectedRevision: changed.revision,
    });
    expect(invalid).toContain("Invalid declared variable");
    const httpQuery = await fetch(
      `${getTestBaseUrl()}/api/executions/${executionId}/variables?names=editable_value,denied_value,unset_value,missing&types=string&editable=true&hasValue=true&writePhase=current`,
      { headers: { Cookie: `better-auth.session_token=${cookie}` } },
    );
    const httpData = (await httpQuery.json()) as {
      data: { variables: Array<{ name: string }>; unknownNames: string[]; revision: number };
    };
    expect(httpData.data).toMatchObject({ unknownNames: ["missing"] });
    expect(httpData.data.variables).toEqual([expect.objectContaining({ name: "editable_value" })]);
    const httpSet = await fetch(
      `${getTestBaseUrl()}/api/executions/${executionId}/variables/editable_value`,
      {
        method: "PUT",
        headers: {
          Cookie: `better-auth.session_token=${cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: "old", expectedRevision: httpData.data.revision }),
      },
    );
    expect(httpSet.status).toBe(200);
    const httpSetData = (await httpSet.json()) as { data: { revision: number } };
    const stale = await callMCPToolRaw(client, "session", {
      action: "set-variable",
      executionId,
      variableName: "editable_value",
      variableValue: "new",
      expectedRevision: httpData.data.revision,
    });
    expect(stale).toContain("stale");

    const contextBeforePath = await callMCPTool<any>(client, "session", {
      action: "execution_context",
      executionId,
    });
    const pathSet = await fetch(`${getTestBaseUrl()}/api/executions/${executionId}/context`, {
      method: "PUT",
      headers: {
        Cookie: `better-auth.session_token=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        variablePath: ["object_value", "count"],
        value: 2,
        expectedRevision: httpSetData.data.revision,
      }),
    });
    expect(pathSet.status).toBe(200);
    const afterPath = await callMCPTool<any>(client, "session", {
      action: "variables",
      executionId,
      names: ["object_value"],
    });
    expect(afterPath.variables).toEqual([
      expect.objectContaining({ value: { count: 2, sibling: "keep" } }),
    ]);

    const deniedPath = await fetch(`${getTestBaseUrl()}/api/executions/${executionId}/context`, {
      method: "PUT",
      headers: {
        Cookie: `better-auth.session_token=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        variablePath: ["denied_value"],
        value: "new",
        expectedRevision: afterPath.revision,
      }),
    });
    expect(deniedPath.status).toBe(400);
    const invalidPath = await fetch(`${getTestBaseUrl()}/api/executions/${executionId}/context`, {
      method: "PUT",
      headers: {
        Cookie: `better-auth.session_token=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        variablePath: ["object_value", "count"],
        value: "not-a-number",
        expectedRevision: afterPath.revision,
      }),
    });
    expect(invalidPath.status).toBe(400);
    const stalePath = await fetch(`${getTestBaseUrl()}/api/executions/${executionId}/context`, {
      method: "PUT",
      headers: {
        Cookie: `better-auth.session_token=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        variablePath: ["object_value", "count"],
        value: 3,
        expectedRevision: httpSetData.data.revision,
      }),
    });
    expect(stalePath.status).toBe(409);
    const afterPathRejections = await callMCPTool<any>(client, "session", {
      action: "execution_context",
      executionId,
    });
    expect(afterPathRejections.revision).toBe(afterPath.revision);
    expect(afterPathRejections.context.variables.object_value).toEqual({
      count: 2,
      sibling: "keep",
    });
    expect(afterPathRejections.context.nodeStates).toEqual(contextBeforePath.context.nodeStates);
    const legacy = await fetch(`${getTestBaseUrl()}/api/executions/${executionId}/context`, {
      method: "PUT",
      headers: {
        Cookie: `better-auth.session_token=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        nodeStates: { task: "fake" },
        expectedRevision: httpData.data.revision + 1,
      }),
    });
    expect(legacy.status).toBe(400);

    const foreignQuery = await callMCPToolRaw(foreignClient, "session", {
      action: "variables",
      executionId,
    });
    expect(foreignQuery).toContain("execution belongs to another user");
    const foreignSet = await callMCPToolRaw(foreignClient, "session", {
      action: "set-variable",
      executionId,
      variableName: "editable_value",
      variableValue: "new",
      expectedRevision: afterPath.revision,
    });
    expect(foreignSet).toContain("execution belongs to another user");
    const foreignHttpQuery = await fetch(
      `${getTestBaseUrl()}/api/executions/${executionId}/variables`,
      { headers: { Cookie: `better-auth.session_token=${foreignCookie}` } },
    );
    expect(foreignHttpQuery.status).toBe(401);
    const foreignHttpSet = await fetch(
      `${getTestBaseUrl()}/api/executions/${executionId}/variables/editable_value`,
      {
        method: "PUT",
        headers: {
          Cookie: `better-auth.session_token=${foreignCookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: "new", expectedRevision: afterPath.revision }),
      },
    );
    expect(foreignHttpSet.status).toBe(401);
    const foreignLegacyPath = await fetch(
      `${getTestBaseUrl()}/api/executions/${executionId}/context`,
      {
        method: "PUT",
        headers: {
          Cookie: `better-auth.session_token=${foreignCookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          variablePath: ["object_value", "count"],
          value: 3,
          expectedRevision: afterPath.revision,
        }),
      },
    );
    expect(foreignLegacyPath.status).toBe(401);
    const afterForeignAttempts = await callMCPTool<any>(client, "session", {
      action: "variables",
      executionId,
      names: ["editable_value", "object_value"],
    });
    expect(afterForeignAttempts.revision).toBe(afterPath.revision);
    expect(afterForeignAttempts.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "editable_value", value: "old" }),
        expect.objectContaining({ name: "object_value", value: { count: 2, sibling: "keep" } }),
      ]),
    );

    const foreignOwnedWorkflow = await callMCPTool<any>(foreignClient, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: `Foreign Owned Runtime Policy ${randomUUID()}`,
          version: "1.0.0",
          description: "Proves administrator inspection grants no mutation authority",
        },
        variableRegistry: {
          settings: {
            type: "object",
            description: "Foreign settings",
            properties: { count: { type: "number" } },
            required: ["count"],
            additionalProperties: false,
            default: { count: 1 },
          },
        },
        runtimePolicy: {
          externalVariableWrites: { settings: { allowedNodeIds: ["task"] } },
        },
        progress: { nodes: [{ id: "work", label: "Foreign work" }] },
        nodes: [
          { id: "start", type: "start", connections: { default: "task" } },
          {
            id: "task",
            type: "agent-directive",
            progressNodeId: "work",
            directive: "Wait",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      },
    });
    const foreignStarted = await callMCPToolRaw(foreignClient, "start", {
      workflowId: foreignOwnedWorkflow.workflowId,
      parentExecutionId: "none",
      skipTelegramCheck: true,
    });
    const foreignExecutionId = foreignStarted.match(/Process ID: ([a-f0-9-]+)/)?.[1];
    expect(foreignExecutionId).toBeDefined();
    const foreignOwnedBefore = await callMCPTool<any>(foreignClient, "session", {
      action: "variables",
      executionId: foreignExecutionId,
      names: ["settings"],
    });
    const adminRead = await fetch(`${getTestBaseUrl()}/api/executions/${foreignExecutionId}`, {
      headers: { Cookie: `better-auth.session_token=${cookie}` },
    });
    expect(adminRead.status).toBe(200);
    const adminProgress = await fetch(
      `${getTestBaseUrl()}/api/executions/${foreignExecutionId}/progress`,
      { headers: { Cookie: `better-auth.session_token=${cookie}` } },
    );
    expect(adminProgress.status).toBe(200);
    expect(await adminProgress.json()).toMatchObject({
      data: { activeNodeId: "work", nodes: [{ id: "work", state: "current" }] },
    });
    const adminMutation = await fetch(
      `${getTestBaseUrl()}/api/executions/${foreignExecutionId}/context`,
      {
        method: "PUT",
        headers: {
          Cookie: `better-auth.session_token=${cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          variablePath: ["settings", "count"],
          value: 2,
          expectedRevision: foreignOwnedBefore.revision,
        }),
      },
    );
    expect(adminMutation.status).toBe(401);
    const foreignOwnedAfter = await callMCPTool<any>(foreignClient, "session", {
      action: "variables",
      executionId: foreignExecutionId,
      names: ["settings"],
    });
    expect(foreignOwnedAfter.revision).toBe(foreignOwnedBefore.revision);
    expect(foreignOwnedAfter.variables).toEqual([
      expect.objectContaining({ name: "settings", value: { count: 1 } }),
    ]);
    const definition = await callMCPTool<any>(client, "manage", {
      action: "list-variables",
      workflowId: "runtime-variable-test",
      variableNames: ["editable_value", "missing"],
      variableTypes: ["string"],
      hasDefault: true,
      externallyWritable: true,
    });
    expect(definition.variables).toEqual([
      expect.objectContaining({ name: "editable_value", externallyWritable: true }),
    ]);
    expect(definition.unknownNames).toEqual(["missing"]);
    expect(definition.appliedFilters).toMatchObject({ hasDefault: true, externallyWritable: true });
    const falseDefinition = await callMCPTool<any>(client, "manage", {
      action: "list-variables",
      workflowId: "runtime-variable-test",
      variableNames: ["editable_value", "denied_value", "unset_value"],
      hasDefault: false,
      externallyWritable: false,
    });
    expect(falseDefinition.variables).toEqual([
      expect.objectContaining({ name: "unset_value", externallyWritable: false }),
    ]);
    expect(falseDefinition.appliedFilters).toMatchObject({
      hasDefault: false,
      externallyWritable: false,
    });
    const definitionHttp = await fetch(
      `${getTestBaseUrl()}/api/workflows/runtime-variable-test/variables?names=editable_value,missing&types=string&hasDefault=true&externallyWritable=true`,
      { headers: { Cookie: `better-auth.session_token=${cookie}` } },
    );
    const definitionHttpData = (await definitionHttp.json()) as {
      data: {
        variables: Array<{ name: string; externalWritePolicy: unknown }>;
        unknownNames: string[];
        appliedFilters: Record<string, unknown>;
      };
    };
    expect(definitionHttpData.data.variables).toEqual([
      expect.objectContaining({
        name: "editable_value",
        externalWritePolicy: { allowedNodeIds: ["task"] },
      }),
    ]);
    expect(definitionHttpData.data.unknownNames).toEqual(["missing"]);
    expect(definitionHttpData.data.appliedFilters).toEqual({
      names: ["editable_value", "missing"],
      search: "",
      types: ["string"],
      hasDefault: true,
      externallyWritable: true,
    });
    const falseDefinitionHttp = await fetch(
      `${getTestBaseUrl()}/api/workflows/runtime-variable-test/variables?names=editable_value,denied_value,unset_value&hasDefault=false&externallyWritable=false`,
      { headers: { Cookie: `better-auth.session_token=${cookie}` } },
    );
    const falseDefinitionHttpData = (await falseDefinitionHttp.json()) as {
      data: { variables: Array<{ name: string }>; appliedFilters: Record<string, unknown> };
    };
    expect(falseDefinitionHttpData.data.variables).toEqual([
      expect.objectContaining({ name: "unset_value" }),
    ]);
    expect(falseDefinitionHttpData.data.appliedFilters).toEqual({
      names: ["editable_value", "denied_value", "unset_value"],
      search: "",
      types: [],
      hasDefault: false,
      externallyWritable: false,
    });
    const auditResponse = await fetch(
      `${getTestBaseUrl()}/api/admin/audit-log?action=execution%3Aupdate_context&resourceId=${executionId}&limit=20`,
      { headers: { Cookie: `better-auth.session_token=${cookie}` } },
    );
    const auditData = (await auditResponse.json()) as {
      data: { entries: Array<{ metadata?: string; changes?: string | null }> };
    };
    const metadata = JSON.stringify(auditData.data.entries.map((entry) => entry.metadata));
    expect(metadata).toContain("variableName");
    expect(metadata).not.toContain('"old"');
    expect(metadata).not.toContain('"new"');
    const pathAudit = auditData.data.entries.find((entry) =>
      entry.metadata?.includes("set-variable-path"),
    );
    expect(pathAudit?.metadata).toContain("object_value.count");
    expect(pathAudit?.changes ?? null).toBeNull();
  });

  test("validator rejects external-write policies for undeclared variables and non-agent nodes", async () => {
    const result = await callMCPTool<any>(client, "manage", {
      action: "validate",
      workflow: {
        metadata: { name: "Invalid Policy", version: "1.0.0", description: "Invalid" },
        variableRegistry: {},
        runtimePolicy: { externalVariableWrites: { missing: { allowedNodeIds: ["start"] } } },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    });
    expect(result.valid).toBe(false);
    const messages = result.errors.map((error: { message: string }) => error.message).join(" ");
    expect(messages).toContain("undeclared variable");
    expect(messages).toContain("agent-directive");
  });

  test("projects owner-scoped progress consistently through session and HTTP", async () => {
    const sessionProgress = await callMCPTool<any>(client, "session", {
      action: "progress",
      executionId,
    });
    expect(sessionProgress).toMatchObject({
      title: "Edited runtime progress",
      activeNodeId: "first",
      workflowVersion: "1.0.0",
    });
    expect(sessionProgress.nodes).toEqual([
      expect.objectContaining({ id: "first", state: "current", focusNodeId: "task" }),
      expect.objectContaining({ id: "second", state: "pending", focusNodeId: "other" }),
    ]);

    const httpResponse = await fetch(`${getTestBaseUrl()}/api/executions/${executionId}/progress`, {
      headers: { Cookie: `better-auth.session_token=${cookie}` },
    });
    expect(httpResponse.status).toBe(200);
    const httpBody = (await httpResponse.json()) as { data: unknown };
    expect(httpBody.data).toEqual(sessionProgress);

    const denied = await fetch(`${getTestBaseUrl()}/api/executions/${executionId}/progress`, {
      headers: { Cookie: `better-auth.session_token=${foreignCookie}` },
    });
    expect(denied.status).toBe(401);
    const deniedMcp = await callMCPToolRaw(foreignClient, "session", {
      action: "progress",
      executionId,
    });
    expect(deniedMcp).toMatch(/access denied/i);

    const invalidCreate = await callMCPToolRaw(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: `Invalid Dynamic Progress ${randomUUID()}`,
          version: "1.0.0",
          description: "Must be rejected instead of narrowed",
        },
        progress: {
          nodes: [{ id: "work", label: "Work", condition: { operator: "always" } }],
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "work" } },
          {
            id: "work",
            type: "agent-directive",
            progressNodeId: "work",
            directive: "Work",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      },
    });
    expect(invalidCreate).toMatch(/invalid|unrecognized/i);

    const invalidEditProgressDefinitions = [
      {
        title: "Must not persist progress state",
        currentNodeId: "first",
        nodes: [
          { id: "first", label: "First" },
          { id: "second", label: "Second" },
        ],
      },
      {
        title: "Must not persist status",
        nodes: [
          { id: "first", label: "First", status: "completed" },
          { id: "second", label: "Second" },
        ],
      },
      {
        title: "Must not persist type",
        nodes: [
          { id: "first", label: "First", type: "condition" },
          { id: "second", label: "Second" },
        ],
      },
      {
        title: "Must not persist connection",
        nodes: [
          { id: "first", label: "First" },
          {
            id: "second",
            label: "Second",
            connections: { default: "first", error: "first" },
          },
        ],
      },
    ];
    for (const progress of invalidEditProgressDefinitions) {
      const invalidEdit = await callMCPToolRaw(client, "manage", {
        action: "edit",
        workflowId: "runtime-variable-test",
        changes: { progress },
      });
      expect(invalidEdit).toMatch(/invalid|unrecognized/i);
    }
    expect(
      await callMCPTool<any>(client, "session", { action: "progress", executionId }),
    ).toMatchObject({ title: "Edited runtime progress", activeNodeId: "first" });

    const noProgressWorkflow = await callMCPTool<any>(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: `No Progress ${randomUUID()}`,
          version: "1.0.0",
          description: "No progress error fixture",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    });
    const noProgressStarted = await callMCPToolRaw(client, "start", {
      workflowId: noProgressWorkflow.workflowId,
      parentExecutionId: "none",
      skipTelegramCheck: true,
    });
    const noProgressExecutionId = noProgressStarted.match(/Process ID: ([a-f0-9-]+)/)?.[1];
    expect(noProgressExecutionId).toBeDefined();
    expect(
      await callMCPToolRaw(client, "session", {
        action: "progress",
        executionId: noProgressExecutionId,
      }),
    ).toContain("no progress graph");
    const noProgressHttp = await fetch(
      `${getTestBaseUrl()}/api/executions/${noProgressExecutionId}/progress`,
      { headers: { Cookie: `better-auth.session_token=${cookie}` } },
    );
    expect(noProgressHttp.status).toBe(404);

    const imageGrant = await callMCPTool<any>(client, "session", {
      action: "progress-image-token",
      executionId,
      theme: "dark",
      viewportWidth: 720,
    });
    expect(imageGrant).toMatchObject({
      mimeType: "image/png",
      workflowVersion: "1.0.0",
      options: { theme: "dark", viewportWidth: 720 },
    });
    const imagePath = new URL(imageGrant.downloadUrl).pathname;
    const concurrentImages = await Promise.all([
      fetch(`${getTestBaseUrl()}${imagePath}`),
      fetch(`${getTestBaseUrl()}${imagePath}`),
    ]);
    expect(concurrentImages.map((response) => response.status).sort()).toEqual([200, 401]);
    const firstImage = concurrentImages.find((response) => response.status === 200)!;
    expect(firstImage.status).toBe(200);
    expect(firstImage.headers.get("content-type")).toContain("image/png");
    expect(
      Buffer.from(await firstImage.arrayBuffer())
        .subarray(0, 8)
        .toString("hex"),
    ).toBe("89504e470d0a1a0a");
    expect((await fetch(`${getTestBaseUrl()}${imagePath}`)).status).toBe(401);

    const httpMint = await fetch(
      `${getTestBaseUrl()}/api/executions/${executionId}/progress-image-token`,
      {
        method: "POST",
        headers: {
          Cookie: `better-auth.session_token=${cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ theme: "light", viewportWidth: 600 }),
      },
    );
    expect(httpMint.status).toBe(200);
    const httpGrantBody = (await httpMint.json()) as { data: any };
    expect(httpGrantBody).toMatchObject({
      data: { mimeType: "image/png", options: { theme: "light", viewportWidth: 600 } },
    });
    const foreignHttpMint = await fetch(
      `${getTestBaseUrl()}/api/executions/${executionId}/progress-image-token`,
      {
        method: "POST",
        headers: { Cookie: `better-auth.session_token=${foreignCookie}` },
      },
    );
    expect(foreignHttpMint.status).toBe(401);
    const invalidHttpMint = await fetch(
      `${getTestBaseUrl()}/api/executions/${executionId}/progress-image-token`,
      {
        method: "POST",
        headers: {
          Cookie: `better-auth.session_token=${cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ theme: "sepia", viewportWidth: 12 }),
      },
    );
    expect(invalidHttpMint.status).toBe(400);
    const currentEditable = await callMCPTool<any>(client, "session", {
      action: "variables",
      executionId,
      names: ["editable_value"],
    });
    await callMCPTool<any>(client, "session", {
      action: "set-variable",
      executionId,
      variableName: "editable_value",
      variableValue: currentEditable.variables[0].value === "old" ? "new" : "old",
      expectedRevision: httpGrantBody.data.executionRevision,
    });
    expect(
      (await fetch(`${getTestBaseUrl()}${new URL(httpGrantBody.data.downloadUrl).pathname}`))
        .status,
    ).toBe(401);
    expect(
      await callMCPToolRaw(foreignClient, "session", {
        action: "progress-image-token",
        executionId,
      }),
    ).toMatch(/access denied/i);
  });

  test("HTTP definition authoring persists valid policy and reports invalid policy", async () => {
    const authoredId = `runtime-variable-http-${randomUUID()}`;
    const invalidId = `runtime-variable-http-invalid-${randomUUID()}`;
    const workflow = {
      metadata: {
        name: "HTTP Runtime Policy",
        version: "1.0.0",
        description: "HTTP-authored runtime policy",
      },
      variableRegistry: {
        choice: { type: "string", description: "Choice", enum: ["a", "b"] },
      },
      runtimePolicy: {
        externalVariableWrites: { choice: { allowedNodeIds: ["task"] } },
      },
      nodes: [
        { id: "start", type: "start", connections: { default: "task" } },
        {
          id: "task",
          type: "agent-directive",
          directive: "Choose",
          completionCondition: "Chosen",
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    };
    const authored = await fetch(`${getTestBaseUrl()}/api/workflows`, {
      method: "POST",
      headers: {
        Cookie: `better-auth.session_token=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: authoredId,
        slug: authoredId,
        overwrite: true,
        workflow,
      }),
    });
    expect(authored.status).toBe(200);
    const authoredData = (await authored.json()) as { data: { validation: { valid: boolean } } };
    expect(authoredData.data.validation.valid).toBe(true);
    const reloaded = await fetch(
      `${getTestBaseUrl()}/api/workflows/${authoredId}/variables?names=choice&externallyWritable=true`,
      { headers: { Cookie: `better-auth.session_token=${cookie}` } },
    );
    const reloadedData = (await reloaded.json()) as {
      data: { variables: Array<{ name: string; externalWritePolicy: unknown }> };
    };
    expect(reloadedData.data.variables).toEqual([
      expect.objectContaining({
        name: "choice",
        externalWritePolicy: { allowedNodeIds: ["task"] },
      }),
    ]);

    const invalidAuthored = await fetch(`${getTestBaseUrl()}/api/workflows`, {
      method: "POST",
      headers: {
        Cookie: `better-auth.session_token=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: invalidId,
        slug: invalidId,
        overwrite: true,
        workflow: {
          ...workflow,
          metadata: { ...workflow.metadata, name: "Invalid HTTP Runtime Policy" },
          runtimePolicy: {
            externalVariableWrites: { missing: { allowedNodeIds: ["start"] } },
          },
        },
      }),
    });
    expect(invalidAuthored.status).toBe(200);
    const invalidData = (await invalidAuthored.json()) as {
      data: { validation: { valid: boolean; errors: string[] } };
    };
    expect(invalidData.data.validation.valid).toBe(false);
    expect(invalidData.data.validation.errors.join(" ")).toContain("undeclared variable");
  });

  test("bundled SDF exposes every variable read-only without changing its development boundary", async () => {
    const started = await callMCPToolRaw(client, "start", {
      workflowId: "moira/software-development-flow",
      parentExecutionId: "none",
      skipTelegramCheck: true,
    });
    const sdfExecutionId = started.match(/Process ID: ([a-f0-9-]+)/)?.[1];
    expect(sdfExecutionId).toBeDefined();
    const variables = await callMCPTool<any>(client, "session", {
      action: "variables",
      executionId: sdfExecutionId,
      names: ["visual_validation_preference", "vcs_commits_authorized", "current_step_index"],
    });
    expect(variables.variables).toHaveLength(3);
    expect(variables.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "visual_validation_preference",
          editable: false,
          denialReason: "policy_denied",
        }),
        expect.objectContaining({
          name: "vcs_commits_authorized",
          editable: false,
          denialReason: "policy_denied",
        }),
        expect.objectContaining({
          name: "current_step_index",
          editable: false,
          denialReason: "policy_denied",
        }),
      ]),
    );
    const editable = await callMCPTool<any>(client, "session", {
      action: "variables",
      executionId: sdfExecutionId,
      editable: true,
    });
    expect(editable.variables).toEqual([]);
    const denied = await callMCPToolRaw(client, "session", {
      action: "set-variable",
      executionId: sdfExecutionId,
      variableName: "visual_validation_preference",
      variableValue: "html_report",
      expectedRevision: variables.revision,
    });
    expect(denied).toContain("not externally editable");
    const after = await callMCPTool<any>(client, "session", {
      action: "variables",
      executionId: sdfExecutionId,
      names: ["visual_validation_preference"],
    });
    expect(after.revision).toBe(variables.revision);
    expect(after.variables).toEqual([
      expect.objectContaining({
        name: "visual_validation_preference",
        hasValue: false,
        editable: false,
      }),
    ]);

    const reminderState = await callMCPTool<any>(client, "session", {
      action: "reminders",
      executionId: sdfExecutionId,
      reminderStatus: "active",
    });
    const reminderText = "Open the authorized release pull request after SDF completion";
    const addedReminder = await callMCPTool<any>(client, "session", {
      action: "add-reminder",
      executionId: sdfExecutionId,
      reminderText,
      idempotencyKey: "sdf-authorized-release-pr",
      expectedRevision: reminderState.revision,
    });
    expect(addedReminder).toMatchObject({
      changed: true,
      reminder: { text: reminderText, status: "active" },
    });
    const activeReminders = await callMCPTool<any>(client, "session", {
      action: "reminders",
      executionId: sdfExecutionId,
      reminderStatus: "active",
    });
    expect(activeReminders.reminders).toEqual([
      expect.objectContaining({ text: reminderText, status: "active" }),
    ]);
    const authorityAfterReminder = await callMCPTool<any>(client, "session", {
      action: "variables",
      executionId: sdfExecutionId,
      names: ["vcs_commits_authorized"],
    });
    expect(authorityAfterReminder.revision).toBe(addedReminder.revision);
    expect(authorityAfterReminder.variables).toEqual([
      expect.objectContaining({
        name: "vcs_commits_authorized",
        value: false,
        editable: false,
      }),
    ]);
    const currentStep = await callMCPToolRaw(client, "session", {
      action: "current_step",
      executionId: sdfExecutionId,
    });
    expect(currentStep).not.toContain(reminderText);
  });
});
