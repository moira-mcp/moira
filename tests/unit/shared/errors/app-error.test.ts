/**
 * Tests for unified error hierarchy
 */

import { describe, it, expect } from "@jest/globals";
import {
  AppError,
  ValidationError,
  NotFoundError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  RateLimitError,
  DatabaseError,
  ConfigurationError,
  ExternalServiceError,
  InternalError,
  normalizeError,
  enrichErrorContext,
  isOperationalError,
  formatErrorForClient,
  // Note domain errors
  NoteNotFoundError,
  NoteVersionNotFoundError,
  InvalidNoteKeyError,
  InvalidTagError,
  TooManyTagsError,
  NoteSizeExceededError,
  QuotaExceededError,
} from "@mcp-moira/shared";

describe("AppError hierarchy", () => {
  describe("Operational errors (isOperational = true)", () => {
    it("ValidationError has correct properties", () => {
      const error = new ValidationError("Invalid email format", { field: "email" });

      expect(error).toBeInstanceOf(AppError);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.isOperational).toBe(true);
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe("Invalid email format");
      expect(error.context).toEqual({ field: "email" });
      expect(error.name).toBe("ValidationError");
    });

    it("NotFoundError has correct properties", () => {
      const error = new NotFoundError("Workflow not found", { workflowId: "test-123" });

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.isOperational).toBe(true);
      expect(error.statusCode).toBe(404);
    });

    it("AuthenticationError has correct properties", () => {
      const error = new AuthenticationError("Invalid credentials");

      expect(error.code).toBe("AUTHENTICATION_ERROR");
      expect(error.isOperational).toBe(true);
      expect(error.statusCode).toBe(401);
    });

    it("AuthorizationError has correct properties", () => {
      const error = new AuthorizationError("Insufficient permissions", { requiredRole: "admin" });

      expect(error.code).toBe("AUTHORIZATION_ERROR");
      expect(error.isOperational).toBe(true);
      expect(error.statusCode).toBe(403);
    });

    it("ConflictError has correct properties", () => {
      const error = new ConflictError("Resource already exists");

      expect(error.code).toBe("CONFLICT");
      expect(error.isOperational).toBe(true);
      expect(error.statusCode).toBe(409);
    });

    it("RateLimitError has correct properties", () => {
      const error = new RateLimitError("Too many requests", { retryAfter: 60 });

      expect(error.code).toBe("RATE_LIMIT_EXCEEDED");
      expect(error.isOperational).toBe(true);
      expect(error.statusCode).toBe(429);
    });
  });

  describe("Programmer errors (isOperational = false)", () => {
    it("DatabaseError has correct properties", () => {
      const error = new DatabaseError("Connection failed");

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("DATABASE_ERROR");
      expect(error.isOperational).toBe(false);
      expect(error.statusCode).toBe(500);
    });

    it("ConfigurationError has correct properties", () => {
      const error = new ConfigurationError("Missing API key");

      expect(error.code).toBe("CONFIGURATION_ERROR");
      expect(error.isOperational).toBe(false);
      expect(error.statusCode).toBe(500);
    });

    it("ExternalServiceError has correct properties", () => {
      const error = new ExternalServiceError("API timeout");

      expect(error.code).toBe("EXTERNAL_SERVICE_ERROR");
      expect(error.isOperational).toBe(false);
      expect(error.statusCode).toBe(502);
    });

    it("InternalError has correct properties", () => {
      const error = new InternalError("Unexpected error");

      expect(error.code).toBe("INTERNAL_ERROR");
      expect(error.isOperational).toBe(false);
      expect(error.statusCode).toBe(500);
    });
  });

  describe("Error with cause", () => {
    it("preserves cause error", () => {
      const cause = new Error("Original error");
      const error = new InternalError("Wrapped error", undefined, cause);

      expect(error.cause).toBe(cause);
      expect(error.stack).toContain("Caused by:");
      expect(error.stack).toContain("Original error");
    });
  });

  describe("toJSON()", () => {
    it("returns serializable object", () => {
      const error = new ValidationError("Test error", { field: "test" });
      const json = error.toJSON();

      expect(json).toEqual({
        code: "VALIDATION_ERROR",
        message: "Test error",
        context: { field: "test" },
        isOperational: true,
      });
    });
  });
});

describe("Error helpers", () => {
  describe("normalizeError", () => {
    it("returns AppError unchanged", () => {
      const original = new ValidationError("Test");
      const normalized = normalizeError(original);

      expect(normalized).toBe(original);
    });

    it("wraps Error in InternalError", () => {
      const original = new Error("Native error");
      const normalized = normalizeError(original);

      expect(normalized).toBeInstanceOf(InternalError);
      expect(normalized.message).toBe("Native error");
      expect(normalized.cause).toBe(original);
    });

    it("wraps string in InternalError", () => {
      const normalized = normalizeError("String error");

      expect(normalized).toBeInstanceOf(InternalError);
      expect(normalized.message).toBe("String error");
    });

    it("wraps null in InternalError", () => {
      const normalized = normalizeError(null);

      expect(normalized).toBeInstanceOf(InternalError);
      expect(normalized.message).toBe("null");
    });

    // Note domain errors normalization
    describe("note domain errors", () => {
      it("converts NoteNotFoundError to NotFoundError (404)", () => {
        const original = new NoteNotFoundError("my-key");
        const normalized = normalizeError(original);

        expect(normalized).toBeInstanceOf(NotFoundError);
        expect(normalized.statusCode).toBe(404);
        expect(normalized.message).toBe("Note not found: my-key");
        expect(normalized.context).toEqual({ code: "NOTE_NOT_FOUND" });
      });

      it("converts NoteVersionNotFoundError to NotFoundError (404)", () => {
        const original = new NoteVersionNotFoundError("my-key", 5);
        const normalized = normalizeError(original);

        expect(normalized).toBeInstanceOf(NotFoundError);
        expect(normalized.statusCode).toBe(404);
        expect(normalized.message).toBe("Note version 5 not found for key: my-key");
        expect(normalized.context).toEqual({ code: "NOTE_VERSION_NOT_FOUND" });
      });

      it("converts InvalidNoteKeyError to ValidationError (400)", () => {
        const original = new InvalidNoteKeyError("bad key", "contains spaces");
        const normalized = normalizeError(original);

        expect(normalized).toBeInstanceOf(ValidationError);
        expect(normalized.statusCode).toBe(400);
        expect(normalized.message).toBe("Invalid note key 'bad key': contains spaces");
        expect(normalized.context).toEqual({ code: "INVALID_NOTE_KEY" });
      });

      it("converts InvalidTagError to ValidationError (400)", () => {
        const original = new InvalidTagError("", "Tag is required");
        const normalized = normalizeError(original);

        expect(normalized).toBeInstanceOf(ValidationError);
        expect(normalized.statusCode).toBe(400);
        expect(normalized.context).toEqual({ code: "INVALID_TAG" });
      });

      it("converts TooManyTagsError to ValidationError (400)", () => {
        const original = new TooManyTagsError(15);
        const normalized = normalizeError(original);

        expect(normalized).toBeInstanceOf(ValidationError);
        expect(normalized.statusCode).toBe(400);
        expect(normalized.message).toBe("Too many tags: 15 (maximum: 10)");
        expect(normalized.context).toEqual({ code: "TOO_MANY_TAGS" });
      });

      it("converts NoteSizeExceededError to ValidationError (400)", () => {
        const original = new NoteSizeExceededError(200000);
        const normalized = normalizeError(original);

        expect(normalized).toBeInstanceOf(ValidationError);
        expect(normalized.statusCode).toBe(400);
        expect(normalized.context).toEqual({ code: "NOTE_SIZE_EXCEEDED" });
      });

      it("converts QuotaExceededError to ValidationError (400)", () => {
        const original = new QuotaExceededError(900000, 200000, 1000000);
        const normalized = normalizeError(original);

        expect(normalized).toBeInstanceOf(ValidationError);
        expect(normalized.statusCode).toBe(400);
        expect(normalized.context).toEqual({ code: "QUOTA_EXCEEDED" });
      });
    });
  });

  describe("enrichErrorContext", () => {
    it("adds context to AppError", () => {
      const error = new ValidationError("Test", { existing: "value" });
      enrichErrorContext(error, { added: "context" });

      expect(error.context).toEqual({
        existing: "value",
        added: "context",
      });
    });

    it("returns same error object", () => {
      const error = new ValidationError("Test");
      const result = enrichErrorContext(error, { key: "value" });

      expect(result).toBe(error);
    });

    it("ignores non-AppError", () => {
      const error = new Error("Native");
      const result = enrichErrorContext(error, { key: "value" });

      expect(result).toBe(error);
      expect((error as Error & { context?: unknown }).context).toBeUndefined();
    });
  });

  describe("isOperationalError", () => {
    it("returns true for operational errors", () => {
      expect(isOperationalError(new ValidationError("Test"))).toBe(true);
      expect(isOperationalError(new NotFoundError("Test"))).toBe(true);
      expect(isOperationalError(new AuthenticationError("Test"))).toBe(true);
    });

    it("returns false for programmer errors", () => {
      expect(isOperationalError(new DatabaseError("Test"))).toBe(false);
      expect(isOperationalError(new InternalError("Test"))).toBe(false);
    });

    it("returns false for unknown errors", () => {
      expect(isOperationalError(new Error("Native"))).toBe(false);
      expect(isOperationalError("string")).toBe(false);
      expect(isOperationalError(null)).toBe(false);
    });
  });

  describe("formatErrorForClient", () => {
    it("shows full details for operational errors", () => {
      const error = new ValidationError("Invalid input", { field: "email" });
      const result = formatErrorForClient(error, true);

      expect(result).toEqual({
        code: "VALIDATION_ERROR",
        message: "Invalid input",
        details: { field: "email" },
      });
    });

    it("hides details for programmer errors in production", () => {
      const error = new DatabaseError("Connection string invalid", { host: "db.local" });
      const result = formatErrorForClient(error, true);

      expect(result).toEqual({
        code: "DATABASE_ERROR",
        message: "Internal server error",
      });
      expect(result.details).toBeUndefined();
    });

    it("shows details for programmer errors in development", () => {
      const error = new DatabaseError("Connection failed", { host: "localhost" });
      const result = formatErrorForClient(error, false);

      expect(result).toEqual({
        code: "DATABASE_ERROR",
        message: "Connection failed",
        details: { host: "localhost" },
      });
    });
  });
});
