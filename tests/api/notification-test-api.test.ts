/**
 * Notification Test API Integration Tests
 * Tests structured error responses from POST /api/notifications/test
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestFetchUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestFetchUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();
const TEST_USER = {
  email: `notification-api-test-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Notification Test User",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let authCookie: string;

beforeAll(async () => {
  // Create test user
  const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(TEST_USER),
  });
  const signUpData = (await signUpRes.json()) as Record<string, unknown>;
  const user = signUpData?.user as Record<string, unknown> | undefined;
  if (!user) {
    throw new Error(`Failed to create test user: ${JSON.stringify(signUpData)}`);
  }
  const testUserId = user.id as string;

  // Login as admin to verify email
  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  const adminCookies = adminLoginRes.headers.get("set-cookie");

  await fetch(`${BASE_URL}/api/admin/users/${testUserId}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookies || "" },
  });

  // Login as test user
  const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: TEST_USER.email,
      password: TEST_USER.password,
    }),
  });

  authCookie = loginRes.headers.get("set-cookie") || "";
});

describe("POST /api/notifications/test - Structured Error Responses", () => {
  test("returns validation error when botToken is missing", async () => {
    const response = await fetch(`${BASE_URL}/api/notifications/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ chatId: "12345" }),
    });

    expect(response.status).toBe(400);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.success).toBe(false);
  });

  test("returns validation error when chatId is missing", async () => {
    const response = await fetch(`${BASE_URL}/api/notifications/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({ botToken: "123456789:ABCDEFGH" }),
    });

    expect(response.status).toBe(400);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.success).toBe(false);
  });

  test("returns structured error with invalid bot token", async () => {
    const response = await fetch(`${BASE_URL}/api/notifications/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        botToken: "000000000:INVALIDTOKENFORMAT",
        chatId: "12345",
      }),
    });

    expect(response.status).toBe(400);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.success).toBe(false);
    expect(data.errorType).toBeDefined();
    expect(typeof data.errorType).toBe("string");
    expect(data.message).toBeDefined();
    expect(typeof data.message).toBe("string");
    // Should be either invalid_token, api_error, or network_error depending on Telegram's response
    expect(["invalid_token", "api_error", "network_error"]).toContain(data.errorType);
  });

  test("returns structured error with invalid chat ID", async () => {
    // Use a valid-looking but non-existent bot token to reach the Telegram API
    // The token format must pass local validation (digits:alphanumeric)
    const response = await fetch(`${BASE_URL}/api/notifications/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        botToken: "9999999999:AAFake_Token_For_Test_Only_Invalid",
        chatId: "nonexistent-chat-999",
      }),
    });

    expect(response.status).toBe(400);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.success).toBe(false);
    expect(data.errorType).toBeDefined();
    expect(typeof data.errorType).toBe("string");
    expect(data.message).toBeDefined();
    expect(typeof data.message).toBe("string");
    // The error message should be actionable (not generic "Unknown error")
    expect(data.message).not.toContain("Unknown error occurred");
  });

  test("error response has correct structure (errorType + message)", async () => {
    const response = await fetch(`${BASE_URL}/api/notifications/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        botToken: "1234567890:AAHello_Invalid_Token_For_Testing",
        chatId: "12345",
      }),
    });

    expect(response.status).toBe(400);
    const data = (await response.json()) as Record<string, unknown>;

    // Verify the structured error response format
    expect(data).toHaveProperty("success", false);
    expect(data).toHaveProperty("errorType");
    expect(data).toHaveProperty("message");

    // errorType should be a known TelegramErrorType
    const validErrorTypes = [
      "invalid_token",
      "invalid_chat_id",
      "network_error",
      "api_error",
      "template_error",
      "rate_limit_exceeded",
      "timeout_error",
      "message_too_long",
    ];
    expect(validErrorTypes).toContain(data.errorType);
  });

  test("returns 401 without authentication", async () => {
    const response = await fetch(`${BASE_URL}/api/notifications/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        botToken: "123456789:ABCDEFGH",
        chatId: "12345",
      }),
    });

    expect(response.status).toBe(401);
  });
});
