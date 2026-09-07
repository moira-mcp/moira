/** User-scoped communication channel discovery and test delivery. */

import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import {
  CommunicationChannelRegistry,
  DatabaseRepository,
  getActiveCommunicationChannelRegistry,
  getActiveUserCommunicationService,
  probeCommunicationChannelConfiguration,
  TrustedExtensionChannelApprovalService,
  type IDataRepository,
  type UserCommunicationService,
} from "@mcp-moira/workflow-engine";
import { getGlobalSettingsService } from "@mcp-moira/shared";
import { AuthenticatedRequest } from "../types/express-types.js";

export interface NotificationRouteDependencies {
  registry: CommunicationChannelRegistry;
  communicationService: Pick<UserCommunicationService, "testChannel">;
  createRepository(): IDataRepository;
  isTrustedApproved(channelId: string): Promise<boolean>;
  configurationDeadlineMs?: number;
}

export function createNotificationsRouter(dependencies: NotificationRouteDependencies): Router {
  const router = Router();

  router.get(
    "/channels",
    asyncHandler(async (req: Request, res: Response) => {
      const userId = (req as AuthenticatedRequest).userId;
      const repository = dependencies.createRepository();
      const configuration = {
        get: <T>(key: string) => repository.getSetting<T>(userId, key),
      };
      const data = await Promise.all(
        dependencies.registry.list().map(async (adapter) => {
          const enabledValue = adapter.metadata.enabledSetting
            ? await configuration.get<boolean>(adapter.metadata.enabledSetting)
            : true;
          const enabled = enabledValue !== false;
          let state: "ready" | "disabled" | "incomplete" | "unavailable" = enabled
            ? "incomplete"
            : "disabled";
          if (enabled) {
            const configurationState = await probeCommunicationChannelConfiguration(
              adapter,
              configuration,
              dependencies.configurationDeadlineMs,
            );
            state =
              configurationState === "configured"
                ? "ready"
                : configurationState === "not_configured"
                  ? "incomplete"
                  : "unavailable";
          }
          const trustedDeclared = adapter.metadata.trustedDeliveryDeclared === true;
          const trustedApproved =
            adapter.metadata.origin === "extension"
              ? await dependencies.isTrustedApproved(adapter.id)
              : false;
          return {
            id: adapter.id,
            title: adapter.metadata.title,
            description: adapter.metadata.description ?? null,
            origin: adapter.metadata.origin,
            extensionName: adapter.metadata.extensionName ?? null,
            extensionVersion: adapter.metadata.extensionVersion ?? null,
            settingKeys: [...new Set(adapter.metadata.settingKeys)],
            helpUrl: adapter.metadata.helpUrl ?? null,
            capabilities: {
              text: adapter.capabilities.text,
              image: adapter.capabilities.image,
              document: adapter.capabilities.document,
            },
            enabled,
            configured: state === "ready",
            available: state !== "unavailable",
            state,
            trustedDelivery:
              adapter.metadata.origin === "extension"
                ? {
                    declared: trustedDeclared,
                    approved: trustedApproved,
                    eligible: trustedDeclared && trustedApproved && state === "ready",
                  }
                : null,
          };
        }),
      );
      res.json({ success: true, data, timestamp: new Date().toISOString() });
    }),
  );

  router.post(
    "/channels/:channelId/test",
    asyncHandler(async (req: Request, res: Response) => {
      const bodyIsEmptyObject =
        req.body &&
        typeof req.body === "object" &&
        !Array.isArray(req.body) &&
        Object.keys(req.body).length === 0;
      if (req.body !== undefined && !bodyIsEmptyObject) {
        throw createApiError.validationFailed("Channel tests do not accept request fields");
      }
      const userId = (req as AuthenticatedRequest).userId;
      const result = await dependencies.communicationService.testChannel(
        req.params.channelId,
        userId,
        dependencies.createRepository(),
      );
      if (!result) throw createApiError.notFound("Communication channel not found");
      res.json({ success: true, data: result, timestamp: new Date().toISOString() });
    }),
  );

  return router;
}

export default createNotificationsRouter({
  registry: getActiveCommunicationChannelRegistry(),
  communicationService: getActiveUserCommunicationService(),
  createRepository: () => new DatabaseRepository(),
  isTrustedApproved: (channelId) =>
    new TrustedExtensionChannelApprovalService(getGlobalSettingsService()).isApproved(channelId),
});
