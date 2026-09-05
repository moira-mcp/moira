/**
 * MCP Tool: Manage Settings
 * Manage user settings with action-based routing
 */

import { MCPEngine } from "../core/mcp-engine.js";
import { ToolResult } from "./interfaces/tool-interface.js";
import { settingsSchema } from "./tool-schemas.js";
import type { z } from "zod";
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

type ManageSettingsParams = z.infer<typeof settingsSchema>;

// Minimal setting definition for agent response
interface MinimalSettingDef {
  key: string;
  description: string | null | undefined;
}

type SettingsData =
  Record<string, unknown> | { key: string; updated: boolean } | MinimalSettingDef[];

interface SettingsReadRepository {
  getSettingsForApi(userId: string, category?: string): Promise<Record<string, unknown>>;
}

async function isAdminUser(userId: string): Promise<boolean> {
  const { getDatabase, user } = await import("@mcp-moira/shared");
  const { eq } = await import("drizzle-orm");
  const [userRecord] = await getDatabase()
    .select({ isAdmin: user.isAdmin })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return userRecord?.isAdmin === true;
}

export async function readSettingsForMcp(
  repository: SettingsReadRepository,
  userId: string,
  category?: string,
  key?: string,
  hiddenKeys: readonly string[] = [],
): Promise<ToolResult<SettingsData>> {
  const settings = await repository.getSettingsForApi(userId, category);
  const visibleSettings = Object.fromEntries(
    Object.entries(settings).filter(([settingKey]) => !hiddenKeys.includes(settingKey)),
  );
  const selected = key
    ? Object.prototype.hasOwnProperty.call(visibleSettings, key)
      ? { [key]: visibleSettings[key] }
      : {}
    : visibleSettings;

  await logAuditEventDirect(repository as unknown as DatabaseRepository, {
    userId,
    action: AuditAction.MCP_SETTINGS_READ,
    resource: "settings",
    resourceId: key ?? category ?? "all",
    source: "mcp",
    metadata: { action: "get", category, key },
  });

  return { success: true, data: selected };
}

export async function manageSettings(
  params: ManageSettingsParams,
): Promise<ToolResult<SettingsData>> {
  try {
    const { userId } = getUserContext();
    const repository = MCPEngine.getInstance().repository;
    const { action } = params;

    switch (action) {
      case "get": {
        const { key, category } = params;
        const hasKey = key !== undefined;
        const hasCategory = category !== undefined;

        if (hasKey && hasCategory) {
          return { success: false, error: "Use either key or category for get, not both" };
        }

        if (hasKey) {
          if (key.trim().length === 0) {
            return { success: false, error: "Setting key cannot be empty" };
          }
          const definition = await repository.getSettingDefinition(key);
          if (!definition) {
            return { success: false, error: ERRORS.setting_not_found(key) };
          }
          if (definition.adminOnly && !(await isAdminUser(userId))) {
            return { success: false, error: ERRORS.admin_only_setting(key) };
          }
          return readSettingsForMcp(repository, userId, definition.category, key);
        }

        if (hasCategory && category.trim().length === 0) {
          return { success: false, error: "Setting category cannot be empty" };
        }

        // Uses getSettingsForApi to mask encrypted values (Issue #374).
        // Admin-only values stay outside non-admin MCP reads, as in the user settings API.
        const definitions = await repository.getSettingDefinitions(category);
        const adminOnlyKeys = definitions.filter((definition) => definition.adminOnly);
        const hiddenKeys =
          adminOnlyKeys.length > 0 && !(await isAdminUser(userId))
            ? adminOnlyKeys.map((definition) => definition.key)
            : [];
        return readSettingsForMcp(repository, userId, category, undefined, hiddenKeys);
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
        if (definition.adminOnly && !(await isAdminUser(userId))) {
          return { success: false, error: ERRORS.admin_only_setting(params.key) };
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
        if (params.category !== undefined && params.category.trim().length === 0) {
          return { success: false, error: "Setting category cannot be empty" };
        }
        // List setting definitions - minimal response for agents
        let definitions = await repository.getSettingDefinitions(params.category);
        if (
          definitions.some((definition) => definition.adminOnly) &&
          !(await isAdminUser(userId))
        ) {
          definitions = definitions.filter((definition) => !definition.adminOnly);
        }
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
