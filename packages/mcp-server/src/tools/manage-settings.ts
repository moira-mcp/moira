/**
 * MCP Tool: Manage Settings
 * Manage user settings with action-based routing
 */

import { MCPEngine } from "../core/mcp-engine.js";
import { ToolResult, WorkflowSpecificParams } from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import { ERRORS, formatError, formatErrorWithAgentInstructions } from "../messages/index.js";
import {
  logAuditEventDirect,
  AuditAction,
  createLogger,
  normalizeError,
  isOperationalError,
} from "@mcp-moira/shared";
import type { DatabaseRepository } from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "ManageSettings" });

type ManageSettingsAction = "get" | "set" | "list";

interface ManageSettingsParams extends WorkflowSpecificParams {
  action: ManageSettingsAction;
  category?: string;
  key?: string;
  value?: unknown;
}

// Minimal setting definition for agent response
interface MinimalSettingDef {
  key: string;
  description: string | null | undefined;
}

type SettingsData =
  | Record<string, unknown>
  | { key: string; updated: boolean }
  | MinimalSettingDef[];

export async function manageSettings(
  params: ManageSettingsParams,
): Promise<ToolResult<SettingsData>> {
  try {
    const { userId } = getUserContext();
    const repository = MCPEngine.getInstance().repository;
    const { action } = params;

    switch (action) {
      case "get": {
        // Get user settings by category or all
        // Uses getSettingsForApi to mask encrypted values (Issue #374)
        const settings = await repository.getSettingsForApi(userId, params.category);

        // Audit log for settings read
        await logAuditEventDirect(repository as unknown as DatabaseRepository, {
          userId,
          action: AuditAction.MCP_SETTINGS_READ,
          resource: "settings",
          resourceId: params.category || "all",
          source: "mcp",
          metadata: { action: "get", category: params.category },
        });

        return { success: true, data: settings };
      }

      case "set": {
        // Set user setting value with validation and encryption
        if (!params.key) {
          return { success: false, error: ERRORS.setting_key_required };
        }

        // Get definition for validation
        const definition = await repository.getSettingDefinition(params.key);
        if (!definition) {
          return { success: false, error: ERRORS.setting_not_found(params.key) };
        }

        // Check admin-only settings
        if (definition.adminOnly) {
          const { getDatabase, user } = await import("@mcp-moira/shared");
          const { eq } = await import("drizzle-orm");
          const db = getDatabase();

          const [userRecord] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
          if (!userRecord || !userRecord.isAdmin) {
            return { success: false, error: ERRORS.admin_only_setting(params.key) };
          }
        }

        // Set setting (validation and encryption handled by repository)
        await repository.setSetting(userId, params.key, params.value);

        // Register Telegram webhook when bot token is saved via MCP
        if (params.key === "telegram.bot_token" && params.value) {
          const { getBaseUrl, createLogger, Component } = await import("@mcp-moira/shared");
          const settingsLogger = createLogger({ component: Component.Settings });
          try {
            const { TelegramClient } = await import("@mcp-moira/workflow-engine");
            const { randomBytes } = await import("node:crypto");
            const baseUrl = getBaseUrl();
            const webhookUrl = `${baseUrl}/api/telegram/webhook`;
            // Generate and store a webhook secret for origin validation
            const webhookSecret = randomBytes(32).toString("hex");
            await repository.setSetting(userId, "telegram.webhook_secret", webhookSecret);
            const client = new TelegramClient({ botToken: params.value as string });
            await client.setWebhook(webhookUrl, ["callback_query"], webhookSecret);
          } catch (webhookError) {
            settingsLogger.warn("Failed to register Telegram webhook via MCP", {
              error: String(webhookError),
              userId,
            });
          }
        }

        // Audit log for settings update
        await logAuditEventDirect(repository as unknown as DatabaseRepository, {
          userId,
          action: AuditAction.SETTINGS_SET,
          resource: "settings",
          resourceId: params.key,
          source: "mcp",
          metadata: { key: params.key },
        });

        return {
          success: true,
          data: { key: params.key, updated: true },
        };
      }

      case "list": {
        // List setting definitions - minimal response for agents
        const definitions = await repository.getSettingDefinitions(params.category);
        const cleanDefinitions = definitions.map((def) => ({
          key: def.key,
          description: def.description,
        }));

        // Audit log for settings list
        await logAuditEventDirect(repository as unknown as DatabaseRepository, {
          userId,
          action: AuditAction.MCP_SETTINGS_READ,
          resource: "settings",
          resourceId: params.category || "all",
          source: "mcp",
          metadata: { action: "list", category: params.category },
        });

        return { success: true, data: cleanDefinitions };
      }

      default: {
        return {
          success: false,
          error: ERRORS.unknown_action_with_valid(action, "get, set, list"),
        };
      }
    }
  } catch (error) {
    // Normalize to AppError for consistent handling
    const appError = normalizeError(error);

    // LOG ONCE at boundary - use appropriate level based on error type
    // Operational errors (user errors) = WARN, Programmer errors = ERROR
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel]("Failed to manage settings", appError, {
      action: params.action,
      key: params.key,
      code: appError.code,
      isOperational: appError.isOperational,
    });

    // Add contextual hints and AGENT INSTRUCTIONS based on error type
    let enhancedError: string;
    if (
      appError.message.includes("admin") ||
      appError.message.includes("permission") ||
      appError.message.includes("read-only")
    ) {
      enhancedError = formatError(appError.message, "settings_troubleshooting", "access_denied");
    } else {
      // Use auto-detection for all other errors
      enhancedError = formatErrorWithAgentInstructions(appError.message);
    }

    return {
      success: false,
      error: enhancedError,
    };
  }
}
