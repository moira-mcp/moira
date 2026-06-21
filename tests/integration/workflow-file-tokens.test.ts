/**
 * Workflow File Token Integration Tests
 * Tests token lifecycle: create, validate, use, expire
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { TokenManager } from "@mcp-moira/shared";

describe("Workflow File Tokens", () => {
  let tokenManager: TokenManager;
  const testUserId = "system-admin"; // Use existing admin user

  beforeEach(() => {
    tokenManager = TokenManager.getInstance();
    tokenManager.clear(); // Clean state before each test
  });

  afterEach(() => {
    tokenManager.clear();
  });

  test("createUploadToken generates valid token", () => {
    const token = tokenManager.createUploadToken(testUserId, 3600000); // 1 hour

    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const tokenData = tokenManager.getTokenData(token);
    expect(tokenData).toBeDefined();
    expect(tokenData!.type).toBe("upload");
    expect(tokenData!.workflowId).toBeNull();
    expect(tokenData!.userId).toBe(testUserId);
    expect(tokenData!.used).toBe(false);
  });

  test("createDownloadToken generates valid token with workflowId", () => {
    const workflowId = "test-workflow-123";
    const token = tokenManager.createDownloadToken(workflowId, testUserId, 3600000);

    expect(token).toBeDefined();
    const tokenData = tokenManager.getTokenData(token);
    expect(tokenData).toBeDefined();
    expect(tokenData!.type).toBe("download");
    expect(tokenData!.workflowId).toBe(workflowId);
    expect(tokenData!.userId).toBe(testUserId);
    expect(tokenData!.used).toBe(false);
  });

  test("validateToken returns token data for valid token", () => {
    const token = tokenManager.createUploadToken(testUserId, 3600000);
    const tokenData = tokenManager.validateToken(token, "upload");

    expect(tokenData).toBeDefined();
    expect(tokenData!.token).toBe(token);
    expect(tokenData!.type).toBe("upload");
    expect(tokenData!.userId).toBe(testUserId);
  });

  test("validateToken returns null for wrong type", () => {
    const token = tokenManager.createUploadToken(testUserId, 3600000);
    const tokenData = tokenManager.validateToken(token, "download");

    expect(tokenData).toBeNull();
  });

  test("validateToken returns null for non-existent token", () => {
    const tokenData = tokenManager.validateToken("non-existent-token", "upload");

    expect(tokenData).toBeNull();
  });

  test("markTokenAsUsed prevents reuse", () => {
    const token = tokenManager.createUploadToken(testUserId, 3600000);

    // First validation succeeds
    let tokenData = tokenManager.validateToken(token, "upload");
    expect(tokenData).toBeDefined();

    // Mark as used
    tokenManager.markTokenAsUsed(token);

    // Second validation fails
    tokenData = tokenManager.validateToken(token, "upload");
    expect(tokenData).toBeNull();
  });

  test("expired token is automatically invalid", async () => {
    const token = tokenManager.createUploadToken(testUserId, 100); // 100ms TTL

    // Initially valid
    let tokenData = tokenManager.validateToken(token, "upload");
    expect(tokenData).toBeDefined();

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Now invalid (validateToken checks expiry)
    tokenData = tokenManager.validateToken(token, "upload");
    expect(tokenData).toBeNull();

    // getTokenData still returns data (doesn't check expiry, only validateToken does)
    const rawData = tokenManager.getTokenData(token);
    expect(rawData).toBeDefined();
    expect(rawData!.expiresAt).toBeLessThan(Date.now());
  });

  test("deleteToken removes token immediately", () => {
    const token = tokenManager.createUploadToken(testUserId, 3600000);

    // Token exists
    expect(tokenManager.getTokenData(token)).toBeDefined();

    // Delete
    tokenManager.deleteToken(token);

    // Token gone
    expect(tokenManager.getTokenData(token)).toBeUndefined();
    expect(tokenManager.validateToken(token, "upload")).toBeNull();
  });

  test("multiple tokens can coexist", () => {
    const uploadToken = tokenManager.createUploadToken(testUserId, 3600000);
    const downloadToken = tokenManager.createDownloadToken("workflow-1", testUserId, 3600000);

    expect(tokenManager.validateToken(uploadToken, "upload")).toBeDefined();
    expect(tokenManager.validateToken(downloadToken, "download")).toBeDefined();

    // Each token has correct type
    expect(tokenManager.validateToken(uploadToken, "download")).toBeNull();
    expect(tokenManager.validateToken(downloadToken, "upload")).toBeNull();
  });

  test("clear removes all tokens", () => {
    const token1 = tokenManager.createUploadToken(testUserId, 3600000);
    const token2 = tokenManager.createDownloadToken("workflow-1", testUserId, 3600000);
    const token3 = tokenManager.createDownloadToken("workflow-2", testUserId, 3600000);

    tokenManager.clear();

    // All tokens gone from database
    expect(tokenManager.getTokenData(token1)).toBeUndefined();
    expect(tokenManager.getTokenData(token2)).toBeUndefined();
    expect(tokenManager.getTokenData(token3)).toBeUndefined();
  });
});
