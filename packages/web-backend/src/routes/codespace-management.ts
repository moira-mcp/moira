import { Router } from "express";
import {
  CodespaceConnectionError,
  CodespaceResourceError,
  projectCodespaceOperationSummary,
  projectCodespaceSummary,
  recordCodespaceRejection,
  parseLocalRepositoryTargetId,
  type CodespaceConnectionService,
  type CodespaceObservabilityService,
  type CodespaceOperationService,
  type CodespaceResourceService,
} from "@mcp-moira/shared";
import type { AuthenticatedRequest } from "../types/express-types.js";
import { asyncHandler } from "../middleware/error-middleware.js";
import {
  getCodespaceConnectionService,
  getCodespaceObservabilityService,
  getCodespaceOperationService,
  getCodespaceResourceService,
  getCodespaceProviderBundles,
  selectCodespaceProviderServices,
  getLocalDeviceService,
} from "../services/codespace-services.js";

export interface CodespaceManagementServices {
  provider?: string;
  providers?: CodespaceManagementServices[];
  select?: (
    userId: string,
    input: { repositoryId?: string; codespaceId?: string },
  ) => CodespaceManagementServices;
  repositoryMetadata?: (
    userId: string,
    repositoryId: string,
  ) => { device_id: string; device_label: string };
  connection: Pick<CodespaceConnectionService, "getStatus" | "refreshGrants">;
  observability: Pick<CodespaceObservabilityService, "readiness" | "limitsWithBilling">;
  resource: Pick<
    CodespaceResourceService,
    | "listRepositories"
    | "listResources"
    | "refreshProviderState"
    | "getCodespace"
    | "create"
    | "startCodespace"
    | "stopCodespace"
    | "deleteCodespace"
  > | null;
  operation: Pick<CodespaceOperationService, "list"> | null;
}

const RESOURCE_ERROR_STATUS: Record<string, number> = {
  CODESPACE_NOT_FOUND: 404,
  CODESPACE_GENERATION_CONFLICT: 409,
  CODESPACE_CREATE_PENDING: 409,
  CODESPACE_NOT_RUNNING: 409,
  CODESPACE_RESOURCE_INVALID: 400,
  CODESPACE_CREATE_REJECTED: 422,
  CODESPACE_BILLING_UNSUPPORTED: 422,
  CODESPACE_POLICY_LIMIT: 429,
  CODESPACE_SESSION_UNAVAILABLE: 409,
  CODESPACE_START_TIMEOUT: 504,
  CODESPACE_OPERATION_BUSY: 429,
  CODESPACE_PROVIDER_DISABLED: 503,
  CODESPACE_PROVIDER_UNAVAILABLE: 503,
  CODESPACE_AUTHORIZATION_REQUIRED: 409,
  CODESPACE_RESULT_EXPIRED: 410,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function defaultServices(): CodespaceManagementServices {
  return {
    connection: getCodespaceConnectionService(),
    observability: getCodespaceObservabilityService(),
    resource: getCodespaceResourceService(),
    operation: getCodespaceOperationService(),
    providers: getCodespaceProviderBundles(),
    select: selectCodespaceProviderServices,
    repositoryMetadata: (userId, repositoryId) => {
      const target = parseLocalRepositoryTargetId(repositoryId);
      return {
        device_id: target.deviceId,
        device_label: getLocalDeviceService().getActiveDevice(userId, target.deviceId).label,
      };
    },
  };
}

/**
 * Website codespace management. The same domain services back the MCP tools; this
 * router is a second presentation with identical tenant, generation and policy
 * authority. Responses never contain provider credentials, resource names, markers,
 * claims or lifecycle capabilities.
 */
export function createCodespaceManagementRoutes(
  services: CodespaceManagementServices = defaultServices(),
): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  const settingsUrl = (userId: string, selected = services): string =>
    selected.connection.getStatus(userId).settingsUrl;

  const notConfigured = (userId: string, selected = services) => ({
    status: 503,
    body: {
      success: false,
      error: {
        code: "CODESPACE_NOT_CONFIGURED",
        message: "Cloud codespaces are not configured on this Moira instance",
      },
      settings_url: settingsUrl(userId, selected),
    },
  });

  const handleError = (userId: string, error: unknown, res: import("express").Response) => {
    if (error instanceof CodespaceResourceError) {
      recordCodespaceRejection(error.code);
      res.status(RESOURCE_ERROR_STATUS[error.code] ?? 500).json({
        success: false,
        error: {
          code: error.code,
          message: error.detail
            ? `${publicMessage(error.code)}. ${error.detail}`
            : publicMessage(error.code),
        },
      });
      return true;
    }
    if (error instanceof CodespaceConnectionError) {
      res.status(503).json({
        success: false,
        error: { code: error.code, message: error.message },
        settings_url: settingsUrl(userId),
      });
      return true;
    }
    return false;
  };

  const codespaceId = (value: unknown): string | null =>
    typeof value === "string" && UUID.test(value) ? value : null;

  const managementData = async (
    userId: string,
    refresh: boolean,
    selected = services,
  ): Promise<Record<string, unknown>> => {
    if (selected.providers) {
      const providers: Array<Record<string, unknown> & { provider: string | undefined }> =
        await Promise.all(
          selected.providers.map(async (bundle) => ({
            ...(await managementData(userId, refresh, bundle)),
            provider: bundle.provider,
          })),
        );
      const preferred =
        providers.find(
          (bundle) => (bundle.connection as { state?: string } | undefined)?.state === "connected",
        ) ?? providers[0];
      return {
        ...preferred,
        providers,
        repositories: providers.flatMap((bundle) =>
          ((bundle.repositories ?? []) as Record<string, unknown>[]).map((repository) => {
            if (bundle.provider !== "local-sandboxes")
              return { ...repository, provider: bundle.provider };
            return {
              ...repository,
              provider: bundle.provider,
              ...selected.repositoryMetadata?.(userId, String(repository.repository_id)),
            };
          }),
        ),
        codespaces: providers.flatMap((bundle) => (bundle.codespaces ?? []) as unknown[]),
        repositories_stale: providers.some((bundle) => bundle.repositories_stale === true),
        resources_stale: providers.some((bundle) => bundle.resources_stale === true),
      };
    }
    const grants = refresh
      ? await selected.connection.refreshGrants(userId, { force: true })
      : await selected.connection.refreshGrants(userId);
    const resources =
      refresh && !grants.stale && selected.resource
        ? await selected.resource.refreshProviderState(userId, { authorizationFresh: true })
        : { stale: refresh && grants.stale };
    return {
      readiness: await selected.observability.readiness(),
      connection: selected.connection.getStatus(userId),
      repositories:
        selected.resource?.listRepositories(userId).map((repository) => ({
          repository_id: repository.id,
          name: repository.fullName,
          private: repository.private,
        })) ?? [],
      repositories_stale: grants.stale,
      resources_stale: resources.stale,
      codespaces: selected.resource?.listResources(userId).map(projectCodespaceSummary) ?? [],
      limits: await selected.observability.limitsWithBilling(userId, { force: refresh }),
    };
  };

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      res.json({ success: true, data: await managementData(userId, false) });
    }),
  );

  router.post(
    "/refresh",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      res.json({ success: true, data: await managementData(userId, true) });
    }),
  );

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      if (!services.resource && !services.providers) {
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
            code: "CODESPACE_RESOURCE_INVALID",
            message: "repository_id and ref are required",
          },
        });
        return;
      }
      try {
        const selected = services.select?.(userId, { repositoryId }) ?? services;
        if (!selected.resource) {
          const failure = notConfigured(userId, selected);
          res.status(failure.status).json(failure.body);
          return;
        }
        await selected.connection.refreshGrants(userId);
        const created = await selected.resource.create(userId, repositoryId, ref);
        res.status(201).json({
          success: true,
          data: { codespace: projectCodespaceSummary(created.resource) },
        });
      } catch (error) {
        if (!handleError(userId, error, res)) throw error;
      }
    }),
  );

  router.get(
    "/:codespaceId",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      const id = codespaceId(req.params.codespaceId);
      if ((!services.resource && !services.providers) || !id) {
        res.status(404).json({
          success: false,
          error: { code: "CODESPACE_NOT_FOUND", message: "Codespace was not found" },
        });
        return;
      }
      try {
        const selected = services.select?.(userId, { codespaceId: id }) ?? services;
        if (!selected.resource)
          throw new CodespaceResourceError(
            "CODESPACE_NOT_FOUND",
            "Codespace provider is unavailable",
          );
        const codespace = selected.resource.getCodespace(userId, id);
        const operations =
          selected.operation
            ?.list(userId, id)
            .slice(-20)
            .reverse()
            .map(projectCodespaceOperationSummary) ?? [];
        res.json({
          success: true,
          data: { codespace: projectCodespaceSummary(codespace), operations },
        });
      } catch (error) {
        if (!handleError(userId, error, res)) throw error;
      }
    }),
  );

  for (const action of ["start", "stop"] as const) {
    router.post(
      `/:codespaceId/${action}`,
      asyncHandler(async (req, res) => {
        const userId = (req as AuthenticatedRequest).userId;
        const id = codespaceId(req.params.codespaceId);
        if (!services.resource && !services.providers) {
          const failure = notConfigured(userId);
          res.status(failure.status).json(failure.body);
          return;
        }
        if (!id) {
          res.status(404).json({
            success: false,
            error: { code: "CODESPACE_NOT_FOUND", message: "Codespace was not found" },
          });
          return;
        }
        try {
          const selected = services.select?.(userId, { codespaceId: id }) ?? services;
          if (!selected.resource) {
            const failure = notConfigured(userId, selected);
            res.status(failure.status).json(failure.body);
            return;
          }
          const codespace =
            action === "start"
              ? await selected.resource.startCodespace(userId, id)
              : await selected.resource.stopCodespace(userId, id);
          res.json({
            success: true,
            data: {
              codespace: projectCodespaceSummary(codespace),
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
    "/:codespaceId",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      const id = codespaceId(req.params.codespaceId);
      if (!services.resource && !services.providers) {
        const failure = notConfigured(userId);
        res.status(failure.status).json(failure.body);
        return;
      }
      if (!id) {
        res.status(404).json({
          success: false,
          error: { code: "CODESPACE_NOT_FOUND", message: "Codespace was not found" },
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
            code: "CODESPACE_DELETE_CONFIRMATION_REQUIRED",
            message: "Deletion requires confirm_delete and the current expected_generation",
          },
        });
        return;
      }
      try {
        const selected = services.select?.(userId, { codespaceId: id }) ?? services;
        if (!selected.resource) {
          const failure = notConfigured(userId, selected);
          res.status(failure.status).json(failure.body);
          return;
        }
        const codespace = await selected.resource.deleteCodespace(userId, id, expectedGeneration);
        res.json({
          success: true,
          data: { codespace: projectCodespaceSummary(codespace), data_preserved: false },
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
    case "CODESPACE_NOT_FOUND":
      return "Codespace was not found";
    case "CODESPACE_GENERATION_CONFLICT":
      return "The codespace changed; refresh and retry";
    case "CODESPACE_POLICY_LIMIT":
      return "A codespace quota or limit was reached";
    case "CODESPACE_SESSION_UNAVAILABLE":
      return "The command session is not available in this codespace";
    case "CODESPACE_START_TIMEOUT":
      return "The codespace is still starting; retry shortly";
    case "CODESPACE_OPERATION_BUSY":
      return "Codespace operations are busy; retry later";
    case "CODESPACE_PROVIDER_DISABLED":
      return "Codespace operations are disabled";
    case "CODESPACE_PROVIDER_UNAVAILABLE":
      return "The codespace provider is unavailable";
    case "CODESPACE_NOT_RUNNING":
      return "The codespace is not ready and running";
    case "CODESPACE_CREATE_PENDING":
      return "Codespace creation or cleanup is still pending";
    case "CODESPACE_AUTHORIZATION_REQUIRED":
      return "Restore codespace repository access in Settings";
    case "CODESPACE_BILLING_UNSUPPORTED":
      return "GitHub would bill an organization; this connection supports only personal billing";
    default:
      return "The codespace request was rejected";
  }
}
