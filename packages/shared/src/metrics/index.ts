/**
 * Prometheus Metrics Module for MCP Moira
 * Provides metrics collection, HTTP middleware, and internal metrics server
 */

import * as promClient from "prom-client";
import { createServer, IncomingMessage, ServerResponse } from "http";
import express from "express";
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
 * `route` label of a request that no Express route handled: 404s, scanners, and responses written
 * by middleware alone. Every such request shares this one value, so an unknown path can never add
 * a series.
 */
export const UNMATCHED_ROUTE = "<unmatched>";

const routeTemplateKey = Symbol.for("moira.metrics.routeTemplate");

type RouteTemplateRequest = Request & { [routeTemplateKey]?: string };

interface DispatchableRoute {
  path: unknown;
  dispatch(req: RouteTemplateRequest, res: Response, done: NextFunction): void;
}

let routeDispatchRecorded = false;

/**
 * Record the route template when an Express route takes a request: the mount path in effect at
 * that moment followed by the route's own pattern, e.g. `/api/workflows` + `/:id`.
 *
 * The template has to be taken at dispatch. By the time the response finishes, Express has
 * restored `req.baseUrl` if the router exited through `next(err)`, and a later wildcard mount may
 * have replaced it with the raw path. Mount paths are static lowercase strings, and Express matches
 * them case-insensitively while keeping the request's casing in `req.baseUrl`; folding it to lower
 * case makes the mount part equal its pattern. A mount path with parameters would put request
 * values into the label and must not be added. The last route that took the request wins.
 */
function recordRouteTemplates(): void {
  if (routeDispatchRecorded) return;
  routeDispatchRecorded = true;

  // Express exports Route at runtime; its type definitions do not declare it.
  const { Route } = express as unknown as { Route: { prototype: DispatchableRoute } };
  const route = Route.prototype;
  const dispatch = route.dispatch;
  route.dispatch = function dispatchWithTemplate(this: DispatchableRoute, req, res, done) {
    req[routeTemplateKey] = routeTemplate(req.baseUrl.toLowerCase(), this.path);
    return dispatch.call(this, req, res, done);
  };
}

function routeTemplate(mountPath: string, routePath: unknown): string {
  const pattern = typeof routePath === "string" ? routePath : String(routePath);
  if (mountPath && pattern === "/") return mountPath;
  return `${mountPath}${pattern}`;
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
 * Records request count and duration for all requests, labelled by the route template that
 * handled the request, or UNMATCHED_ROUTE
 */
export function metricsMiddleware() {
  recordRouteTemplates();

  return (req: RouteTemplateRequest, res: Response, next: NextFunction): void => {
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
      const route = req[routeTemplateKey] ?? UNMATCHED_ROUTE;
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

/** Replay protocol outcomes. Both labels are closed enums and contain no request data. */
export const executionMutationAttemptsTotal = new promClient.Counter({
  name: "moira_execution_mutation_attempts_total",
  help: "Workflow mutation attempt outcomes",
  labelNames: ["operation", "outcome"],
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

/**
 * Materialize archive delivery metrics.
 * Reasons are a closed, low-cardinality set and never contain grant values.
 */
export const materializeDownloadsTotal = new promClient.Counter({
  name: "moira_materialize_downloads_total",
  help: "Total number of materialize archive download outcomes",
  labelNames: ["outcome", "reason"],
  registers: [metricsRegistry],
});

/**
 * Cloud codespace metrics. Every label is a closed enumeration (provider, action,
 * kind, state, code); user, codespace and operation identifiers are never labels.
 */
export const codespaceConnectionEventsTotal = new promClient.Counter({
  name: "moira_codespace_connection_events_total",
  help: "Codespace provider connection audit events by provider and action",
  labelNames: ["provider", "action"],
  registers: [metricsRegistry],
});

export const codespaceLifecycleEventsTotal = new promClient.Counter({
  name: "moira_codespace_lifecycle_events_total",
  help: "Codespace lifecycle audit events by provider, action and resulting state",
  labelNames: ["provider", "action", "state"],
  registers: [metricsRegistry],
});

export const codespaceOperationEventsTotal = new promClient.Counter({
  name: "moira_codespace_operation_events_total",
  help: "Codespace operation audit events by provider, kind, action and state",
  labelNames: ["provider", "kind", "action", "state"],
  registers: [metricsRegistry],
});

export const codespaceOperationDurationSeconds = new promClient.Histogram({
  name: "moira_codespace_operation_duration_seconds",
  help: "Seconds from operation reservation to its terminal state",
  labelNames: ["kind", "state"],
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900],
  registers: [metricsRegistry],
});

export const codespaceRejectionsTotal = new promClient.Counter({
  name: "moira_codespace_rejections_total",
  help: "Codespace requests refused before provider contact by bounded error code",
  labelNames: ["code"],
  registers: [metricsRegistry],
});

export const codespaceReconciliationDueGauge = new promClient.Gauge({
  name: "moira_codespace_reconciliation_due",
  help: "Codespace records currently waiting for reconciliation",
  labelNames: ["kind"],
  registers: [metricsRegistry],
});

export const codespaceReconciliationOldestDueAgeSeconds = new promClient.Gauge({
  name: "moira_codespace_reconciliation_oldest_due_age_seconds",
  help: "Age of the oldest codespace record waiting for reconciliation",
  labelNames: ["kind"],
  registers: [metricsRegistry],
});

export const codespaceActiveGauge = new promClient.Gauge({
  name: "moira_codespace_active",
  help: "Active codespace resources and operations across the instance",
  labelNames: ["kind"],
  registers: [metricsRegistry],
});

export const codespaceTransferLiveBytesGauge = new promClient.Gauge({
  name: "moira_codespace_transfer_live_bytes",
  help: "Bytes currently reserved or held by private codespace transfers",
  registers: [metricsRegistry],
});

export const codespaceConnectorAvailableGauge = new promClient.Gauge({
  name: "moira_codespace_connector_available",
  help: "1 when the credential-bearing codespace connector answers its health probe",
  labelNames: ["provider"],
  registers: [metricsRegistry],
});

export const codespaceReadyGauge = new promClient.Gauge({
  name: "moira_codespace_ready",
  help: "1 when the instance can accept new codespace work for the provider",
  labelNames: ["provider"],
  registers: [metricsRegistry],
});

// Re-export prom-client types for convenience
export { Counter, Gauge, Histogram, Registry } from "prom-client";
