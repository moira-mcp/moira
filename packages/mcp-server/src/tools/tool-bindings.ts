import type { z } from "zod";

import type { AnyToolDefinition, McpToolName, ToolResponsePolicy } from "./tool-definitions.js";
import { renderToolReference } from "./tool-definitions.js";

export interface ToolCallResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface ToolResultLike {
  success: boolean;
  data?: unknown;
  error?: string;
}

type ToolInvocationResult = ToolCallResult | ToolResultLike;
type DefinitionFor<Name extends McpToolName> = Extract<AnyToolDefinition, { name: Name }>;
type ToolParams<Name extends McpToolName> = z.infer<DefinitionFor<Name>["schema"]>;
type ToolBindings = {
  [Name in McpToolName]: (params: ToolParams<Name>) => Promise<ToolInvocationResult>;
};

function isToolResultLike(result: ToolInvocationResult): result is ToolResultLike {
  return typeof (result as ToolResultLike).success === "boolean";
}

function renderToolResult(result: ToolResultLike, policy: ToolResponsePolicy): ToolCallResult {
  if (!result.success) {
    return { content: [{ type: "text", text: `Error: ${result.error ?? "Unknown error"}` }] };
  }
  const text =
    policy === "json"
      ? (JSON.stringify(result.data, null, 2) ?? "No result")
      : typeof result.data === "string"
        ? result.data
        : result.data === undefined
          ? "No result"
          : JSON.stringify(result.data, null, 2);
  return { content: [{ type: "text", text }] };
}

export const TOOL_BINDINGS = {
  list: async (params) => (await import("./list-workflows.js")).listWorkflows(params),
  reconciliation: async (params) =>
    (await import("./manage-reconciliation.js")).manageReconciliation(params),
  start: async (params) => (await import("./start-workflow.js")).startWorkflow(params),
  step: async (params) => {
    const result = await (await import("./execute-step.js")).executeStep(params);
    if (!result.success) {
      return { content: [{ type: "text", text: result.error ?? "No result" }], isError: true };
    }
    return renderToolResult(result, "text");
  },
  manage: async (params) => (await import("./manage-workflow.js")).manageWorkflow(params),
  help: async (params) =>
    (await import("./get-help.js")).getHelp(params, () => renderToolReference("en")),
  settings: async (params) => (await import("./manage-settings.js")).manageSettings(params),
  token: async (params) => {
    const result = await (await import("./create-workflow-token.js")).createWorkflowToken(params);
    if (!result.success) return renderToolResult(result, "formatted-text");
    const { formatUploadToken, formatDownloadToken } = await import("../messages/index.js");
    const text =
      params.action === "upload"
        ? formatUploadToken(result.data as Parameters<typeof formatUploadToken>[0])
        : formatDownloadToken(result.data as Parameters<typeof formatDownloadToken>[0]);
    return { content: [{ type: "text", text }] };
  },
  session: async (params) => (await import("./get-session-info.js")).getSessionInfo(params),
  notes: async (params) => (await import("./manage-notes.js")).manageNotes(params),
  artifacts: async (params) => (await import("./manage-artifacts.js")).manageArtifacts(params),
  lock: async (params) => (await import("./manage-locks.js")).manageLocks(params),
} satisfies ToolBindings;

export async function invokeToolDefinition(
  definition: AnyToolDefinition,
  params: unknown,
): Promise<ToolCallResult> {
  const parsed = definition.schema.parse(params);
  const invoke = TOOL_BINDINGS[definition.name] as (
    validated: typeof parsed,
  ) => Promise<ToolInvocationResult>;
  const result = await invoke(parsed);
  return isToolResultLike(result) ? renderToolResult(result, definition.responsePolicy) : result;
}
