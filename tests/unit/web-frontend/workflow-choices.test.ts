import { describe, expect, it } from "@jest/globals";
import { loadWorkflowChoices } from "../../../packages/web-frontend/src/services/workflow-choices";
import type { WorkflowListResponse } from "../../../packages/web-frontend/src/types/api-types";

describe("complete overview workflow choices", () => {
  function response(offset: number, limit: number, total = 205): WorkflowListResponse {
    return {
      workflows: Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, index) => ({
          id: `flow-${offset + index}`,
          metadata: { name: `Flow ${offset + index}` },
        }),
      ) as WorkflowListResponse["workflows"],
      totalWorkflows: total,
      validWorkflows: 0,
      invalidWorkflows: 0,
      lastScan: 1,
    };
  }
  it("includes choices beyond both default and maximum pages with bounded requests", async () => {
    const pages: number[] = [];
    const choices = await loadWorkflowChoices(async (request) => {
      expect(request.limit).toBe(100);
      expect(request.sort).toBe("name");
      expect(request.sortOrder).toBe("asc");
      pages.push(request.offset!);
      return response(request.offset!, request.limit!);
    });
    expect(pages).toEqual([0, 100, 200]);
    expect(choices).toHaveLength(205);
    expect(choices[204]).toEqual({ id: "flow-204", name: "Flow 204" });
  });
  it("reports an incomplete or failed read instead of silently presenting a partial chooser", async () => {
    await expect(loadWorkflowChoices(async () => response(205, 100))).rejects.toThrow("retry");
    await expect(loadWorkflowChoices(async () => response(0, 100))).rejects.toThrow("retry");
    await expect(
      loadWorkflowChoices(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(await loadWorkflowChoices(async () => response(0, 100, 0))).toEqual([]);
  });
});
