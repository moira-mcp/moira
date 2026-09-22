#!/usr/bin/env node
/**
 * Seed Initial Setting Definitions
 * Creates default settings catalog via SettingsRepository
 */

import {
  CODESPACE_AUTO_STOP_SETTING,
  CODESPACE_IDLE_TIMEOUT_MINUTES,
  CODESPACE_IDLE_TIMEOUT_SETTING,
  getDatabase,
  SettingsRepository,
  createLogger,
  Service,
  setGlobalService,
} from "@mcp-moira/shared";
import type { SettingDefinition } from "@mcp-moira/workflow-engine";

// Set global service for this script process
setGlobalService(Service.WEB_BACKEND);

const logger = createLogger({ component: "SeedSettings" });

/**
 * Definitions the installation seeds. Exported so that checks about built-in setting namespaces
 * compare against the real list instead of a copy that can fall behind it.
 */
export const initialDefinitions: Omit<SettingDefinition, "createdAt" | "updatedAt">[] = [
  // ===== Telegram / Notification Settings =====
  {
    key: "telegram.bot_token",
    type: "encrypted",
    category: "notifications",
    label: "Bot Token",
    description: "Your Telegram bot token from @BotFather",
    defaultValue: null,
    required: false,
    validation: null,
    adminOnly: false,
    protected: true, // Critical system setting
  },
  {
    key: "telegram.chat_id",
    type: "string",
    category: "notifications",
    label: "Chat ID",
    description: "Your Telegram chat ID for notifications",
    defaultValue: null,
    required: false,
    validation: null,
    adminOnly: false,
    protected: true, // Critical system setting
  },
  {
    key: "telegram.enabled",
    type: "boolean",
    category: "notifications",
    label: "Enable Notifications",
    description: "Enable or disable Telegram notifications",
    defaultValue: "true",
    required: false,
    validation: null,
    adminOnly: false,
    protected: true, // Critical system setting
  },

  // ===== UI Settings =====
  {
    key: "ui.theme",
    type: "string",
    category: "ui",
    label: "Theme",
    description: "Color theme preference (light, dark, or system)",
    defaultValue: "system",
    required: false,
    validation: JSON.stringify({
      type: "string",
      enum: ["light", "dark", "system"],
    }),
    adminOnly: false,
    protected: false, // User setting, can be deleted
  },

  // ===== Profile Settings =====
  {
    key: "profile.display_name",
    type: "string",
    category: "profile",
    label: "Display Name",
    description: "Your display name (overrides Better Auth name)",
    defaultValue: null,
    required: false,
    validation: JSON.stringify({
      type: "string",
      minLength: 1,
      maxLength: 100,
    }),
    adminOnly: false,
    protected: false, // User setting, can be deleted
  },

  // ===== Codespace Settings =====
  {
    key: CODESPACE_AUTO_STOP_SETTING,
    type: "boolean",
    category: "codespaces",
    label: "Pause idle codespaces",
    description:
      "Stop a cloud codespace when no agent has used it through Moira (commands, file operations, transfers) for the idle timeout. A stopped codespace keeps its files and starts again when an agent next uses it. Moira does not see direct use in the browser or an editor, so turn this off if you work in your codespaces directly; GitHub still stops an idle codespace after at most 240 minutes either way.",
    defaultValue: "true",
    required: false,
    validation: null,
    adminOnly: false,
    protected: true,
  },
  {
    key: CODESPACE_IDLE_TIMEOUT_SETTING,
    type: "number",
    category: "codespaces",
    label: "Idle timeout (minutes)",
    description:
      "How long a codespace may go without agent activity through Moira (commands, file operations, transfers) before it is paused. Direct use in the browser or an editor is not seen and does not count. GitHub stops an idle codespace after at most 240 minutes regardless of this setting.",
    defaultValue: String(CODESPACE_IDLE_TIMEOUT_MINUTES.default),
    required: false,
    validation: JSON.stringify({
      type: "number",
      minimum: CODESPACE_IDLE_TIMEOUT_MINUTES.minimum,
      maximum: CODESPACE_IDLE_TIMEOUT_MINUTES.maximum,
    }),
    adminOnly: false,
    protected: true,
  },

  // ===== MCP Settings (Admin Only) =====
  {
    key: "mcp.systemReminder",
    type: "string",
    category: "mcp",
    label: "System Reminder",
    description:
      "Global system reminder appended to all workflow step responses. Supports multi-line text.",
    defaultValue: null,
    required: false,
    validation: JSON.stringify({
      type: "string",
      maxLength: 10000,
    }),
    adminOnly: true,
    protected: true, // Critical MCP setting
  },
];

export async function seedSettingDefinitions() {
  logger.info("Seeding initial setting definitions...");

  const db = getDatabase();
  const settingsRepo = new SettingsRepository(db);

  for (const def of initialDefinitions) {
    try {
      // Check if already exists
      const existing = await settingsRepo.getSettingDefinition(def.key);

      if (existing) {
        logger.info("Setting definition already exists, skipping", { key: def.key });
        continue;
      }

      // Create new definition via repository
      // Repository handles timestamp creation internally
      await settingsRepo.createSettingDefinition(def);

      logger.info("Setting definition created", { key: def.key, category: def.category });
    } catch (error) {
      logger.error("Failed to seed setting definition", error, { key: def.key });
      throw error;
    }
  }

  logger.info("Setting definitions seeded successfully", { count: initialDefinitions.length });
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  seedSettingDefinitions()
    .then(() => {
      logger.info("Seed completed");
      process.exit(0);
    })
    .catch((error) => {
      logger.error("Seed failed", error);
      process.exit(1);
    });
}
