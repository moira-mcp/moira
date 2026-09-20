/**
 * A run that carries a recorded error, for the specs that need the run page's error surfaces
 * rendered: a one-step workflow with a strict input schema, started and answered with fields it
 * does not accept, so its error history holds one validation refusal and the header shows the
 * error-count badge. Driven through the MCP tools, as `error-history-display.spec.ts` does.
 */

import {
  advanceWorkflowExecution,
  callMCPTool,
  createAuthenticatedMCPClient,
  startWorkflowExecutionState,
} from "../../utils/mcp-auth.js";

export async function runWithAnError(
  client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"],
): Promise<{ processId: string; workflowId: string }> {
  const created = (await callMCPTool(client, "manage", {
    action: "create",
    workflow: {
      id: `erroring-run-${Date.now()}`,
      metadata: { name: "Erroring run", version: "1.0.0", description: "One refused answer" },
      nodes: [
        { type: "start", id: "start", connections: { default: "step1" } },
        {
          type: "agent-directive",
          id: "step1",
          directive: "Provide the required field",
          completionCondition: "Valid input received",
          inputSchema: {
            type: "object",
            properties: { required_field: { type: "string" } },
            required: ["required_field"],
          },
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    },
  })) as { workflowId: string };
  const run = await startWorkflowExecutionState(client, created.workflowId);
  await advanceWorkflowExecution(client, run, { wrong_field: "value" });
  return { processId: run.processId, workflowId: created.workflowId };
}
