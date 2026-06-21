/**
 * Unit Tests: Domain Errors
 * Tests custom exception classes for domain errors
 */

import { describe, it, expect } from "@jest/globals";
import {
  DomainError,
  WorkflowNotFoundError,
  UserNotFoundError,
  SlugConflictError,
  HandleConflictError,
  InvalidSlugError,
  InvalidHandleError,
  WorkflowAccessDeniedError,
} from "@mcp-moira/shared";

describe("Domain Errors", () => {
  describe("WorkflowNotFoundError", () => {
    it("has correct code and httpStatus", () => {
      const error = new WorkflowNotFoundError("test-workflow", "slug");
      expect(error.code).toBe("WORKFLOW_NOT_FOUND");
      expect(error.httpStatus).toBe(404);
      expect(error.name).toBe("WorkflowNotFoundError");
    });

    it("includes identifier in message", () => {
      const error = new WorkflowNotFoundError("my-workflow", "slug");
      expect(error.message).toContain("my-workflow");
    });

    it("stores identifier and identifierType", () => {
      const error = new WorkflowNotFoundError("uuid-123", "id");
      expect(error.identifier).toBe("uuid-123");
      expect(error.identifierType).toBe("id");
    });

    it("is instanceof Error and DomainError", () => {
      const error = new WorkflowNotFoundError("test", "slug");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DomainError);
    });
  });

  describe("UserNotFoundError", () => {
    it("has correct code and httpStatus", () => {
      const error = new UserNotFoundError("test-user", "handle");
      expect(error.code).toBe("USER_NOT_FOUND");
      expect(error.httpStatus).toBe(404);
      expect(error.name).toBe("UserNotFoundError");
    });

    it("includes identifier in message", () => {
      const error = new UserNotFoundError("john-doe", "handle");
      expect(error.message).toContain("john-doe");
    });

    it("stores identifier and identifierType", () => {
      const error = new UserNotFoundError("uuid-456", "id");
      expect(error.identifier).toBe("uuid-456");
      expect(error.identifierType).toBe("id");
    });
  });

  describe("SlugConflictError", () => {
    it("has correct code and httpStatus", () => {
      const error = new SlugConflictError("duplicate-slug", "user-123");
      expect(error.code).toBe("SLUG_CONFLICT");
      expect(error.httpStatus).toBe(409);
      expect(error.name).toBe("SlugConflictError");
    });

    it("includes slug in message", () => {
      const error = new SlugConflictError("my-workflow", "user-123");
      expect(error.message).toContain("my-workflow");
    });

    it("stores slug and userId", () => {
      const error = new SlugConflictError("test-slug", "user-456");
      expect(error.slug).toBe("test-slug");
      expect(error.userId).toBe("user-456");
    });
  });

  describe("HandleConflictError", () => {
    it("has correct code and httpStatus", () => {
      const error = new HandleConflictError("john-doe");
      expect(error.code).toBe("HANDLE_CONFLICT");
      expect(error.httpStatus).toBe(409);
      expect(error.name).toBe("HandleConflictError");
    });

    it("includes handle in message", () => {
      const error = new HandleConflictError("john-doe");
      expect(error.message).toContain("john-doe");
    });

    it("stores handle", () => {
      const error = new HandleConflictError("test-handle");
      expect(error.handle).toBe("test-handle");
    });
  });

  describe("InvalidSlugError", () => {
    it("has correct code and httpStatus", () => {
      const error = new InvalidSlugError("INVALID", "too short");
      expect(error.code).toBe("INVALID_SLUG");
      expect(error.httpStatus).toBe(400);
      expect(error.name).toBe("InvalidSlugError");
    });

    it("includes slug and reason in message", () => {
      const error = new InvalidSlugError("My Workflow", "contains uppercase");
      expect(error.message).toContain("My Workflow");
      expect(error.message).toContain("contains uppercase");
    });

    it("stores slug and reason", () => {
      const error = new InvalidSlugError("bad", "too short");
      expect(error.slug).toBe("bad");
      expect(error.reason).toBe("too short");
    });
  });

  describe("InvalidHandleError", () => {
    it("has correct code and httpStatus", () => {
      const error = new InvalidHandleError("JD", "too short");
      expect(error.code).toBe("INVALID_HANDLE");
      expect(error.httpStatus).toBe(400);
      expect(error.name).toBe("InvalidHandleError");
    });

    it("includes handle and reason in message", () => {
      const error = new InvalidHandleError("John Doe", "contains spaces");
      expect(error.message).toContain("John Doe");
      expect(error.message).toContain("contains spaces");
    });

    it("stores handle and reason", () => {
      const error = new InvalidHandleError("ab", "too short");
      expect(error.handle).toBe("ab");
      expect(error.reason).toBe("too short");
    });
  });

  describe("WorkflowAccessDeniedError", () => {
    it("has correct code and httpStatus", () => {
      const error = new WorkflowAccessDeniedError("private-workflow", "user-123", "read");
      expect(error.code).toBe("WORKFLOW_ACCESS_DENIED");
      expect(error.httpStatus).toBe(403);
      expect(error.name).toBe("WorkflowAccessDeniedError");
    });

    it("includes workflow and action in message", () => {
      const error = new WorkflowAccessDeniedError("secret-workflow", "user-123", "write");
      expect(error.message).toContain("secret-workflow");
      expect(error.message).toContain("write");
    });

    it("stores workflowId, userId and action", () => {
      const error = new WorkflowAccessDeniedError("wf-123", "user-456", "delete");
      expect(error.workflowId).toBe("wf-123");
      expect(error.userId).toBe("user-456");
      expect(error.action).toBe("delete");
    });
  });

  describe("Error inheritance and instanceof", () => {
    it("all errors extend DomainError", () => {
      const errors = [
        new WorkflowNotFoundError("test", "slug"),
        new UserNotFoundError("test", "handle"),
        new SlugConflictError("test", "user"),
        new HandleConflictError("test"),
        new InvalidSlugError("test", "reason"),
        new InvalidHandleError("test", "reason"),
        new WorkflowAccessDeniedError("test", "user", "read"),
      ];

      errors.forEach((error) => {
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toBeInstanceOf(Error);
      });
    });

    it("each error has unique name", () => {
      const errors = [
        new WorkflowNotFoundError("test", "slug"),
        new UserNotFoundError("test", "handle"),
        new SlugConflictError("test", "user"),
        new HandleConflictError("test"),
        new InvalidSlugError("test", "reason"),
        new InvalidHandleError("test", "reason"),
        new WorkflowAccessDeniedError("test", "user", "read"),
      ];

      const names = new Set(errors.map((e) => e.name));
      expect(names.size).toBe(errors.length);
    });

    it("each error has unique code", () => {
      const errors = [
        new WorkflowNotFoundError("test", "slug"),
        new UserNotFoundError("test", "handle"),
        new SlugConflictError("test", "user"),
        new HandleConflictError("test"),
        new InvalidSlugError("test", "reason"),
        new InvalidHandleError("test", "reason"),
        new WorkflowAccessDeniedError("test", "user", "read"),
      ];

      const codes = new Set(errors.map((e) => e.code));
      expect(codes.size).toBe(errors.length);
    });
  });

  describe("Error serialization", () => {
    it("errors can be caught and re-thrown", () => {
      const original = new WorkflowNotFoundError("test-wf", "slug");
      try {
        throw original;
      } catch (e) {
        expect(e).toBe(original);
        expect((e as WorkflowNotFoundError).code).toBe("WORKFLOW_NOT_FOUND");
      }
    });

    it("errors have proper stack trace", () => {
      const error = new SlugConflictError("test", "user");
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("SlugConflictError");
    });

    it("toJSON returns code and message", () => {
      const error = new HandleConflictError("john-doe");
      const json = error.toJSON();
      expect(json.code).toBe("HANDLE_CONFLICT");
      expect(json.message).toContain("john-doe");
    });
  });
});
