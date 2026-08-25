import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

const deployment = { accountApprovalEnabled: false, adminAnalyticsEnabled: false };
const approvalState: { approvedAt: string | null } = { approvedAt: null };
const auditEvents: Array<{ action: string; adminId: string; userId: string }> = [];
let reconciliationState: Record<string, unknown> = {
  status: "ok",
  code: "MANAGED_WORKFLOW_RECONCILIATION_REQUIRED",
  conflicts: [],
};
const isEnabled = jest.fn(
  (feature: string) =>
    (feature === "accountApproval" && deployment.accountApprovalEnabled) ||
    (feature === "adminAnalytics" && deployment.adminAnalyticsEnabled),
);
let broadReadsAllowed = false;
let workflowsFixture: Array<{ id: string }> = [];
let executionsFixture: Array<{
  executionId: string;
  workflowId: string;
  status: string;
  createdAt: number;
}> = [];
const listWorkflows = jest.fn(async () => {
  if (!broadReadsAllowed) throw new Error("broad workflow read entered");
  return workflowsFixture;
});
const listExecutions = jest.fn(async () => {
  if (!broadReadsAllowed) throw new Error("broad execution read entered");
  return executionsFixture;
});
const getSettingDefinitions = jest.fn(async () => [{ key: "first" }, { key: "second" }]);
const approveAccount = jest.fn(async (adminId: string, userId: string) => {
  const approvedAt = "2026-08-21T12:00:00.000Z";
  approvalState.approvedAt = approvedAt;
  auditEvents.push({ action: "account.approved", adminId, userId });
  return { status: "approved", approvedAt };
});

jest.unstable_mockModule("@mcp-moira/workflow-engine", () => ({
  DatabaseRepository: class {
    async listWorkflows() {
      return listWorkflows();
    }
    async listExecutions() {
      return listExecutions();
    }
    async getSettingDefinitions() {
      return getSettingDefinitions();
    }
  },
}));

jest.unstable_mockModule("@mcp-moira/shared", () => ({
  AuthorizationError: class extends Error {},
  AuditAction: {},
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  MCP_AGENT_CATEGORY: "agent",
  MCP_MODEL_CATEGORY: "model",
  MCP_TEXT_KEYS: {},
  getArtifactService: jest.fn(),
  getArtifactUrl: jest.fn(),
  getBaseUrl: jest.fn(),
  getDbPath: () => "/definitely-not-present/moira.db",
  getFeatureResolver: () => ({ isEnabled }),
  getGlobalSettingsService: jest.fn(),
  getLockService: jest.fn(),
  getLoadTestSecret: jest.fn(),
  getMcpTextService: jest.fn(),
  getRateLimitWhitelist: () => [],
  getSqliteInstance: jest.fn(),
  getUserService: () => ({ approveAccount }),
  getWorkflowReconciliationStatusSummary: jest.fn(() => reconciliationState),
  isEmailConfigured: jest.fn(),
  isRateLimitDisabled: () => true,
  isTestEnvironment: () => true,
  logAuditEvent: jest.fn(),
}));

jest.unstable_mockModule(
  "../../../packages/web-backend/src/middleware/admin-middleware.js",
  () => ({
    requireAdmin: (req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { userId: string }).userId = "saas-admin";
      next();
    },
  }),
);

jest.unstable_mockModule(
  "../../../packages/web-backend/src/middleware/error-middleware.js",
  () => ({
    asyncHandler:
      (handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
      (req: Request, res: Response, next: NextFunction) => {
        void handler(req, res, next).catch(next);
      },
    createApiError: {
      forbidden: (message: string) => Object.assign(new Error(message), { statusCode: 403 }),
      notFound: (message: string) => Object.assign(new Error(message), { statusCode: 404 }),
      badRequest: (message: string) => Object.assign(new Error(message), { statusCode: 400 }),
      validationFailed: (message: string) => Object.assign(new Error(message), { statusCode: 400 }),
    },
  }),
);

jest.unstable_mockModule("../../../packages/web-backend/src/auth.js", () => ({
  auth: { api: {} },
}));

async function mountProductionAdminRoutes(app: express.Application): Promise<void> {
  const { adminRoutes } = await import("../../../packages/web-backend/src/routes/admin.js");
  const { requireAdmin } =
    await import("../../../packages/web-backend/src/middleware/admin-middleware.js");
  const { requireSelectedCapability } =
    await import("../../../packages/web-backend/src/middleware/capability-middleware.js");
  const { selectAdminRouteCapability } =
    await import("../../../packages/web-backend/src/middleware/admin-route-capability.js");

  app.use(
    "/api/admin",
    requireAdmin,
    requireSelectedCapability(selectAdminRouteCapability),
    adminRoutes,
  );
}

describe("account approval route capability", () => {
  beforeEach(() => {
    deployment.accountApprovalEnabled = false;
    deployment.adminAnalyticsEnabled = false;
    broadReadsAllowed = false;
    workflowsFixture = [];
    executionsFixture = [];
    approvalState.approvedAt = null;
    auditEvents.length = 0;
    reconciliationState = {
      status: "ok",
      code: "MANAGED_WORKFLOW_RECONCILIATION_REQUIRED",
      conflicts: [],
    };
    isEnabled.mockClear();
    listWorkflows.mockClear();
    listExecutions.mockClear();
    getSettingDefinitions.mockClear();
    approveAccount.mockClear();
  });

  it("returns 403 in SaaS before the mutation service can change storage or audit state", async () => {
    const app = express();
    app.use(express.json());
    await mountProductionAdminRoutes(app);
    app.use(
      (
        error: Error & { statusCode?: number },
        _req: Request,
        res: Response,
        _next: NextFunction,
      ) => {
        res.status(error.statusCode ?? 500).json({ error: error.message });
      },
    );

    const response = await request(app).post("/api/admin/users/saas-user/approve");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Account approval is not enabled for this deployment" });
    expect(isEnabled).toHaveBeenCalledWith("accountApproval", { userId: "saas-admin" });
    expect(approveAccount).not.toHaveBeenCalled();
    expect(approvalState).toEqual({ approvedAt: null });
    expect(auditEvents).toEqual([]);
  });

  it("allows the self-host capability and exposes the approval transition", async () => {
    deployment.accountApprovalEnabled = true;
    const app = express();
    app.use(express.json());
    await mountProductionAdminRoutes(app);

    const response = await request(app).post("/api/admin/users/self-host-user/approve");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        id: "self-host-user",
        approvedAt: "2026-08-21T12:00:00.000Z",
        approved: true,
        alreadyApproved: false,
      },
    });
    expect(isEnabled).toHaveBeenCalledWith("accountApproval", { userId: "saas-admin" });
    expect(approvalState).toEqual({ approvedAt: "2026-08-21T12:00:00.000Z" });
    expect(auditEvents).toEqual([
      { action: "account.approved", adminId: "saas-admin", userId: "self-host-user" },
    ]);
  });

  it("returns graph-free reconciliation references and degraded admin health", async () => {
    reconciliationState = {
      status: "error",
      code: "MANAGED_WORKFLOW_RECONCILIATION_REQUIRED",
      conflicts: [
        {
          owner: "system-admin",
          slug: "managed-flow",
          classification: "conflict",
          instruction: "Run Workflow Management Flow (WMF)",
          candidateRefs: {
            previous: "database:workflow-reconciliation:system-admin/managed-flow#previous",
            current: "database:workflow-reconciliation:system-admin/managed-flow#current",
            incoming: "database:workflow-reconciliation:system-admin/managed-flow#incoming",
          },
          recoveryLocation: "database:workflow-reconciliation:system-admin/managed-flow",
        },
      ],
    };
    const app = express();
    await mountProductionAdminRoutes(app);

    const response = await request(app).get("/api/admin/system-status");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      totalDefinitions: 2,
      systemHealth: {
        backendStatus: "degraded",
        databaseSize: 0,
        workflowReconciliation: reconciliationState,
      },
    });
    expect(JSON.stringify(response.body.data.systemHealth.workflowReconciliation)).not.toContain(
      '"graph"',
    );
  });

  it("serves computed statistics through the enabled production route selector", async () => {
    deployment.adminAnalyticsEnabled = true;
    broadReadsAllowed = true;
    workflowsFixture = [{ id: "workflow-1" }, { id: "workflow-2" }];
    executionsFixture = [
      {
        executionId: "execution-old",
        workflowId: "workflow-1",
        status: "completed",
        createdAt: 100,
      },
      {
        executionId: "execution-new",
        workflowId: "workflow-2",
        status: "running",
        createdAt: 300,
      },
      {
        executionId: "execution-middle",
        workflowId: "workflow-1",
        status: "failed",
        createdAt: 200,
      },
    ];
    const app = express();
    await mountProductionAdminRoutes(app);

    const response = await request(app).get("/api/admin/stats");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      totalWorkflows: 2,
      totalExecutions: 3,
      totalDefinitions: 2,
      systemHealth: {
        backendStatus: "healthy",
        databaseSize: 0,
        workflowReconciliation: reconciliationState,
      },
      activeExecutions: 1,
      recentActivity: [
        {
          id: "execution-new",
          workflowId: "workflow-2",
          status: "running",
          timestamp: 300,
          action: "Workflow execution running",
        },
        {
          id: "execution-middle",
          workflowId: "workflow-1",
          status: "failed",
          timestamp: 200,
          action: "Workflow execution failed",
        },
        {
          id: "execution-old",
          workflowId: "workflow-1",
          status: "completed",
          timestamp: 100,
          action: "Workflow execution completed",
        },
      ],
    });
  });
});
