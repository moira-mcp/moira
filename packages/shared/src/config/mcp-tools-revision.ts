import { MCP_TOOLS_REVISION } from "./mcp-tools-revision.generated.js";

export interface McpToolsRevisionErrorBody {
  error: "upgrade_required";
  error_description: string;
  hint: string;
  serverVersion: string;
  toolsRevision: string;
  clientVersion: string;
}

export type McpToolsRevisionGate =
  { accepted: true } | { accepted: false; status: 426; body: McpToolsRevisionErrorBody };

export function evaluateMcpToolsRevision(
  clientRevision: string | null,
  serverVersion: string,
): McpToolsRevisionGate {
  if (clientRevision === MCP_TOOLS_REVISION) return { accepted: true };

  const displayedClientRevision = clientRevision || "unknown";
  return {
    accepted: false,
    status: 426,
    body: {
      error: "upgrade_required",
      error_description: `MCP tool contract changed. Your client has cached revision ${displayedClientRevision}.`,
      hint: "Run '/mcp reconnect moira' in Claude Code to refresh tools.",
      serverVersion,
      toolsRevision: MCP_TOOLS_REVISION,
      clientVersion: displayedClientRevision,
    },
  };
}
