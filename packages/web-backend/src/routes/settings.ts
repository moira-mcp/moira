/**
 * Settings API Routes
 * User settings management with authentication
 */

import { Router, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { maskEncryptedValue, TelegramClient } from "@mcp-moira/workflow-engine";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { checkAdminRole } from "../utils/admin-utils.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import { getSettingsService, getBaseUrl, createLogger, Component } from "@mcp-moira/shared";

const router = Router();
const repository = new DatabaseRepository();

// Get SettingsService for operations with automatic audit
const settingsService = getSettingsService();

/**
 * GET /api/settings - Get all user settings
 * Returns all settings across all categories
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId; // From requireAuth middleware

    // Get all setting definitions to find all categories
    const allDefinitions = await repository.getSettingDefinitions();
    const categories = Array.from(new Set(allDefinitions.map((d) => d.category)));

    // Get settings from all categories
    const allSettings: Record<string, unknown> = {};

    for (const category of categories) {
      const categorySettings = await repository.getSettings(userId, category);
      Object.assign(allSettings, categorySettings);
    }

    res.json({
      success: true,
      data: allSettings,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * PUT /api/settings - Update user settings (bulk update)
 * Body: { key1: value1, key2: value2, ... }
 */
router.put(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const updates = req.body;

    // Update each setting via service (handles audit automatically)
    for (const [key, value] of Object.entries(updates)) {
      await settingsService.set(userId, key, value);
    }

    // Register Telegram webhook if bot token was updated in bulk
    if (updates["telegram.bot_token"]) {
      const settingsLogger = createLogger({ component: Component.Settings });
      try {
        const baseUrl = getBaseUrl();
        const webhookUrl = `${baseUrl}/api/telegram/webhook`;
        const webhookSecret = randomBytes(32).toString("hex");
        await settingsService.set(userId, "telegram.webhook_secret", webhookSecret);
        const client = new TelegramClient({ botToken: updates["telegram.bot_token"] as string });
        await client.setWebhook(webhookUrl, ["callback_query"], webhookSecret);
        settingsLogger.info("Telegram webhook registered (bulk)", { webhookUrl, userId });
      } catch (webhookError) {
        settingsLogger.warn("Failed to register Telegram webhook (bulk)", {
          error: String(webhookError),
          userId,
        });
      }
    }

    res.json({
      success: true,
      data: updates,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/settings/definitions - List setting definitions
 * Query params: category (optional)
 * This endpoint is for USER settings page - always filters out adminOnly definitions
 * Admin settings are managed via /api/admin/settings/definitions
 */
router.get(
  "/definitions",
  asyncHandler(async (req: Request, res: Response) => {
    const { category } = req.query;

    let definitions = await repository.getSettingDefinitions(category as string);

    // Always filter out adminOnly definitions - this is user settings endpoint
    // Admin settings are managed separately via /api/admin/* routes
    definitions = definitions.filter((def) => !def.adminOnly);

    res.json({
      success: true,
      data: definitions,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/settings/:category - Get user settings for category
 */
router.get(
  "/:category",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId; // From requireAuth middleware
    const { category } = req.params;

    const settings = await repository.getSettings(userId, category);

    // Mask encrypted values for response
    const definitions = await repository.getSettingDefinitions(category);
    const maskedSettings: Record<string, unknown> = {};

    for (const def of definitions) {
      if (settings[def.key] !== undefined) {
        if (def.type === "encrypted") {
          // Get raw encrypted value from DB to mask it
          const rawValue = await repository.getRawSettingValue(userId, def.key);
          maskedSettings[def.key] = rawValue ? maskEncryptedValue(rawValue) : null;
        } else {
          maskedSettings[def.key] = settings[def.key];
        }
      }
    }

    res.json({
      success: true,
      data: maskedSettings,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * PUT /api/settings/:key - Update setting value
 */
router.put(
  "/:key",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      throw createApiError.validationFailed("Value is required");
    }

    // Get definition to validate
    const definition = await repository.getSettingDefinition(key);

    if (!definition) {
      throw createApiError.notFound(`Setting definition not found: ${key}`, { key });
    }

    // Check if admin-only
    if (definition.adminOnly) {
      const isAdmin = await checkAdminRole(userId);
      if (!isAdmin) {
        throw createApiError.unauthorized("Admin permission required for this setting");
      }
    }

    // Basic validation against definition.validation schema
    if (definition.validation) {
      try {
        const schema = JSON.parse(definition.validation);

        // Type validation
        if (schema.type && typeof value !== schema.type) {
          throw createApiError.validationFailed(
            `Invalid type: expected ${schema.type}, got ${typeof value}`,
          );
        }

        // Enum validation
        if (schema.enum && !schema.enum.includes(value)) {
          throw createApiError.validationFailed(
            `Invalid value: must be one of ${schema.enum.join(", ")}`,
          );
        }

        // String length validation
        if (schema.minLength && typeof value === "string" && value.length < schema.minLength) {
          throw createApiError.validationFailed(
            `Value too short: minimum length ${schema.minLength}`,
          );
        }

        if (schema.maxLength && typeof value === "string" && value.length > schema.maxLength) {
          throw createApiError.validationFailed(
            `Value too long: maximum length ${schema.maxLength}`,
          );
        }
      } catch (error) {
        // Re-throw validation errors (they should not be swallowed)
        if (error instanceof Error && "statusCode" in error) {
          throw error;
        }
        // Invalid validation schema (JSON parse error etc.) - skip validation
      }
    }

    // Save setting via service (handles audit automatically including encrypted masking)
    await settingsService.set(userId, key, value);

    // Register Telegram webhook when bot token is saved
    if (key === "telegram.bot_token" && value) {
      const settingsLogger = createLogger({ component: Component.Settings });
      try {
        const baseUrl = getBaseUrl();
        const webhookUrl = `${baseUrl}/api/telegram/webhook`;
        // Generate and store a webhook secret for origin validation
        const webhookSecret = randomBytes(32).toString("hex");
        await settingsService.set(userId, "telegram.webhook_secret", webhookSecret);
        const client = new TelegramClient({ botToken: value as string });
        await client.setWebhook(webhookUrl, ["callback_query"], webhookSecret);
        settingsLogger.info("Telegram webhook registered", { webhookUrl, userId });
      } catch (webhookError) {
        // Non-blocking: log warning but don't fail the settings save
        settingsLogger.warn("Failed to register Telegram webhook", {
          error: String(webhookError),
          userId,
        });
      }
    }

    res.json({
      success: true,
      data: { key, updated: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/settings/:key - Delete user setting value (reset to default)
 */
router.delete(
  "/:key",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { key } = req.params;

    // Check definition exists
    const definition = await settingsService.getDefinition(key);
    if (!definition) {
      throw createApiError.notFound(`Setting definition not found: ${key}`, { key });
    }

    // Delete user value via service (handles audit automatically)
    await settingsService.delete(userId, key);

    res.json({
      success: true,
      data: { key, deleted: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

export { router as settingsRoutes };
