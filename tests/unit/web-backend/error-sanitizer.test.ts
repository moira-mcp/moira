/**
 * Error Sanitizer Tests
 * Tests for security issue #276: Sensitive error messages leak to frontend
 */

import {
  containsSensitiveInfo,
  sanitizeErrorMessage,
  createClientSafeError,
} from "../../../packages/web-backend/src/utils/error-sanitizer.js";

describe("Error Sanitizer", () => {
  describe("containsSensitiveInfo", () => {
    it("should detect environment variable names", () => {
      expect(containsSensitiveInfo("TELEGRAM_ENCRYPTION_KEY environment variable not set")).toBe(
        true,
      );
      expect(containsSensitiveInfo("AUTH_SECRET is missing")).toBe(true);
      expect(containsSensitiveInfo("Missing DATABASE_PASSWORD")).toBe(true);
      expect(containsSensitiveInfo("API_TOKEN required")).toBe(true);
    });

    it("should detect file system paths", () => {
      expect(containsSensitiveInfo("File not found: /Users/jane/secret.txt")).toBe(true);
      expect(containsSensitiveInfo("Error reading /home/user/.ssh/id_rsa")).toBe(true);
      expect(containsSensitiveInfo("Cannot access C:\\Users\\Admin\\config")).toBe(true);
      expect(containsSensitiveInfo("Loading from /var/log/app.log")).toBe(true);
      expect(containsSensitiveInfo("Config at /etc/nginx/nginx.conf")).toBe(true);
    });

    it("should detect database error details", () => {
      expect(containsSensitiveInfo("SQLITE_ERROR: no such table: users")).toBe(true);
      expect(containsSensitiveInfo("ENOENT: file not found")).toBe(true);
      expect(containsSensitiveInfo("table 'credentials' doesn't exist")).toBe(true);
      expect(containsSensitiveInfo("no such column in table")).toBe(true);
    });

    it("should detect internal service details", () => {
      expect(containsSensitiveInfo("Connection refused to localhost:5432")).toBe(true);
      expect(containsSensitiveInfo("Cannot reach 127.0.0.1:6379")).toBe(true);
    });

    it("should detect stack traces", () => {
      expect(
        containsSensitiveInfo("at Function.processTicksAndRejections (/app/server.js:42:15)"),
      ).toBe(true);
      expect(containsSensitiveInfo("    at Module._compile (node:internal/modules:1234:14)")).toBe(
        true,
      );
    });

    it("should detect module internals", () => {
      expect(containsSensitiveInfo("Error in node_modules/express/lib/router.js")).toBe(true);
    });

    it("should return false for safe messages", () => {
      expect(containsSensitiveInfo("Invalid email format")).toBe(false);
      expect(containsSensitiveInfo("User not found")).toBe(false);
      expect(containsSensitiveInfo("Password must be at least 8 characters")).toBe(false);
      expect(containsSensitiveInfo("Workflow validation failed")).toBe(false);
    });
  });

  describe("sanitizeErrorMessage", () => {
    it("should return generic message for sensitive content", () => {
      expect(sanitizeErrorMessage("TELEGRAM_ENCRYPTION_KEY environment variable not set")).toBe(
        "Internal server error",
      );
      expect(sanitizeErrorMessage("File not found: /Users/admin/secret.key")).toBe(
        "Internal server error",
      );
    });

    it("should return original message for safe content", () => {
      expect(sanitizeErrorMessage("Invalid email format")).toBe("Invalid email format");
      expect(sanitizeErrorMessage("User not found")).toBe("User not found");
    });

    it("should return generic message for undefined input", () => {
      expect(sanitizeErrorMessage(undefined)).toBe("An error occurred");
    });

    it("should return generic message for very long messages", () => {
      const longMessage = "a".repeat(600);
      expect(sanitizeErrorMessage(longMessage)).toBe("Internal server error");
    });

    it("should pass through safe error codes even with suspicious content", () => {
      // When errorCode is in safe list, trust the message was intentionally crafted
      expect(sanitizeErrorMessage("Workflow 'test' not found", "WORKFLOW_NOT_FOUND")).toBe(
        "Workflow 'test' not found",
      );
      expect(sanitizeErrorMessage("Invalid request format", "INVALID_REQUEST")).toBe(
        "Invalid request format",
      );
    });
  });

  describe("createClientSafeError", () => {
    it("should handle Error objects", () => {
      const error = new Error("TELEGRAM_ENCRYPTION_KEY not set");
      const result = createClientSafeError(error);

      expect(result.message).toBe("Internal server error");
      expect(result.isSanitized).toBe(true);
    });

    it("should handle string errors", () => {
      const result = createClientSafeError("Connection to /var/run/docker.sock failed");

      expect(result.message).toBe("Internal server error");
      expect(result.isSanitized).toBe(true);
    });

    it("should handle safe Error objects", () => {
      const error = new Error("Invalid email format");
      const result = createClientSafeError(error);

      expect(result.message).toBe("Invalid email format");
      expect(result.isSanitized).toBe(false);
    });

    it("should handle unknown error types", () => {
      const result = createClientSafeError({ code: 500 });

      expect(result.message).toBe("An error occurred");
      expect(result.isSanitized).toBe(false);
    });

    it("should handle null/undefined", () => {
      const result = createClientSafeError(null);
      expect(result.message).toBe("An error occurred");

      const result2 = createClientSafeError(undefined);
      expect(result2.message).toBe("An error occurred");
    });
  });
});
