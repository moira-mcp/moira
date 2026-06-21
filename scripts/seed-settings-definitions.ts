#!/usr/bin/env node
/**
 * Seed Initial Setting Definitions
 * Creates default settings catalog via SettingsRepository
 */

import {
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

const initialDefinitions: Omit<SettingDefinition, "createdAt" | "updatedAt">[] = [
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
