/**
 * Prometheus Metrics Module for MCP Moira
 * Provides metrics collection, HTTP middleware, and internal metrics server
 */

import * as promClient from "prom-client";
import { createServer, IncomingMessage, ServerResponse } from "http";
import type { Request, Response, NextFunction } from "express";

// Create a single registry for all metrics
export const metricsRegistry = new promClient.Registry();

// Add default Node.js metrics (memory, event loop, GC, etc.)
promClient.collectDefaultMetrics({
  register: metricsRegistry,
  prefix: "moira_",
});

// === HTTP Request Metrics ===

/**
 * Counter for total HTTP requests
 * Labels: method, route, status_code
 */
export const httpRequestsTotal = new promClient.Counter({
  name: "moira_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry],
});

/**
 * Histogram for HTTP request duration in seconds
 * Labels: method, route, status_code
 */
export const httpRequestDurationSeconds = new promClient.Histogram({
  name: "moira_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * Normalize route path by replacing dynamic segments with placeholders
 * e.g., /api/workflows/abc123 -> /api/workflows/:id
 */
export function normalizeRoute(path: string): string {
  if (!path) return "unknown";

  return (
    path
      // UUID-like patterns (e.g., workflow IDs, execution IDs)
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
      // Generic alphanumeric IDs (20+ chars, likely IDs)
      .replace(/\/[a-zA-Z0-9]{20,}/g, "/:id")
      // Numeric IDs
      .replace(/\/\d+/g, "/:id")
      // Token-like patterns (base64url encoded)
      .replace(/\/[a-zA-Z0-9_-]{32,}/g, "/:token")
  );
}

/**
 * Paths to exclude from metrics collection
 */
const EXCLUDED_PATHS = ["/health", "/metrics", "/startup-ready", "/api/health"];

/**
 * Check if path should be excluded from metrics
 */
function shouldExclude(path: string): boolean {
  return EXCLUDED_PATHS.some((excluded) => path === excluded || path.startsWith(excluded));
}

/**
 * Express middleware for collecting HTTP metrics
 * Records request count and duration for all requests
 */
export function metricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.path || req.url || "";

    // Skip metrics collection for excluded paths
    if (shouldExclude(path)) {
      next();
      return;
    }

    const startTime = process.hrtime.bigint();

    // Hook into response finish event
    res.on("finish", () => {
      const endTime = process.hrtime.bigint();
      const durationNs = Number(endTime - startTime);
      const durationSeconds = durationNs / 1e9;

      const method = req.method || "UNKNOWN";
      const route = normalizeRoute(path);
      const statusCode = res.statusCode.toString();

      // Increment request counter
      httpRequestsTotal.inc({
        method,
        route,
        status_code: statusCode,
      });

      // Record request duration
      httpRequestDurationSeconds.observe(
        {
          method,
          route,
          status_code: statusCode,
        },
        durationSeconds,
      );
    });

    next();
  };
}

/**
 * Create and start internal metrics server
 * Exposes /metrics endpoint in Prometheus format and /health for health checks
 *
 * @param port - Port to listen on (default: 9090)
 * @param serviceName - Service name for logging
 * @returns HTTP server instance
 */
export function createMetricsServer(port: number = 9090, serviceName: string = "unknown") {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "";

    if (url === "/metrics") {
      try {
        const metrics = await metricsRegistry.metrics();
        res.writeHead(200, { "Content-Type": promClient.prometheusContentType });
        res.end(metrics);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[${serviceName}] Error collecting metrics:`, error);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error collecting metrics");
      }
    } else if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy" }));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    // Using console here is OK - metrics server is infrastructure
    // eslint-disable-next-line no-console
    console.log(`[${serviceName}] Metrics server listening on port ${port}`);
  });

  return server;
}

// === Business Metrics Helpers ===

/**
 * Create a labeled counter for business metrics
 */
export function createCounter(name: string, help: string, labelNames: string[] = []) {
  return new promClient.Counter({
    name: `moira_${name}`,
    help,
    labelNames,
    registers: [metricsRegistry],
  });
}

/**
 * Create a labeled gauge for business metrics
 */
export function createGauge(name: string, help: string, labelNames: string[] = []) {
  return new promClient.Gauge({
    name: `moira_${name}`,
    help,
    labelNames,
    registers: [metricsRegistry],
  });
}

/**
 * Create a labeled histogram for business metrics
 */
export function createHistogram(
  name: string,
  help: string,
  labelNames: string[] = [],
  buckets?: number[],
) {
  return new promClient.Histogram({
    name: `moira_${name}`,
    help,
    labelNames,
    buckets: buckets || promClient.linearBuckets(0, 1, 10),
    registers: [metricsRegistry],
  });
}

// === Pre-configured Business Metrics ===

/**
 * Workflow execution metrics
 */
export const workflowExecutionsTotal = new promClient.Counter({
  name: "moira_workflow_executions_total",
  help: "Total number of workflow executions",
  labelNames: ["status", "workflow_id"],
  registers: [metricsRegistry],
});

export const workflowStepDurationSeconds = new promClient.Histogram({
  name: "moira_workflow_step_duration_seconds",
  help: "Duration of workflow step execution in seconds",
  labelNames: ["workflow_id", "node_type"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

export const activeExecutionsGauge = new promClient.Gauge({
  name: "moira_active_executions",
  help: "Current number of active workflow executions",
  registers: [metricsRegistry],
});

/**
 * MCP tool call metrics
 */
export const mcpToolCallsTotal = new promClient.Counter({
  name: "moira_mcp_tool_calls_total",
  help: "Total number of MCP tool calls",
  labelNames: ["tool", "status"],
  registers: [metricsRegistry],
});

/**
 * Audit action metrics
 */
export const auditActionsTotal = new promClient.Counter({
  name: "moira_audit_actions_total",
  help: "Total number of audit actions",
  labelNames: ["action", "resource"],
  registers: [metricsRegistry],
});

// Re-export prom-client types for convenience
export { Counter, Gauge, Histogram, Registry } from "prom-client";
