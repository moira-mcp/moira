/**
 * Unit tests for GlobalSettingsService
 * Tests audit logging behavior with real values
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { GlobalSettingsService } from "@mcp-moira/shared";
import type { GlobalSettingsRepository, GlobalSetting } from "@mcp-moira/shared";
import type { AuditRepository } from "@mcp-moira/shared";

describe("GlobalSettingsService", () => {
  let service: GlobalSettingsService;
  let mockGlobalSettingsRepo: jest.Mocked<GlobalSettingsRepository>;
  let mockAuditRepo: jest.Mocked<AuditRepository>;
  const adminUserId = "admin-user-123";

  beforeEach(() => {
    // Create mock repositories
    mockGlobalSettingsRepo = {
      getAll: jest.fn<() => Promise<GlobalSetting[]>>(),
      get: jest.fn<(key: string) => Promise<GlobalSetting | null>>(),
      getValue: jest.fn<(key: string) => Promise<unknown>>(),
      getByCategory: jest.fn<(category: string) => Promise<GlobalSetting[]>>(),
      setValue: jest.fn<(key: string, value: string | null, updatedBy: string) => Promise<void>>(),
    } as unknown as jest.Mocked<GlobalSettingsRepository>;

    mockAuditRepo = {
      log: jest.fn<() => Promise<string>>().mockResolvedValue("audit-id-123"),
    } as unknown as jest.Mocked<AuditRepository>;

    service = new GlobalSettingsService(mockGlobalSettingsRepo, mockAuditRepo);
  });

  describe("setValue", () => {
    it("logs audit event with REAL old and new values", async () => {
      // Setup: existing value
      mockGlobalSettingsRepo.get.mockResolvedValue({
        key: "mcp.systemReminder",
        value: "old reminder text",
        type: "text",
        label: "System Reminder",
        description: null,
        category: "mcp",
        sortOrder: 0,
        updatedAt: Date.now(),
        updatedBy: null,
      });

      // Act: update value
      await service.setValue("mcp.systemReminder", "new reminder text", adminUserId);

      // Assert: audit log called with real values
      expect(mockAuditRepo.log).toHaveBeenCalledTimes(1);
      const auditCall = mockAuditRepo.log.mock.calls[0][0];

      expect(auditCall.action).toBe("admin:global_settings:update");
      expect(auditCall.resource).toBe("globalSetting");
      expect(auditCall.resourceId).toBe("mcp.systemReminder");
      expect(auditCall.userId).toBe(adminUserId);

      // Parse changes JSON
      const changes = JSON.parse(auditCall.changes as string);
      expect(changes).toEqual([
        {
          field: "value",
          oldValue: "old reminder text",
          newValue: "new reminder text",
        },
      ]);
    });

    it("logs audit event with null old value when setting is new", async () => {
      // Setup: no existing value
      mockGlobalSettingsRepo.get.mockResolvedValue(null);

      // Act: set new value
      await service.setValue("mcp.newSetting", "new value", adminUserId);

      // Assert: audit log has null oldValue
      const auditCall = mockAuditRepo.log.mock.calls[0][0];
      const changes = JSON.parse(auditCall.changes as string);

      expect(changes).toEqual([
        {
          field: "value",
          oldValue: null,
          newValue: "new value",
        },
      ]);
    });

    it("logs audit event with null new value when clearing setting", async () => {
      // Setup: existing value
      mockGlobalSettingsRepo.get.mockResolvedValue({
        key: "mcp.setting",
        value: "existing value",
        type: "string",
        label: "Test",
        description: null,
        category: "mcp",
        sortOrder: 0,
        updatedAt: Date.now(),
        updatedBy: null,
      });

      // Act: clear value
      await service.setValue("mcp.setting", null, adminUserId);

      // Assert: audit log has null newValue
      const auditCall = mockAuditRepo.log.mock.calls[0][0];
      const changes = JSON.parse(auditCall.changes as string);

      expect(changes).toEqual([
        {
          field: "value",
          oldValue: "existing value",
          newValue: null,
        },
      ]);
    });

    it("stores complete values for rollback capability", async () => {
      // Setup: long text value
      const longOldValue =
        "This is a very long system prompt text that contains multiple paragraphs and instructions for the AI agent.";
      const longNewValue =
        "This is an updated system prompt with completely different content for testing purposes.";

      mockGlobalSettingsRepo.get.mockResolvedValue({
        key: "mcp.systemPrompt",
        value: longOldValue,
        type: "text",
        label: "System Prompt",
        description: null,
        category: "mcp",
        sortOrder: 0,
        updatedAt: Date.now(),
        updatedBy: null,
      });

      // Act
      await service.setValue("mcp.systemPrompt", longNewValue, adminUserId);

      // Assert: complete values stored (not truncated or placeholder)
      const auditCall = mockAuditRepo.log.mock.calls[0][0];
      const changes = JSON.parse(auditCall.changes as string);

      expect(changes[0].oldValue).toBe(longOldValue);
      expect(changes[0].newValue).toBe(longNewValue);
    });

    it("does NOT use placeholder values like [set] or [not set]", async () => {
      mockGlobalSettingsRepo.get.mockResolvedValue({
        key: "test.key",
        value: "actual value",
        type: "string",
        label: "Test",
        description: null,
        category: "test",
        sortOrder: 0,
        updatedAt: Date.now(),
        updatedBy: null,
      });

      await service.setValue("test.key", "new actual value", adminUserId);

      const auditCall = mockAuditRepo.log.mock.calls[0][0];
      const changes = JSON.parse(auditCall.changes as string);

      // Should NOT contain placeholder text
      expect(changes[0].oldValue).not.toBe("[set]");
      expect(changes[0].oldValue).not.toBe("[not set]");
      expect(changes[0].newValue).not.toBe("[set]");
      expect(changes[0].newValue).not.toBe("[not set]");

      // Should contain actual values
      expect(changes[0].oldValue).toBe("actual value");
      expect(changes[0].newValue).toBe("new actual value");
    });
  });

  describe("read operations (no audit)", () => {
    it("getAll does not create audit entry", async () => {
      mockGlobalSettingsRepo.getAll.mockResolvedValue([]);

      await service.getAll();

      expect(mockAuditRepo.log).not.toHaveBeenCalled();
    });

    it("get does not create audit entry", async () => {
      mockGlobalSettingsRepo.get.mockResolvedValue(null);

      await service.get("any.key");

      expect(mockAuditRepo.log).not.toHaveBeenCalled();
    });

    it("getValue does not create audit entry", async () => {
      mockGlobalSettingsRepo.getValue.mockResolvedValue(null);

      await service.getValue("any.key");

      expect(mockAuditRepo.log).not.toHaveBeenCalled();
    });

    it("getByCategory does not create audit entry", async () => {
      mockGlobalSettingsRepo.getByCategory.mockResolvedValue([]);

      await service.getByCategory("any");

      expect(mockAuditRepo.log).not.toHaveBeenCalled();
    });
  });
});
