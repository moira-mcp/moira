import { Router } from "express";
import {
  WorkspaceConnectionError,
  WorkspaceResourceError,
  projectWorkspaceOperationSummary,
  projectWorkspaceSummary,
  recordWorkspaceRejection,
  type WorkspaceConnectionService,
  type WorkspaceObservabilityService,
  type WorkspaceOperationService,
  type WorkspaceResourceService,
} from "@mcp-moira/shared";
import type { AuthenticatedRequest } from "../types/express-types.js";
import { asyncHandler } from "../middleware/error-middleware.js";
import {
  getWorkspaceConnectionService,
  getWorkspaceObservabilityService,
  getWorkspaceOperationService,
  getWorkspaceResourceService,
} from "../services/workspace-services.js";

export interface WorkspaceManagementServices {
  connection: Pick<WorkspaceConnectionService, "getStatus">;
  observability: Pick<WorkspaceObservabilityService, "readiness">;
  resource: Pick<
    WorkspaceResourceService,
    | "listRepositories"
    | "listResources"
    | "getWorkspace"
    | "create"
    | "startWorkspace"
    | "stopWorkspace"
    | "deleteWorkspace"
  > | null;
  operation: Pick<WorkspaceOperationService, "list"> | null;
}

const RESOURCE_ERROR_STATUS: Record<string, number> = {
  WORKSPACE_NOT_FOUND: 404,
  WORKSPACE_GENERATION_CONFLICT: 409,
  WORKSPACE_CREATE_PENDING: 409,
  WORKSPACE_NOT_RUNNING: 409,
  WORKSPACE_RESOURCE_INVALID: 400,
  WORKSPACE_CREATE_REJECTED: 422,
  WORKSPACE_POLICY_LIMIT: 429,
  WORKSPACE_OPERATION_BUSY: 429,
  WORKSPACE_PROVIDER_DISABLED: 503,
  WORKSPACE_PROVIDER_UNAVAILABLE: 503,
  WORKSPACE_AUTHORIZATION_REQUIRED: 409,
  WORKSPACE_RESULT_EXPIRED: 410,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function defaultServices(): WorkspaceManagementServices {
  return {
    connection: getWorkspaceConnectionService(),
    observability: getWorkspaceObservabilityService(),
    resource: getWorkspaceResourceService(),
    operation: getWorkspaceOperationService(),
  };
}

/**
 * Website workspace management. The same domain services back the MCP tools; this
 * router is a second presentation with identical tenant, generation and policy
 * authority. Responses never contain provider credentials, resource names, markers,
 * claims or lifecycle capabilities.
 */
export function createWorkspaceManagementRoutes(
  services: WorkspaceManagementServices = defaultServices(),
): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  const settingsUrl = (userId: string): string => services.connection.getStatus(userId).settingsUrl;

  const notConfigured = (userId: string) => ({
    status: 503,
    body: {
      success: false,
      error: {
        code: "WORKSPACE_NOT_CONFIGURED",
        message: "Cloud workspaces are not configured on this Moira instance",
      },
      settings_url: settingsUrl(userId),
    },
  });

  const handleError = (userId: string, error: unknown, res: import("express").Response) => {
    if (error instanceof WorkspaceResourceError) {
      recordWorkspaceRejection(error.code);
      res.status(RESOURCE_ERROR_STATUS[error.code] ?? 500).json({
        success: false,
        error: { code: error.code, message: publicMessage(error.code) },
      });
      return true;
    }
    if (error instanceof WorkspaceConnectionError) {
      res.status(503).json({
        success: false,
        error: { code: error.code, message: error.message },
        settings_url: settingsUrl(userId),
      });
      return true;
    }
    return false;
  };

  const workspaceId = (value: unknown): string | null =>
    typeof value === "string" && UUID.test(value) ? value : null;

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      const readiness = await services.observability.readiness();
      res.json({
        success: true,
        data: {
          readiness,
          connection: services.connection.getStatus(userId),
          repositories:
            services.resource?.listRepositories(userId).map((repository) => ({
              repository_id: repository.id,
              name: repository.fullName,
              private: repository.private,
            })) ?? [],
          workspaces: services.resource?.listResources(userId).map(projectWorkspaceSummary) ?? [],
        },
      });
    }),
  );

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      if (!services.resource) {
        const failure = notConfigured(userId);
        res.status(failure.status).json(failure.body);
        return;
      }
      const repositoryId = req.body?.repository_id;
      const ref = req.body?.ref;
      if (
        typeof repositoryId !== "string" ||
        repositoryId.length === 0 ||
        repositoryId.length > 255 ||
        typeof ref !== "string" ||
        ref.length === 0 ||
        ref.length > 255
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "WORKSPACE_RESOURCE_INVALID",
            message: "repository_id and ref are required",
          },
        });
        return;
      }
      try {
        const created = await services.resource.create(userId, repositoryId, ref);
        res.status(201).json({
          success: true,
          data: { workspace: projectWorkspaceSummary(created.resource) },
        });
      } catch (error) {
        if (!handleError(userId, error, res)) throw error;
      }
    }),
  );

  router.get(
    "/:workspaceId",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      const id = workspaceId(req.params.workspaceId);
      if (!services.resource || !id) {
        res.status(404).json({
          success: false,
          error: { code: "WORKSPACE_NOT_FOUND", message: "Workspace was not found" },
        });
        return;
      }
      try {
        const workspace = services.resource.getWorkspace(userId, id);
        const operations =
          services.operation
            ?.list(userId, id)
            .slice(-20)
            .reverse()
            .map(projectWorkspaceOperationSummary) ?? [];
        res.json({
          success: true,
          data: { workspace: projectWorkspaceSummary(workspace), operations },
        });
      } catch (error) {
        if (!handleError(userId, error, res)) throw error;
      }
    }),
  );

  for (const action of ["start", "stop"] as const) {
    router.post(
      `/:workspaceId/${action}`,
      asyncHandler(async (req, res) => {
        const userId = (req as AuthenticatedRequest).userId;
        const id = workspaceId(req.params.workspaceId);
        if (!services.resource) {
          const failure = notConfigured(userId);
          res.status(failure.status).json(failure.body);
          return;
        }
        if (!id) {
          res.status(404).json({
            success: false,
            error: { code: "WORKSPACE_NOT_FOUND", message: "Workspace was not found" },
          });
          return;
        }
        try {
          const workspace =
            action === "start"
              ? await services.resource.startWorkspace(userId, id)
              : await services.resource.stopWorkspace(userId, id);
          res.json({
            success: true,
            data: {
              workspace: projectWorkspaceSummary(workspace),
              data_preserved: true,
            },
          });
        } catch (error) {
          if (!handleError(userId, error, res)) throw error;
        }
      }),
    );
  }

  router.delete(
    "/:workspaceId",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      const id = workspaceId(req.params.workspaceId);
      if (!services.resource) {
        const failure = notConfigured(userId);
        res.status(failure.status).json(failure.body);
        return;
      }
      if (!id) {
        res.status(404).json({
          success: false,
          error: { code: "WORKSPACE_NOT_FOUND", message: "Workspace was not found" },
        });
        return;
      }
      const expectedGeneration = req.body?.expected_generation;
      if (
        req.body?.confirm_delete !== true ||
        !Number.isInteger(expectedGeneration) ||
        expectedGeneration < 1
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "WORKSPACE_DELETE_CONFIRMATION_REQUIRED",
            message: "Deletion requires confirm_delete and the current expected_generation",
          },
        });
        return;
      }
      try {
        const workspace = await services.resource.deleteWorkspace(userId, id, expectedGeneration);
        res.json({
          success: true,
          data: { workspace: projectWorkspaceSummary(workspace), data_preserved: false },
        });
      } catch (error) {
        if (!handleError(userId, error, res)) throw error;
      }
    }),
  );

  return router;
}

function publicMessage(code: string): string {
  switch (code) {
    case "WORKSPACE_NOT_FOUND":
      return "Workspace was not found";
    case "WORKSPACE_GENERATION_CONFLICT":
      return "The workspace changed; refresh and retry";
    case "WORKSPACE_POLICY_LIMIT":
      return "A workspace quota or limit was reached";
    case "WORKSPACE_OPERATION_BUSY":
      return "Workspace operations are busy; retry later";
    case "WORKSPACE_PROVIDER_DISABLED":
      return "Cloud workspace operations are disabled";
    case "WORKSPACE_PROVIDER_UNAVAILABLE":
      return "The cloud workspace provider is unavailable";
    case "WORKSPACE_NOT_RUNNING":
      return "The workspace is not ready and running";
    case "WORKSPACE_CREATE_PENDING":
      return "Workspace creation or cleanup is still pending";
    case "WORKSPACE_AUTHORIZATION_REQUIRED":
      return "Restore workspace repository access in Settings";
    default:
      return "The workspace request was rejected";
  }
}
