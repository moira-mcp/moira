/**
 * Integration Tests - Audit Logging
 * Verify audit trail captures security events
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { logAuditEventDirect, AuditAction } from "@mcp-moira/shared";

describe("Audit Logging Integration", () => {
  let repository: DatabaseRepository;
  const testUserId = "system-admin";

  beforeAll(() => {
    repository = new DatabaseRepository();
  });

  test("workflow:create event logged", async () => {
    const beforeCount = (await repository.listAuditLogs({ action: AuditAction.WORKFLOW_CREATE }))
      .length;

    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.WORKFLOW_CREATE,
      resource: "workflow",
      resourceId: "test-wf-123",
      metadata: { name: "Test Workflow", source: "integration-test" },
    });

    const afterCount = (await repository.listAuditLogs({ action: AuditAction.WORKFLOW_CREATE }))
      .length;

    expect(afterCount).toBeGreaterThanOrEqual(beforeCount + 1);
  });

  test("workflow:delete event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.WORKFLOW_DELETE,
      resource: "workflow",
      resourceId: "deleted-wf-123",
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.WORKFLOW_DELETE, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.WORKFLOW_DELETE);
    expect(logs[0].resource).toBe("workflow");
  });

  test("workflow:edit event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.WORKFLOW_EDIT,
      resource: "workflow",
      resourceId: "edited-wf-123",
      metadata: { changes: "metadata update" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.WORKFLOW_EDIT, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].resourceId).toBe("edited-wf-123");
  });

  test("execution:start event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.EXECUTION_START,
      resource: "execution",
      resourceId: "exec-123",
      metadata: { workflowId: "wf-123" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.EXECUTION_START, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.EXECUTION_START);
  });

  test("execution:update_context event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.EXECUTION_UPDATE_CONTEXT,
      resource: "execution",
      resourceId: "exec-456",
      metadata: { contextChanges: { key: "value" } },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.EXECUTION_UPDATE_CONTEXT,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.EXECUTION_UPDATE_CONTEXT);
    expect(logs[0].resource).toBe("execution");
  });

  test("admin:block_user event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_BLOCK_USER,
      resource: "user",
      resourceId: "blocked-user-123",
      metadata: { reason: "test block" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.ADMIN_BLOCK_USER, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].resourceId).toBe("blocked-user-123");
  });

  test("admin:unblock_user event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_UNBLOCK_USER,
      resource: "user",
      resourceId: "unblocked-user-123",
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.ADMIN_UNBLOCK_USER,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
  });

  test("audit logs include complete context", async () => {
    const testId = "context-test-" + Date.now();

    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: "test:context",
      resource: "test",
      resourceId: testId,
      ip: "192.168.1.100",
      country: "US",
      userAgent: "Test Agent 1.0",
      metadata: { key1: "value1", key2: "value2" },
    });

    const logs = await repository.listAuditLogs({ resource: "test", limit: 10 });
    const log = logs.find((l) => l.resourceId === testId);

    expect(log).toBeDefined();
    expect(log?.userId).toBe(testUserId);
    expect(log?.ip).toBe("192.168.1.100");
    expect(log?.country).toBe("US");
    expect(log?.userAgent).toBe("Test Agent 1.0");
    expect(log?.metadata).toBeDefined();
  });

  test("audit logs queryable by userId", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: "test:user-filter",
      resource: "test",
    });

    const logs = await repository.listAuditLogs({ userId: testUserId, limit: 100 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.userId === testUserId)).toBe(true);
  });

  test("audit logs ordered by createdAt DESC", async () => {
    const logs = await repository.listAuditLogs({ limit: 10 });

    expect(logs.length).toBeGreaterThan(0);

    for (let i = 1; i < logs.length; i++) {
      expect(logs[i - 1].createdAt).toBeGreaterThanOrEqual(logs[i].createdAt);
    }
  });

  test("auth:sign_up event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.AUTH_SIGN_UP,
      resource: "user",
      resourceId: testUserId,
      ip: "192.168.1.50",
      userAgent: "Mozilla/5.0",
      metadata: { email: "test@example.com", provider: "email" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.AUTH_SIGN_UP, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.AUTH_SIGN_UP);
    expect(logs[0].resource).toBe("user");
  });

  test("auth:sign_in event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.AUTH_SIGN_IN,
      resource: "session",
      resourceId: "session-123",
      ip: "192.168.1.51",
      userAgent: "Mozilla/5.0",
      metadata: { provider: "email" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.AUTH_SIGN_IN, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.AUTH_SIGN_IN);
    expect(logs[0].resource).toBe("session");
  });

  test("auth:sign_out event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.AUTH_SIGN_OUT,
      resource: "session",
      resourceId: "session-456",
      ip: "192.168.1.52",
      userAgent: "Mozilla/5.0",
      metadata: {},
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.AUTH_SIGN_OUT, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.AUTH_SIGN_OUT);
    expect(logs[0].resource).toBe("session");
  });

  // Settings Tests
  test("settings:set event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.SETTINGS_SET,
      resource: "settings",
      resourceId: "ui.theme",
      metadata: { value: "dark", previousValue: "light" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.SETTINGS_SET, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.SETTINGS_SET);
    expect(logs[0].resourceId).toBe("ui.theme");
  });

  test("settings:delete event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.SETTINGS_DELETE,
      resource: "settings",
      resourceId: "profile.bio",
      metadata: { deletedValue: "old bio text" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.SETTINGS_DELETE, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.SETTINGS_DELETE);
    expect(logs[0].resource).toBe("settings");
  });

  // Admin Settings Tests
  test("admin:settings:create_definition event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_SETTINGS_CREATE_DEFINITION,
      resource: "settings_definition",
      resourceId: "new.feature.flag",
      metadata: { type: "boolean", defaultValue: false, category: "features" },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.ADMIN_SETTINGS_CREATE_DEFINITION,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_SETTINGS_CREATE_DEFINITION);
    expect(logs[0].resourceId).toBe("new.feature.flag");
  });

  test("admin:settings:update_definition event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_SETTINGS_UPDATE_DEFINITION,
      resource: "settings_definition",
      resourceId: "existing.setting",
      metadata: { changes: { defaultValue: "new-default" } },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.ADMIN_SETTINGS_UPDATE_DEFINITION,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_SETTINGS_UPDATE_DEFINITION);
  });

  test("admin:settings:delete_definition event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_SETTINGS_DELETE_DEFINITION,
      resource: "settings_definition",
      resourceId: "deprecated.setting",
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.ADMIN_SETTINGS_DELETE_DEFINITION,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_SETTINGS_DELETE_DEFINITION);
  });

  // Admin User Management Tests
  test("admin:verify_email event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_VERIFY_EMAIL,
      resource: "user",
      resourceId: "user-789",
      metadata: { email: "user@example.com" },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.ADMIN_VERIFY_EMAIL,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_VERIFY_EMAIL);
    expect(logs[0].resource).toBe("user");
  });

  test("admin:send_verification event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_SEND_VERIFICATION,
      resource: "user",
      resourceId: "user-790",
      metadata: { email: "newuser@example.com" },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.ADMIN_SEND_VERIFICATION,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_SEND_VERIFICATION);
  });

  test("admin:send_reset event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_SEND_RESET,
      resource: "user",
      resourceId: "user-791",
      metadata: { email: "reset@example.com", reason: "admin initiated" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.ADMIN_SEND_RESET, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_SEND_RESET);
  });

  test("admin:revoke_all_sessions event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_REVOKE_ALL_SESSIONS,
      resource: "user",
      resourceId: "user-792",
      metadata: { sessionsRevoked: 5 },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.ADMIN_REVOKE_ALL_SESSIONS,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_REVOKE_ALL_SESSIONS);
  });

  test("admin:update_user event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_UPDATE_USER,
      resource: "user",
      resourceId: "user-793",
      metadata: { changes: { role: "admin" } },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.ADMIN_UPDATE_USER,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_UPDATE_USER);
  });

  test("admin:delete_user event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_DELETE_USER,
      resource: "user",
      resourceId: "user-794",
      metadata: { reason: "account violation" },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.ADMIN_DELETE_USER,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_DELETE_USER);
    expect(logs[0].resource).toBe("user");
  });

  // Admin Workflow Tests
  test("workflow:restore event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.WORKFLOW_RESTORE,
      resource: "workflow",
      resourceId: "restored-wf-456",
      metadata: { deletedAt: "2025-01-01T00:00:00Z" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.WORKFLOW_RESTORE, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.WORKFLOW_RESTORE);
    expect(logs[0].resource).toBe("workflow");
  });

  test("workflow:hard_delete event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.WORKFLOW_HARD_DELETE,
      resource: "workflow",
      resourceId: "permanently-deleted-wf-789",
      metadata: { reason: "admin cleanup" },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.WORKFLOW_HARD_DELETE,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.WORKFLOW_HARD_DELETE);
  });

  // Admin Execution Test
  test("admin:update_execution_context event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_UPDATE_EXECUTION_CONTEXT,
      resource: "execution",
      resourceId: "exec-999",
      metadata: { contextChanges: { variable: "new-value" } },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.ADMIN_UPDATE_EXECUTION_CONTEXT,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_UPDATE_EXECUTION_CONTEXT);
    expect(logs[0].resource).toBe("execution");
  });

  // Admin Database Tests
  test("admin:vacuum_db event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_VACUUM_DB,
      resource: "database",
      resourceId: "moira.db",
      metadata: { sizeBefore: "100MB", sizeAfter: "80MB" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.ADMIN_VACUUM_DB, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_VACUUM_DB);
    expect(logs[0].resource).toBe("database");
  });

  test("admin:backup_db event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.ADMIN_BACKUP_DB,
      resource: "database",
      resourceId: "moira.db",
      metadata: { backupPath: "/backups/moira-2025-01-21.db", size: "100MB" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.ADMIN_BACKUP_DB, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.ADMIN_BACKUP_DB);
  });

  // Execution Step Tests (for Step 1 fix)
  test("execution:step event logged with node transition metadata", async () => {
    const testExecId = "exec-step-test-" + Date.now();

    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.EXECUTION_STEP,
      resource: "execution",
      resourceId: testExecId,
      metadata: {
        workflowId: "test-workflow",
        fromNodeId: "node-1",
        toNodeId: "node-2",
      },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.EXECUTION_STEP, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.EXECUTION_STEP);
    expect(logs[0].resourceId).toBe(testExecId);
    expect(logs[0].metadata).toBeDefined();

    const metadata = JSON.parse(logs[0].metadata || "{}");
    expect(metadata.fromNodeId).toBe("node-1");
    expect(metadata.toNodeId).toBe("node-2");
  });

  test("execution:complete event logged with completion metadata", async () => {
    const testExecId = "exec-complete-test-" + Date.now();
    const createdAt = Date.now() - 60000; // 1 minute ago
    const completedAt = Date.now();
    const totalSteps = 5;
    const durationMs = completedAt - createdAt;

    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.EXECUTION_COMPLETE,
      resource: "execution",
      resourceId: testExecId,
      metadata: {
        workflowId: "test-workflow",
        completedAt,
        totalSteps,
        durationMs,
      },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.EXECUTION_COMPLETE,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.EXECUTION_COMPLETE);
    expect(logs[0].resourceId).toBe(testExecId);
    expect(logs[0].metadata).toBeDefined();

    const metadata = JSON.parse(logs[0].metadata || "{}");
    expect(metadata.workflowId).toBe("test-workflow");
    expect(metadata.completedAt).toBe(completedAt);
    expect(metadata.totalSteps).toBe(totalSteps);
    expect(metadata.durationMs).toBe(durationMs);
  });

  test("execution:step_fail event logged with error context", async () => {
    const testExecId = "exec-fail-test-" + Date.now();

    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.EXECUTION_STEP_FAIL,
      resource: "execution",
      resourceId: testExecId,
      metadata: {
        workflowId: "test-workflow",
        nodeId: "failing-node",
        errorMessage: "Validation failed",
        errorCode: "VALIDATION_ERROR",
      },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.EXECUTION_STEP_FAIL,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.EXECUTION_STEP_FAIL);
    expect(logs[0].resourceId).toBe(testExecId);

    const metadata = JSON.parse(logs[0].metadata || "{}");
    expect(metadata.nodeId).toBe("failing-node");
    expect(metadata.errorMessage).toBe("Validation failed");
  });

  test("execution:fail event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.EXECUTION_FAIL,
      resource: "execution",
      resourceId: "failed-exec-123",
      metadata: { workflowId: "wf-123", error: "Runtime error" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.EXECUTION_FAIL, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.EXECUTION_FAIL);
    expect(logs[0].resource).toBe("execution");
  });

  test("execution:cancel event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.EXECUTION_CANCEL,
      resource: "execution",
      resourceId: "cancelled-exec-123",
      metadata: { workflowId: "wf-123" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.EXECUTION_CANCEL, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.EXECUTION_CANCEL);
    expect(logs[0].resource).toBe("execution");
  });

  test("execution:delete event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.EXECUTION_DELETE,
      resource: "execution",
      resourceId: "deleted-exec-123",
      metadata: { workflowId: "wf-123" },
    });

    const logs = await repository.listAuditLogs({ action: AuditAction.EXECUTION_DELETE, limit: 1 });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.EXECUTION_DELETE);
    expect(logs[0].resource).toBe("execution");
  });

  test("countByActionAndResourceId returns correct count", async () => {
    const testExecId = "count-test-exec-" + Date.now();

    // Create 3 step events for the same execution
    for (let i = 0; i < 3; i++) {
      await logAuditEventDirect(repository, {
        userId: testUserId,
        action: AuditAction.EXECUTION_STEP,
        resource: "execution",
        resourceId: testExecId,
        metadata: {
          workflowId: "test-workflow",
          fromNodeId: `node-${i}`,
          toNodeId: `node-${i + 1}`,
        },
      });
    }

    const count = await repository.countAuditByActionAndResourceId(
      AuditAction.EXECUTION_STEP,
      testExecId,
    );

    expect(count).toBe(3);
  });

  test("oauth:consent_grant event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.OAUTH_CONSENT_GRANT,
      resource: "oauth_consent",
      resourceId: "consent-123",
      metadata: { clientId: "test-client", scopes: "openid" },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.OAUTH_CONSENT_GRANT,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.OAUTH_CONSENT_GRANT);
    expect(logs[0].resource).toBe("oauth_consent");
  });

  test("oauth:consent_update event logged", async () => {
    await logAuditEventDirect(repository, {
      userId: testUserId,
      action: AuditAction.OAUTH_CONSENT_UPDATE,
      resource: "oauth_consent",
      resourceId: "consent-456",
      metadata: { clientId: "test-client", scopes: "openid profile" },
    });

    const logs = await repository.listAuditLogs({
      action: AuditAction.OAUTH_CONSENT_UPDATE,
      limit: 1,
    });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe(AuditAction.OAUTH_CONSENT_UPDATE);
  });

  test("all AuditAction enum values are valid strings", () => {
    const allActions = Object.values(AuditAction);
    expect(allActions.length).toBeGreaterThan(0);

    for (const action of allActions) {
      expect(typeof action).toBe("string");
      expect(action).toMatch(/^[a-z_]+(:[a-z_]+)+$/);
    }
  });

  test("every mutating audit action can be logged and queried", async () => {
    const mutatingActions = [
      AuditAction.WORKFLOW_CREATE,
      AuditAction.WORKFLOW_EDIT,
      AuditAction.WORKFLOW_DELETE,
      AuditAction.EXECUTION_START,
      AuditAction.EXECUTION_STEP,
      AuditAction.EXECUTION_COMPLETE,
      AuditAction.ADMIN_BLOCK_USER,
      AuditAction.ADMIN_UNBLOCK_USER,
      AuditAction.SETTINGS_SET,
      AuditAction.SETTINGS_DELETE,
      AuditAction.NOTE_CREATE,
      AuditAction.NOTE_UPDATE,
      AuditAction.NOTE_DELETE,
      AuditAction.ARTIFACT_CREATE,
      AuditAction.ARTIFACT_UPDATE,
      AuditAction.ARTIFACT_DELETE,
      AuditAction.SHARING_INVITE_CREATE,
      AuditAction.SHARING_INVITE_ACCEPT,
      AuditAction.SHARING_ACCESS_REVOKE,
      AuditAction.OAUTH_CONSENT_GRANT,
      AuditAction.OAUTH_CONSENT_UPDATE,
      AuditAction.USER_PASSWORD_CHANGED,
    ];

    const uniqueResourceId = `coverage-test-${Date.now()}`;

    for (const action of mutatingActions) {
      await logAuditEventDirect(repository, {
        userId: testUserId,
        action,
        resource: "coverage-test",
        resourceId: uniqueResourceId,
        metadata: { test: true },
      });
    }

    const allLogs = await repository.listAuditLogs({
      resourceId: uniqueResourceId,
      limit: 100,
    });

    expect(allLogs.length).toBe(mutatingActions.length);

    const loggedActions = new Set(allLogs.map((l) => l.action));
    for (const action of mutatingActions) {
      expect(loggedActions.has(action)).toBe(true);
    }
  });
});
