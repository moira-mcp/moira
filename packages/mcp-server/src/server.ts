#!/usr/bin/env node

/**
 * MCP Server for Moira Workflow Engine
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import cors from "cors";
import {
  requestLogger,
  geoipLogger,
  requestContextMiddleware,
  createLogger,
  Service,
  Component,
  setGlobalService,
  getDatabase,
  closeDatabase,
  user,
  oauthAccessToken,
  apiToken,
  getBaseUrl,
  getBrowserOriginAllowlist,
  isBrowserOriginAllowed,
  getContactEmail,
  getLogLevelEnv,
  getMcpPort,
  metricsMiddleware,
  setLogLevel,
  getMcpServerVersion,
  MCP_TOOLS_REVISION,
  evaluateMcpToolsRevision,
  updateContext,
  sanitizeInput,
  getMcpTextService,
  isPersistentToken,
  hashToken,
  validateTokenRecord,
  getAccountAccessDenial,
  ACCOUNT_APPROVAL_REQUIRED_CODE,
  type McpPromptContext,
  getSqliteInstance,
  getWorkflowReconciliationStatusSummary,
  formatWorkflowReconciliationNotice,
} from "@mcp-moira/shared";

// Get monorepo version from root package.json (#196)
export const MCP_SERVER_VERSION: string = getMcpServerVersion() || "0.0.0";

// Set global service for this process (MUST be first thing after imports)
setGlobalService(Service.MCP_SERVER);
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { runWithMCPContext } from "./core/request-context.js";
import { auth } from "./auth.js";
import { mcpLimiter } from "./middleware/rate-limit-middleware.js";

import { buildReconciliationAwareInstructions } from "./reconciliation-aware-server.js";
import { registerTools } from "./tools/register-tools.js";
import { TOOL_DEFINITIONS } from "./tools/tool-definitions.js";
import {
  getCatalogInitializeRequest,
  requireRevisionStampBeforeInitializeResult,
} from "./auth/mcp-catalog-lifecycle.js";

// Initialize logger
const logger = createLogger({ component: "MCPServer" });

function parseBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization || authorization.length > 4096) return undefined;
  const separator = authorization.indexOf(" ");
  if (separator === -1 || authorization.slice(0, separator).toLowerCase() !== "bearer") {
    return undefined;
  }
  const token = authorization.slice(separator + 1).trim();
  return token && !token.includes(" ") ? token : undefined;
}

// Set log level from environment variable
const logLevel = getLogLevelEnv();
if (logLevel) {
  setLogLevel(logLevel);
}

// MCP SDK supports `instructions` in ServerOptions. System prompts remain
// runtime-configurable and are passed only through that protocol field.
// Tool descriptions are part of the static typed registry. Agent/model context
// selects a static variant and never causes a database lookup.

// Import prompt context extraction utilities
import { extractPromptContext } from "./utils/prompt-context.js";

/**
 * Create a new MCP server instance with tools registered from the static contract.
 *
 * @param context - Optional agent/model context for hierarchical override resolution
 */
async function createMcpServerWithTools(context?: McpPromptContext): Promise<McpServer> {
  // Load system prompt for MCP instructions field
  const mcpTextService = getMcpTextService();
  const systemPrompt = context
    ? await mcpTextService.getSystemPromptWithOverride(context)
    : await mcpTextService.getSystemPrompt();

  const mcpServer = new McpServer(
    {
      name: "mcp-moira",
      version: MCP_SERVER_VERSION,
      title: "MCP Moira Workflow Engine",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: buildReconciliationAwareInstructions(systemPrompt),
    },
  );

  // Register all tools with current descriptions
  registerTools(mcpServer, context);

  return mcpServer;
}

interface AuthenticatedCatalogCredential {
  kind: "oauth" | "persistent";
  id: string;
  toolsVersion: string | null;
  stampRevision: () => Promise<boolean>;
}

async function handleAuthenticatedMcpRequest(
  req: Request,
  res: Response,
  identity: { userId: string; email: string },
  credential: AuthenticatedCatalogCredential,
): Promise<void> {
  const revisionGate = evaluateMcpToolsRevision(credential.toolsVersion, MCP_SERVER_VERSION);
  const initializeRequest = getCatalogInitializeRequest(req.body);

  if (!revisionGate.accepted && !initializeRequest) {
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
  const toolArgs = toolName ? mcpParams.arguments || {} : undefined;
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
      const { inputData, resourceIds } = sanitizeInput(toolArgs);
      updateContext({ operation: `mcp:${toolName}`, inputData, resourceIds });
    }
    await transport.handleRequest(req, res, req.body);
  });

  res.on("finish", () => {
    transport.close?.();
  });
}

// Tools will be registered per session in HTTP mode

// Stateless mode - no session storage needed

// Express app setup
const app = express();

// Prometheus metrics middleware FIRST
app.use(metricsMiddleware());

// Request context middleware - creates AsyncLocalStorage context for each request
// Must be early to capture requestId for all logs and enable inputData in error logs
app.use(requestContextMiddleware());

// Centralized HTTP logging via morgan with standardized component
const httpLogger = createLogger({ component: Component.HTTP });
app.use(requestLogger({ logger: httpLogger }));

// GeoIP logging for request origins
app.use(geoipLogger({ logger: httpLogger }));

app.use(express.json({ limit: "10mb" }));
const mcpOriginAllowlist = getBrowserOriginAllowlist();
app.use(
  cors({
    origin: (origin, callback) =>
      callback(null, isBrowserOriginAllowed(origin, mcpOriginAllowlist)),
    credentials: true,
    exposedHeaders: ["Mcp-Session-Id"],
  }),
);

// From the spec (Transports 2.2.3):
// The server MUST [...] return HTTP 405 Method Not Allowed,
// indicating that the server does not offer an SSE stream at this endpoint.
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).send();
});

// MCP HTTP endpoints - Authenticated mode with rate limiting
app.post("/mcp", mcpLimiter, async (req: Request, res: Response) => {
  try {
    // Log MCP request with tool context (for debugging)
    const mcpMethod = req.body?.method;
    const mcpParams = req.body?.params;

    // Extract tool info for logging (context update happens inside runWithMCPContext)
    const toolName = mcpMethod === "tools/call" && mcpParams?.name ? mcpParams.name : undefined;
    const toolArgs = toolName ? mcpParams.arguments || {} : undefined;

    logger.info("MCP request received", {
      method: mcpMethod,
      ...(toolName && { tool: toolName }),
      hasAuthHeader: !!req.headers.authorization,
    });

    // Extract Bearer token for auth routing
    const bearerToken = parseBearerToken(req.headers.authorization);

    // --- Persistent API token authentication (moira_ prefix) ---
    // Persistent tokens use direct authentication, then the shared catalog gate.
    if (bearerToken && isPersistentToken(bearerToken)) {
      const db = getDatabase();
      const tokenHash = hashToken(bearerToken);

      // Look up token by hash
      const [tokenRecord] = await db
        .select({
          id: apiToken.id,
          userId: apiToken.userId,
          toolsVersion: apiToken.toolsVersion,
          expiresAt: apiToken.expiresAt,
          revokedAt: apiToken.revokedAt,
        })
        .from(apiToken)
        .where(eq(apiToken.tokenHash, tokenHash))
        .limit(1);

      if (!tokenRecord) {
        logger.info("Persistent token not found", { method: mcpMethod });
        return res.status(401).json({
          error: "invalid_token",
          error_description: "Invalid API token.",
        });
      }

      // Validate token not expired/revoked
      const validationError = validateTokenRecord(tokenRecord);
      if (validationError) {
        logger.info("Persistent token rejected", {
          reason: validationError,
          tokenId: tokenRecord.id,
        });
        return res.status(401).json({
          error: "invalid_token",
          error_description:
            validationError === "token_revoked"
              ? "API token has been revoked."
              : "API token has expired.",
        });
      }

      // Check if user is blocked
      const [userData] = await db
        .select({
          blocked: user.blocked,
          blockedReason: user.blockedReason,
          email: user.email,
          approvedAt: user.approvedAt,
          emailVerified: user.emailVerified,
        })
        .from(user)
        .where(eq(user.id, tokenRecord.userId))
        .limit(1);

      if (!userData) {
        return res.status(401).json({
          error: "invalid_token",
          error_description: "Token owner not found.",
        });
      }

      const denial = getAccountAccessDenial({
        userId: tokenRecord.userId,
        blocked: !!userData.blocked,
        approvedAt: userData.approvedAt,
        emailVerified: !!userData.emailVerified,
      });

      if (denial === "blocked") {
        logger.warn("Blocked user attempted MCP access via persistent token", {
          userId: tokenRecord.userId,
        });
        const reason = userData?.blockedReason ? `: ${userData.blockedReason}` : "";
        return res.status(403).json({
          error: "access_denied",
          error_description: `Account is blocked${reason}`,
          hint: `Contact support at ${getContactEmail()} if you believe this is an error.`,
        });
      }

      if (denial === "approval") {
        logger.warn("Pending user attempted MCP access via persistent token", {
          userId: tokenRecord.userId,
        });
        return res.status(403).json({
          error: "access_denied",
          error_code: ACCOUNT_APPROVAL_REQUIRED_CODE,
          error_description: "Account is awaiting administrator approval.",
        });
      }

      // Update lastUsedAt fire-and-forget
      db.update(apiToken)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(apiToken.id, tokenRecord.id))
        .then(() => {})
        .catch(() => {});

      await handleAuthenticatedMcpRequest(
        req,
        res,
        { userId: tokenRecord.userId, email: userData.email },
        {
          kind: "persistent",
          id: tokenRecord.id,
          toolsVersion: tokenRecord.toolsVersion,
          stampRevision: async () => {
            const now = new Date().toISOString();
            const updated = await db
              .update(apiToken)
              .set({ toolsVersion: MCP_TOOLS_REVISION })
              .where(
                and(
                  eq(apiToken.id, tokenRecord.id),
                  eq(apiToken.tokenHash, tokenHash),
                  isNull(apiToken.revokedAt),
                  or(isNull(apiToken.expiresAt), gt(apiToken.expiresAt, now)),
                ),
              )
              .returning({ id: apiToken.id });
            return updated.length === 1;
          },
        },
      );
      return;
    }

    // --- OAuth authentication (existing flow) ---

    // Validate MCP session via Better Auth MCP plugin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await (auth.api as any).getMcpSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      headers: req.headers as any,
    });

    // Return HTTP 401 if no valid session (includes initialize requests)
    if (!session) {
      const baseUrl = getBaseUrl();
      const wwwAuthHeader = `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;

      logger.info("MCP request without valid session - returning 401", {
        method: req.body?.method,
        hasAuthHeader: !!req.headers.authorization,
      });

      return res.status(401).header("WWW-Authenticate", wwwAuthHeader).json({
        error: "invalid_token",
        error_description: "Authorization required. Please authenticate via OAuth.",
        hint: "Re-authorize MCP server in client settings. Token may have expired.",
      });
    }

    // Extract user context from Better Auth session
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (session as any).userId || "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const email = (session as any).email || "";

    // Check if user is blocked - SECURITY: blocked users cannot access MCP
    if (userId) {
      const db = getDatabase();
      const [userData] = await db
        .select({
          blocked: user.blocked,
          blockedReason: user.blockedReason,
          approvedAt: user.approvedAt,
          emailVerified: user.emailVerified,
        })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);

      const denial = userData
        ? getAccountAccessDenial(
            {
              userId,
              blocked: !!userData.blocked,
              approvedAt: userData.approvedAt,
              emailVerified: !!userData.emailVerified,
            },
            { requireEmailVerified: true },
          )
        : "approval";

      if (denial === "blocked") {
        logger.warn("Blocked user attempted MCP access", { userId, email });
        const reason = userData?.blockedReason ? `: ${userData.blockedReason}` : "";
        return res.status(403).json({
          error: "access_denied",
          error_code: "ACCOUNT_BLOCKED",
          error_description: `Account is blocked${reason}`,
          hint: `Contact support at ${getContactEmail()} if you believe this is an error.`,
        });
      }

      if (denial === "approval") {
        logger.warn("Pending user attempted MCP access", { userId, email });
        return res.status(403).json({
          error: "access_denied",
          error_code: ACCOUNT_APPROVAL_REQUIRED_CODE,
          error_description: "Account is awaiting administrator approval.",
        });
      }

      if (denial === "email-verification") {
        logger.warn("Unverified user attempted MCP access", { userId, email });
        return res.status(403).json({
          error: "access_denied",
          error_code: "EMAIL_NOT_VERIFIED",
          error_description: "Email verification is required before accessing MCP.",
        });
      }
    }

    if (!bearerToken) {
      return res.status(401).json({
        error: "invalid_token",
        error_description: "OAuth access token is required.",
      });
    }

    const database = getDatabase();
    const [tokenData] = await database
      .select({ id: oauthAccessToken.id, toolsVersion: oauthAccessToken.toolsVersion })
      .from(oauthAccessToken)
      .where(
        and(eq(oauthAccessToken.accessToken, bearerToken), eq(oauthAccessToken.userId, userId)),
      )
      .limit(1);
    if (!tokenData) {
      return res.status(401).json({
        error: "invalid_token",
        error_description: "OAuth credential has been revoked or is invalid.",
      });
    }

    await handleAuthenticatedMcpRequest(
      req,
      res,
      { userId, email },
      {
        kind: "oauth",
        id: tokenData.id,
        toolsVersion: tokenData.toolsVersion,
        stampRevision: async () => {
          const updated = await database
            .update(oauthAccessToken)
            .set({ toolsVersion: MCP_TOOLS_REVISION })
            .where(
              and(
                eq(oauthAccessToken.id, tokenData.id),
                eq(oauthAccessToken.accessToken, bearerToken),
                eq(oauthAccessToken.userId, userId),
                gt(oauthAccessToken.accessTokenExpiresAt, new Date().toISOString()),
              ),
            )
            .returning({ id: oauthAccessToken.id });
          return updated.length === 1;
        },
      },
    );
  } catch (error) {
    logger.error("MCP request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal MCP server error",
        },
        id: req.body?.id || null,
      });
    }
  }
});

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  const reconciliation = getWorkflowReconciliationStatusSummary(getSqliteInstance());
  res.json({
    status: reconciliation.status === "ok" ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    mode: "stateless",
    version: MCP_SERVER_VERSION,
    reconciliation,
  });
});

// Start HTTP server
async function main() {
  try {
    // Config is validated automatically on first access (lazy initialization)
    const port = getMcpPort();
    const reconciliationNotice = formatWorkflowReconciliationNotice(getSqliteInstance());
    if (reconciliationNotice) {
      logger.error(
        "Managed workflow reconciliation is required; MCP remains available for recovery",
        {
          code: "MANAGED_WORKFLOW_RECONCILIATION_REQUIRED",
          notice: reconciliationNotice,
        },
      );
    }

    logger.info("Static tool descriptions loaded", { toolCount: TOOL_DEFINITIONS.length });

    logger.info("Starting MCP Moira HTTP server...", { port });
    const httpServer = app.listen(port, () => {
      logger.info("MCP Moira HTTP server started successfully", {
        port,
        endpoint: `http://localhost:${port}/mcp`,
      });
    });

    // Graceful shutdown of HTTP server (stateless mode)
    process.on("SIGINT", () => {
      logger.info("Received SIGINT, shutting down HTTP server");
      httpServer.close(() => {
        try {
          closeDatabase();
          logger.info("Database closed successfully");
        } catch (dbError) {
          logger.error("Error closing database", {
            error: dbError instanceof Error ? dbError.message : "Unknown error",
          });
        }
        process.exit(0);
      });
    });

    process.on("SIGTERM", () => {
      logger.info("Received SIGTERM, shutting down HTTP server");
      httpServer.close(() => {
        try {
          closeDatabase();
          logger.info("Database closed successfully");
        } catch (dbError) {
          logger.error("Error closing database", {
            error: dbError instanceof Error ? dbError.message : "Unknown error",
          });
        }
        process.exit(0);
      });
    });
  } catch (error) {
    logger.error("Fatal MCP server error", error);
    throw error;
  }
}

main().catch((error) => {
  logger.error("Fatal error", error);
  process.exit(1);
});
