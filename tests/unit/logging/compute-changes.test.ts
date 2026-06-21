/**
 * Unit Tests - computeChanges helper
 * Tests diff computation between objects for audit log
 */

import { describe, test, expect } from "@jest/globals";
import { computeChanges } from "@mcp-moira/shared";

describe("computeChanges", () => {
  test("detects simple string field changes", () => {
    const oldObj = { name: "Old Name", version: "1.0.0" };
    const newObj = { name: "New Name", version: "1.0.0" };

    const changes = computeChanges(oldObj, newObj);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      field: "name",
      oldValue: "Old Name",
      newValue: "New Name",
    });
  });

  test("detects multiple field changes", () => {
    const oldObj = { name: "Old", version: "1.0.0", count: 5 };
    const newObj = { name: "New", version: "2.0.0", count: 10 };

    const changes = computeChanges(oldObj, newObj);

    expect(changes).toHaveLength(3);
    expect(changes.map((c) => c.field).sort()).toEqual(["count", "name", "version"]);
  });

  test("returns empty array when no changes", () => {
    const oldObj = { name: "Same", version: "1.0.0" };
    const newObj = { name: "Same", version: "1.0.0" };

    const changes = computeChanges(oldObj, newObj);

    expect(changes).toHaveLength(0);
  });

  test("filters by specified fields", () => {
    const oldObj = { name: "Old", version: "1.0.0", description: "Old desc" };
    const newObj = { name: "New", version: "2.0.0", description: "New desc" };

    const changes = computeChanges(oldObj, newObj, ["name", "version"]);

    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.field).sort()).toEqual(["name", "version"]);
    expect(changes.find((c) => c.field === "description")).toBeUndefined();
  });

  test("detects added fields", () => {
    const oldObj = { name: "Test" };
    const newObj = { name: "Test", newField: "added" };

    const changes = computeChanges(oldObj, newObj);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      field: "newField",
      oldValue: undefined,
      newValue: "added",
    });
  });

  test("detects removed fields", () => {
    const oldObj = { name: "Test", oldField: "removed" };
    const newObj = { name: "Test" };

    const changes = computeChanges(oldObj, newObj);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      field: "oldField",
      oldValue: "removed",
      newValue: undefined,
    });
  });

  test("handles null to value transition", () => {
    const oldObj = { field: null };
    const newObj = { field: "value" };

    const changes = computeChanges(oldObj, newObj);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      field: "field",
      oldValue: null,
      newValue: "value",
    });
  });

  test("handles nested objects via JSON comparison", () => {
    const oldObj = { config: { setting: "old" } };
    const newObj = { config: { setting: "new" } };

    const changes = computeChanges(oldObj, newObj);

    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe("config");
    expect(changes[0].oldValue).toEqual({ setting: "old" });
    expect(changes[0].newValue).toEqual({ setting: "new" });
  });

  test("handles number changes", () => {
    const oldObj = { count: 5 };
    const newObj = { count: 10 };

    const changes = computeChanges(oldObj, newObj);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      field: "count",
      oldValue: 5,
      newValue: 10,
    });
  });

  test("handles boolean changes", () => {
    const oldObj = { enabled: false };
    const newObj = { enabled: true };

    const changes = computeChanges(oldObj, newObj);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      field: "enabled",
      oldValue: false,
      newValue: true,
    });
  });

  test("handles empty objects", () => {
    const changes = computeChanges({}, {});
    expect(changes).toHaveLength(0);
  });
});
