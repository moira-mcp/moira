/**
 * Unit Tests - AuditRepository
 * Tests audit log CRUD operations
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { AuditRepository, getDatabase, closeDatabase } from "@mcp-moira/shared";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "@mcp-moira/shared";

describe("AuditRepository", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let repository: AuditRepository;
  const testUserId = "system-admin"; // Use existing user

  beforeEach(() => {
    db = getDatabase();
    repository = new AuditRepository(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  test("log() creates audit entry", async () => {
    const entry = {
      userId: testUserId,
      action: "test:action",
      resource: "test-resource",
      resourceId: "resource-123",
      ip: "192.168.1.1",
      country: "US",
      userAgent: "test-agent",
      metadata: JSON.stringify({ test: true }),
    };

    const id = await repository.log(entry);

    expect(id).toBeDefined();
    expect(typeof id).toBe("string");

    // Verify entry was created
    const retrieved = await repository.get(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.userId).toBe(testUserId);
    expect(retrieved?.action).toBe("test:action");
    expect(retrieved?.resource).toBe("test-resource");
    expect(retrieved?.resourceId).toBe("resource-123");
    expect(retrieved?.ip).toBe("192.168.1.1");
    expect(retrieved?.country).toBe("US");
  });

  test("log() creates entry without optional fields", async () => {
    const entry = {
      action: "test:minimal",
    };

    const id = await repository.log(entry);
    const retrieved = await repository.get(id);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.action).toBe("test:minimal");
    expect(retrieved?.userId).toBeUndefined();
    expect(retrieved?.resource).toBeUndefined();
  });

  test("list() returns all entries", async () => {
    // Create multiple entries
    await repository.log({ userId: testUserId, action: "test:action1" });
    await repository.log({ userId: testUserId, action: "test:action2" });
    await repository.log({ action: "test:action3" });

    const entries = await repository.list();

    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries[0].createdAt).toBeGreaterThanOrEqual(entries[1].createdAt);
  });

  test("list() filters by userId", async () => {
    const userId1 = "system-admin";

    await repository.log({ userId: userId1, action: "test:user1" });
    await repository.log({ action: "test:user2" }); // No userId

    const user1Entries = await repository.list({ userId: userId1 });

    expect(user1Entries.length).toBeGreaterThanOrEqual(1);
    expect(user1Entries.every((e) => e.userId === userId1)).toBe(true);
  });

  test("list() filters by action", async () => {
    await repository.log({ action: "auth:login", userId: testUserId });
    await repository.log({ action: "workflow:create", userId: testUserId });

    const loginEntries = await repository.list({ action: "auth:login" });

    expect(loginEntries.length).toBeGreaterThanOrEqual(1);
    expect(loginEntries.every((e) => e.action === "auth:login")).toBe(true);
  });

  test("list() filters by resource", async () => {
    await repository.log({ action: "test:action", resource: "workflow", resourceId: "wf-1" });
    await repository.log({ action: "test:action", resource: "execution", resourceId: "ex-1" });

    const workflowEntries = await repository.list({ resource: "workflow" });

    expect(workflowEntries.length).toBeGreaterThanOrEqual(1);
    expect(workflowEntries.every((e) => e.resource === "workflow")).toBe(true);
  });

  test("list() supports pagination", async () => {
    // Create multiple entries
    for (let i = 0; i < 5; i++) {
      await repository.log({ action: `test:pagination${i}` });
    }

    const page1 = await repository.list({ limit: 2, offset: 0 });
    const page2 = await repository.list({ limit: 2, offset: 2 });

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  test("get() returns null for non-existent entry", async () => {
    const entry = await repository.get("non-existent-id");
    expect(entry).toBeNull();
  });

  test("get() returns complete entry data", async () => {
    const metadata = { key: "value", nested: { data: true } };
    const entry = {
      userId: testUserId,
      action: "test:complete",
      resource: "test",
      resourceId: "res-123",
      ip: "10.0.0.1",
      country: "UK",
      userAgent: "Mozilla/5.0",
      metadata: JSON.stringify(metadata),
    };

    const id = await repository.log(entry);
    const retrieved = await repository.get(id);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(id);
    expect(retrieved?.userId).toBe(testUserId);
    expect(retrieved?.action).toBe("test:complete");
    expect(retrieved?.resource).toBe("test");
    expect(retrieved?.resourceId).toBe("res-123");
    expect(retrieved?.ip).toBe("10.0.0.1");
    expect(retrieved?.country).toBe("UK");
    expect(retrieved?.userAgent).toBe("Mozilla/5.0");
    expect(retrieved?.metadata).toBe(JSON.stringify(metadata));
    expect(retrieved?.createdAt).toBeGreaterThan(0);
  });

  // Tests for changes field (audit diff tracking)
  describe("changes field", () => {
    test("log() stores changes field as JSON string", async () => {
      const changes = [
        { field: "name", oldValue: "Old Name", newValue: "New Name" },
        { field: "version", oldValue: "1.0.0", newValue: "2.0.0" },
      ];

      const id = await repository.log({
        action: "workflow:edit",
        resource: "workflow",
        resourceId: "wf-123",
        changes: JSON.stringify(changes),
      });

      const retrieved = await repository.get(id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.changes).toBeDefined();
      expect(JSON.parse(retrieved!.changes!)).toEqual(changes);
    });

    test("log() handles entry without changes field", async () => {
      const id = await repository.log({
        action: "workflow:create",
        resource: "workflow",
      });

      const retrieved = await repository.get(id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.changes).toBeUndefined();
    });

    test("list() returns entries with changes field", async () => {
      const changes = [{ field: "count", oldValue: 5, newValue: 10 }];

      await repository.log({
        action: "test:changes",
        changes: JSON.stringify(changes),
      });

      const entries = await repository.list({ action: "test:changes" });

      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries.find((e) => e.changes);
      expect(entry).toBeDefined();
      expect(JSON.parse(entry!.changes!)).toEqual(changes);
    });

    test("get() returns entry with complex changes", async () => {
      const changes = [
        { field: "config", oldValue: { nested: "old" }, newValue: { nested: "new" } },
        { field: "enabled", oldValue: false, newValue: true },
        { field: "tags", oldValue: null, newValue: ["tag1", "tag2"] },
      ];

      const id = await repository.log({
        action: "settings:update",
        changes: JSON.stringify(changes),
      });

      const retrieved = await repository.get(id);

      expect(retrieved?.changes).toBeDefined();
      const parsedChanges = JSON.parse(retrieved!.changes!);
      expect(parsedChanges).toHaveLength(3);
      expect(parsedChanges[0].field).toBe("config");
      expect(parsedChanges[1].newValue).toBe(true);
      expect(parsedChanges[2].newValue).toEqual(["tag1", "tag2"]);
    });

    test("changes field preserves empty array", async () => {
      const id = await repository.log({
        action: "test:empty-changes",
        changes: JSON.stringify([]),
      });

      const retrieved = await repository.get(id);

      expect(retrieved?.changes).toBe("[]");
      expect(JSON.parse(retrieved!.changes!)).toEqual([]);
    });
  });
});
