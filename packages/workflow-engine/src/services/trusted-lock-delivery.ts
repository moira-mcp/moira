import {
  createLogger,
  getLockService,
  ValidationError,
  type LockDeliverySecret,
} from "@mcp-moira/shared";
import type { IDataRepository } from "../interfaces/data-repository.js";
import { buildApproveKeyboard } from "../types/telegram-types.js";
import { getTelegramClient } from "./telegram-client-factory.js";
import type { TelegramClient } from "./telegram-client.js";

const logger = createLogger({ component: "TrustedLockDelivery" });

export type TrustedLockConfigurationFailure = "missing" | "invalid";

export type TrustedLockConfigurationResult =
  { configured: true } | { configured: false; reason: TrustedLockConfigurationFailure };

interface TrustedLockDeliveryClient {
  sendMessage: TelegramClient["sendMessage"];
}

interface TrustedLockService {
  createLockWithDelivery(
    options: {
      executionId: string;
      nodeId: string;
      reason: string;
      lockedBy: string;
    },
    deliver: (secret: LockDeliverySecret) => Promise<void>,
  ): Promise<{ lockId: string }>;
}

export interface TrustedLockDeliveryDependencies {
  lockService?: TrustedLockService;
  clientFactory?: (botToken?: string, chatId?: string) => TrustedLockDeliveryClient | null;
  logger?: {
    info(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
  };
}

export interface CreateTrustedExecutionLockOptions {
  executionId: string;
  workflowId: string;
  nodeId: string;
  reason: string;
  userId: string;
}

interface ResolvedTelegramDelivery {
  client: TrustedLockDeliveryClient;
  chatId: string;
}

export class TrustedLockDeliveryError extends ValidationError {
  constructor(reason: "missing" | "invalid" | "delivery_failed") {
    const message =
      reason === "missing"
        ? "Trusted Telegram PIN delivery is not configured. Configure Telegram and retry."
        : reason === "invalid"
          ? "Trusted Telegram PIN delivery configuration is invalid. Reconfigure Telegram and retry."
          : "Trusted Telegram PIN delivery failed. No usable lock was created; retry when delivery is available.";
    super(message, { trustedLockDeliveryFailure: reason });
    this.name = "TrustedLockDeliveryError";
  }
}

async function resolveTelegramDelivery(
  repository: IDataRepository,
  userId: string,
  dependencies: TrustedLockDeliveryDependencies = {},
): Promise<ResolvedTelegramDelivery> {
  let botToken: string | null;
  let chatId: string | null;
  try {
    botToken = await repository.getSetting<string>(userId, "telegram.bot_token");
    chatId = await repository.getSetting<string>(userId, "telegram.chat_id");
  } catch {
    throw new TrustedLockDeliveryError("missing");
  }
  if (!botToken || !chatId) {
    throw new TrustedLockDeliveryError("missing");
  }

  try {
    const client = (dependencies.clientFactory ?? getTelegramClient)(botToken, chatId);
    if (!client) throw new Error("Telegram client unavailable");
    return { client, chatId };
  } catch {
    throw new TrustedLockDeliveryError("invalid");
  }
}

export async function checkTrustedLockDeliveryConfiguration(
  repository: IDataRepository,
  userId: string,
  dependencies: TrustedLockDeliveryDependencies = {},
): Promise<TrustedLockConfigurationResult> {
  try {
    await resolveTelegramDelivery(repository, userId, dependencies);
    return { configured: true };
  } catch (error) {
    if (error instanceof TrustedLockDeliveryError) {
      const reason = error.context?.trustedLockDeliveryFailure;
      if (reason === "missing" || reason === "invalid") {
        return { configured: false, reason };
      }
    }
    return { configured: false, reason: "invalid" };
  }
}

export async function createTrustedExecutionLock(
  repository: IDataRepository,
  options: CreateTrustedExecutionLockOptions,
  dependencies: TrustedLockDeliveryDependencies = {},
): Promise<{ lockId: string }> {
  const operationLogger = dependencies.logger ?? logger;
  const { client, chatId } = await resolveTelegramDelivery(
    repository,
    options.userId,
    dependencies,
  );

  let workflowName = options.workflowId;
  try {
    const workflow = await repository.getWorkflow(options.workflowId, options.userId);
    if (workflow?.metadata.name) workflowName = workflow.metadata.name;
  } catch {
    // The workflow identity is only presentation metadata for the trusted message.
  }

  const lockService = dependencies.lockService ?? getLockService();
  try {
    return await lockService.createLockWithDelivery(
      {
        executionId: options.executionId,
        nodeId: options.nodeId,
        reason: options.reason,
        lockedBy: options.userId,
      },
      async ({ lockId, pin }) => {
        const message =
          `🔒 Execution Lock\n\n` +
          `Reason: ${options.reason}\n` +
          `PIN: ${pin}\n\n` +
          `---\n📋 Process: ${options.executionId.substring(0, 8)}\n` +
          `🔄 Workflow: ${workflowName}\n🤖 via MCP Moira`;

        await client.sendMessage({
          chatId,
          text: message,
          replyMarkup: buildApproveKeyboard(options.executionId, options.nodeId),
        });

        operationLogger.info("Lock PIN delivered through trusted Telegram destination", {
          lockId,
          executionId: options.executionId,
          nodeId: options.nodeId,
        });
      },
    );
  } catch {
    operationLogger.warn("Trusted lock delivery attempt failed", {
      executionId: options.executionId,
      nodeId: options.nodeId,
      failureType: "delivery_error",
    });
    throw new TrustedLockDeliveryError("delivery_failed");
  }
}
