/**
 * Unit tests for mapLegacyStatus and mapLegacyStatusArray
 *
 * Tests the status mapping functions that handle "locked" as a
 * non-DB status (resolved via lock table join).
 */

import { describe, test, expect } from "@jest/globals";
import {
  mapLegacyStatus,
  mapLegacyStatusArray,
  type LegacyExecutionStatus,
} from "../../../packages/shared/src/types/execution-error.js";

describe("mapLegacyStatus", () => {
  test("maps waiting to running", () => {
    expect(mapLegacyStatus("waiting")).toBe("running");
  });

  test("maps failed to completed", () => {
    expect(mapLegacyStatus("failed")).toBe("completed");
  });

  test("passes through running unchanged", () => {
    expect(mapLegacyStatus("running")).toBe("running");
  });

  test("passes through completed unchanged", () => {
    expect(mapLegacyStatus("completed")).toBe("completed");
  });

  test("returns null for locked (not a DB status)", () => {
    expect(mapLegacyStatus("locked")).toBeNull();
  });
});

describe("mapLegacyStatusArray", () => {
  test("maps array of standard statuses", () => {
    const result = mapLegacyStatusArray(["running", "completed"]);
    expect(result.dbStatuses).toEqual(expect.arrayContaining(["running", "completed"]));
    expect(result.hasLockedFilter).toBe(false);
  });

  test("maps waiting and failed to their DB equivalents", () => {
    const result = mapLegacyStatusArray(["waiting", "failed"]);
    expect(result.dbStatuses).toEqual(expect.arrayContaining(["running", "completed"]));
    expect(result.hasLockedFilter).toBe(false);
  });

  test("strips locked and sets hasLockedFilter", () => {
    const result = mapLegacyStatusArray(["locked"]);
    expect(result.dbStatuses).toEqual([]);
    expect(result.hasLockedFilter).toBe(true);
  });

  test("handles locked with other statuses", () => {
    const result = mapLegacyStatusArray(["running", "locked", "completed"]);
    expect(result.dbStatuses).toEqual(expect.arrayContaining(["running", "completed"]));
    expect(result.hasLockedFilter).toBe(true);
  });

  test("deduplicates mapped statuses", () => {
    // waiting→running + running→running should deduplicate
    const result = mapLegacyStatusArray(["waiting", "running"]);
    const runningCount = result.dbStatuses.filter((s) => s === "running").length;
    expect(runningCount).toBe(1);
    expect(result.hasLockedFilter).toBe(false);
  });

  test("empty array returns empty result", () => {
    const result = mapLegacyStatusArray([]);
    expect(result.dbStatuses).toEqual([]);
    expect(result.hasLockedFilter).toBe(false);
  });

  test("all statuses including locked", () => {
    const allStatuses: LegacyExecutionStatus[] = [
      "running",
      "waiting",
      "completed",
      "failed",
      "locked",
    ];
    const result = mapLegacyStatusArray(allStatuses);
    // running + waiting→running (dedup) + completed + failed→completed (dedup) = ["running", "completed"]
    expect(result.dbStatuses).toHaveLength(2);
    expect(result.dbStatuses).toEqual(expect.arrayContaining(["running", "completed"]));
    expect(result.hasLockedFilter).toBe(true);
  });
});
