import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createReconciliationAwareRegisterTool,
  type ReconciliationNoticeProvider,
} from "../reconciliation-aware-server.js";
import { sanitizeMcpError } from "../utils/error-sanitizer.js";
import { createLogger, isOperationalError, normalizeError } from "@mcp-moira/shared";
import { PUBLIC_TOOL_INPUT_SCHEMAS } from "./public-tool-contract.js";
import type { McpPromptContext } from "@mcp-moira/shared";
import { invokeToolDefinition } from "./tool-bindings.js";
import {
  TOOL_DEFINITIONS,
  getClaudeCodeToolSchema,
  getToolJsonSchema,
  resolveToolDescription,
} from "./tool-definitions.js";

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
        inputSchema: PUBLIC_TOOL_INPUT_SCHEMAS[definition.name],
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

  mcpServer.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const userAgent = extra.requestInfo?.headers["user-agent"];
    const claudeCode = typeof userAgent === "string" && /^claude-code\//i.test(userAgent);
    return {
      tools: TOOL_DEFINITIONS.map((definition) => {
        const schema = getToolJsonSchema(definition);
        return {
          name: definition.name,
          description: resolveToolDescription(definition, context),
          inputSchema: claudeCode ? getClaudeCodeToolSchema(schema) : schema,
          ...(definition._meta ? { _meta: definition._meta } : {}),
        };
      }),
    };
  });
}
