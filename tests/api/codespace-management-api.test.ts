import { beforeAll, describe, expect, test } from "@jest/globals";
import { dockerExecSync } from "../utils/docker-command.js";
import { createTestUserViaApi } from "../utils/mcp-auth.js";
import { getAdminCredentials, getTestBaseUrl } from "../utils/test-config.js";

const baseUrl = getTestBaseUrl();
let adminCookie = "";
let userCookie = "";

async function signIn(credentials: { email: string; password: string }): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie") ?? "";
}

beforeAll(async () => {
  adminCookie = await signIn(getAdminCredentials());
  const user = {
    email: `codespace-mgmt-${Date.now()}@example.test`,
    password: "CodespaceMgmt!Pass123",
    name: "Codespace Management Probe",
  };
  // Shared helper: legal consents, email verification and, only where the deployment
  // mode gates it, administrator approval.
  await createTestUserViaApi(baseUrl, user.email, user.password, user.name);
  userCookie = await signIn({ email: user.email, password: user.password });
});

describe("codespace management and controls on a default-disabled installation", () => {
  test("lists a disabled readiness decision with no codespaces and no secrets", async () => {
    const response = await fetch(`${baseUrl}/api/integrations/github/codespaces`, {
      headers: { Cookie: userCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      readiness: {
        state: "disabled",
        reason: "NOT_CONFIGURED",
        configuration: "absent",
        connector: { state: "not_applicable" },
      },
      connection: { state: "disabled" },
      repositories: [],
      codespaces: [],
    });
    expect(JSON.stringify(body)).not.toMatch(/accessToken|refreshToken|clientSecret|vaultKey/);
  });

  test("refuses creation and lifecycle before any provider contact", async () => {
    const create = await fetch(`${baseUrl}/api/integrations/github/codespaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ repository_id: "162", ref: "main" }),
    });
    expect(create.status).toBe(503);
    const body = await create.json();
    expect(body.error.code).toBe("CODESPACE_NOT_CONFIGURED");
    expect(body.settings_url).toMatch(/\/settings#integrations-github$/);

    const unauthenticated = await fetch(`${baseUrl}/api/integrations/github/codespaces`);
    expect(unauthenticated.status).toBe(401);
  });

  test("exposes the same readiness through backend health and admin system status", async () => {
    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody.data.services.codespaces).toBe(true);
    // Unauthenticated health carries only the public decision: no controls, backlog or usage.
    expect(healthBody.data.codespaces).toEqual({
      state: "disabled",
      provider: "github-codespaces",
      degraded: false,
    });

    const status = await fetch(`${baseUrl}/api/admin/system-status`, {
      headers: { Cookie: adminCookie },
    });
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.data.systemHealth.codespaces).toMatchObject({ state: "disabled" });
    expect(statusBody.data.systemHealth.backendStatus).toBe("healthy");
  });

  test("exposes the codespace gauges on the internal metrics endpoint", async () => {
    const metrics = dockerExecSync(["curl", "-s", "http://localhost:9090/metrics"]);
    expect(metrics).toContain('moira_codespace_ready{provider="github-codespaces"} 0');
    expect(metrics).toContain(
      'moira_codespace_connector_available{provider="github-codespaces"} 0',
    );
    expect(metrics).toMatch(/moira_codespace_reconciliation_due\{kind="resource"\} \d+/);
    expect(metrics).toMatch(/moira_codespace_active\{kind="operation"\} \d+/);
    expect(metrics).toMatch(/moira_codespace_transfer_live_bytes \d+/);
  });

  test("keeps kill switches administrator-only and fail-closed while unconfigured", async () => {
    const forbidden = await fetch(`${baseUrl}/api/admin/codespaces`, {
      headers: { Cookie: userCookie },
    });
    expect(forbidden.status).toBe(403);

    const controls = await fetch(`${baseUrl}/api/admin/codespaces`, {
      headers: { Cookie: adminCookie },
    });
    expect(controls.status).toBe(200);
    const controlsBody = await controls.json();
    expect(controlsBody.data.controls).toEqual([
      expect.objectContaining({ scope: "global", disabled: false }),
      expect.objectContaining({ scope: "provider:github-codespaces", disabled: false }),
    ]);

    const update = await fetch(`${baseUrl}/api/admin/codespaces/controls/global`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ disabled: true, reason: "api probe" }),
    });
    expect(update.status).toBe(503);
    await expect(update.json()).resolves.toMatchObject({
      error: { code: "CODESPACE_NOT_CONFIGURED" },
    });
  });
});
