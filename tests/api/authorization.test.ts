/**
 * API Authorization Tests
 * Verifies that protected endpoints return 401 without authentication
 * and public endpoints are accessible without authentication.
 *
 * Step 2 of audit-completion: Audit all API endpoints for authorization
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 */

import { describe, test, expect } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

describe("API Authorization", () => {
  describe("Protected endpoints (require 401 without auth)", () => {
    // Workflows API
    test("GET /api/workflows returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/workflows`);
      expect(response.status).toBe(401);
    });

    test("POST /api/workflows returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "test" }),
      });
      expect(response.status).toBe(401);
    });

    test("GET /api/workflows/:id returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/workflows/test-id`);
      expect(response.status).toBe(401);
    });

    test("PUT /api/workflows/:id returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/workflows/test-id`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
    });

    test("DELETE /api/workflows/:id returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/workflows/test-id`, {
        method: "DELETE",
      });
      expect(response.status).toBe(401);
    });

    // Executions API
    test("GET /api/executions returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/executions`);
      expect(response.status).toBe(401);
    });

    test("POST /api/executions/start returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/executions/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId: "test" }),
      });
      expect(response.status).toBe(401);
    });

    test("POST /api/executions/:id/step returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/executions/test-id/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
    });

    // Settings API
    test("GET /api/settings returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/settings`);
      expect(response.status).toBe(401);
    });

    test("PUT /api/settings/:key returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/settings/test-key`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "test" }),
      });
      expect(response.status).toBe(401);
    });

    // User API
    test("GET /api/user/info returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/user/info`);
      expect(response.status).toBe(401);
    });

    test("GET /api/user/profile returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/user/profile`);
      expect(response.status).toBe(401);
    });

    test("PUT /api/user/profile returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/user/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
    });

    test("GET /api/user/account-status returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/user/account-status`);
      expect(response.status).toBe(401);
    });

    test("GET /api/user/sessions returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/user/sessions`);
      expect(response.status).toBe(401);
    });

    test("GET /api/user/oauth-consents returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/user/oauth-consents`);
      expect(response.status).toBe(401);
    });

    // Stats API
    test("GET /api/stats/workflows returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/stats/workflows`);
      expect(response.status).toBe(401);
    });

    test("GET /api/stats/executions returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/stats/executions`);
      expect(response.status).toBe(401);
    });

    // Admin API
    test("GET /api/admin/users returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/users`);
      expect(response.status).toBe(401);
    });

    test("GET /api/admin/audit-log returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/audit-log`);
      expect(response.status).toBe(401);
    });

    test("GET /api/admin/global-settings returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/global-settings`);
      expect(response.status).toBe(401);
    });

    test("POST /api/admin/monitoring-test/error returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/monitoring-test/error`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
    });

    // OAuth consent API
    test("GET /api/oauth/consent/check returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/oauth/consent/check?client_id=test`);
      expect(response.status).toBe(401);
    });

    test("POST /api/oauth/consent returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/oauth/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "test" }),
      });
      expect(response.status).toBe(401);
    });

    // Notifications API
    test("POST /api/notifications/test returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/notifications/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: "test", chatId: "test" }),
      });
      expect(response.status).toBe(401);
    });
  });

  describe("Public endpoints (accessible without auth)", () => {
    test("GET /api/health returns 200 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/health`);
      expect(response.status).toBe(200);
    });

    test("POST /api/logs/client returns 200 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/logs/client`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "info", message: "test" }),
      });
      expect(response.status).toBe(200);
    });

    test("POST /api/logs/client/batch returns 200 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/logs/client/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ level: "info", message: "test" }]),
      });
      expect(response.status).toBe(200);
    });

    // Auth endpoints - return validation errors, not session required errors
    test("POST /api/auth/sign-in/email returns non-401 session error without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@test.com", password: "test" }),
      });
      // 401 with INVALID_EMAIL_OR_PASSWORD is OK (credential validation, not session required)
      const json = (await response.json()) as { code?: string };
      if (response.status === 401) {
        expect(json.code).toBe("INVALID_EMAIL_OR_PASSWORD");
      }
    });

    test("GET /api/auth/session is accessible without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/auth/session`);
      // Better Auth manages this endpoint — should not return 401
      expect(response.status).not.toBe(401);
    });

    test("POST /api/auth/sign-up/email is accessible without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "invalid-email", // Will fail validation, not auth
          password: "short",
          name: "Test",
        }),
      });
      // Should return 400 (validation) or 422, not 401 (auth required)
      expect(response.status).not.toBe(401);
    });

    // Token-based workflow access
    test("POST /api/public/workflows/upload/:token validates token, not session", async () => {
      const response = await fetch(`${BASE_URL}/api/public/workflows/upload/invalid-token`, {
        method: "POST",
      });
      // 401 with "Invalid, expired, or already used token" is OK (token validation, not session)
      const json = (await response.json()) as { error?: string };
      if (response.status === 401) {
        expect(json.error.message).toContain("token");
      }
    });
  });
});
