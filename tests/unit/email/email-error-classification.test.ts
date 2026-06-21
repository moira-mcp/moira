/**
 * Unit tests for email error classification
 */

import { describe, it, expect } from "@jest/globals";
import { classifyEmailError, maskEmail, EmailErrorType } from "@mcp-moira/shared/email/index.js";

describe("Email Error Classification", () => {
  describe("classifyEmailError", () => {
    it("classifies HTTP 429 as rate limit error", () => {
      const error = { statusCode: 429, message: "Too Many Requests" };
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.RATE_LIMIT);
    });

    it("classifies HTTP 401 as auth error", () => {
      const error = { statusCode: 401, message: "Unauthorized" };
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.AUTH_ERROR);
    });

    it("classifies HTTP 403 as auth error", () => {
      const error = { statusCode: 403, message: "Forbidden" };
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.AUTH_ERROR);
    });

    it("classifies HTTP 400 with email in message as invalid recipient", () => {
      const error = { statusCode: 400, body: { message: "Invalid email address" } };
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.INVALID_RECIPIENT);
    });

    it("classifies HTTP 400 with recipient in message as invalid recipient", () => {
      const error = { statusCode: 400, body: { message: "Recipient not found" } };
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.INVALID_RECIPIENT);
    });

    it("classifies HTTP 400 with quota in message as quota exceeded", () => {
      const error = { statusCode: 400, body: { message: "Daily quota exceeded" } };
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.QUOTA_EXCEEDED);
    });

    it("classifies HTTP 400 with limit in message as quota exceeded", () => {
      const error = {
        statusCode: 400,
        body: { message: "You have reached your daily sending limit" },
      };
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.QUOTA_EXCEEDED);
    });

    it("classifies ECONNREFUSED as network error", () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:587");
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.NETWORK_ERROR);
    });

    it("classifies ENOTFOUND as network error", () => {
      const error = new Error("getaddrinfo ENOTFOUND api.brevo.com");
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.NETWORK_ERROR);
    });

    it("classifies ETIMEDOUT as network error", () => {
      const error = new Error("connect ETIMEDOUT");
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.NETWORK_ERROR);
    });

    it("classifies generic network error", () => {
      const error = new Error("Network request failed");
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.NETWORK_ERROR);
    });

    it("classifies unknown error with statusCode", () => {
      const error = { statusCode: 500, message: "Internal Server Error" };
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.UNKNOWN);
    });

    it("classifies Error without statusCode as unknown", () => {
      const error = new Error("Something went wrong");
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.UNKNOWN);
      expect(result.details).toBe("Something went wrong");
    });

    it("classifies non-Error object as unknown", () => {
      const error = "string error";
      const result = classifyEmailError(error);
      expect(result.type).toBe(EmailErrorType.UNKNOWN);
      expect(result.details).toBe("string error");
    });

    it("includes error details in response", () => {
      const error = { statusCode: 429, message: "Rate limit: 10 requests per second" };
      const result = classifyEmailError(error);
      expect(result.details).toContain("Rate limit");
    });
  });

  describe("maskEmail", () => {
    it("masks email with 2+ character local part", () => {
      expect(maskEmail("john@example.com")).toBe("jo***@example.com");
    });

    it("masks email with exactly 2 character local part", () => {
      // When local part is 2 chars or less, it's fully masked for privacy
      expect(maskEmail("ab@test.com")).toBe("***@test.com");
    });

    it("masks email with 1 character local part", () => {
      expect(maskEmail("a@test.com")).toBe("***@test.com");
    });

    it("handles invalid email without @", () => {
      expect(maskEmail("invalid")).toBe("***@***");
    });

    it("handles empty string", () => {
      expect(maskEmail("")).toBe("***@***");
    });

    it("preserves domain fully", () => {
      expect(maskEmail("user@subdomain.example.com")).toBe("us***@subdomain.example.com");
    });

    it("handles long local part", () => {
      expect(maskEmail("verylongemail@domain.com")).toBe("ve***@domain.com");
    });
  });
});
