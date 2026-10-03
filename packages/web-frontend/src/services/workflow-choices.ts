import type { WorkflowListRequest, WorkflowListResponse } from "../types/api-types";

/** Load every readable choice through bounded, deterministically ordered summary pages. */
export async function loadWorkflowChoices(
  getPage: (request: WorkflowListRequest) => Promise<WorkflowListResponse>,
): Promise<Array<{ id: string; name: string }>> {
  const choices = new Map<string, { id: string; name: string }>();
  let offset = 0;
  while (true) {
    const page = await getPage({ limit: 100, offset, sort: "name", sortOrder: "asc" });
    for (const workflow of page.workflows) {
      choices.set(workflow.id, {
        id: workflow.id,
        name: workflow.metadata?.name || workflow.id,
      });
    }
    offset += page.workflows.length;
    if (choices.size !== offset) throw new Error("Workflow choices changed; retry loading");
    if (offset >= page.totalWorkflows) return [...choices.values()];
    if (page.workflows.length === 0) throw new Error("Workflow choices changed; retry loading");
  }
}
