import { Router } from "express";
import { z } from "zod";
import {
  decodeReference,
  encodeReference,
  isReference,
} from "@mcp-moira/shared/workspace-references";
import { WORKSPACE_TOOL_SCHEMAS } from "@mcp-moira/shared/workspace-tool-schemas";
import {
  CodespaceConnectionError,
  LocalDeviceError,
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
import { getWorkspaceSemanticServices } from "../services/workspace-semantic-service.js";
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
  semantic: Pick<
    ReturnType<typeof getWorkspaceSemanticServices>,
    "invoke" | "project" | "projectUnavailable" | "controllerIdentity"
  >;
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
    "listRepositories" | "listResources" | "refreshProviderState" | "getCodespace"
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

function defaultServices(): CodespaceManagementServices {
  const semantic = getWorkspaceSemanticServices();
  return {
    semantic,
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
    providers: getCodespaceProviderBundles().map((provider) => ({ ...provider, semantic })),
    select: (userId, input) => ({ ...selectCodespaceProviderServices(userId, input), semantic }),
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

  const repositoryTargets = (
    userId: string,
    provider: string,
    repositories: Record<string, unknown>[],
    controllers: Array<{ device_id: string; label: string; available: boolean }>,
  ) =>
    repositories.flatMap((repository) => {
      const candidates =
        provider === "local-sandboxes"
          ? [
              services.semantic.controllerIdentity(
                userId,
                parseLocalRepositoryTargetId(String(repository.repository_id)).deviceId,
              ),
            ]
          : controllers
              .filter((controller) => controller.available)
              .map((controller) =>
                services.semantic.controllerIdentity(userId, controller.device_id),
              );
      return candidates.map((controller) => ({
        ...repository,
        provider,
        controller: encodeReference("controller", controller),
        target: encodeReference("target", {
          provider: provider as "local-sandboxes" | "github-codespaces",
          repositoryId: String(repository.repository_id),
          controller,
        }),
        device_id: controller.deviceId,
        ...(provider === "local-sandboxes"
          ? services.repositoryMetadata?.(userId, String(repository.repository_id))
          : {}),
      }));
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
    if (error instanceof LocalDeviceError) {
      const status = {
        LOCAL_UNAUTHORIZED: 401,
        LOCAL_CONFLICT: 409,
        LOCAL_EXPIRED: 410,
        LOCAL_INVALID: 400,
        LOCAL_UNAVAILABLE: 503,
        LOCAL_OUTCOME_UNCONFIRMED: 409,
      }[error.code];
      res.status(status).json({
        success: false,
        error: {
          code: error.code,
          message:
            error.code === "LOCAL_OUTCOME_UNCONFIRMED"
              ? "The owner outcome is unconfirmed; inspect the original operation before choosing another action"
              : "The selected computer cannot authorize this request",
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
        controllers: controllers.map((controller) => ({
          ...controller,
          controller: encodeReference(
            "controller",
            services.semantic.controllerIdentity(userId, controller.device_id),
          ),
        })),
        providers: providers.map((bundle) =>
          "error" in bundle
            ? bundle
            : {
                ...bundle,
                repositories: repositoryTargets(
                  userId,
                  String(bundle.provider),
                  (bundle.repositories ?? []) as Record<string, unknown>[],
                  controllers,
                ),
              },
        ),
        provider_errors: providerErrors,
        repositories: successful.flatMap((bundle) =>
          repositoryTargets(
            userId,
            String(bundle.provider),
            (bundle.repositories ?? []) as Record<string, unknown>[],
            controllers,
          ),
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
      codespaces: listed.codespaces.map((codespace) => ({
        ...services.semantic.project(userId, codespace),
        codespace_id: codespace.codespace_id,
        ...(codespace.device_id
          ? {
              controller: encodeReference(
                "controller",
                services.semantic.controllerIdentity(userId, codespace.device_id),
              ),
            }
          : {}),
      })),
      unavailable: listed.unavailable.map((resource) => ({
        ...services.semantic.projectUnavailable(userId, resource),
        codespace_id: resource.codespace_id,
      })),
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
    "/operations/:purpose",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      try {
        const purpose = z
          .enum([
            "workspace_create",
            "workspace_lifecycle",
            "workspace_delete",
            "workspace_observe",
            "workspace_adopt",
            "workspace_adopt_external",
            "operation_get",
            "operation_find",
          ])
          .parse(req.params.purpose);
        const input = WORKSPACE_TOOL_SCHEMAS[purpose].parse(req.body);
        const result = await services.semantic.invoke(
          userId,
          purpose,
          input,
          undefined,
          purpose === "workspace_delete" ? { ownerConfirmed: true } : undefined,
        );
        const webWorkspace = (value: unknown) => {
          if (
            !value ||
            typeof value !== "object" ||
            !("workspace" in value) ||
            !isReference(value.workspace, "workspace")
          )
            return value;
          const reference = decodeReference(value.workspace, "workspace");
          return {
            ...value,
            codespace_id: reference.resourceId,
            ...(reference.deviceId
              ? {
                  controller: encodeReference(
                    "controller",
                    services.semantic.controllerIdentity(userId, reference.deviceId),
                  ),
                }
              : {}),
          };
        };
        const direct = webWorkspace(result);
        const data =
          direct && typeof direct === "object"
            ? {
                ...direct,
                ...("original" in direct ? { original: webWorkspace(direct.original) } : {}),
                ...("outcome" in direct &&
                direct.outcome &&
                typeof direct.outcome === "object" &&
                "result" in direct.outcome
                  ? { outcome: { ...direct.outcome, result: webWorkspace(direct.outcome.result) } }
                  : {}),
              }
            : direct;
        res.json({ success: true, data });
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
      return "The owner outcome is unconfirmed; collect or discover the original operation before choosing another action";
    case "CODESPACE_NOT_FOUND":
      return "Codespace was not found";
    case "CODESPACE_GENERATION_CONFLICT":
      return "The environment changed; inspect a new observation and make a new explicit decision";
    case "CODESPACE_POLICY_LIMIT":
      return "A codespace quota or limit was reached";
    case "CODESPACE_START_TIMEOUT":
      return "Readiness is not confirmed; collect the original operation without starting another action";
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
