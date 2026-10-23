/**
 * API Authorization Tests
 * Verifies that protected endpoints return 401 without authentication
 * and public endpoints are accessible without authentication.
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

    test("GET /api/executions/:id returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/executions/test-id`);
      expect(response.status).toBe(401);
    });

    test("POST /api/executions/:id/stop returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/executions/test-id/stop`, {
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
    test("GET /api/user/me returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/user/me`);
      expect(response.status).toBe(401);
    });

    test("GET /api/user/profile returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/user/profile`);
      expect(response.status).toBe(401);
    });

    test("PATCH /api/user/profile returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/user/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
    });

    test("GET /api/user/handle returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/user/handle`);
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
    test("GET /api/stats/summary returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/stats/summary`);
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
    test("POST /api/notifications/channels/:channelId/test returns 401 without auth", async () => {
      const response = await fetch(`${BASE_URL}/api/notifications/channels/test-channel/test`, {
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
    test("POST /api/auth/sign-in/email rejects invalid credentials", async () => {
      const response = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@test.com", password: "test" }),
      });
      // 401 here is credential validation, not "session required"
      expect(response.status).toBe(401);
      const json = (await response.json()) as { code?: string };
      expect(json.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    });

    test("GET /api/auth/get-session returns no session without cookies", async () => {
      const response = await fetch(`${BASE_URL}/api/auth/get-session`);
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
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
      const body = (await response.json()) as { code?: string };
      if (response.status === 403) {
        expect(body.code).toBe("REGISTRATION_DISABLED");
      } else {
        expect(response.status).toBe(400);
        expect([
          "INVALID_EMAIL",
          "VALIDATION_ERROR",
          "TERMS_NOT_ACCEPTED",
          "RESIDENCY_NOT_CONFIRMED",
        ]).toContain(body.code);
      }
    });

    // Token-based workflow access
    test("POST /api/public/workflows/upload/:token validates token, not session", async () => {
      const response = await fetch(`${BASE_URL}/api/public/workflows/upload/invalid-token`, {
        method: "POST",
      });
      // 401 here is token validation ("Invalid, expired, or already used token"), not session
      expect(response.status).toBe(401);
      const json = (await response.json()) as { error: { message: string } };
      expect(json.error.message).toContain("token");
    });
  });
});
