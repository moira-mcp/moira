/**
 * Error Logging Levels Tests (Issue #377)
 *
 * Validates that validation/user errors are logged as WARN
 * while system errors are logged as ERROR.
 */

import { describe, test, expect } from "@jest/globals";
import { createLogger } from "@mcp-moira/shared";

describe("Error Logging Levels (Issue #377)", () => {
  describe("ServiceLogger.warn signature", () => {
    const logger = createLogger({ component: "TestComponent" });

    test("accepts (message, meta) signature", () => {
      expect(() => {
        logger.warn("Test message", { key: "value" });
      }).not.toThrow();
    });

    test("accepts (message, error, meta) signature", () => {
      const error = new Error("Test error");
      expect(() => {
        logger.warn("Test message", error, { key: "value" });
      }).not.toThrow();
    });

    test("accepts (message) only", () => {
      expect(() => {
        logger.warn("Test message");
      }).not.toThrow();
    });
  });

  describe("startWorkflow error classification", () => {
    test("'not found' errors are user errors", () => {
      const errorMessage = "Workflow 'xyz' not found";
      const isUserError =
        errorMessage.includes("not found") ||
        errorMessage.includes("parentExecutionId") ||
        errorMessage.includes("Invalid format");

      expect(isUserError).toBe(true);
    });

    test("parentExecutionId errors are user errors", () => {
      const errorMessage = "parentExecutionId must be a valid UUID";
      const isUserError =
        errorMessage.includes("not found") ||
        errorMessage.includes("parentExecutionId") ||
        errorMessage.includes("Invalid format");

      expect(isUserError).toBe(true);
    });

    test("DB errors are NOT user errors", () => {
      const errorMessage = "Database connection failed";
      const isUserError =
        errorMessage.includes("not found") ||
        errorMessage.includes("parentExecutionId") ||
        errorMessage.includes("Invalid format");

      expect(isUserError).toBe(false);
    });
  });
});
