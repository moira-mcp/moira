import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

const deployment = { accountApprovalEnabled: false };
const approvalState: { approvedAt: string | null } = { approvedAt: null };
const auditEvents: Array<{ action: string; adminId: string; userId: string }> = [];
let reconciliationState: Record<string, unknown> = {
  status: "ok",
  code: "MANAGED_WORKFLOW_RECONCILIATION_REQUIRED",
  conflicts: [],
};
const isEnabled = jest.fn(
  (feature: string) => feature === "accountApproval" && deployment.accountApprovalEnabled,
);
const approveAccount = jest.fn(async (adminId: string, userId: string) => {
  const approvedAt = "2026-08-21T12:00:00.000Z";
  approvalState.approvedAt = approvedAt;
  auditEvents.push({ action: "account.approved", adminId, userId });
  return { status: "approved", approvedAt };
});

jest.unstable_mockModule("@mcp-moira/workflow-engine", () => ({
  DatabaseRepository: class {
    async listWorkflows() {
      return [];
    }
    async listExecutions() {
      return [];
    }
    async getSettingDefinitions() {
      return [];
    }
  },
}));

jest.unstable_mockModule("@mcp-moira/shared", () => ({
  AuditAction: {},
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
  getMcpTextService: jest.fn(),
  getSqliteInstance: jest.fn(),
  getUserService: () => ({ approveAccount }),
  getWorkflowReconciliationStatusSummary: jest.fn(() => reconciliationState),
  isEmailConfigured: jest.fn(),
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

describe("account approval route capability", () => {
  beforeEach(() => {
    deployment.accountApprovalEnabled = false;
    approvalState.approvedAt = null;
    auditEvents.length = 0;
    reconciliationState = {
      status: "ok",
      code: "MANAGED_WORKFLOW_RECONCILIATION_REQUIRED",
      conflicts: [],
    };
    isEnabled.mockClear();
    approveAccount.mockClear();
  });

  it("returns 403 in SaaS before the mutation service can change storage or audit state", async () => {
    const { adminRoutes } = await import("../../../packages/web-backend/src/routes/admin.js");
    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminRoutes);
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
    const { adminRoutes } = await import("../../../packages/web-backend/src/routes/admin.js");
    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminRoutes);

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
    const { adminRoutes } = await import("../../../packages/web-backend/src/routes/admin.js");
    const app = express();
    app.use("/api/admin", adminRoutes);

    const response = await request(app).get("/api/admin/stats");

    expect(response.status).toBe(200);
    expect(response.body.data.systemHealth).toMatchObject({
      backendStatus: "degraded",
      workflowReconciliation: reconciliationState,
    });
    expect(JSON.stringify(response.body.data.systemHealth.workflowReconciliation)).not.toContain(
      '"graph"',
    );
  });
});
