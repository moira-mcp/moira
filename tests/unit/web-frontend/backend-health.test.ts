import { describe, expect, test } from "@jest/globals";
import { isBackendOperable } from "../../../packages/web-frontend/src/hooks/useWorkflowData.js";

describe("backend health operability", () => {
  test("keeps degraded reconciliation instances connected while rejecting hard errors", () => {
    expect(isBackendOperable("ok")).toBe(true);
    expect(isBackendOperable("degraded")).toBe(true);
    expect(isBackendOperable("error")).toBe(false);
  });
});
