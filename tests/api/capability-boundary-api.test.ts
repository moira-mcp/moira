/**
 * Real HTTP evidence for the self-host administration capability boundary.
 *
 * The target container for this suite must report deploymentMode=self-host.
 * Every disabled request is made with a real administrator session so a 403
 * distinguishes capability denial from authentication or role denial.
 */

import { beforeAll, describe, expect, test } from "@jest/globals";
import { getAdminCredentials, getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

let adminCookie: string;

async function adminRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Cookie: adminCookie,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

async function expectCapabilityDenied(
  path: string,
  expectedCapability: string,
  init: RequestInit = {},
): Promise<void> {
  const response = await adminRequest(path, init);
  expect(response.status).toBe(403);
  const body = (await response.json()) as {
    success: boolean;
    error: { code: string; details?: { capability?: string } };
  };
  expect(body.success).toBe(false);
  expect(body.error.code).toBe("ACCESS_DENIED");
  expect(body.error.details?.capability).toBe(expectedCapability);
}

beforeAll(async () => {
  const featuresResponse = await fetch(`${BASE_URL}/api/features`);
  const features = (await featuresResponse.json()) as {
    data: {
      deploymentMode: string;
      features: Record<string, boolean>;
    };
  };
  expect(features.data.deploymentMode).toBe("self-host");
  expect(features.data.features).toMatchObject({
    accountApproval: true,
    userManagement: true,
    multiUserAdmin: false,
    adminAnalytics: false,
    adminOperations: false,
    operationsDevelopment: false,
  });

  const login = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  expect(login.status).toBe(200);
  adminCookie = login.headers.get("set-cookie") ?? "";
  expect(adminCookie).toBeTruthy();
});

describe("self-host capability authorization", () => {
  test("returns only deployment-neutral administrator status", async () => {
    const response = await adminRequest("/api/admin/system-status");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty("totalDefinitions");
    expect(body.data).toHaveProperty("systemHealth.workflowReconciliation");
    expect(body.data).not.toHaveProperty("totalWorkflows");
    expect(body.data).not.toHaveProperty("totalExecutions");
    expect(body.data).not.toHaveProperty("activeExecutions");
    expect(body.data).not.toHaveProperty("recentActivity");
  });

  test.each([
    ["/api/admin/stats", "adminAnalytics"],
    ["/api/admin/STATS", "adminAnalytics"],
    ["/api/admin/stats/", "adminAnalytics"],
    ["/api/admin/analytics/overview", "adminAnalytics"],
    ["/api/admin/analytics/executions", "adminAnalytics"],
    ["/api/admin/analytics/top-workflows", "adminAnalytics"],
    ["/api/admin/analytics/users", "adminAnalytics"],
    ["/api/admin/analytics/audit-summary", "adminAnalytics"],
    ["/api/admin/analytics/workflow-quality/not-a-workflow", "adminAnalytics"],
    ["/api/admin/analytics/conversion-funnel", "adminAnalytics"],
    ["/api/admin/analytics/engagement", "adminAnalytics"],
    ["/api/admin/analytics/operational", "adminOperations"],
    ["/api/admin/analytics/OPERATIONAL", "adminOperations"],
  ] as const)(
    "denies mounted analytics or operations route %s with %s",
    async (path, capability) => {
      await expectCapabilityDenied(path, capability);
    },
  );

  test.each([
    ["POST", "/api/admin/monitoring-test/error", { message: "must not be logged" }],
    ["POST", "/api/admin/monitoring-test/internal-error-test", {}],
    ["POST", "/api/admin/monitoring-test/slow", { delayMs: 10_000 }],
    ["POST", "/api/admin/monitoring-test/log-levels", { levels: ["error"] }],
    ["POST", "/api/admin/monitoring-test/workflow", { workflowId: "not-a-workflow" }],
    ["POST", "/api/admin/monitoring-test/mcp-call", { toolName: "must-not-run" }],
    ["GET", "/api/admin/monitoring-test/status", undefined],
  ] as const)(
    "denies monitoring side effect %s %s before its handler",
    async (method, path, body) => {
      await expectCapabilityDenied(path, "operationsDevelopment", {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
  );

  test.each([
    ["GET", "/api/admin/workflows", undefined],
    ["GET", "/api/admin/WORKFLOWS", undefined],
    ["GET", "/api/admin/workflows/deleted", undefined],
    ["POST", "/api/admin/workflows/not-a-workflow/restore", {}],
    ["DELETE", "/api/admin/workflows/not-a-workflow/hard-delete", undefined],
    ["GET", "/api/admin/executions", undefined],
    ["GET", "/api/admin/EXECUTIONS", undefined],
    ["GET", "/api/admin/executions/not-an-execution", undefined],
    ["GET", "/api/admin/executions/not-an-execution/context", undefined],
    ["PUT", "/api/admin/executions/not-an-execution/context", { variables: {} }],
    ["GET", "/api/admin/executions/not-an-execution/locks", undefined],
    ["POST", "/api/admin/executions/not-an-execution/locks/not-a-lock/unlock", {}],
    ["GET", "/api/admin/artifacts", undefined],
    ["GET", "/api/admin/ARTIFACTS", undefined],
    ["GET", "/api/admin/artifacts/stats", undefined],
    ["DELETE", "/api/admin/artifacts/not-an-artifact", undefined],
    ["GET", "/api/admin/artifacts/reported", undefined],
    ["POST", "/api/admin/artifacts/not-an-artifact/takedown", { reason: "must not run" }],
    ["POST", "/api/admin/users/not-a-user/artifacts/takedown", { reason: "must not run" }],
    ["POST", "/api/admin/users/not-a-user/ARTIFACTS/TAKEDOWN", { reason: "must not run" }],
    ["GET", "/api/admin/users/not-a-user/artifact-quota", undefined],
    ["GET", "/api/admin/users/not-a-user/ARTIFACT-QUOTA", undefined],
    ["PUT", "/api/admin/users/not-a-user/artifact-quota", { quotaMb: 1, maxFiles: 1 }],
    ["DELETE", "/api/admin/sessions/all", undefined],
    ["DELETE", "/api/admin/SESSIONS/ALL", undefined],
  ] as const)("denies broad cross-user route %s %s", async (method, path, body) => {
    await expectCapabilityDenied(path, "multiUserAdmin", {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  });

  test("keeps ordinary-user approval available", async () => {
    const email = `capability-approval-${Date.now()}@example.com`;
    const signup = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "CapabilityBoundary123!",
        name: "Capability boundary user",
      }),
    });
    expect(signup.status).toBe(200);
    const signupBody = (await signup.json()) as { user: { id: string } };

    try {
      const approval = await adminRequest(`/api/admin/users/${signupBody.user.id}/approve`, {
        method: "POST",
      });
      expect(approval.status).toBe(200);
      const approvalBody = (await approval.json()) as { success: boolean };
      expect(approvalBody.success).toBe(true);
    } finally {
      await adminRequest(`/api/admin/users/${signupBody.user.id}`, { method: "DELETE" });
    }
  });
});
