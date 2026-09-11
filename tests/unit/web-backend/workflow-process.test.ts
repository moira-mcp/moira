import { describe, expect, test } from "@jest/globals";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { findSystemCatalogEntry } from "../../../packages/shared/src/services/workflow-catalog.js";
import { buildWorkflowProcessResponse } from "../../../packages/web-backend/src/services/workflow-process.js";
import { renderWorkflowDerivation } from "../../../packages/workflow-cli/src/workflow-derive.js";
import { formatProcessProjection } from "../../../packages/workflow-cli/src/workflow-derive.js";

function bundled(slug: string): WorkflowGraph {
  return structuredClone(findSystemCatalogEntry(slug, "public")!.graph) as WorkflowGraph;
}

describe("GET /api/workflows/:id/process response", () => {
  test("serves the same derivation the CLI prints for the same workflow", () => {
    const workflow = bundled("software-development-flow");
    const response = buildWorkflowProcessResponse("wf-1", workflow);
    expect(response.workflowId).toBe("wf-1");
    expect(response.version).toBe(workflow.metadata.version);
    expect(response.process?.blocks).toHaveLength(15);
    expect(response.process?.diagnostics).toEqual([]);
    expect(formatProcessProjection(workflow, response.process!)).toBe(
      renderWorkflowDerivation(workflow),
    );
  });

  test("carries diagnostics for a workflow that violates the contract", () => {
    const workflow = bundled("robust-task");
    const response = buildWorkflowProcessResponse("wf-2", workflow);
    expect(response.process?.diagnostics.some((d) => d.code === "unowned-node")).toBe(true);
  });

  test("returns a null process for a workflow without progress", () => {
    const workflow = bundled("quick-task");
    delete workflow.progress;
    expect(buildWorkflowProcessResponse("wf-3", workflow).process).toBeNull();
  });
});
