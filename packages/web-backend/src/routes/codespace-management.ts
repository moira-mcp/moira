import { Router } from "express";
import { z } from "zod";
import {
  CodespaceConnectionError,
  ScopedCredentialError,
  CodespaceResourceError,
  recordCodespaceRejection,
  localCodespaceFailureGuidance,
  parseLocalRepositoryTargetId,
  providerFailureSchema,
  codespaceObservationErrorCode,
  type CodespaceProviderErrorView,
  type CodespaceConnectionService,
} from "@mcp-moira/shared";
import type { AuthenticatedRequest } from "../types/express-types.js";
import { asyncHandler } from "../middleware/error-middleware.js";
import { GitHubResourceService } from "../services/github-resource-service.js";
import { LocalCodespaceResourceService } from "../services/local-codespace-resource-service.js";
import {
  getCodespaceConnectionService,
  getCodespaceObservabilityService,
  getCodespaceResourceService,
  getCodespaceProviderBundles,
  selectCodespaceProviderServices,
  getLocalDeviceService,
  getCodespaceProviderBilling,
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
  billing?: typeof getCodespaceProviderBilling;
  controllers?: (
    userId: string,
  ) => Promise<Array<{ device_id: string; label: string; available: boolean }>>;
  connection: Pick<CodespaceConnectionService, "getStatus" | "refreshGrants">;
  observability: ReturnType<typeof selectCodespaceProviderServices>["observability"];
  resource: Pick<
    NonNullable<ReturnType<typeof selectCodespaceProviderServices>["resource"]>,
    | "listRepositories"
    | "listResources"
    | "refreshProviderState"
    | "getCodespace"
    | "create"
    | "startCodespace"
    | "stopCodespace"
    | "deleteCodespace"
  > | null;
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
  CODESPACE_START_TIMEOUT: 504,
  CODESPACE_PROVIDER_DISABLED: 503,
  CODESPACE_PROVIDER_UNAVAILABLE: 503,
  CODESPACE_AUTHORIZATION_REQUIRED: 409,
  WORKSPACE_OUTCOME_UNCONFIRMED: 503,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function defaultServices(): CodespaceManagementServices {
  return {
    connection: getCodespaceConnectionService(),
    observability: getCodespaceObservabilityService(),
    resource: getCodespaceResourceService(),
    billing: getCodespaceProviderBilling,
    controllers: async (userId) =>
      (await getLocalDeviceService().listOwned(userId)).devices.map((device) => ({
        device_id: device.deviceId,
        label: device.label,
        available: device.status === "active" && device.owner.state === "available",
      })),
    providers: getCodespaceProviderBundles(),
    select: selectCodespaceProviderServices,
    repositoryMetadata: (userId, repositoryId) => {
      const target = parseLocalRepositoryTargetId(repositoryId);
      return {
        device_id: target.deviceId,
        device_label:
          getLocalDeviceService()
            .listRegistered(userId)
            .devices.find((device) => device.deviceId === target.deviceId)?.label ?? "Local device",
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
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: {
          code: "CODESPACE_RESOURCE_INVALID",
          message: "The lifecycle request is invalid",
        },
      });
      return true;
    }
    if (error instanceof ScopedCredentialError) {
      res.status(error.status).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.requestId ? { request_id: error.requestId } : {}),
          ...(error.deviceId ? { device_id: error.deviceId } : {}),
          ...(error.resourceId ? { codespace_id: error.resourceId } : {}),
          ...(error.securityRequestId ? { security_request_id: error.securityRequestId } : {}),
        },
      });
      return true;
    }
    if (error instanceof CodespaceResourceError) {
      const providerFailure = providerFailureSchema.safeParse(error.providerFailure);
      recordCodespaceRejection(error.code);
      res
        .status(
          localCodespaceFailureGuidance(error.code)?.status ??
            RESOURCE_ERROR_STATUS[error.code] ??
            500,
        )
        .json({
          success: false,
          error: {
            code: error.code,
            message: error.detail
              ? `${publicMessage(error.code).replace(/\.$/, "")}. ${error.detail}`
              : publicMessage(error.code),
            ...(error.requestId ? { request_id: error.requestId } : {}),
            ...(error.deviceId ? { device_id: error.deviceId } : {}),
            ...(error.resourceId ? { codespace_id: error.resourceId } : {}),
            ...(providerFailure.success ? { provider_failure: providerFailure.data } : {}),
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
          selected.providers.map(async (bundle) => {
            try {
              return {
                ...(await managementData(userId, refresh, bundle)),
                provider: bundle.provider,
              };
            } catch (error) {
              return {
                provider: bundle.provider,
                error: { code: codespaceObservationErrorCode(error) },
              };
            }
          }),
        );
      const successful = providers.filter((bundle) => !bundle.error);
      const providerErrors: CodespaceProviderErrorView[] = providers
        .filter((bundle) => bundle.error)
        .map((bundle) => ({
          provider: bundle.provider ?? "unknown",
          error: { code: codespaceObservationErrorCode(bundle.error) },
        }));
      const preferred =
        successful.find(
          (bundle) => (bundle.connection as { state?: string } | undefined)?.state === "connected",
        ) ?? successful[0];
      let controllers: Awaited<
        ReturnType<NonNullable<CodespaceManagementServices["controllers"]>>
      > = [];
      try {
        controllers = (await selected.controllers?.(userId)) ?? [];
      } catch (error) {
        providerErrors.push({
          provider: "local-sandboxes",
          error: { code: codespaceObservationErrorCode(error) },
        });
      }
      return {
        ...preferred,
        controllers,
        providers,
        provider_errors: providerErrors,
        repositories: successful.flatMap((bundle) =>
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
        codespaces: successful.flatMap((bundle) => (bundle.codespaces ?? []) as unknown[]),
        unavailable: successful.flatMap((bundle) => (bundle.unavailable ?? []) as unknown[]),
        repositories_stale:
          providerErrors.length > 0 ||
          successful.some((bundle) => bundle.repositories_stale === true),
        resources_stale:
          providerErrors.length > 0 ||
          successful.some(
            (bundle) =>
              bundle.resources_stale === true ||
              (bundle.unavailable as unknown[] | undefined)?.length,
          ),
      };
    }
    const grants = refresh
      ? await selected.connection.refreshGrants(userId, { force: true })
      : await selected.connection.refreshGrants(userId);
    const resources =
      refresh &&
      !grants.stale &&
      selected.resource &&
      !(selected.resource instanceof GitHubResourceService)
        ? await selected.resource.refreshProviderState(userId, { authorizationFresh: true })
        : { stale: refresh && grants.stale };
    const listed = (await selected.resource?.listResources(userId)) ?? {
      codespaces: [],
      unavailable: [],
    };
    return {
      readiness: await selected.observability.readiness(),
      connection: selected.connection.getStatus(userId),
      repositories:
        (await selected.resource?.listRepositories(userId))?.map((repository) => ({
          repository_id: repository.id,
          name: repository.fullName,
          private: repository.private,
        })) ?? [],
      repositories_stale: grants.stale,
      resources_stale: resources.stale || listed.unavailable.length > 0,
      codespaces: listed.codespaces,
      unavailable: listed.unavailable,
      ...(selected.billing ? { provider_billing: await selected.billing(userId) } : {}),
      controllers: (await selected.controllers?.(userId)) ?? [],
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
        const created =
          selected.resource instanceof GitHubResourceService
            ? await selected.resource.create(userId, repositoryId, ref, req.body?.request_id, {
                deviceId: req.body?.device_id,
                devcontainerPath: req.body?.devcontainer_path,
              })
            : await selected.resource.create(userId, repositoryId, ref, req.body?.request_id);
        res.status(201).json({
          success: true,
          data: {
            codespace: created,
          },
        });
      } catch (error) {
        if (!handleError(userId, error, res)) throw error;
      }
    }),
  );

  router.post(
    "/adopt",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      try {
        const selected = services.select?.(userId, {}) ?? services;
        if (!(selected.resource instanceof GitHubResourceService))
          throw new CodespaceResourceError(
            "CODESPACE_PROVIDER_UNAVAILABLE",
            "GitHub provisioning is unavailable",
          );
        const input = z
          .object({
            provider_resource_name: z.string().min(1),
            request_id: z.string(),
            device_id: z.string().uuid().optional(),
          })
          .strict()
          .parse(req.body);
        const identity = await selected.resource.registerExisting(
          userId,
          input.provider_resource_name,
          { deviceId: input.device_id, requestId: input.request_id },
        );
        const codespace = await selected.resource.adopt(
          userId,
          identity.codespace_id,
          input.request_id,
          identity.generation,
          { deviceId: input.device_id },
        );
        res.json({
          success: true,
          data: { codespace, data_preserved: true },
        });
      } catch (error) {
        if (!handleError(userId, error, res)) throw error;
      }
    }),
  );
  router.post(
    "/:codespaceId/adopt",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      try {
        const id = z.string().uuid().parse(req.params.codespaceId),
          selected = services.select?.(userId, { codespaceId: id }) ?? services;
        if (!(selected.resource instanceof GitHubResourceService))
          throw new CodespaceResourceError(
            "CODESPACE_RESOURCE_INVALID",
            "Only a GitHub resource can be adopted",
          );
        const input = z
          .object({
            request_id: z.string(),
            expected_generation: z.number().int().positive(),
            device_id: z.string().uuid().optional(),
          })
          .strict()
          .parse(req.body);
        const codespace = await selected.resource.adopt(
          userId,
          id,
          input.request_id,
          input.expected_generation,
          { deviceId: input.device_id },
        );
        res.json({
          success: true,
          data: { codespace, data_preserved: true },
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
        const codespace = await selected.resource.getCodespace(userId, id);
        res.json({
          success: true,
          data: { codespace },
        });
      } catch (error) {
        if (!handleError(userId, error, res)) throw error;
      }
    }),
  );

  for (const action of ["start", "stop", "resume_setup"] as const) {
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
          if (
            action === "resume_setup" &&
            !(selected.resource instanceof LocalCodespaceResourceService)
          )
            throw new CodespaceResourceError(
              "CODESPACE_RESOURCE_INVALID",
              "Setup recovery requires an existing owned Local codespace.",
            );
          const codespace =
            action === "resume_setup" && selected.resource instanceof LocalCodespaceResourceService
              ? await selected.resource.resumeSetup(
                  userId,
                  id,
                  req.body?.request_id,
                  req.body?.expected_generation,
                )
              : action === "start"
                ? await selected.resource.startCodespace(
                    userId,
                    id,
                    req.body?.request_id,
                    req.body?.expected_generation,
                  )
                : await selected.resource.stopCodespace(
                    userId,
                    id,
                    req.body?.request_id,
                    req.body?.expected_generation,
                  );
          res.json({
            success: true,
            data: {
              codespace,
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
        const codespace = await selected.resource.deleteCodespace(userId, id, expectedGeneration, {
          ownerConfirmed: true,
          requestId: req.body?.request_id,
        });
        res.json({
          success: true,
          data: { codespace, data_preserved: false },
        });
      } catch (error) {
        if (!handleError(userId, error, res)) throw error;
      }
    }),
  );

  return router;
}

function publicMessage(code: string): string {
  const local = localCodespaceFailureGuidance(code);
  if (local) return local.message;
  switch (code) {
    case "WORKSPACE_OUTCOME_UNCONFIRMED":
      return "The owner outcome is unconfirmed; collect the original request before submitting another lifecycle action";
    case "CODESPACE_NOT_FOUND":
      return "Codespace was not found";
    case "CODESPACE_GENERATION_CONFLICT":
      return "The codespace changed; refresh and retry";
    case "CODESPACE_POLICY_LIMIT":
      return "A codespace quota or limit was reached";
    case "CODESPACE_START_TIMEOUT":
      return "The codespace is still starting; retry shortly";
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
