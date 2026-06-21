/**
 * Error Sanitization Utilities
 * Prevents sensitive information from leaking to clients
 *
 * Security issue #276: Sensitive error messages leak to frontend
 */

/**
 * Patterns that indicate sensitive information in error messages
 */
const SENSITIVE_PATTERNS = [
  // Environment variables
  /\b[A-Z][A-Z0-9_]*_KEY\b/gi, // API_KEY, SECRET_KEY, ENCRYPTION_KEY
  /\b[A-Z][A-Z0-9_]*_SECRET\b/gi, // AUTH_SECRET, CLIENT_SECRET
  /\b[A-Z][A-Z0-9_]*_TOKEN\b/gi, // ACCESS_TOKEN, REFRESH_TOKEN
  /\b[A-Z][A-Z0-9_]*_PASSWORD\b/gi, // DB_PASSWORD
  /environment variable/gi,
  /process\.env/gi,

  // File system paths
  /\/Users\/[^/\s]+/gi, // macOS user paths
  /\/home\/[^/\s]+/gi, // Linux user paths
  /C:\\Users\\[^\\]+/gi, // Windows user paths
  /\/var\/[^/\s]+/gi, // System paths
  /\/etc\/[^/\s]+/gi, // Config paths
  /\/opt\/[^/\s]+/gi, // Application paths

  // Database details
  /SQLITE_ERROR/gi,
  /ENOENT/gi,
  /EACCES/gi,
  /EPERM/gi,
  /table\s+['"`]?\w+['"`]?\s+(not found|doesn't exist)/gi,
  /column\s+['"`]?\w+['"`]?\s+(not found|doesn't exist)/gi,
  /no such table/gi,
  /no such column/gi,

  // Internal service names and ports
  /localhost:\d+/gi,
  /127\.0\.0\.1:\d+/gi,
  /0\.0\.0\.0:\d+/gi,

  // Stack trace indicators
  /at\s+[\w.]+\s+\([^)]+:\d+:\d+\)/g, // at Function (file:line:col)
  /^\s+at\s+/gm, // Stack trace lines

  // Module internals
  /node_modules/gi,
  /require\(['"]/gi,
  /import\s+.*from/gi,
];

/**
 * Error codes that are safe to expose to clients
 * These are intentional, user-facing error messages
 */
const SAFE_ERROR_CODES = new Set([
  "VALIDATION_FAILED",
  "INVALID_REQUEST",
  "INVALID_FORMAT",
  "WORKFLOW_NOT_FOUND",
  "FOLDER_NOT_FOUND",
  "FILE_READ_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "RATE_LIMIT_EXCEEDED",
]);

/**
 * Check if an error message contains sensitive information
 */
export function containsSensitiveInfo(message: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Sanitize an error message by removing sensitive information
 * Returns a generic message if sensitive info is detected
 */
export function sanitizeErrorMessage(message: string | undefined, errorCode?: string): string {
  // If no message, return generic
  if (!message) {
    return "An error occurred";
  }

  // If error code is in safe list, the message was intentionally crafted for users
  if (errorCode && SAFE_ERROR_CODES.has(errorCode)) {
    return message;
  }

  // Check for sensitive information
  if (containsSensitiveInfo(message)) {
    return "Internal server error";
  }

  // Additional safety: check message length
  // Very long messages often contain stack traces or verbose debug info
  if (message.length > 500) {
    return "Internal server error";
  }

  return message;
}

/**
 * Create a client-safe error object from any error
 * Logs full error details server-side, returns sanitized version for client
 */
export function createClientSafeError(
  error: Error | unknown,
  errorCode?: string,
): { message: string; isSanitized: boolean } {
  let message: string;

  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    message = "An error occurred";
  }

  const sanitized = sanitizeErrorMessage(message, errorCode);
  const isSanitized = sanitized !== message;

  return {
    message: sanitized,
    isSanitized,
  };
}
