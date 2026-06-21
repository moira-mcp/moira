/**
 * Error Sanitization for MCP Server
 * Prevents sensitive information from leaking to MCP clients
 *
 * Security issue #276: Sensitive error messages leak to frontend
 */

/**
 * Patterns that indicate sensitive information in error messages
 */
const SENSITIVE_PATTERNS = [
  // Environment variables
  /\b[A-Z][A-Z0-9_]*_KEY\b/gi,
  /\b[A-Z][A-Z0-9_]*_SECRET\b/gi,
  /\b[A-Z][A-Z0-9_]*_TOKEN\b/gi,
  /\b[A-Z][A-Z0-9_]*_PASSWORD\b/gi,
  /environment variable/gi,
  /process\.env/gi,

  // File system paths
  /\/Users\/[^/\s]+/gi,
  /\/home\/[^/\s]+/gi,
  /C:\\Users\\[^\\]+/gi,
  /\/var\/[^/\s]+/gi,
  /\/etc\/[^/\s]+/gi,
  /\/opt\/[^/\s]+/gi,

  // Database details
  /SQLITE_ERROR/gi,
  /ENOENT/gi,
  /EACCES/gi,
  /EPERM/gi,
  /table\s+['"`]?\w+['"`]?\s+(not found|doesn't exist)/gi,
  /no such table/gi,
  /no such column/gi,

  // Internal service names and ports
  /localhost:\d+/gi,
  /127\.0\.0\.1:\d+/gi,

  // Stack trace indicators
  /at\s+[\w.]+\s+\([^)]+:\d+:\d+\)/g,
  /^\s+at\s+/gm,

  // Module internals
  /node_modules/gi,
];

/**
 * Check if an error message contains sensitive information
 */
function containsSensitiveInfo(message: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Sanitize an error message for MCP client response
 * Returns generic message if sensitive info is detected
 */
export function sanitizeMcpError(error: Error | unknown): string {
  let message: string;

  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    return "An error occurred";
  }

  // Check for sensitive information
  if (containsSensitiveInfo(message)) {
    return "Internal server error";
  }

  // Very long messages often contain stack traces
  if (message.length > 500) {
    return "Internal server error";
  }

  return message;
}
