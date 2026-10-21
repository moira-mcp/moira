import { beforeAll, describe, expect, test } from "@jest/globals";
import { encodeReference } from "@mcp-moira/shared/workspace-references";
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

describe("codespace management on a default-disabled installation", () => {
  test("lists a disabled readiness decision with no codespaces and no secrets", async () => {
    const response = await fetch(`${baseUrl}/api/integrations/github/codespaces`, {
      headers: { Cookie: userCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      readiness: {
        state: "disabled",
        reason: null,
        configuration: "absent",
      },
      connection: { state: "disabled" },
      repositories: [],
      codespaces: [],
      provider_billing: "unavailable",
    });
    expect(body.data).not.toHaveProperty("limits");
    expect(JSON.stringify(body)).not.toMatch(/accessToken|refreshToken|clientSecret|vaultKey/);
  });

  test("refuses an unowned controller and rejects legacy mutation inputs", async () => {
    const create = await fetch(
      `${baseUrl}/api/integrations/github/codespaces/operations/workspace_create`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userCookie },
        body: JSON.stringify({
          target: encodeReference("target", {
            provider: "github-codespaces",
            repositoryId: "162",
            controller: {
              deviceId: "00000000-0000-4000-8000-000000000001",
              connectionId: "00000000-0000-4000-8000-000000000002",
            },
          }),
          branch: "main",
        }),
      },
    );
    expect(create.status).toBe(401);
    const body = await create.json();
    expect(body.error.code).toBe("LOCAL_UNAUTHORIZED");

    const legacy = await fetch(`${baseUrl}/api/integrations/github/codespaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ repository_id: "162", ref: "main" }),
    });
    expect(legacy.status).toBe(404);

    const invalid = await fetch(
      `${baseUrl}/api/integrations/github/codespaces/operations/workspace_create`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userCookie },
        body: JSON.stringify({ repository_id: "162", ref: "main", request_id: "manual-id" }),
      },
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("CODESPACE_RESOURCE_INVALID");

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

  test("reports connection and refusal metrics without obsolete cloud execution gauges", async () => {
    const metrics = dockerExecSync(["curl", "-s", "http://localhost:9090/metrics"]);
    expect(metrics).toContain("moira_codespace_connection_events_total");
    expect(metrics).toContain("moira_codespace_rejections_total");
    expect(metrics).not.toMatch(
      /moira_codespace_(ready|connector_available|reconciliation_due|active)\b/,
    );
  });

  test("keeps configuration observation administrator-only and has no mass-stop mutation route", async () => {
    const forbidden = await fetch(`${baseUrl}/api/admin/codespaces`, {
      headers: { Cookie: userCookie },
    });
    expect(forbidden.status).toBe(403);

    const controls = await fetch(`${baseUrl}/api/admin/codespaces`, {
      headers: { Cookie: adminCookie },
    });
    expect(controls.status).toBe(200);
    const controlsBody = await controls.json();
    expect(controlsBody.data).not.toHaveProperty("controls");

    const update = await fetch(`${baseUrl}/api/admin/codespaces/controls/global`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ disabled: true, reason: "api probe" }),
    });
    expect(update.status).toBe(404);
  });
});
