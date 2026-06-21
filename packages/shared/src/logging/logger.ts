/**
 * Unified Logger for MCP Moira
 * Service-aware structured logging for all packages
 *
 * ПРАВИЛО: ЗАПРЕЩЕНО использовать console.log/console.error!
 * Всегда используйте logger из этого модуля.
 */

import * as winston from "winston";
import { getRequestContext, getGlobalService } from "./context.js";

// Service identifiers for logging
// Only real entry points - mcp-server, web-backend, web-frontend
export enum Service {
  MCP_SERVER = "mcp-server",
  WEB_BACKEND = "web-backend",
  WEB_FRONTEND = "web-frontend",
}

/**
 * Standard component names for log filtering
 * Use these for consistent filtering in Loki/Grafana
 * Example: component!="HTTP" to exclude HTTP request logs
 */
export enum Component {
  HTTP = "HTTP", // HTTP request/response logs
  Auth = "Auth", // Authentication operations
  Workflow = "Workflow", // Workflow CRUD operations
  Execution = "Execution", // Execution lifecycle
  Database = "Database", // Database operations
  MCP = "MCP", // MCP tool calls
  Audit = "Audit", // Audit logging
  Settings = "Settings", // Settings operations
  Admin = "Admin", // Admin operations
}

// JSON format for Docker stdout (Promtail-compatible)
const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }), // ISO 8601
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// Human-readable format for local development
const devFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  winston.format.errors({ stack: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, service, component, requestId, ...meta } = info;

    let log = `${timestamp} [${level.toUpperCase()}]`;
    if (service) log += ` [${service}]`;
    if (component) log += ` [${component}]`;
    if (requestId && typeof requestId === "string") log += ` [${requestId.slice(0, 8)}]`; // Short requestId for dev
    log += ` ${message}`;

    // Add metadata if present
    const excludeKeys = [
      "metadata",
      "timestamp",
      "level",
      "message",
      "service",
      "component",
      "requestId",
      "userId",
    ];
    const metaKeys = Object.keys(meta).filter((k) => !excludeKeys.includes(k));
    if (metaKeys.length > 0) {
      const metaObj: Record<string, unknown> = {};
      metaKeys.forEach((k) => (metaObj[k] = meta[k]));
      log += ` ${JSON.stringify(metaObj)}`;
    }

    return log;
  }),
);

// Use JSON in production (Docker), human-readable in development
const isProduction = process.env.NODE_ENV === "production";
const activeFormat = isProduction ? jsonFormat : devFormat;

// Build transports list
const transports: winston.transport[] = [
  new winston.transports.Console({
    format: activeFormat,
    stderrLevels: [], // All logs to stdout for docker logs
  }),
];

// In production (Docker), also write to a file for reliable log access.
// supervisord's stdout pipe capture has buffering issues that can cause
// logs to be delayed or lost from `docker logs`. Direct file writes bypass this.
const logFilePath = process.env.LOG_FILE;
if (logFilePath) {
  transports.push(
    new winston.transports.File({
      filename: logFilePath,
      format: jsonFormat,
      maxsize: 50 * 1024 * 1024, // 50MB
      maxFiles: 2,
    }),
  );
}

// Logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: activeFormat,
  transports,
  exceptionHandlers: [new winston.transports.Console({ format: activeFormat })],
  rejectionHandlers: [new winston.transports.Console({ format: activeFormat })],
  exitOnError: false, // Do not exit on handled errors
});

/**
 * Performance timer
 */
export class Timer {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  elapsed(): number {
    return Date.now() - this.startTime;
  }
}

/**
 * Logger with automatic context from global service and AsyncLocalStorage
 */
export class ServiceLogger {
  private component?: string;
  private baseContext: Record<string, unknown>;

  constructor(component?: string, context?: Record<string, unknown>) {
    this.component = component;
    this.baseContext = context || {};
  }

  private log(level: string, message: string, meta?: Record<string, unknown>): void {
    // Get global service (set at process startup)
    const globalService = getGlobalService();
    // Get request context from AsyncLocalStorage (if available)
    const requestContext = getRequestContext();

    const logMeta: Record<string, unknown> = {
      // Service from global variable (set at process startup)
      ...(globalService && { service: globalService }),
      // Component from logger instance
      ...(this.component && { component: this.component }),
      // Request context from AsyncLocalStorage
      ...(requestContext && {
        requestId: requestContext.requestId,
        userId: requestContext.userId,
      }),
      ...this.baseContext,
      ...meta,
    };

    // For error logs, include inputData and resourceIds from context for diagnostics
    // This enables full error diagnostics without reproducing the issue
    if (level === "error" && requestContext) {
      if (requestContext.operation) {
        logMeta.operation = requestContext.operation;
      }
      if (requestContext.inputData !== undefined) {
        logMeta.inputData = requestContext.inputData;
      }
      if (requestContext.resourceIds && Object.keys(requestContext.resourceIds).length > 0) {
        logMeta.resourceIds = requestContext.resourceIds;
      }
    }

    logger.log(level, message, logMeta);
  }

  error(message: string, error?: Error | unknown, meta?: Record<string, unknown>): void {
    let errorMessage: string;
    let errorStack: string | undefined;
    let errorName: string;

    if (error instanceof Error) {
      errorMessage = error.message;
      errorStack = error.stack;
      errorName = error.name;
    } else if (error && typeof error === "object") {
      try {
        errorMessage = JSON.stringify(error);
      } catch {
        errorMessage = String(error);
      }
      errorStack = undefined;
      errorName = "object";
    } else {
      errorMessage = String(error);
      errorStack = undefined;
      errorName = typeof error;
    }

    const errorMeta = {
      ...meta,
      errorMessage,
      errorName,
      // Standard 'stack' field for Grafana/Loki compatibility
      // Grafana expects 'stack' field for stack trace display
      ...(errorStack && { stack: errorStack }),
    };
    this.log("error", message, errorMeta);
  }

  warn(
    message: string,
    error?: Error | unknown | Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): void {
    // Handle both signatures: warn(msg, meta) and warn(msg, error, meta)
    let errorMeta: Record<string, unknown> = {};
    let actualMeta = meta;

    if (error !== undefined) {
      if (error instanceof Error) {
        // It's an Error object - extract error info
        errorMeta = {
          errorMessage: error.message,
          errorName: error.name,
        };
      } else if (error && typeof error === "object" && !("errorMessage" in error)) {
        // It's metadata object (old signature: warn(msg, meta))
        actualMeta = error as Record<string, unknown>;
      } else if (error && typeof error === "object") {
        // It's an object with error info
        try {
          errorMeta = { errorMessage: JSON.stringify(error) };
        } catch {
          errorMeta = { errorMessage: String(error) };
        }
      } else if (error !== null) {
        // It's a primitive
        errorMeta = { errorMessage: String(error) };
      }
    }

    this.log("warn", message, { ...errorMeta, ...actualMeta });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log("info", message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log("debug", message, meta);
  }

  child(context: Record<string, unknown>): ServiceLogger {
    return new ServiceLogger(this.component, { ...this.baseContext, ...context });
  }

  startTimer(): Timer {
    return new Timer();
  }
}

// Type alias for workflow-engine naming consistency
export type WorkflowLogger = ServiceLogger;

/**
 * Create logger for specific component
 * Service is taken from global variable automatically
 */
export function createLogger(options: {
  component?: string | Component;
  [key: string]: unknown;
}): ServiceLogger {
  const component = options.component || undefined;
  const { component: _, ...context } = options;

  return new ServiceLogger(component as string | undefined, context);
}

/**
 * Set log level dynamically
 */
export function setLogLevel(level: string): void {
  logger.level = level;
  logger.info(`Log level changed to: ${level}`);
}

/**
 * Get current log level
 */
export function getLogLevel(): string {
  return logger.level;
}

// Root logger instance for direct usage
export const rootLogger = new ServiceLogger();
