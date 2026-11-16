import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import {
  createLogger,
  getMcpServerVersion,
  updateContext,
  type McpPromptContext,
} from "@mcp-moira/shared";
import { runWithMCPContext } from "./core/request-context.js";
import {
  getCatalogInitializeRequest,
  isCatalogDiscoveryRequest,
  requireRevisionStampBeforeInitializeResult,
} from "./auth/mcp-catalog-lifecycle.js";
import { evaluateMcpToolsRevision } from "./auth/mcp-tools-revision.js";
import { MCP_TOOLS_REVISION, type McpToolName } from "./tools/tool-definitions.js";
import { PUBLIC_TOOL_INPUT_SCHEMAS, publicToolLogContext } from "./tools/public-tool-contract.js";
import { extractPromptContext } from "./utils/prompt-context.js";

export const MCP_SERVER_VERSION = getMcpServerVersion() || "0.0.0";
const logger = createLogger({ component: "MCPServer" });

export interface AuthenticatedCatalogCredential {
  kind: "oauth" | "persistent";
  id: string;
  toolsVersion: string | null;
  stampRevision: () => Promise<boolean>;
}

export async function handleAuthenticatedMcpRequest(
  req: Request,
  res: Response,
  identity: { userId: string; email: string },
  credential: AuthenticatedCatalogCredential,
  createMcpServerWithTools: (context?: McpPromptContext) => Promise<McpServer>,
): Promise<void> {
  const revisionGate = evaluateMcpToolsRevision(credential.toolsVersion, MCP_SERVER_VERSION);
  const initializeRequest = getCatalogInitializeRequest(req.body);

  if (!revisionGate.accepted && !initializeRequest && !isCatalogDiscoveryRequest(req.body)) {
    logger.info("Outdated MCP client detected", {
      userId: identity.userId.substring(0, 8) + "...",
      credentialKind: credential.kind,
      tokenToolsRevision: credential.toolsVersion || "unknown",
      serverToolsRevision: MCP_TOOLS_REVISION,
    });
    res.status(revisionGate.status).json(revisionGate.body);
    return;
  }

  const mcpMethod = req.body?.method;
  const mcpParams = req.body?.params;
  const toolName = mcpMethod === "tools/call" && mcpParams?.name ? mcpParams.name : undefined;
  let toolArgs = toolName ? mcpParams.arguments || {} : undefined;
  if (toolName !== undefined) {
    const parsed =
      typeof toolName === "string" && Object.hasOwn(PUBLIC_TOOL_INPUT_SCHEMAS, toolName)
        ? PUBLIC_TOOL_INPUT_SCHEMAS[toolName as McpToolName].safeParse(toolArgs)
        : null;
    if (!parsed?.success) {
      res.status(400).json({
        jsonrpc: "2.0",
        id: req.body?.id ?? null,
        error: { code: -32602, message: "Invalid tool action parameters" },
      });
      return;
    }
    // Forward the admitted value to logging and the SDK. Re-reading the raw
    // arguments could compute a different default or reject stringified JSON.
    toolArgs = parsed.data;
    mcpParams.arguments = toolArgs;
  }
  const promptContext = await extractPromptContext(req);
  const userContext = {
    ...identity,
    agent: promptContext.agent,
    model: promptContext.model,
  };

  logger.info("Authenticated MCP request", {
    method: mcpMethod,
    requestId: req.body?.id,
    userId: userContext.userId.substring(0, 8) + "...",
    credentialKind: credential.kind,
    credentialId: credential.id.substring(0, 8) + "...",
    ...(promptContext.agent && { agent: promptContext.agent }),
    ...(promptContext.model && { model: promptContext.model }),
  });

  const mcpServer = await createMcpServerWithTools(promptContext);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  if (!revisionGate.accepted && initializeRequest) {
    requireRevisionStampBeforeInitializeResult(
      transport,
      initializeRequest,
      credential.stampRevision,
    );
  }
  await mcpServer.connect(transport);

  await runWithMCPContext(userContext, async () => {
    if (toolName && toolArgs) {
      const { inputData, resourceIds } = publicToolLogContext(toolName as McpToolName, toolArgs);
      updateContext({ operation: `mcp:${toolName}`, inputData, resourceIds });
    }
    await transport.handleRequest(req, res, req.body);
  });

  res.on("finish", () => {
    transport.close?.();
  });
}
