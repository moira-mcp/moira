/**
 * Self-host auth behavior (HTTP, real container).
 *
 * Proves the Step 3 self-host branch end-to-end against a running container:
 *   - open registration is CLOSED (REGISTRATION_DISABLED)
 *   - the admin logs in WITHOUT legal consents
 *   - a requireVerifiedAuth route (/api/tokens) issues a token even though the
 *     self-host admin's email path has no verification gate (the MCP blocker fix)
 *
 * The dev/test container is normally booted in saas mode (so the broad API suite
 * asserts saas enforcement). This spec auto-detects the running container's mode
 * by probing registration behavior: if open registration is closed it runs the
 * self-host assertions; in saas it asserts the saas counterpart (consents
 * enforced) so the spec is meaningful in BOTH container modes rather than a no-op.
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

type Mode = "self-host" | "saas";

/** Detect the container's deployment mode from sign-up behavior. */
async function detectMode(): Promise<Mode> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `mode-probe-${Date.now()}@example.com`,
      password: "testpassword123",
      name: "Mode Probe",
      // no consent fields
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { code?: string };
  // self-host closes registration; saas enforces consent on the same request.
  if (res.status === 403 && json.code === "REGISTRATION_DISABLED") return "self-host";
  return "saas";
}

describe("Self-host auth behavior", () => {
  let mode: Mode;

  beforeAll(async () => {
    mode = await detectMode();
  });

  test("open registration is closed in self-host (enforced with consent in saas)", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `selfhost-reg-${Date.now()}@example.com`,
        password: "testpassword123",
        name: "Reg User",
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { code?: string };

    if (mode === "self-host") {
      expect(res.status).toBe(403);
      expect(json.code).toBe("REGISTRATION_DISABLED");
    } else {
      // saas: same request (no consents) is rejected for missing consent, not closed.
      expect(res.status).toBe(400);
      expect(json.code).toBe("TERMS_NOT_ACCEPTED");
    }
  });

  test("admin can issue an API token on a requireVerifiedAuth route", async () => {
    const { email, password } = getAdminCredentials();

    const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers.get("set-cookie") || "").split(";")[0];
    expect(cookie).toBeTruthy();

    const tokenRes = await fetch(`${BASE_URL}/api/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: `selfhost-auth-token-${Date.now()}` }),
    });

    // /api/tokens is behind requireVerifiedAuth. In self-host the email gate is
    // off so issuance succeeds regardless of verification; in saas the admin is
    // verified, so it also succeeds. Either way: a real token must be returned.
    expect(tokenRes.status).toBe(201);
    const json = (await tokenRes.json()) as { success?: boolean; data?: { token?: string } };
    expect(json.success).toBe(true);
    expect(json.data?.token).toMatch(/^moira_/);

    // Cleanup
    if (json.data && "id" in (json.data as Record<string, unknown>)) {
      const id = (json.data as { id: string }).id;
      await fetch(`${BASE_URL}/api/tokens/${id}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
    }
  });
});
