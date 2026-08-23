import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatWorkflowReconciliationNotice, getSqliteInstance } from "@mcp-moira/shared";

export type ReconciliationNoticeProvider = () => string | null;

export function buildReconciliationAwareInstructions(
  systemPrompt: string | undefined,
  getNotice: ReconciliationNoticeProvider = () =>
    formatWorkflowReconciliationNotice(getSqliteInstance()),
): string | undefined {
  return [getNotice(), systemPrompt].filter(Boolean).join("\n\n") || undefined;
}

/** Register an MCP tool whose observable response always reflects current reconciliation state. */
export function createReconciliationAwareRegisterTool(
  mcpServer: McpServer,
  getNotice: ReconciliationNoticeProvider = () =>
    formatWorkflowReconciliationNotice(getSqliteInstance()),
): typeof mcpServer.registerTool {
  const sdkRegisterTool = mcpServer.registerTool.bind(mcpServer);
  return ((
    name: string,
    config: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (...args: any[]) => any,
  ) =>
    sdkRegisterTool(
      name,
      // The public SDK overload recovers the concrete schema at each typed call site.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (...args: any[]) => {
        const result = await handler(...args);
        const notice = getNotice();
        if (!notice || !result || !Array.isArray(result.content)) return result;
        return {
          ...result,
          content: [{ type: "text" as const, text: notice }, ...result.content],
        };
      },
    )) as typeof mcpServer.registerTool;
}
