/**
 * Admin Analytics API Integration Tests
 * Tests analytics endpoints for audit data aggregation
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { getTestBaseUrl, isExternalTarget } from "../utils/test-config.js";
import { execSqliteInDocker } from "../utils/docker-command.js";
import {
  createTestUserViaApi,
  formatSessionCookie,
  getAdminSessionCookie,
  signInUser,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
// Only this fixture group writes historical rows directly to an isolated local Docker database.
// Remote scripts still run the HTTP analytics contract tests below, without synthetic SQL writes.
const localFixtureTarget =
  !isExternalTarget() &&
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE_URL).hostname) &&
  !process.env.REMOTE_DOCKER_CONTEXT;
const describeLocalFixtures = localFixtureTarget ? describe : describe.skip;

let adminCookie: string;
let normalUserCookie: string;

describe("Admin Analytics API", () => {
  beforeAll(async () => {
    adminCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));

    // Create and login as normal user for access denial tests
    const normalUserEmail = `analytics-test-${Date.now()}@example.com`;
    const normalUserPassword = "TestPassword123!";
    await createTestUserViaApi(
      BASE_URL,
      normalUserEmail,
      normalUserPassword,
      "Analytics Test User",
    );
    normalUserCookie = formatSessionCookie(
      BASE_URL,
      await signInUser(BASE_URL, normalUserEmail, normalUserPassword),
    );
  });

  describeLocalFixtures(
    "intentional stops remain separate from genuine completion outcomes (local Docker fixtures)",
    () => {
      let workflowId: string;
      let ownerId: string;
      const executionIds: string[] = [];
      const createdAt = Date.parse("2001-01-02T23:59:59.000Z");

      async function analytics(path: string) {
        const response = await fetch(`${BASE_URL}/api/admin/analytics/${path}`, {
          headers: { Cookie: adminCookie },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as any;
        expect(body.success).toBe(true);
        return body.data;
      }

      function seed(
        state: string,
        duration: number | null,
        stopReason: string | null,
        errorType?: string,
        startedAt = createdAt,
      ) {
        const id = randomUUID();
        executionIds.push(id);
        const errors = errorType
          ? [{ timestamp: startedAt, nodeId: "start", errorType, message: "Recorded step fact" }]
          : [];
        // These are owned synthetic rows in the existing Docker fixture database. Production
        // mutations cannot reproduce legacy states or independently chosen historical cohorts.
        const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
        execSqliteInDocker(
          `INSERT INTO workflowExecution
          (executionId, workflowId, userId, state, context, errors, createdAt, updatedAt, completedAt, stopReason)
         VALUES (${quote(id)}, ${quote(workflowId)}, ${quote(ownerId)}, ${quote(state)},
          ${quote(JSON.stringify({ variables: {}, nodeStates: {}, executionId: id, workflowId, userId: ownerId }))},
          ${quote(JSON.stringify(errors))}, ${startedAt}, ${startedAt},
          ${duration === null ? "NULL" : startedAt + duration},
          ${stopReason === null ? "NULL" : quote(stopReason)});`,
        );
        return id;
      }

      beforeAll(async () => {
        if (
          !process.env.DOCKER_CONTAINER_NAME ||
          new URL(BASE_URL).port !== process.env.DOCKER_PORT
        ) {
          throw new Error("Local HTTP target and explicit Docker fixture environment must agree");
        }
        const response = await fetch(`${BASE_URL}/api/workflows`, {
          method: "POST",
          headers: { Cookie: adminCookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            visibility: "private",
            workflow: {
              metadata: {
                name: `Outcome analytics ${randomUUID()}`,
                version: "1.0.0",
                description: "Controlled completion and stop analytics",
              },
              nodes: [
                { id: "start", type: "start", connections: { default: "end" } },
                { id: "end", type: "end" },
              ],
            },
          }),
        });
        expect(response.status).toBe(200);
        workflowId = ((await response.json()) as any).data.workflowId;
        ownerId = execSqliteInDocker(`SELECT userId FROM workflow WHERE id = '${workflowId}';`);
        expect(ownerId.length).toBeGreaterThan(0);
      });

      afterEach(() => {
        for (const id of executionIds.splice(0)) {
          execSqliteInDocker(`DELETE FROM workflowExecution WHERE executionId = '${id}';`);
        }
      });

      afterAll(async () => {
        if (workflowId) {
          const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
            method: "DELETE",
            headers: { Cookie: adminCookie },
          });
          expect(response.status).toBe(200);
        }
      });

      test("all five consumers exclude stops with and without refusals while retaining starts and genuine durations", async () => {
        const beforeOverview = await analytics("overview?range=all");
        const beforeExecutions = await analytics("executions?range=all");
        // Weight the new durations against the native contributing count and unrounded sum;
        // completed totals can include runs without a duration, and the API average is rounded.
        const [durationCountBefore, durationSumBefore] = execSqliteInDocker(
          "SELECT COUNT(*), COALESCE(SUM(completedAt - createdAt), 0) FROM workflowExecution WHERE state = 'completed' AND stopReason IS NULL AND completedAt IS NOT NULL AND createdAt IS NOT NULL AND completedAt != 0 AND createdAt != 0;",
        )
          .split("|")
          .map(Number);
        const beforeOperational = await analytics("operational?range=all&granularity=daily");
        const completedMetricBefore = beforeOperational.metrics.find(
          (metric: any) => metric.name === "workflows_completed_per_day",
        );
        const startedMetricBefore = beforeOperational.metrics.find(
          (metric: any) => metric.name === "workflows_started_per_day",
        );
        const beforeDay = beforeExecutions.overTime.find(
          (point: any) => point.date === "2001-01-02",
        ) ?? { count: 0, completed: 0, failed: 0, stopped: 0 };

        seed("completed", 1000, null, "degradation");
        seed("completed", 3000, null, "handler");
        seed("completed", 100_000, "Scope withdrawn");
        seed("completed", 200_000, "", "validation");
        seed("running", null, "Historical intentional stop");
        seed("running", null, null);
        seed("failed", 500_000, null, "system");

        const overview = await analytics("overview?range=all");
        expect(overview.totalExecutions).toBe(beforeOverview.totalExecutions + 7);
        expect(overview.activeExecutions).toBe(beforeOverview.activeExecutions + 1);
        expect(overview.completedExecutions).toBe(beforeOverview.completedExecutions + 2);
        expect(overview.failedExecutions).toBe(beforeOverview.failedExecutions + 1);
        expect(overview.stoppedExecutions).toBe(beforeOverview.stoppedExecutions + 3);

        const executions = await analytics("executions?range=all");
        expect(executions.total).toBe(beforeExecutions.total + 7);
        expect(executions.active).toBe(beforeExecutions.active + 1);
        expect(executions.completed).toBe(beforeExecutions.completed + 2);
        expect(executions.failed).toBe(beforeExecutions.failed + 1);
        expect(executions.stopped).toBe(beforeExecutions.stopped + 3);
        expect(executions.avgDurationMs).toBe(
          Math.round((durationSumBefore + 4000) / (durationCountBefore + 2)),
        );
        expect(executions.successRate).toBe(
          Math.round(
            ((beforeExecutions.completed - beforeExecutions.failed + 1) /
              (beforeExecutions.completed + 2)) *
              10000,
          ) / 100,
        );
        expect(executions.byWorkflow.find((row: any) => row.workflowId === workflowId)).toEqual({
          workflowId,
          count: 7,
          completed: 2,
          failed: 1,
          stopped: 3,
        });
        expect(executions.overTime.find((row: any) => row.date === "2001-01-02")).toEqual({
          date: "2001-01-02",
          count: beforeDay.count + 7,
          completed: beforeDay.completed + 2,
          failed: beforeDay.failed + 1,
          stopped: beforeDay.stopped + 3,
        });

        const top = await analytics("top-workflows?range=all&limit=100000");
        expect(top.workflows.find((row: any) => row.workflowId === workflowId)).toEqual(
          expect.objectContaining({
            executionCount: 7,
            completedCount: 2,
            failedCount: 1,
            stoppedCount: 3,
            successRate: 50,
            avgDurationMs: 2000,
          }),
        );
        const quality = await analytics(`workflow-quality/${workflowId}?range=all`);
        expect(quality).toEqual(
          expect.objectContaining({
            totalExecutions: 7,
            completedExecutions: 2,
            stoppedExecutions: 3,
            completionRate: 28.57,
          }),
        );

        const operational = await analytics("operational?range=all&granularity=daily");
        expect(operational.metrics.map((metric: any) => metric.name)).toEqual([
          "unique_users_per_day",
          "total_calls_per_day",
          "calls_per_second",
          "workflows_started_per_day",
          "workflows_completed_per_day",
          "mcp_calls_per_second",
        ]);
        const completedMetric = operational.metrics.find(
          (metric: any) => metric.name === "workflows_completed_per_day",
        );
        const startedMetric = operational.metrics.find(
          (metric: any) => metric.name === "workflows_started_per_day",
        );
        expect(completedMetric.available).toBe(true);
        expect(completedMetric.value).toBe(completedMetricBefore.value + 2);
        expect(startedMetric.available).toBe(true);
        expect(startedMetric.value).toBe(startedMetricBefore.value + 7);
        const previousCompletedDay =
          completedMetricBefore.timeSeries.find((point: any) => point.date === "2001-01-03")
            ?.value ?? 0;
        expect(
          completedMetric.timeSeries.find((point: any) => point.date === "2001-01-03")?.value,
        ).toBe(previousCompletedDay + 2);
        const previousStartedDay =
          startedMetricBefore.timeSeries.find((point: any) => point.date === "2001-01-02")?.value ??
          0;
        expect(
          startedMetric.timeSeries.find((point: any) => point.date === "2001-01-02")?.value,
        ).toBe(previousStartedDay + 7);
        expect(
          execSqliteInDocker(
            `SELECT COUNT(*) FROM workflowExecution WHERE workflowId = '${workflowId}' AND completedAt IS NOT NULL;`,
          ),
        ).toBe("5");
      });

      test("stopped-only work has zero genuine completions, refusals, success and completed duration", async () => {
        seed("completed", 100_000, "Stopped after refusal", "handler");
        const top = await analytics("top-workflows?range=all&limit=100000");
        expect(top.workflows.find((row: any) => row.workflowId === workflowId)).toEqual(
          expect.objectContaining({
            executionCount: 1,
            completedCount: 0,
            failedCount: 0,
            stoppedCount: 1,
            successRate: 0,
            avgDurationMs: 0,
          }),
        );
        const quality = await analytics(`workflow-quality/${workflowId}?range=all`);
        expect(quality).toEqual(
          expect.objectContaining({
            totalExecutions: 1,
            completedExecutions: 0,
            stoppedExecutions: 1,
            completionRate: 0,
          }),
        );
      });

      test("completion-time operational cohorts include an old start completed recently without changing creation-time analytics", async () => {
        const beforeExecutions = await analytics("executions?range=week");
        const beforeOperational = await analytics("operational?range=week&granularity=daily");
        const completedBefore = beforeOperational.metrics.find(
          (metric: any) => metric.name === "workflows_completed_per_day",
        );
        const startedBefore = beforeOperational.metrics.find(
          (metric: any) => metric.name === "workflows_started_per_day",
        );
        const completedAt = Date.now() - 60_000;
        const id = seed("completed", completedAt - createdAt, null);
        seed("completed", completedAt - createdAt, "No longer needed", "handler");

        const executions = await analytics("executions?range=week");
        expect(executions.total).toBe(beforeExecutions.total);
        expect(executions.completed).toBe(beforeExecutions.completed);
        expect(
          executions.byWorkflow.find((row: any) => row.workflowId === workflowId),
        ).toBeUndefined();
        const quality = await analytics(`workflow-quality/${workflowId}?range=week`);
        expect(quality).toEqual(
          expect.objectContaining({
            totalExecutions: 0,
            completedExecutions: 0,
            stoppedExecutions: 0,
            completionRate: 0,
          }),
        );
        const operational = await analytics("operational?range=week&granularity=daily");
        const completed = operational.metrics.find(
          (metric: any) => metric.name === "workflows_completed_per_day",
        );
        const started = operational.metrics.find(
          (metric: any) => metric.name === "workflows_started_per_day",
        );
        expect(completed.available).toBe(true);
        expect(completed.value).toBe(completedBefore.value + 1);
        expect(started.value).toBe(startedBefore.value);
        const day = new Date(completedAt).toISOString().slice(0, 10);
        const previous =
          completedBefore.timeSeries.find((point: any) => point.date === day)?.value ?? 0;
        expect(completed.timeSeries.find((point: any) => point.date === day)?.value).toBe(
          previous + 1,
        );
        expect(
          execSqliteInDocker(
            `SELECT createdAt || '|' || completedAt FROM workflowExecution WHERE executionId = '${id}';`,
          ),
        ).toBe(`${createdAt}|${completedAt}`);
      });
    },
  );

  describe("GET /api/admin/analytics/overview", () => {
    test("returns overview statistics for admin", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/overview`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("totalUsers");
      expect(json.data).toHaveProperty("totalWorkflows");
      expect(json.data).toHaveProperty("totalExecutions");
      expect(json.data).toHaveProperty("activeExecutions");
      expect(json.data).toHaveProperty("completedExecutions");
      expect(json.data).toHaveProperty("failedExecutions");
      expect(json.data).toHaveProperty("timeRange");

      // Values should be non-negative numbers
      expect(typeof json.data.totalUsers).toBe("number");
      expect(json.data.totalUsers).toBeGreaterThanOrEqual(0);
    });

    test("supports time range filter", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/overview?range=week`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.timeRange).toBe("week");
    });

    test("denies access to non-admin users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/overview`, {
        headers: { Cookie: normalUserCookie },
      });

      expect(response.status).toBe(403);
    });

    test("denies access to unauthenticated users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/overview`);

      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/analytics/executions", () => {
    test("returns execution statistics for admin", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/executions`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("total");
      expect(json.data).toHaveProperty("completed");
      expect(json.data).toHaveProperty("failed");
      expect(json.data).toHaveProperty("active");
      expect(json.data).toHaveProperty("successRate");
      expect(json.data).toHaveProperty("avgDurationMs");
      expect(json.data).toHaveProperty("byWorkflow");
      expect(json.data).toHaveProperty("overTime");
      expect(json.data).toHaveProperty("timeRange");

      // byWorkflow should be an array
      expect(Array.isArray(json.data.byWorkflow)).toBe(true);
      // overTime should be an array
      expect(Array.isArray(json.data.overTime)).toBe(true);
    });

    test("supports time range filter", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/executions?range=today`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.data.timeRange).toBe("today");
    });

    test("denies access to non-admin users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/executions`, {
        headers: { Cookie: normalUserCookie },
      });

      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/admin/analytics/top-workflows", () => {
    test("returns top workflows for admin", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/top-workflows`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("workflows");
      expect(json.data).toHaveProperty("timeRange");

      expect(Array.isArray(json.data.workflows)).toBe(true);

      // If there are workflows, check structure
      if (json.data.workflows.length > 0) {
        const firstWorkflow = json.data.workflows[0];
        expect(firstWorkflow).toHaveProperty("workflowId");
        expect(firstWorkflow).toHaveProperty("workflowName");
        expect(firstWorkflow).toHaveProperty("executionCount");
        expect(firstWorkflow).toHaveProperty("completedCount");
        expect(firstWorkflow).toHaveProperty("failedCount");
        expect(firstWorkflow).toHaveProperty("successRate");
        expect(firstWorkflow).toHaveProperty("avgDurationMs");
      }
    });

    test("supports limit parameter", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/top-workflows?limit=5`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.data.workflows.length).toBeLessThanOrEqual(5);
    });

    test("denies access to non-admin users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/top-workflows`, {
        headers: { Cookie: normalUserCookie },
      });

      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/admin/analytics/users", () => {
    test("returns user statistics for admin", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/users`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("totalUsers");
      expect(json.data).toHaveProperty("activeUsers");
      expect(json.data).toHaveProperty("newUsers");
      expect(json.data).toHaveProperty("topUsers");
      expect(json.data).toHaveProperty("timeRange");

      expect(typeof json.data.totalUsers).toBe("number");
      expect(json.data.totalUsers).toBeGreaterThanOrEqual(1); // At least admin exists
      expect(Array.isArray(json.data.topUsers)).toBe(true);
    });

    test("denies access to non-admin users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/users`, {
        headers: { Cookie: normalUserCookie },
      });

      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/admin/analytics/audit-summary", () => {
    test("returns audit log summary for admin", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/audit-summary`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("byAction");
      expect(json.data).toHaveProperty("byCategory");
      expect(json.data).toHaveProperty("activityTrend");
      expect(json.data).toHaveProperty("totalEntries");
      expect(json.data).toHaveProperty("timeRange");

      expect(Array.isArray(json.data.byAction)).toBe(true);
      expect(Array.isArray(json.data.byCategory)).toBe(true);
      expect(Array.isArray(json.data.activityTrend)).toBe(true);

      // Should have at least some audit entries from login
      expect(json.data.totalEntries).toBeGreaterThanOrEqual(0);
    });

    test("supports time range filter", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/audit-summary?range=today`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.data.timeRange).toBe("today");
    });

    test("denies access to non-admin users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/audit-summary`, {
        headers: { Cookie: normalUserCookie },
      });

      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/admin/analytics/workflow-quality/:workflowId", () => {
    let testWorkflowId: string;

    beforeAll(async () => {
      // Create a test workflow for quality analytics tests
      const createResponse = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          visibility: "public",
          workflow: {
            metadata: {
              name: "Analytics Quality Test Workflow",
              version: "1.0.0",
              description: "Test workflow for quality analytics",
            },
            nodes: [
              { type: "start", id: "start", connections: { default: "end" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(createResponse.status).toBe(200);
      const createData = (await createResponse.json()) as any;
      testWorkflowId = createData.data.workflowId;
    });

    afterAll(async () => {
      // Cleanup
      if (testWorkflowId) {
        try {
          await fetch(`${BASE_URL}/api/workflows/${testWorkflowId}`, {
            method: "DELETE",
            headers: { Cookie: adminCookie },
          });
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    test("returns workflow quality analytics for existing workflow", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/analytics/workflow-quality/${testWorkflowId}`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("workflowId", testWorkflowId);
      expect(json.data).toHaveProperty("workflowName");
      expect(json.data).toHaveProperty("totalNodes");
      expect(json.data).toHaveProperty("completionRate");
      expect(json.data).toHaveProperty("totalExecutions");
      expect(json.data).toHaveProperty("completedExecutions");
      expect(json.data).toHaveProperty("hotSteps");
      expect(json.data).toHaveProperty("deadSteps");
      expect(json.data).toHaveProperty("problematicSteps");
      expect(json.data).toHaveProperty("timeRange");

      // Arrays
      expect(Array.isArray(json.data.hotSteps)).toBe(true);
      expect(Array.isArray(json.data.deadSteps)).toBe(true);
      expect(Array.isArray(json.data.problematicSteps)).toBe(true);

      // Numbers
      expect(typeof json.data.totalNodes).toBe("number");
      expect(json.data.totalNodes).toBeGreaterThan(0);
      expect(typeof json.data.completionRate).toBe("number");
    });

    test("returns 404 for non-existent workflow", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/analytics/workflow-quality/non-existent-workflow-xyz`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(404);
      const json = (await response.json()) as any;
      expect(json.success).toBe(false);
    });

    test("supports time range filter", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/analytics/workflow-quality/${testWorkflowId}?range=week`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.data.timeRange).toBe("week");
    });

    test("denies access to non-admin users", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/analytics/workflow-quality/${testWorkflowId}`,
        {
          headers: { Cookie: normalUserCookie },
        },
      );

      expect(response.status).toBe(403);
    });

    test("denies access to unauthenticated users", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/analytics/workflow-quality/${testWorkflowId}`,
      );

      expect(response.status).toBe(401);
    });

    test("hotSteps have correct structure when present", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/analytics/workflow-quality/${testWorkflowId}`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;

      if (json.data.hotSteps.length > 0) {
        const hotStep = json.data.hotSteps[0];
        expect(hotStep).toHaveProperty("nodeId");
        expect(hotStep).toHaveProperty("executionCount");
        expect(hotStep).toHaveProperty("nodeName");
        expect(typeof hotStep.executionCount).toBe("number");
      }
    });

    test("deadSteps have correct structure when present", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/analytics/workflow-quality/${testWorkflowId}`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;

      if (json.data.deadSteps.length > 0) {
        const deadStep = json.data.deadSteps[0];
        expect(deadStep).toHaveProperty("nodeId");
        expect(deadStep).toHaveProperty("nodeName");
      }
    });
  });

  describe("GET /api/admin/audit/actions", () => {
    test("returns all audit action types for admin", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/audit/actions`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("actions");
      expect(Array.isArray(json.data.actions)).toBe(true);

      // Should have all AuditAction enum values (42 as of current implementation)
      expect(json.data.actions.length).toBeGreaterThanOrEqual(40);
    });

    test("includes execution action types", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/audit/actions`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      const actions = json.data.actions as string[];

      // Verify execution actions are present
      expect(actions).toContain("execution:start");
      expect(actions).toContain("execution:step");
      expect(actions).toContain("execution:complete");
      expect(actions).toContain("execution:fail");
    });

    test("includes auth action types", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/audit/actions`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      const actions = json.data.actions as string[];

      // Verify auth actions are present
      expect(actions).toContain("auth:sign_in");
      expect(actions).toContain("auth:sign_up");
      expect(actions).toContain("auth:sign_out");
    });

    test("includes admin action types", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/audit/actions`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      const actions = json.data.actions as string[];

      // Verify admin actions are present
      expect(actions).toContain("admin:block_user");
      expect(actions).toContain("admin:unblock_user");
    });

    test("denies access to non-admin users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/audit/actions`, {
        headers: { Cookie: normalUserCookie },
      });

      expect(response.status).toBe(403);
    });

    test("denies access to unauthenticated users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/audit/actions`);

      expect(response.status).toBe(401);
    });
  });

  describe("Query Performance", () => {
    test("overview endpoint responds in reasonable time", async () => {
      const start = Date.now();
      const response = await fetch(`${BASE_URL}/api/admin/analytics/overview`, {
        headers: { Cookie: adminCookie },
      });
      const duration = Date.now() - start;

      expect(response.status).toBe(200);
      // Performance target: < 3000ms (relaxed for remote Docker execution and parallel test load)
      expect(duration).toBeLessThan(3000);
    });

    test("executions endpoint responds in reasonable time", async () => {
      const start = Date.now();
      const response = await fetch(`${BASE_URL}/api/admin/analytics/executions`, {
        headers: { Cookie: adminCookie },
      });
      const duration = Date.now() - start;

      expect(response.status).toBe(200);
      // Performance target: < 3000ms (relaxed for remote Docker execution and parallel test load)
      expect(duration).toBeLessThan(3000);
    });

    test("top-workflows endpoint responds in reasonable time", async () => {
      const start = Date.now();
      const response = await fetch(`${BASE_URL}/api/admin/analytics/top-workflows`, {
        headers: { Cookie: adminCookie },
      });
      const duration = Date.now() - start;

      expect(response.status).toBe(200);
      // Performance target: < 3000ms (relaxed for remote Docker execution and parallel test load)
      expect(duration).toBeLessThan(3000);
    });

    test("audit-summary endpoint responds in reasonable time", async () => {
      const start = Date.now();
      const response = await fetch(`${BASE_URL}/api/admin/analytics/audit-summary`, {
        headers: { Cookie: adminCookie },
      });
      const duration = Date.now() - start;

      expect(response.status).toBe(200);
      // Performance target: < 3000ms (relaxed for remote Docker execution and parallel test load)
      expect(duration).toBeLessThan(3000);
    });

    test("operational endpoint responds in reasonable time", async () => {
      const start = Date.now();
      const response = await fetch(`${BASE_URL}/api/admin/analytics/operational`, {
        headers: { Cookie: adminCookie },
      });
      const duration = Date.now() - start;

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(3000);
    });
  });

  describe("GET /api/admin/analytics/operational", () => {
    test("returns all 6 operational metrics for admin", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/operational`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("metrics");
      expect(json.data).toHaveProperty("timeRange");

      // Must return exactly 6 metrics
      expect(json.data.metrics).toHaveLength(6);

      // Check metric names
      const metricNames = json.data.metrics.map((m: any) => m.name);
      expect(metricNames).toContain("unique_users_per_day");
      expect(metricNames).toContain("total_calls_per_day");
      expect(metricNames).toContain("calls_per_second");
      expect(metricNames).toContain("workflows_started_per_day");
      expect(metricNames).toContain("workflows_completed_per_day");
      expect(metricNames).toContain("mcp_calls_per_second");

      // Each metric should have required fields
      for (const metric of json.data.metrics) {
        expect(metric).toHaveProperty("name");
        expect(metric).toHaveProperty("unit");
        expect(metric).toHaveProperty("available");
        expect(typeof metric.available).toBe("boolean");

        if (metric.available) {
          expect(typeof metric.value).toBe("number");
          expect(metric.value).toBeGreaterThanOrEqual(0);
        }
      }
    });

    test("all metrics include time series data", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/operational?range=month`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;

      // All 6 metrics should include timeSeries (all audit-based now)
      for (const metric of json.data.metrics) {
        if (metric.available) {
          expect(metric).toHaveProperty("timeSeries");
          expect(Array.isArray(metric.timeSeries)).toBe(true);

          // Each time series point should have date and value
          for (const point of metric.timeSeries) {
            expect(point).toHaveProperty("date");
            expect(point).toHaveProperty("value");
            expect(typeof point.value).toBe("number");
          }
        }
      }
    });

    test("supports time range filter", async () => {
      const ranges = ["today", "week", "month", "year", "all"];
      for (const range of ranges) {
        const response = await fetch(`${BASE_URL}/api/admin/analytics/operational?range=${range}`, {
          headers: { Cookie: adminCookie },
        });

        expect(response.status).toBe(200);
        const json = (await response.json()) as any;
        expect(json.data.timeRange).toBe(range);
      }
    });

    test("denies access to non-admin users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/operational`, {
        headers: { Cookie: normalUserCookie },
      });

      expect(response.status).toBe(403);
    });

    test("denies access to unauthenticated users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/operational`);

      expect(response.status).toBe(401);
    });

    test("supports granularity parameter (auto/hourly/daily)", async () => {
      // Auto for today → hourly
      const autoResp = await fetch(
        `${BASE_URL}/api/admin/analytics/operational?range=today&granularity=auto`,
        { headers: { Cookie: adminCookie } },
      );
      expect(autoResp.status).toBe(200);
      const autoJson = (await autoResp.json()) as any;
      expect(autoJson.data.granularity).toBe("hourly");

      // Explicit hourly
      const hourlyResp = await fetch(
        `${BASE_URL}/api/admin/analytics/operational?range=today&granularity=hourly`,
        { headers: { Cookie: adminCookie } },
      );
      expect(hourlyResp.status).toBe(200);
      const hourlyJson = (await hourlyResp.json()) as any;
      expect(hourlyJson.data.granularity).toBe("hourly");

      // Explicit daily
      const dailyResp = await fetch(
        `${BASE_URL}/api/admin/analytics/operational?range=today&granularity=daily`,
        { headers: { Cookie: adminCookie } },
      );
      expect(dailyResp.status).toBe(200);
      const dailyJson = (await dailyResp.json()) as any;
      expect(dailyJson.data.granularity).toBe("daily");

      // Auto for month → daily
      const monthResp = await fetch(
        `${BASE_URL}/api/admin/analytics/operational?range=month&granularity=auto`,
        { headers: { Cookie: adminCookie } },
      );
      expect(monthResp.status).toBe(200);
      const monthJson = (await monthResp.json()) as any;
      expect(monthJson.data.granularity).toBe("daily");
    });

    test("supports action/source/resource filter params", async () => {
      // Filter by action
      const actionResp = await fetch(
        `${BASE_URL}/api/admin/analytics/operational?range=all&action=workflow.start`,
        { headers: { Cookie: adminCookie } },
      );
      expect(actionResp.status).toBe(200);
      const actionJson = (await actionResp.json()) as any;
      expect(actionJson.data.activeFilters).toBeDefined();
      expect(actionJson.data.activeFilters.action).toBe("workflow.start");
      expect(actionJson.data.activeFilters.source).toBeNull();
      expect(actionJson.data.activeFilters.resource).toBeNull();

      // Filter by source
      const sourceResp = await fetch(
        `${BASE_URL}/api/admin/analytics/operational?range=all&source=mcp`,
        { headers: { Cookie: adminCookie } },
      );
      expect(sourceResp.status).toBe(200);
      const sourceJson = (await sourceResp.json()) as any;
      expect(sourceJson.data.activeFilters.source).toBe("mcp");

      // Filter by resource
      const resourceResp = await fetch(
        `${BASE_URL}/api/admin/analytics/operational?range=all&resource=workflow`,
        { headers: { Cookie: adminCookie } },
      );
      expect(resourceResp.status).toBe(200);
      const resourceJson = (await resourceResp.json()) as any;
      expect(resourceJson.data.activeFilters.resource).toBe("workflow");

      // Multiple filters combined
      const combinedResp = await fetch(
        `${BASE_URL}/api/admin/analytics/operational?range=all&action=workflow.start&source=mcp`,
        { headers: { Cookie: adminCookie } },
      );
      expect(combinedResp.status).toBe(200);
      const combinedJson = (await combinedResp.json()) as any;
      expect(combinedJson.data.activeFilters.action).toBe("workflow.start");
      expect(combinedJson.data.activeFilters.source).toBe("mcp");

      // No filters → all null
      const noFilterResp = await fetch(`${BASE_URL}/api/admin/analytics/operational?range=all`, {
        headers: { Cookie: adminCookie },
      });
      expect(noFilterResp.status).toBe(200);
      const noFilterJson = (await noFilterResp.json()) as any;
      expect(noFilterJson.data.activeFilters.action).toBeNull();
      expect(noFilterJson.data.activeFilters.source).toBeNull();
      expect(noFilterJson.data.activeFilters.resource).toBeNull();
    });

    test("response includes activeFilters field", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/operational?range=today`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.data).toHaveProperty("activeFilters");
      expect(json.data.activeFilters).toEqual({
        action: null,
        source: null,
        resource: null,
      });
    });

    test("response includes breakdowns (byAction, bySource, byResource)", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/operational?range=today`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.data).toHaveProperty("breakdowns");
      expect(json.data.breakdowns).toHaveProperty("byAction");
      expect(json.data.breakdowns).toHaveProperty("bySource");
      expect(json.data.breakdowns).toHaveProperty("byResource");

      // Each breakdown is an array of {label, count}
      expect(Array.isArray(json.data.breakdowns.byAction)).toBe(true);
      expect(Array.isArray(json.data.breakdowns.bySource)).toBe(true);
      expect(Array.isArray(json.data.breakdowns.byResource)).toBe(true);

      // Verify structure of breakdown items (if data exists)
      for (const item of json.data.breakdowns.byAction) {
        expect(item).toHaveProperty("label");
        expect(item).toHaveProperty("count");
        expect(typeof item.label).toBe("string");
        expect(typeof item.count).toBe("number");
      }
    });
  });

  describe("GET /api/admin/analytics/conversion-funnel", () => {
    test("returns conversion funnel data for admin", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/conversion-funnel`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("funnel");
      expect(json.data).toHaveProperty("registrationTrend");
      expect(json.data).toHaveProperty("timeRange");

      // Funnel should have 4 stages
      expect(json.data.funnel).toHaveLength(4);
      const stages = json.data.funnel.map((s: any) => s.stage);
      expect(stages).toEqual(["registered", "verified", "first_workflow", "active"]);

      // Each stage should have count >= 0
      for (const stage of json.data.funnel) {
        expect(typeof stage.count).toBe("number");
        expect(stage.count).toBeGreaterThanOrEqual(0);
        expect(stage).toHaveProperty("label");
      }

      // Funnel should be monotonically non-increasing
      for (let i = 1; i < json.data.funnel.length; i++) {
        expect(json.data.funnel[i].count).toBeLessThanOrEqual(json.data.funnel[i - 1].count);
      }
    });

    test("supports time range filter", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/conversion-funnel?range=year`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.data.timeRange).toBe("year");
    });

    test("denies access to non-admin users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/conversion-funnel`, {
        headers: { Cookie: normalUserCookie },
      });
      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/admin/analytics/engagement", () => {
    test("returns engagement metrics for admin", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/engagement`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("returningUsersRate");
      expect(json.data).toHaveProperty("returningUsersCount");
      expect(json.data).toHaveProperty("totalActiveUsers");
      expect(json.data).toHaveProperty("avgExecutionsPerUser");
      expect(json.data).toHaveProperty("avgTimeToFirstWorkflowDays");
      expect(json.data).toHaveProperty("activeUsersTrend");
      expect(json.data).toHaveProperty("timeRange");

      // Numeric fields should be numbers
      expect(typeof json.data.returningUsersRate).toBe("number");
      expect(json.data.returningUsersRate).toBeGreaterThanOrEqual(0);
      expect(json.data.returningUsersRate).toBeLessThanOrEqual(100);
      expect(typeof json.data.avgExecutionsPerUser).toBe("number");
      expect(json.data.avgExecutionsPerUser).toBeGreaterThanOrEqual(0);

      // Active users trend should be an array
      expect(Array.isArray(json.data.activeUsersTrend)).toBe(true);
    });

    test("supports time range filter", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/engagement?range=all`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.data.timeRange).toBe("all");
    });

    test("denies access to non-admin users", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/analytics/engagement`, {
        headers: { Cookie: normalUserCookie },
      });
      expect(response.status).toBe(403);
    });
  });
});
