/**
 * Notifications API Routes
 * Test notification endpoints with structured error responses
 */

import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { TelegramClient, classifyTelegramError } from "@mcp-moira/workflow-engine";

const router = Router();

/**
 * POST /api/notifications/test - Send test notification
 * Body: { botToken: string, chatId: string }
 *
 * Returns structured error on failure:
 * { success: false, errorType: TelegramErrorType, message: string }
 */
router.post(
  "/test",
  asyncHandler(async (req: Request, res: Response) => {
    const { botToken, chatId } = req.body;

    if (!botToken || !chatId) {
      throw createApiError.validationFailed("botToken and chatId are required");
    }

    try {
      // Create telegram client with provided credentials
      const telegramClient = new TelegramClient({
        botToken,
        defaultChatId: chatId,
      });

      // Send test message
      await telegramClient.sendMessage({
        chatId,
        text: "✅ Test notification from MCP Moira\n\nYour Telegram configuration is working correctly!",
        parseMode: "Markdown",
      });

      res.json({
        success: true,
        message: "Test notification sent successfully",
      });
    } catch (error) {
      // Return structured error response instead of generic 500
      const classified = classifyTelegramError(error);
      res.status(400).json({
        success: false,
        errorType: classified.errorType,
        message: classified.message,
      });
    }
  }),
);

export default router;
