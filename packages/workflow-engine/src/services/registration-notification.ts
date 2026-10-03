import {
  createLogger,
  getAccountAccessDenial,
  getAppPrefix,
  getBaseUrl,
  getDatabase,
  getGlobalSettingsService,
  UserRepository,
  type SuccessfulRegistration,
} from "@mcp-moira/shared";
import type { IDataRepository } from "../interfaces/data-repository.js";
import { DatabaseRepository } from "../storage/database-repository.js";
import { getActiveUserCommunicationService } from "./user-communication-provider.js";
import type { UserCommunicationService } from "./user-communication.js";

export const REGISTRATION_NOTIFICATION_SETTING = "system.notify_admins_on_registration";

export interface RegistrationNotificationDependencies {
  getEnabled(): Promise<boolean | null>;
  getRecipients(): ReturnType<UserRepository["getAdminNotificationRecipients"]>;
  createRepository(): IDataRepository;
  communication: Pick<UserCommunicationService, "deliverChannel" | "maxTextLength">;
  getBaseUrl(): string;
  getAppPrefix(): string;
  logger: Pick<ReturnType<typeof createLogger>, "info" | "warn">;
}

function defaultDependencies(): RegistrationNotificationDependencies {
  return {
    getEnabled: () =>
      getGlobalSettingsService().getValue<boolean>(REGISTRATION_NOTIFICATION_SETTING),
    getRecipients: () => new UserRepository(getDatabase()).getAdminNotificationRecipients(),
    createRepository: () => new DatabaseRepository(),
    communication: getActiveUserCommunicationService(),
    getBaseUrl,
    getAppPrefix,
    logger: createLogger({ component: "RegistrationNotification" }),
  };
}

/** A confirmed creation is attempted once per admitted administrator; provider failure never escapes. */
export async function notifyAdminsOfRegistration(
  registration: SuccessfulRegistration,
  suppliedDependencies?: RegistrationNotificationDependencies,
): Promise<void> {
  let logger: RegistrationNotificationDependencies["logger"] | undefined;
  try {
    const dependencies = suppliedDependencies ?? defaultDependencies();
    logger = dependencies.logger;
    if ((await dependencies.getEnabled()) !== true) return;
    const recipients = await dependencies.getRecipients();
    const repository = dependencies.createRepository();
    const url = `${dependencies.getBaseUrl()}${dependencies.getAppPrefix()}/admin/users/${encodeURIComponent(registration.id)}`;
    const clean = (text: string) => text.replace(/[\r\n\t]/g, " ");
    const details = `\nEmail: ${clean(registration.email)}\nRegistered: ${new Date(registration.createdAt).toISOString()}\nAccount: ${url}`;
    const heading = "New account registered\nName: ";
    const nameBudget = Math.max(
      0,
      dependencies.communication.maxTextLength - heading.length - details.length,
    );
    const text = heading + clean(registration.name ?? "—").slice(0, nameBudget) + details;
    for (const recipient of recipients) {
      if (
        !recipient.isAdmin ||
        getAccountAccessDenial(
          { ...recipient, userId: recipient.id },
          { requireEmailVerified: true },
        )
      )
        continue;
      try {
        const result = await dependencies.communication.deliverChannel(
          "telegram",
          { userId: recipient.id, text, format: "plain", purpose: "notification" },
          repository,
        );
        logger.info("Registration notification completed", {
          recipientId: recipient.id,
          status: result?.status ?? "no_configured_channels",
          deliveredChannels: result?.deliveredChannels ?? 0,
        });
      } catch {
        logger.warn("Registration notification failed", {
          recipientId: recipient.id,
          status: "failed",
        });
      }
    }
  } catch {
    logger?.warn("Registration notification unavailable", { status: "failed" });
  }
}
