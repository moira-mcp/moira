/**
 * Client-side Error Logger
 * Sends frontend errors to backend for centralized logging
 */

type LogLevel = "error" | "warn" | "info" | "debug";

interface LogEntry {
  level: LogLevel;
  message: string;
  stack?: string;
  url?: string;
  userAgent?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

// Buffer for batching logs
let logBuffer: LogEntry[] = [];
let flushTimeout: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 5000; // 5 seconds
const MAX_BUFFER_SIZE = 20;

/**
 * Get backend API URL for logging endpoint
 */
function getLogEndpoint(): string {
  // Use relative URL (proxied in dev, direct in production)
  return "/api/logs/client";
}

/**
 * Flush buffered logs to backend
 */
async function flushLogs(): Promise<void> {
  if (logBuffer.length === 0) return;

  const logsToSend = [...logBuffer];
  logBuffer = [];

  try {
    const endpoint = logsToSend.length === 1 ? getLogEndpoint() : `${getLogEndpoint()}/batch`;

    const body =
      logsToSend.length === 1 ? JSON.stringify(logsToSend[0]) : JSON.stringify(logsToSend);

    // Use fetch for reliability (doesn't depend on axios instance state)
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
      // Don't wait forever for logging
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Silently fail - logging shouldn't break the app
    // Optionally: console.error for dev debugging
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line no-console
      console.warn("[ClientLogger] Failed to send logs to backend");
    }
  }
}

/**
 * Schedule flush with debouncing
 */
function scheduleFlush(): void {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
  }
  flushTimeout = setTimeout(() => {
    flushLogs();
    flushTimeout = null;
  }, FLUSH_INTERVAL);
}

/**
 * Add log entry to buffer
 */
function addToBuffer(entry: LogEntry): void {
  logBuffer.push(entry);

  // Immediate flush if buffer is full or it's an error
  if (logBuffer.length >= MAX_BUFFER_SIZE || entry.level === "error") {
    flushLogs();
  } else {
    scheduleFlush();
  }
}

/**
 * Create log entry with common metadata
 */
function createLogEntry(level: LogLevel, message: string, extra?: Partial<LogEntry>): LogEntry {
  return {
    level,
    message: message.slice(0, 10000), // Limit message size
    url: typeof window !== "undefined" ? window.location.href : undefined,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 1000) : undefined,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Client Logger API
 */
export const clientLogger = {
  /**
   * Log error with optional stack trace
   */
  error(message: string, error?: Error, metadata?: Record<string, unknown>): void {
    addToBuffer(
      createLogEntry("error", message, {
        stack: error?.stack?.slice(0, 50000),
        metadata,
      }),
    );
  },

  /**
   * Log warning
   */
  warn(message: string, metadata?: Record<string, unknown>): void {
    addToBuffer(createLogEntry("warn", message, { metadata }));
  },

  /**
   * Log info
   */
  info(message: string, metadata?: Record<string, unknown>): void {
    addToBuffer(createLogEntry("info", message, { metadata }));
  },

  /**
   * Log debug (only in development or if enabled)
   */
  debug(message: string, metadata?: Record<string, unknown>): void {
    // Only send debug logs in development
    if (process.env.NODE_ENV === "development") {
      addToBuffer(createLogEntry("debug", message, { metadata }));
    }
  },

  /**
   * Manually flush pending logs (e.g., before page unload)
   */
  flush(): void {
    flushLogs();
  },
};

/**
 * Setup global error handlers
 * Call this once at app initialization
 */
export function setupGlobalErrorHandlers(): void {
  if (typeof window === "undefined") return;

  // Capture unhandled errors
  window.onerror = (message, source, lineno, colno, error) => {
    clientLogger.error(`Unhandled error: ${message}`, error || undefined, {
      source,
      lineno,
      colno,
      type: "window.onerror",
    });
    // Return false to let default handler run too
    return false;
  };

  // Capture unhandled promise rejections
  window.onunhandledrejection = (event) => {
    const error = event.reason instanceof Error ? event.reason : undefined;
    const message = error?.message || String(event.reason);

    clientLogger.error(`Unhandled promise rejection: ${message}`, error, {
      type: "unhandledrejection",
    });
  };

  // Flush logs before page unload
  window.addEventListener("beforeunload", () => {
    clientLogger.flush();
  });

  // Flush logs when page becomes hidden (mobile tab switch)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      clientLogger.flush();
    }
  });
}

export default clientLogger;
