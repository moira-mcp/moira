/**
 * Registration Consent Validation Tests
 * Verifies GDPR compliance - registration must include legal consent timestamps
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { describe, test, expect } from "@jest/globals";
import { getTestBaseUrl } from "../../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

describe("Registration Consent Validation", () => {
  const generateTestEmail = () => `consent-test-${Date.now()}@example.com`;

  test("should reject registration without acceptedTermsAt with TERMS_NOT_ACCEPTED error", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: generateTestEmail(),
        password: "testpassword123",
        name: "Test User",
        // Missing acceptedTermsAt
        acceptedNotRussianResidentAt: new Date().toISOString(),
      }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { code?: string; message?: string };
    expect(json.code).toBe("TERMS_NOT_ACCEPTED");
    expect(json.message).toContain("Terms of Service");
  });

  test("should reject registration without acceptedNotRussianResidentAt with RESIDENCY_NOT_CONFIRMED error", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: generateTestEmail(),
        password: "testpassword123",
        name: "Test User",
        acceptedTermsAt: new Date().toISOString(),
        // Missing acceptedNotRussianResidentAt
      }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { code?: string; message?: string };
    expect(json.code).toBe("RESIDENCY_NOT_CONFIRMED");
    expect(json.message).toContain("Russian Federation");
  });

  test("should accept registration with both consent fields", async () => {
    const email = generateTestEmail();
    const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "testpassword123",
        name: "Test User",
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      }),
    });

    // Should succeed (200) or user already exists (400 with different error)
    const json = (await res.json()) as { token?: string; code?: string };

    if (res.status === 200) {
      // Registration successful
      expect(json.token).toBeDefined();
    } else {
      // If 400, should NOT be consent errors
      expect(json.code).not.toBe("TERMS_NOT_ACCEPTED");
      expect(json.code).not.toBe("RESIDENCY_NOT_CONFIRMED");
    }
  });

  test("should reject registration with empty consent fields", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: generateTestEmail(),
        password: "testpassword123",
        name: "Test User",
        acceptedTermsAt: "", // Empty string
        acceptedNotRussianResidentAt: "", // Empty string
      }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { code?: string };
    // Should fail on first validation - terms
    expect(json.code).toBe("TERMS_NOT_ACCEPTED");
  });

  test("should reject registration with missing both consent fields", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: generateTestEmail(),
        password: "testpassword123",
        name: "Test User",
        // Both fields missing
      }),
    });

    expect(res.status).toBe(400);

    const json = (await res.json()) as { code?: string };
    // Should fail on first validation - terms checked first
    expect(json.code).toBe("TERMS_NOT_ACCEPTED");
  });
});
