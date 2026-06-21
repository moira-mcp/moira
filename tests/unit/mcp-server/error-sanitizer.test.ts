/**
 * MCP Server Error Sanitizer Tests
 * Tests for security issue #276 in MCP server context
 */

import { sanitizeMcpError } from "../../../packages/mcp-server/src/utils/error-sanitizer.js";

describe("MCP Error Sanitizer", () => {
  describe("sanitizeMcpError", () => {
    it("should sanitize environment variable leaks", () => {
      const error = new Error("TELEGRAM_ENCRYPTION_KEY environment variable not set");
      expect(sanitizeMcpError(error)).toBe("Internal server error");
    });

    it("should sanitize file path leaks", () => {
      const error = new Error("Cannot read file /Users/admin/config/secrets.json");
      expect(sanitizeMcpError(error)).toBe("Internal server error");
    });

    it("should sanitize database error details", () => {
      const error = new Error("SQLITE_ERROR: no such table: api_keys");
      expect(sanitizeMcpError(error)).toBe("Internal server error");
    });

    it("should sanitize internal service addresses", () => {
      const error = new Error("Connection refused to localhost:5432");
      expect(sanitizeMcpError(error)).toBe("Internal server error");
    });

    it("should sanitize stack trace content", () => {
      const error = new Error(
        "Error at Function.processTicksAndRejections (/app/node_modules/pg/lib/client.js:123:45)",
      );
      expect(sanitizeMcpError(error)).toBe("Internal server error");
    });

    it("should preserve safe error messages", () => {
      const error = new Error("Workflow not found");
      expect(sanitizeMcpError(error)).toBe("Workflow not found");
    });

    it("should preserve user-facing validation errors", () => {
      const error = new Error("Invalid workflow ID format");
      expect(sanitizeMcpError(error)).toBe("Invalid workflow ID format");
    });

    it("should handle string errors", () => {
      expect(sanitizeMcpError("Process not found")).toBe("Process not found");
      expect(sanitizeMcpError("ENOENT: file not found")).toBe("Internal server error");
    });

    it("should handle unknown error types", () => {
      expect(sanitizeMcpError({ code: 500 })).toBe("An error occurred");
      expect(sanitizeMcpError(null)).toBe("An error occurred");
      expect(sanitizeMcpError(undefined)).toBe("An error occurred");
    });

    it("should sanitize very long error messages", () => {
      const longMessage = "Error: " + "a".repeat(600);
      expect(sanitizeMcpError(new Error(longMessage))).toBe("Internal server error");
    });
  });
});
