/**
 * Telegram Webhook Route
 * Handles callback_query updates from Telegram inline keyboard buttons.
 * Public route (no auth) — Telegram sends updates directly.
 * Validated via X-Telegram-Bot-Api-Secret-Token header.
 */

import { Router, Request, Response } from "express";
import { asyncHandler } from "../middleware/error-middleware.js";
import { TelegramClient, parseApproveCallback } from "@mcp-moira/workflow-engine";
import { getLockService, getSettingsService, createLogger, Component } from "@mcp-moira/shared";
import { LockNotFoundError, LockNotActiveError } from "@mcp-moira/shared";

const router = Router();
const logger = createLogger({ component: Component.Execution });

/** Webhook secret token setting key */
const WEBHOOK_SECRET_KEY = "telegram.webhook_secret";

/**
 * POST /api/telegram/webhook
 * Receives Telegram Update objects with callback_query from inline buttons.
 * Validates origin via secret_token header, parses approve action,
 * finds the lock, unlocks it, then answers the callback query.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const update = req.body;

    // Only handle callback_query updates
    if (!update?.callback_query) {
      res.json({ ok: true });
      return;
    }

    const callbackQuery = update.callback_query;
    const callbackData = callbackQuery.data;

    if (!callbackData) {
      res.json({ ok: true });
      return;
    }

    // Parse the compact callback data (a:<exec8>:<node12>)
    const parsed = parseApproveCallback(callbackData);
    if (!parsed) {
      logger.debug("Ignoring unknown callback_data", { data: callbackData });
      res.json({ ok: true });
      return;
    }

    const { executionIdPrefix, nodeIdPrefix } = parsed;
    const lockService = getLockService();
    const settingsService = getSettingsService();

    // 1. Find lock (read-only) to identify the user
    // 2. Validate webhook secret BEFORE any mutation
    // 3. Only then approve the lock
    try {
      const lock = await lockService.findActiveLockByPrefix(executionIdPrefix, nodeIdPrefix);

      // Validate origin: check the secret token header against stored secret
      const expectedSecret = await settingsService.get<string>(lock.lockedBy, WEBHOOK_SECRET_KEY);
      if (expectedSecret) {
        const receivedSecret = req.headers["x-telegram-bot-api-secret-token"];
        if (receivedSecret !== expectedSecret) {
          logger.warn("Webhook secret mismatch", {
            executionIdPrefix,
            hasReceivedSecret: !!receivedSecret,
          });
          res.status(403).json({ ok: false, error: "invalid_secret" });
          return;
        }
      } else {
        logger.warn("No webhook secret configured — validation skipped", {
          userId: lock.lockedBy,
          executionIdPrefix,
        });
      }

      // Secret validated — unlock
      await lockService.unlockByApproval(executionIdPrefix, nodeIdPrefix);

      // Answer callback query using the bot token of the lock owner
      const botToken = await settingsService.get<string>(lock.lockedBy, "telegram.bot_token");

      if (botToken && callbackQuery.id) {
        try {
          const client = new TelegramClient({ botToken });
          await client.answerCallbackQuery(callbackQuery.id, "✅ Lock approved");
        } catch (answerError) {
          logger.warn("Failed to answer callback query", {
            error: String(answerError),
            callbackQueryId: callbackQuery.id,
          });
        }
      }

      logger.info("Telegram callback processed", {
        action: "approve",
        executionIdPrefix,
        nodeIdPrefix,
        lockId: lock.id,
      });

      res.json({ ok: true });
    } catch (error) {
      if (error instanceof LockNotFoundError) {
        logger.warn("Lock not found for callback", {
          executionIdPrefix,
          nodeIdPrefix,
        });
        res.json({ ok: true, error: "lock_not_found" });
        return;
      }

      if (error instanceof LockNotActiveError) {
        logger.warn("Lock not active for callback", {
          executionIdPrefix,
          nodeIdPrefix,
          error: (error as Error).message,
        });
        res.json({ ok: true, error: "lock_not_active" });
        return;
      }

      throw error;
    }
  }),
);

export { WEBHOOK_SECRET_KEY };
export default router;
