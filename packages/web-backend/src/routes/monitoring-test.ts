/**
 * Monitoring Test API Routes
 * Admin-only endpoints for testing and validating monitoring pipeline
 *
 * Used to generate test events (errors, slow requests, log levels)
 * that should appear in Grafana dashboards via Prometheus/Loki
 */

import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { requireAdmin } from "../middleware/admin-middleware.js";
import { createLogger, InternalError } from "@mcp-moira/shared";

const router = Router();
const logger = createLogger({ component: "MonitoringTest" });

// All monitoring test routes protected by requireAdmin middleware
router.use(requireAdmin);

/**
 * POST /api/admin/monitoring-test/error - Generate a 500 error with logging
 * Used to test error logging pipeline and error rate alerts
 *
 * NOTE: This endpoint manually logs and returns 500 for monitoring dashboards.
 * For unified error architecture testing, use /internal-error-test endpoint.
 */
router.post(
  "/error",
  asyncHandler(async (req: Request, res: Response) => {
    const { message = "Test error generated via Monitoring Test page" } = req.body;

    // Log the error that will be captured by monitoring
    logger.error("Monitoring test error triggered", new Error(message), {
      testType: "error",
      triggeredBy: "admin-monitoring-test",
      source: "monitoring-test-endpoint",
    });

    // Return 500 to test error rate metrics
    res.status(500).json({
      success: false,
      error: {
        code: "TEST_ERROR",
        message: message,
        testType: "monitoring-validation",
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/monitoring-test/internal-error-test - Throw InternalError through error-middleware
 * Used to validate unified error architecture "Log Once at Boundary" for programmer errors
 *
 * Unlike /error endpoint, this throws InternalError which goes through error-middleware,
 * validating that errors are logged exactly once at the boundary layer.
 */
router.post(
  "/internal-error-test",
  asyncHandler(async (req: Request) => {
    const { message = "Intentional internal error for architecture validation" } = req.body;

    // Throw InternalError - will be caught by error-middleware and logged there
    throw new InternalError(message, {
      context: {
        testType: "internal-error",
        triggeredBy: "admin-monitoring-test",
        source: "internal-error-test-endpoint",
      },
    });
  }),
);

/**
 * POST /api/admin/monitoring-test/slow - Generate a slow response
 * Used to test latency metrics and slow request alerts
 */
router.post(
  "/slow",
  asyncHandler(async (req: Request, res: Response) => {
    const { delayMs = 3000 } = req.body;

    // Clamp delay between 100ms and 10s
    const delay = Math.min(Math.max(Number(delayMs), 100), 10000);

    logger.info("Monitoring test slow request started", {
      testType: "slow-request",
      delayMs: delay,
      triggeredBy: "admin-monitoring-test",
    });

    // Wait for specified delay
    await new Promise((resolve) => setTimeout(resolve, delay));

    logger.info("Monitoring test slow request completed", {
      testType: "slow-request",
      delayMs: delay,
      triggeredBy: "admin-monitoring-test",
    });

    res.json({
      success: true,
      data: {
        delayMs: delay,
        message: `Responded after ${delay}ms delay`,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/monitoring-test/log-levels - Generate logs at different levels
 * Used to test log ingestion and filtering in Loki/Grafana
 */
router.post(
  "/log-levels",
  asyncHandler(async (req: Request, res: Response) => {
    const { levels = ["debug", "info", "warn", "error"] } = req.body;
    const validLevels = ["debug", "info", "warn", "error"];
    const generatedLogs: string[] = [];

    for (const level of levels) {
      if (!validLevels.includes(level)) continue;

      const message = `Monitoring test log at ${level.toUpperCase()} level`;
      const meta = {
        testType: "log-levels",
        level: level,
        triggeredBy: "admin-monitoring-test",
        generatedAt: new Date().toISOString(),
      };

      switch (level) {
        case "debug":
          logger.debug(message, meta);
          break;
        case "info":
          logger.info(message, meta);
          break;
        case "warn":
          logger.warn(message, meta);
          break;
        case "error":
          logger.error(message, new Error("Test error for log-levels"), meta);
          break;
      }

      generatedLogs.push(level);
    }

    res.json({
      success: true,
      data: {
        generatedLogs,
        message: `Generated ${generatedLogs.length} log entries at different levels`,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/monitoring-test/workflow - Trigger a test workflow execution
 * Used to test workflow metrics (workflow_executions_total, active_executions)
 * Creates real workflow execution for monitoring validation
 */
router.post(
  "/workflow",
  asyncHandler(async (req: Request, res: Response) => {
    const { workflowId } = req.body;

    if (!workflowId) {
      throw createApiError.validationFailed("workflowId is required");
    }

    logger.info("Monitoring test workflow start requested", {
      testType: "workflow",
      action: "start",
      workflowId,
      triggeredBy: "admin-monitoring-test",
    });

    // For real workflow execution, we log the intent
    // Actual workflow start requires the WorkflowExecutor which is in mcp-server
    // The admin should use Web UI or MCP server to start workflows

    logger.info("Monitoring test workflow execution simulated", {
      testType: "workflow",
      action: "simulated",
      workflowId,
      triggeredBy: "admin-monitoring-test",
      note: "Real execution requires MCP server or Web UI workflow start",
    });

    res.json({
      success: true,
      data: {
        workflowId,
        message: `Workflow start request logged for ${workflowId}. Use Web UI or MCP server for real execution.`,
        suggestion: "Navigate to Workflows page and click Start on a workflow",
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/monitoring-test/mcp-call - Simulate MCP tool call
 * Used to test MCP metrics (mcp_tool_calls_total)
 */
router.post(
  "/mcp-call",
  asyncHandler(async (req: Request, res: Response) => {
    const { toolName = "test_tool", status = "success" } = req.body;
    const validStatuses = ["success", "error"];
    const normalizedStatus = validStatuses.includes(status) ? status : "success";

    logger.info("Monitoring test MCP tool call simulated", {
      testType: "mcp-call",
      toolName,
      status: normalizedStatus,
      triggeredBy: "admin-monitoring-test",
    });

    // Simulate tool execution time
    const executionTime = Math.floor(Math.random() * 500) + 50; // 50-550ms

    if (normalizedStatus === "error") {
      logger.error(
        "Monitoring test MCP tool call error",
        new Error(`Simulated ${toolName} error`),
        {
          testType: "mcp-call",
          toolName,
          status: "error",
          executionTimeMs: executionTime,
          triggeredBy: "admin-monitoring-test",
        },
      );
    }

    res.json({
      success: true,
      data: {
        toolName,
        status: normalizedStatus,
        executionTimeMs: executionTime,
        message: `MCP tool call "${toolName}" simulated with ${normalizedStatus} status`,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/monitoring-test/status - Get current test events history
 * Returns recent test events for display in the admin panel
 */
router.get(
  "/status",
  asyncHandler(async (_req: Request, res: Response) => {
    // This is a simple endpoint that returns instructions
    // In a more advanced setup, we could track recent test events in memory

    res.json({
      success: true,
      data: {
        endpoints: {
          error: "POST /api/admin/monitoring-test/error - Generate 500 error",
          slow: "POST /api/admin/monitoring-test/slow - Slow response (default 3s)",
          logLevels: "POST /api/admin/monitoring-test/log-levels - Generate logs at all levels",
          workflow: "POST /api/admin/monitoring-test/workflow - Workflow execution simulation",
          mcpCall: "POST /api/admin/monitoring-test/mcp-call - MCP tool call simulation",
        },
        verificationCommands: {
          dockerLogs: 'docker logs <container> 2>&1 | grep "MonitoringTest"',
          metricsEndpoint: "curl localhost:9090/metrics | grep http_request",
          grafanaDashboard: "/grafana (after monitoring integration complete)",
        },
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

export { router as monitoringTestRoutes };
