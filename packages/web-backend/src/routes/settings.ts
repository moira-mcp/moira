/**
 * Settings API Routes
 * User settings management with authentication
 */

import { Router, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { DatabaseRepository, TelegramClient, maskEncryptedValue } from "@mcp-moira/workflow-engine";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { checkAdminRole } from "../utils/admin-utils.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import { getSettingsService, getBaseUrl, createLogger, Component } from "@mcp-moira/shared";

const router = Router();
const repository = new DatabaseRepository();

// Get SettingsService for operations with automatic audit
const settingsService = getSettingsService();

/**
 * Read the browser-facing settings projection.
 *
 * The repository's API/MCP contract deliberately represents built-in secrets as the stable
 * `[encrypted]` sentinel. The settings screen has an older, more useful contract: it displays a
 * bullet mask with the last four characters, so a user can tell saved credentials apart. Keep that
 * presentation at the HTTP boundary without changing what MCP consumers receive. Extension
 * secrets use the same presentation here, while a manifest default is still omitted because it has
 * no stored raw value and therefore must not be revealed.
 */
async function getBrowserSettings(userId: string, category?: string) {
  const definitions = (await repository.getSettingDefinitions(category)).filter(
    (definition) => !definition.adminOnly,
  );
  const visibleKeys = new Set(definitions.map((definition) => definition.key));
  const settings = await repository.getSettingsForApi(userId, category);
  const projected = Object.fromEntries(
    Object.entries(settings).filter(([key]) => visibleKeys.has(key)),
  );

  for (const definition of definitions) {
    if (definition.type !== "encrypted" || !(definition.key in projected)) continue;
    const raw = await repository.getRawSettingValue(userId, definition.key);
    if (raw !== null) projected[definition.key] = maskEncryptedValue(raw);
  }

  return projected;
}

/**
 * GET /api/settings - Get all user settings
 * Returns all settings across all categories
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId; // From requireAuth middleware

    // The user surface never exposes admin-only keys, and all encrypted values come from the
    // repository's masked API projection. Reading through the internal projection here would hand
    // plaintext secrets to the browser before the category route had a chance to mask them.
    const allSettings = await getBrowserSettings(userId);

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

    // An administrator's setting is an administrator's on every path that writes it, this one
    // included: the per-key endpoint and the MCP tool already check the role, and a bulk request is
    // the same write with more keys in it.
    //
    // A key the caller may not write does not cancel the rest of the request. Every key is decided
    // before anything is stored — so what gets saved does not depend on the order the keys arrived
    // in — and the response says which keys were refused and why. Refusing the whole body would
    // leave the caller to work out by reading the settings back which of them landed.
    let isAdmin: boolean | null = null;
    const allowed: Record<string, unknown> = {};
    const refused: Array<{ key: string; reason: string }> = [];

    for (const [key, value] of Object.entries(updates)) {
      const definition = await repository.getSettingDefinition(key);
      if (definition?.adminOnly) {
        if (isAdmin === null) isAdmin = await checkAdminRole(userId);
        if (!isAdmin) {
          refused.push({
            key,
            reason: "Admin permission required for this setting",
          });
          continue;
        }
      }
      allowed[key] = value;
    }

    // Through the repository rather than the service directly: settings declared by an installed
    // extension are stored elsewhere, and this bulk endpoint is the one the settings screen saves
    // through. Built-in keys still take the service path, so their audit is unchanged.
    //
    // A write that fails is refused like any other key rather than abandoning the rest of the body:
    // an unknown key and a value its schema rejects both throw here, and stopping at the first one
    // would leave the keys before it stored, the keys after it not, and the caller with an error
    // that names neither group. There is no transaction to lean on — a declared key goes to the
    // extension value store and a built-in one to the settings service — so "everything or nothing"
    // is not available; "everything permitted, and the rest named" is.
    const saved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(allowed)) {
      try {
        await repository.setSetting(userId, key, value);
        saved[key] = value;
      } catch (error) {
        // The failure now lives in the response instead of an exception, so it would otherwise
        // vanish from the server's own record of what happened.
        createLogger({ component: Component.Settings }).warn("Bulk settings write refused a key", {
          userId,
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        refused.push({
          key,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Register Telegram webhook if the bot token was actually saved: a token that was refused must
    // not leave a webhook pointing at this installation.
    if (saved["telegram.bot_token"]) {
      const settingsLogger = createLogger({ component: Component.Settings });
      try {
        const baseUrl = getBaseUrl();
        const webhookUrl = `${baseUrl}/api/telegram/webhook`;
        const webhookSecret = randomBytes(32).toString("hex");
        await settingsService.set(userId, "telegram.webhook_secret", webhookSecret);
        const client = new TelegramClient({
          botToken: saved["telegram.bot_token"] as string,
        });
        await client.setWebhook(webhookUrl, ["callback_query"], webhookSecret);
        settingsLogger.info("Telegram webhook registered (bulk)", { webhookUrl, userId });
      } catch (webhookError) {
        settingsLogger.warn("Failed to register Telegram webhook (bulk)", {
          error: String(webhookError),
          userId,
        });
      }
    }

    // `saved` and `refused` are always both present, so a client reads one shape whether or not
    // anything was refused; the status distinguishes the two outcomes at a glance (207 is the
    // ordinary way to say "the request was processed, and not all of it succeeded").
    res.status(refused.length > 0 ? 207 : 200).json({
      success: true,
      data: { saved, refused },
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

    const maskedSettings = await getBrowserSettings(userId, category);

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

    // Basic validation against definition.validation schema.
    //
    // Skipped for a setting an installed extension declares: the repository checks such a value
    // against the manifest's full schema and first brings it to the declared type. This shallow
    // check compares `typeof value` with the schema type and would reject the form the settings
    // screen itself sends — a `json` setting is edited in a textarea and therefore travels as text,
    // which the bulk endpoint accepts and this one refused. Where the definition came from is read
    // off the definition itself, which carries it, rather than asked of the registry a second time.
    const declaredByExtension = definition.source === "extension";

    if (definition.validation && !declaredByExtension) {
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

    // Through the repository, like the bulk endpoint: a key declared by an installed extension is
    // stored elsewhere, and the definition lookup above already knows about such keys — writing
    // through the service instead would fail on exactly the settings this endpoint just accepted.
    await repository.setSetting(userId, key, value);

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

    // The same merged source as every other read: a setting declared by an extension exists as
    // surely as a stored one, and resetting it to its default must work the same way.
    const definition = await repository.getSettingDefinition(key);
    if (!definition) {
      throw createApiError.notFound(`Setting definition not found: ${key}`, { key });
    }

    if (definition.adminOnly && !(await checkAdminRole(userId))) {
      throw createApiError.unauthorized("Admin permission required for this setting");
    }

    // Repository routing decides where the value lives; for stored keys it still goes through the
    // service, so their audit is unchanged.
    await repository.deleteUserSettingValue(userId, key);

    res.json({
      success: true,
      data: { key, deleted: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

export { router as settingsRoutes };
