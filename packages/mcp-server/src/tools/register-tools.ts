import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createReconciliationAwareRegisterTool } from "../reconciliation-aware-server.js";
import { sanitizeMcpError } from "../utils/error-sanitizer.js";
import { wrapSchemaWithAutoparse } from "../utils/flexible-json-parser.js";
import type { McpPromptContext } from "@mcp-moira/shared";
import { invokeToolDefinition } from "./tool-bindings.js";
import { TOOL_DEFINITIONS, resolveToolDescription } from "./tool-definitions.js";

export function registerTools(mcpServer: McpServer, context?: McpPromptContext): void {
  const registerTool = createReconciliationAwareRegisterTool(mcpServer);

  for (const definition of TOOL_DEFINITIONS) {
    registerTool(
      definition.name,
      {
        description: resolveToolDescription(definition, context),
        inputSchema: wrapSchemaWithAutoparse(definition.schema.shape),
      },
      async (params) => {
        try {
          return await invokeToolDefinition(definition, params);
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${sanitizeMcpError(error)}` }],
          };
        }
      },
    );
  }
}
