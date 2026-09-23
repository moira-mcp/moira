import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { getDatabase, getWorkflowService, user } from "@mcp-moira/shared";
import { DatabaseRepository, type WorkflowGraph } from "@mcp-moira/workflow-engine";

import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import { listWorkflows } from "../../packages/mcp-server/src/tools/list-workflows.js";
import { manageSettings } from "../../packages/mcp-server/src/tools/manage-settings.js";
import { manageWorkflow } from "../../packages/mcp-server/src/tools/manage-workflow.js";

const suffix = `${Date.now()}`;
/**
 * The payload of a tool result that must have succeeded.
 *
 * A tool answers with `data` optional, because a failure carries an error instead. Reading through
 * that with `?.` or a cast makes an unexpected failure show up as "undefined has no property x";
 * this says which call failed and why.
 */
function payload<T>(result: { success: boolean; data?: unknown; error?: unknown }): T {
  if (!result.success || result.data === undefined) {
    throw new Error(`tool call failed: ${JSON.stringify(result.error ?? result)}`);
  }
  return result.data as T;
}

const TEST_USER_ID = `contract-completeness-${suffix}`;
const ADMIN_USER_ID = `contract-completeness-admin-${suffix}`;
const SEARCH_PREFIX = `Contract completeness ${suffix}`;

function workflow(name: string, complete = false): WorkflowGraph {
  return {
    metadata: {
      name,
      version: "1.0.0",
      description: "Exercises the complete MCP retrieval contract",
      ...(complete ? { author: "Contract Author", tags: ["contract", "mcp"] } : {}),
    },
    ...(complete
      ? {
          variableRegistry: {
            topic: { type: "string", description: "Current topic", default: "contracts" },
          },
          runtimePolicy: {
            externalVariableWrites: { topic: { allowedNodeIds: ["task"] } },
          },
          progress: {
            title: "Contract progress",
            nodes: [
              { id: "start", label: "Start", connections: { default: "task" } },
              { id: "task", label: "Task", connections: { default: "end" } },
              { id: "end", label: "Done" },
            ],
          },
          systemReminder: "Keep the complete contract visible.",
        }
      : {}),
    nodes: [
      { id: "start", type: "start", connections: { default: "task" } },
      {
        id: "task",
        type: "agent-directive",
        directive: "Complete the task.",
        completionCondition: "The task is complete.",
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
}

describe("complete MCP manage, settings, and list contracts", () => {
  const repository = new DatabaseRepository();
  const workflowIds: string[] = [];
  let completeWorkflowId = "";
  let emptyReminderWorkflowId = "";

  beforeAll(async () => {
    MCPEngine.resetInstance();
    const db = getDatabase();
    const now = new Date().toISOString();
    await db
      .insert(user)
      .values([
        {
          id: TEST_USER_ID,
          email: `${TEST_USER_ID}@test.invalid`,
          name: "Contract Completeness User",
          handle: TEST_USER_ID,
          emailVerified: true,
          isAdmin: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: ADMIN_USER_ID,
          email: `${ADMIN_USER_ID}@test.invalid`,
          name: "Contract Completeness Admin",
          handle: ADMIN_USER_ID,
          emailVerified: true,
          isAdmin: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .onConflictDoNothing();

    const service = getWorkflowService();
    const graphs = [
      workflow(`${SEARCH_PREFIX} A`, true),
      { ...workflow(`${SEARCH_PREFIX} B`), systemReminder: "" },
      workflow(`${SEARCH_PREFIX} C`),
    ];
    for (const [index, graph] of graphs.entries()) {
      const saved = await service.save({ graph, userId: TEST_USER_ID, visibility: "private" });
      workflowIds.push(saved.id);
      if (index === 0) completeWorkflowId = saved.id;
      if (index === 1) emptyReminderWorkflowId = saved.id;
    }

    await repository.setSetting(TEST_USER_ID, "profile.display_name", "dark");
    await repository.setSetting(TEST_USER_ID, "telegram.bot_token", "secret-contract-token");
    await repository.setSetting(TEST_USER_ID, "mcp.systemReminder", "admin-only value");
    await repository.setSetting(ADMIN_USER_ID, "mcp.systemReminder", "admin-visible value");
  });

  afterAll(async () => {
    for (const workflowId of workflowIds) {
      await repository.deleteWorkflow(workflowId, TEST_USER_ID);
    }
    await repository.deleteUserSettingValue(TEST_USER_ID, "profile.display_name");
    await repository.deleteUserSettingValue(TEST_USER_ID, "telegram.bot_token");
    await repository.deleteUserSettingValue(TEST_USER_ID, "mcp.systemReminder");
    await repository.deleteUserSettingValue(ADMIN_USER_ID, "mcp.systemReminder");
    MCPEngine.resetInstance();
  });

  test("manage get returns authored workflow facts and each inclusion flag removes only its field", async () => {
    const get = (params: Record<string, unknown>) =>
      runWithMCPContext({ userId: TEST_USER_ID }, () =>
        manageWorkflow({ action: "get", workflowId: completeWorkflowId, ...params }),
      );

    const full = await get({});
    expect(full.success).toBe(true);
    expect(full.data.workflowId).toBe(completeWorkflowId);
    expect(full.data.metadata).toEqual(
      expect.objectContaining({
        author: "Contract Author",
        tags: ["contract", "mcp"],
      }),
    );
    expect(full.data.variableRegistry).toEqual(
      expect.objectContaining({ topic: expect.objectContaining({ type: "string" }) }),
    );
    expect(full.data.runtimePolicy).toEqual(
      expect.objectContaining({ externalVariableWrites: expect.any(Object) }),
    );
    expect(full.data.progress).toEqual(expect.objectContaining({ title: "Contract progress" }));
    expect(full.data.systemReminder).toBe("Keep the complete contract visible.");
    expect(full.data).toHaveProperty("nodes");
    expect(full.data).toHaveProperty("validation");

    const withoutNodes = await get({ includeNodes: false });
    expect(withoutNodes.success).toBe(true);
    expect(withoutNodes.data).not.toHaveProperty("nodes");
    expect(withoutNodes.data).toHaveProperty("validation");
    expect(withoutNodes.data.variableRegistry).toEqual(full.data.variableRegistry);
    expect(withoutNodes.data.runtimePolicy).toEqual(full.data.runtimePolicy);
    expect(withoutNodes.data.progress).toEqual(full.data.progress);

    const withoutValidation = await get({ includeValidation: false });
    expect(withoutValidation.success).toBe(true);
    expect(withoutValidation.data).toHaveProperty("nodes");
    expect(withoutValidation.data).not.toHaveProperty("validation");
    expect(withoutValidation.data.metadata).toEqual(full.data.metadata);
    expect(withoutValidation.data.systemReminder).toBe(full.data.systemReminder);

    const emptyReminder = await runWithMCPContext({ userId: TEST_USER_ID }, () =>
      manageWorkflow({ action: "get", workflowId: emptyReminderWorkflowId }),
    );
    expect(emptyReminder.success).toBe(true);
    expect(emptyReminder.data.systemReminder).toBe("");
  });

  test("settings get distinguishes exact key, category, all, and invalid selectors", async () => {
    const get = (params: Record<string, unknown>) =>
      runWithMCPContext({ userId: TEST_USER_ID }, () =>
        manageSettings({ action: "get", ...params }),
      );

    await expect(get({ key: "profile.display_name" })).resolves.toEqual({
      success: true,
      data: { "profile.display_name": "dark" },
    });
    await expect(get({ key: "telegram.bot_token" })).resolves.toEqual({
      success: true,
      data: { "telegram.bot_token": "[encrypted]" },
    });

    const category = payload<Record<string, unknown>>(await get({ category: "notifications" }));
    expect(category["telegram.bot_token"]).toBe("[encrypted]");
    expect(Object.keys(category).every((key) => key.startsWith("telegram."))).toBe(true);

    const all = payload<Record<string, unknown>>(await get({}));
    expect(all["profile.display_name"]).toBe("dark");
    expect(all["telegram.bot_token"]).toBe("[encrypted]");
    expect(all).not.toHaveProperty("mcp.systemReminder");

    const adminCategory = await get({ category: "mcp" });
    expect(adminCategory).toEqual({ success: true, data: {} });

    const ambiguous = await get({ key: "profile.display_name", category: "profile" });
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.error).toContain("key or category");

    const emptyKey = await get({ key: "" });
    expect(emptyKey.success).toBe(false);
    expect(emptyKey.error).toContain("empty");

    const emptyCategory = await get({ category: "" });
    expect(emptyCategory.success).toBe(false);
    expect(emptyCategory.error).toContain("empty");

    const blankKey = await get({ key: "   " });
    expect(blankKey.success).toBe(false);
    expect(blankKey.error).toContain("empty");

    const blankCategory = await get({ category: "   " });
    expect(blankCategory.success).toBe(false);
    expect(blankCategory.error).toContain("empty");

    const emptyKeyWithCategory = await get({ key: "", category: "profile" });
    expect(emptyKeyWithCategory.success).toBe(false);
    expect(emptyKeyWithCategory.error).toContain("key or category");

    const unknown = await get({ key: `unknown.${suffix}` });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain("not found");

    const adminOnly = await get({ key: "mcp.systemReminder" });
    expect(adminOnly.success).toBe(false);
    expect(adminOnly.error).toContain("admin-only");

    const listedAdminOnly = await runWithMCPContext({ userId: TEST_USER_ID }, () =>
      manageSettings({ action: "list", category: "mcp" }),
    );
    expect(listedAdminOnly).toEqual({ success: true, data: [] });

    const adminExact = await runWithMCPContext({ userId: ADMIN_USER_ID }, () =>
      manageSettings({ action: "get", key: "mcp.systemReminder" }),
    );
    expect(adminExact).toEqual({
      success: true,
      data: { "mcp.systemReminder": "admin-visible value" },
    });

    const adminDefinitions = await runWithMCPContext({ userId: ADMIN_USER_ID }, () =>
      manageSettings({ action: "list", category: "mcp" }),
    );
    expect(adminDefinitions.success).toBe(true);
    expect(adminDefinitions.data).toContainEqual(
      expect.objectContaining({ key: "mcp.systemReminder" }),
    );
  });

  test("list returns an explicit first-page continuation and terminal last page", async () => {
    const list = (offset: number) =>
      runWithMCPContext({ userId: TEST_USER_ID }, () =>
        listWorkflows({ search: SEARCH_PREFIX, sort: "name", sortOrder: "asc", limit: 2, offset }),
      );

    const defaults = await runWithMCPContext({ userId: TEST_USER_ID }, () =>
      listWorkflows({ search: SEARCH_PREFIX, sort: "name", sortOrder: "asc" }),
    );
    expect(defaults.success).toBe(true);
    expect(defaults.data).toEqual(
      expect.objectContaining({
        total: 3,
        offset: 0,
        limit: 20,
        returnedCount: 3,
        hasMore: false,
        nextOffset: null,
      }),
    );

    const first = await list(0);
    expect(first.success).toBe(true);
    expect(first.data).toEqual(
      expect.objectContaining({
        total: 3,
        offset: 0,
        limit: 2,
        returnedCount: 2,
        hasMore: true,
        nextOffset: 2,
      }),
    );

    const last = await list(payload<{ nextOffset: number }>(first).nextOffset);
    expect(last.success).toBe(true);
    expect(last.data).toEqual(
      expect.objectContaining({
        total: 3,
        offset: 2,
        limit: 2,
        returnedCount: 1,
        hasMore: false,
        nextOffset: null,
      }),
    );
  });
});
