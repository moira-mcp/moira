import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createReconciliationAwareRegisterTool,
  type ReconciliationNoticeProvider,
} from "../reconciliation-aware-server.js";
import { sanitizeMcpError } from "../utils/error-sanitizer.js";
import { createLogger, isOperationalError, normalizeError } from "@mcp-moira/shared";
import { wrapToolSchemaWithAutoparse } from "../utils/flexible-json-parser.js";
import type { McpPromptContext } from "@mcp-moira/shared";
import { invokeToolDefinition } from "./tool-bindings.js";
import { TOOL_DEFINITIONS, getToolJsonSchema, resolveToolDescription } from "./tool-definitions.js";

const logger = createLogger({ component: "MCPTools" });

export type ToolFailureReporter = (toolName: string, error: unknown) => void;

/**
 * The agent receives a sanitized message, and a suppressed one carries no diagnosis at all. The
 * original failure is therefore recorded here with the tool that produced it, classified the way
 * this project classifies a failure at a boundary: an operational one is a warning, anything
 * unexpected is an error.
 */
let reportToolFailure: ToolFailureReporter = (toolName, error) => {
  const level = isOperationalError(normalizeError(error)) ? "warn" : "error";
  logger[level]("MCP tool failed", error, { tool: toolName });
};

export function setToolFailureReporterForTests(reporter: ToolFailureReporter): () => void {
  const previous = reportToolFailure;
  reportToolFailure = reporter;
  return () => {
    if (reportToolFailure === reporter) reportToolFailure = previous;
  };
}

export function registerTools(
  mcpServer: McpServer,
  context?: McpPromptContext,
  getReconciliationNotice?: ReconciliationNoticeProvider,
): void {
  const registerTool = createReconciliationAwareRegisterTool(mcpServer, getReconciliationNotice);

  for (const definition of TOOL_DEFINITIONS) {
    registerTool(
      definition.name,
      {
        description: resolveToolDescription(definition, context),
        inputSchema: wrapToolSchemaWithAutoparse(definition.schema),
        ...(definition._meta ? { _meta: definition._meta } : {}),
      },
      async (params: unknown) => {
        try {
          return await invokeToolDefinition(definition, params);
        } catch (error) {
          reportToolFailure(definition.name, error);
          return {
            content: [{ type: "text" as const, text: `Error: ${sanitizeMcpError(error)}` }],
            isError: true,
          };
        }
      },
    );
  }

  // Publish the same typed registry directly so tools/list, contract revisions, and generated
  // references use one serialized schema. The SDK validates this public shape on tools/call;
  // handlers may additionally enforce narrower action-specific invariants.
  mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((definition) => ({
      name: definition.name,
      description: resolveToolDescription(definition, context),
      inputSchema: getToolJsonSchema(definition),
      ...(definition._meta ? { _meta: definition._meta } : {}),
    })),
  }));
}
