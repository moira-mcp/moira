/**
 * MCP Moira Backend API Server
 * Express server for workflow visualization with MCP engine integration
 */

// Load environment variables from .env file

import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";
import path from "path";
import { toNodeHandler } from "better-auth/node";
import type { Server } from "http";
import type { AddressInfo } from "net";

import {
  requestLogger,
  geoipLogger,
  requestContextMiddleware,
  createLogger,
  Service,
  Component,
  setGlobalService,
  closeDatabase,
  getBaseUrl,
  getMcpUrl,
  getAppPrefix,
  getWebBackendPort,
  getNodeEnv,
  metricsMiddleware,
  createMetricsServer,
  getMetricsPort,
  getExecutionRetentionService,
} from "@mcp-moira/shared";

// Set global service for this process (MUST be first thing after imports)
setGlobalService(Service.WEB_BACKEND);
import { setupCorsMiddleware } from "./middleware/cors-middleware.js";
import { setupErrorMiddleware } from "./middleware/error-middleware.js";
import { requireAuth, optionalAuth } from "./middleware/auth-middleware.js";
import { apiLimiter, authLimiter } from "./middleware/rate-limit-middleware.js";
import { requestBodyLogger } from "./middleware/request-body-logger.js";
import { inputContextMiddleware } from "./middleware/input-context-middleware.js";
import { workflowRoutes } from "./routes/workflows.js";
import { workflowTokenRoutes } from "./routes/workflow-tokens.js";
import { executionRoutes } from "./routes/executions.js";
import { healthRoutes } from "./routes/health.js";
import { featuresRoutes } from "./routes/features.js";
import { settingsRoutes } from "./routes/settings.js";
import { adminRoutes } from "./routes/admin.js";
import { userInfoRoutes } from "./routes/auth-info.js";
import oauthConsentRoutes from "./routes/oauth-consent.js";
import notificationsRoutes from "./routes/notifications.js";
import telegramWebhookRoutes from "./routes/telegram-webhook.js";
import statsRoutes from "./routes/stats.js";
import { userProfileRoutes } from "./routes/user-profile.js";
import userOAuthSessionsRoutes from "./routes/user-oauth-sessions.js";
import adminUserSecurityRoutes from "./routes/admin-user-security.js";
import { adminAnalyticsRoutes } from "./routes/admin-analytics.js";
import clientLogsRoutes from "./routes/client-logs.js";
import { monitoringTestRoutes } from "./routes/monitoring-test.js";
import { notesRoutes } from "./routes/notes.js";
import { artifactsRoutes } from "./routes/artifacts.js";
import { artifactTokenRoutes } from "./routes/artifact-tokens.js";
import { staticArtifactsRoutes } from "./routes/static-artifacts.js";
import { workflowSharingRoutes } from "./routes/workflow-sharing.js";
import { inviteAcceptRoutes } from "./routes/invite-accept.js";
import { tokenRoutes } from "./routes/tokens.js";
import { adminTokenRoutes } from "./routes/admin-tokens.js";
import { mcpClientAutoRegister } from "./middleware/mcp-client-auto-register.js";
import { auth } from "./auth.js";

// ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create logger for server
const logger = createLogger({ component: "Server" });

/**
 * MCP Moira API Server
 */
class MoiraApiServer {
  private app: express.Application;
  private server: Server | undefined;
  private metricsServer: Server | undefined;

  constructor() {
    try {
      this.app = express();

      this.setupMiddlewareBeforeAuth();
      this.setupOAuthEndpoints();
      this.setupAuthRoutes();
      this.setupMiddlewareAfterAuth();
      this.setupRoutes();
      this.setupErrorHandling();
    } catch (error) {
      logger.error("Server construction failed:", error);
      throw error;
    }
  }

  /**
   * Get workflow directories from configuration
   */
  private getWorkflowDirectories(): string[] {
    return ["../../workflows/production"];
  }

  /**
   * Setup middleware that must run BEFORE Better Auth routes
   */
  private setupMiddlewareBeforeAuth(): void {
    // Trust proxy for correct IP detection (nginx reverse proxy)
    this.app.set("trust proxy", true);

    // Prometheus metrics middleware FIRST (before any logging)
    this.app.use(metricsMiddleware());

    // Request context middleware - creates AsyncLocalStorage context for request tracing
    // Must be early to capture requestId for all logs
    // Note: service is taken from global variable (set at startup)
    this.app.use(
      requestContextMiddleware({
        getUserId: (req) => (req as unknown as { user?: { id?: string } }).user?.id,
      }),
    );

    // Centralized HTTP request logging with standardized component
    const httpLogger = createLogger({ component: Component.HTTP });
    this.app.use(requestLogger({ logger: httpLogger }));

    // GeoIP logging for request origins
    this.app.use(geoipLogger({ logger: httpLogger }));

    // Security headers
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:"],
            scriptSrc: ["'self'"],
          },
        },
      }),
    );

    // CORS configuration for frontend communication
    this.app.use(setupCorsMiddleware());

    // Cookie parser for session management
    this.app.use(cookieParser());
  }

  /**
   * Setup middleware that must run AFTER Better Auth routes
   */
  private setupMiddlewareAfterAuth(): void {
    // JSON parsing with default limits (AFTER Better Auth)
    this.app.use(
      express.json({
        limit: "10mb",
        strict: true,
      }),
    );

    // URL encoding (AFTER Better Auth)
    this.app.use(
      express.urlencoded({
        extended: true,
        limit: "10mb",
      }),
    );

    // Request body logging for debugging and audit (AFTER body parsers)
    // Logs POST/PUT/PATCH bodies except sensitive endpoints
    this.app.use(requestBodyLogger());

    // Input context middleware for error diagnostics
    // Stores sanitized request body in AsyncLocalStorage context
    // Enables automatic inclusion in error logs
    this.app.use(inputContextMiddleware());
  }

  /**
   * Setup Better Auth routes BEFORE body parsers
   */
  private setupAuthRoutes(): void {
    // CRITICAL: toNodeHandler must be BEFORE express.json/urlencoded
    // Better Auth parses body itself

    // Wrap toNodeHandler to catch parsing errors and add logging
    const authHandler = toNodeHandler(auth);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedAuthHandler = async (req: any, res: any) => {
      // Logging for auth requests
      const url = req.url || req.originalUrl || "";
      logger.info("Auth request received", {
        method: req.method,
        url: url,
        path: url.split("?")[0],
        query: url.includes("?") ? url.split("?")[1] : "",
      });

      try {
        await authHandler(req, res);

        // Log response status after handler completes
        logger.info("Auth request completed", {
          method: req.method,
          path: url.split("?")[0],
          statusCode: res.statusCode,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        // Get error message safely
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Handle JSON parsing errors
        if (errorMessage?.includes("JSON") || errorMessage?.includes("parse")) {
          logger.error("Invalid JSON in auth request", { error: errorMessage });
          if (!res.headersSent) {
            res.status(400).json({ error: "Invalid JSON in request body" });
          }
          return;
        }
        // Log unexpected errors
        logger.error("Auth request error", {
          method: req.method,
          path: url.split("?")[0],
          error: errorMessage,
        });
        // Re-throw other errors
        throw error;
      }
    };

    // Rate limiting for auth endpoints: 10 requests/minute
    // Auth audit logging handled via Better Auth hooks in auth config
    // Auto-register unknown MCP OAuth clients before Better Auth processes the request
    this.app.all("/api/auth/*", authLimiter, mcpClientAutoRegister(), wrappedAuthHandler);
  }

  /**
   * Setup OAuth 2.1 discovery endpoints
   * Must be called before body parsers
   */
  private setupOAuthEndpoints(): void {
    // Web UI base path, configurable via APP_BASE_PATH (default "/"). In root
    // mode the SPA authorize page lives at /oauth/authorize; in /app mode it
    // lives at /app/oauth/authorize and the backend redirects the bare path to it.
    const appPrefix = getAppPrefix();

    // GET /oauth/authorize is the frontend SPA authorization page.
    // - Root mode (appPrefix === ""): nginx serves the SPA at /oauth/authorize; a
    //   backend redirect would loop onto itself, so we register no handler.
    // - /app mode: the SPA page is at /app/oauth/authorize, so redirect the bare
    //   path there (RFC clients hit the bare authorization_endpoint).
    if (appPrefix !== "") {
      this.app.get("/oauth/authorize", (req, res) => {
        const queryString = req.url.split("?")[1] || "";
        res.redirect(`${appPrefix}/oauth/authorize${queryString ? "?" + queryString : ""}`);
      });
    }

    // OAuth Protected Resource Metadata (RFC9728)
    this.app.get("/.well-known/oauth-protected-resource", (req, res) => {
      const baseUrl = getBaseUrl();

      res.json({
        resource: getMcpUrl(),
        authorization_servers: [baseUrl],
        jwks_uri: `${baseUrl}/api/auth/mcp/jwks`,
        scopes_supported: ["openid", "profile", "email", "offline_access"],
        bearer_methods_supported: ["header"],
        resource_signing_alg_values_supported: ["RS256", "none"],
      });
    });

    // OAuth Authorization Server Metadata (RFC8414)
    this.app.get("/.well-known/oauth-authorization-server", (req, res) => {
      const baseUrl = getBaseUrl();

      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/api/auth/mcp/token`,
        userinfo_endpoint: `${baseUrl}/api/auth/mcp/userinfo`,
        jwks_uri: `${baseUrl}/api/auth/mcp/jwks`,
        registration_endpoint: `${baseUrl}/api/auth/mcp/register`,
        scopes_supported: ["openid", "profile", "email", "offline_access"],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256", "none"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        code_challenge_methods_supported: ["S256"],
        claims_supported: [
          "sub",
          "iss",
          "aud",
          "exp",
          "nbf",
          "iat",
          "jti",
          "email",
          "email_verified",
          "name",
        ],
      });
    });
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // Public health check (no auth required for Docker healthcheck)
    this.app.use("/api/health", healthRoutes);

    // Public deployment-mode + feature flags (read pre-auth by login/register UI)
    this.app.use("/api/features", apiLimiter, featuresRoutes);

    // Client-side logging endpoint (public for frontend error reporting)
    this.app.use("/api/logs/client", apiLimiter, clientLogsRoutes);

    // Public workflow token routes (token = authorization, no session required)
    this.app.use("/api/public/workflows", apiLimiter, workflowTokenRoutes);

    // Public artifact token routes (token = authorization, no session required)
    this.app.use("/api/public/artifacts", apiLimiter, artifactTokenRoutes);

    // Public static artifact serving (separate domain in production)
    // Serves HTML with branding injection, security headers
    this.app.use("/static", apiLimiter, staticArtifactsRoutes);

    // Telegram webhook (public — Telegram sends updates directly, no auth)
    this.app.use("/api/telegram/webhook", apiLimiter, telegramWebhookRoutes);

    // Protected API routes (require authentication + rate limiting)
    this.app.use("/api/user", apiLimiter, requireAuth, userInfoRoutes);
    this.app.use("/api/user", userProfileRoutes); // Already has apiLimiter and requireAuth inside
    this.app.use("/api/user", userOAuthSessionsRoutes); // Already has apiLimiter and requireAuth inside
    // Workflow sharing routes MUST be before main workflow routes (more specific patterns first)
    this.app.use("/api/workflows", apiLimiter, requireAuth, workflowSharingRoutes);
    this.app.use("/api/workflows", apiLimiter, requireAuth, workflowRoutes);
    this.app.use("/api/invites", apiLimiter, optionalAuth, inviteAcceptRoutes); // Auth optional for GET, checked inside for POST
    this.app.use("/api/executions", apiLimiter, requireAuth, executionRoutes);
    this.app.use("/api/settings", apiLimiter, requireAuth, settingsRoutes);
    this.app.use("/api/oauth/consent", apiLimiter, requireAuth, oauthConsentRoutes);
    this.app.use("/api/notifications", apiLimiter, requireAuth, notificationsRoutes);
    this.app.use("/api/stats", apiLimiter, requireAuth, statsRoutes);
    this.app.use("/api/notes", apiLimiter, requireAuth, notesRoutes);
    this.app.use("/api/artifacts", apiLimiter, requireAuth, artifactsRoutes);
    this.app.use("/api/tokens", apiLimiter, tokenRoutes); // requireVerifiedAuth inside routes
    this.app.use("/api/admin", apiLimiter, requireAuth, adminRoutes); // requireAdmin inside routes
    this.app.use("/api/admin/tokens", apiLimiter, requireAuth, adminTokenRoutes); // requireAdmin inside routes
    this.app.use("/api/admin", adminUserSecurityRoutes); // Already has apiLimiter, requireAuth, requireAdmin inside
    this.app.use("/api/admin/analytics", apiLimiter, requireAuth, adminAnalyticsRoutes); // requireAdmin inside routes
    this.app.use("/api/admin/monitoring-test", apiLimiter, requireAuth, monitoringTestRoutes); // requireAdmin inside routes

    // Default route for API documentation
    this.app.get("/api", (req, res) => {
      res.json({
        name: "MCP Moira Web UI API",
        version: "0.1.0",
        description: "REST API for workflow visualization and validation",
        endpoints: {
          health: "GET /api/health",
          config: "GET /api/config",
          workflows: "GET /api/workflows",
          folderWorkflows: "GET /api/workflows/:folder",
          workflowDetail: "GET /api/workflows/:folder/:id",
          workflowValidation: "POST /api/workflows/:folder/:id/validate",
          folders: "GET /api/folders",
        },
        timestamp: new Date().toISOString(),
      });
    });

    // Catch-all for unknown API routes
    this.app.use("/api/*", (req, res) => {
      res.status(404).json({
        success: false,
        error: {
          code: "ENDPOINT_NOT_FOUND",
          message: `API endpoint not found: ${req.method} ${req.path}`,
          timestamp: new Date().toISOString(),
        },
      });
    });
  }

  /**
   * Setup error handling middleware
   */
  private setupErrorHandling(): void {
    this.app.use(setupErrorMiddleware());
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    try {
      // Get port (triggers config singleton initialization with validation & logging)
      const port = getWebBackendPort();

      // Start internal metrics server on separate port
      const metricsPort = getMetricsPort();
      this.metricsServer = createMetricsServer(metricsPort, "web-backend");

      // Start periodic execution-retention cleanup (no-op unless
      // executions.retention_days > 0).
      getExecutionRetentionService().start();

      this.server = this.app.listen(port, () => {
        logger.info("MCP Moira API Server Started", {
          type: "server-startup",
          host: "localhost",
          port: port,
          environment: getNodeEnv(),
          workflowDirectories: this.getWorkflowDirectories(),
          urls: {
            server: `http://localhost:${port}`,
            api: `http://localhost:${port}/api`,
            health: `http://localhost:${port}/api/health`,
          },
        });
      });

      // Graceful shutdown handling
      this.setupGracefulShutdown();

      // Handle unhandled rejections to prevent process crash
      process.on("unhandledRejection", (reason, _promise) => {
        logger.error("Unhandled rejection - continuing", reason, {
          type: "unhandled-rejection",
        });
        // DO NOT exit - continue running
      });

      process.on("uncaughtException", (error) => {
        logger.error("Uncaught exception - FATAL", error, {
          type: "uncaught-exception",
        });
        // Uncaught exceptions are fatal - must exit
        process.exit(1);
      });
    } catch (error) {
      logger.error("Failed to start server", {
        type: "server-startup-error",
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      process.exit(1);
    }
  }

  /**
   * Setup graceful shutdown
   */
  private setupGracefulShutdown(): void {
    const shutdown = (signal: string) => {
      logger.info("Shutting down server gracefully", {
        type: "server-shutdown",
        signal,
        uptime: process.uptime(),
      });

      // Close metrics server
      if (this.metricsServer) {
        this.metricsServer.close();
        logger.info("Metrics server closed", { type: "metrics-server-shutdown" });
      }

      if (this.server) {
        this.server.close((error?: Error) => {
          if (error) {
            logger.error("Error during server shutdown", {
              type: "server-shutdown-error",
              error: error.message || "Unknown error",
            });
            process.exit(1);
          }

          // Close database connection
          try {
            closeDatabase();
            logger.info("Database closed successfully", {
              type: "database-shutdown-complete",
            });
          } catch (dbError) {
            logger.error("Error closing database", {
              type: "database-shutdown-error",
              error: dbError instanceof Error ? dbError.message : "Unknown error",
            });
          }

          logger.info("Server closed successfully", {
            type: "server-shutdown-complete",
          });
          process.exit(0);
        });
      } else {
        // Close database even if server wasn't started
        try {
          closeDatabase();
          logger.info("Database closed successfully", {
            type: "database-shutdown-complete",
          });
        } catch (dbError) {
          logger.error("Error closing database", {
            type: "database-shutdown-error",
            error: dbError instanceof Error ? dbError.message : "Unknown error",
          });
        }
        process.exit(0);
      }
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }

  /**
   * Get server configuration
   */
  getConfig() {
    return {
      environment: getNodeEnv(),
      backend: {
        port: 4201,
        host: "localhost",
        workflowDirectories: this.getWorkflowDirectories(),
      },
      runtime: {
        actualPort:
          typeof this.server?.address() === "object"
            ? (this.server?.address() as AddressInfo)?.port
            : 5000,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
      },
    };
  }
}

// Start server if this file is run directly
async function main() {
  try {
    const server = new MoiraApiServer();
    await server.start();
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(logger.error);
}

export { MoiraApiServer };
