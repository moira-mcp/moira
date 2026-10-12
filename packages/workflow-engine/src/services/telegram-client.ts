/**
 * Telegram Bot API HTTP Client
 * Production-ready client with comprehensive error handling and rate limiting
 */

import {
  TelegramConfig,
  SendMessageParams,
  SendPhotoParams,
  SendDocumentParams,
  TelegramResponse,
  TelegramError,
  TelegramErrorType,
  TELEGRAM_CAPTION_MAX_LENGTH,
  TELEGRAM_PHOTO_MAX_BYTES,
  TELEGRAM_TEXT_MAX_LENGTH,
  TELEGRAM_DOCUMENT_MAX_BYTES,
} from "../types/telegram-types.js";
import { RateLimiter, createTelegramRateLimiter } from "./rate-limiter.js";
import { createLogger, WorkflowLogger } from "@mcp-moira/shared";
import { isSafeAttachmentFilename } from "@mcp-moira/shared/validation/attachment-filename";
import type { CodespaceVerifiedByteSource } from "@mcp-moira/shared";
import { createHash, randomBytes } from "node:crypto";

/**
 * HTTP client for Telegram Bot API with rate limiting and error handling
 * Implements graceful degradation strategy for production use
 */
export class TelegramClient {
  private config: TelegramConfig;
  private rateLimiter: RateLimiter;
  private logger: WorkflowLogger;

  constructor(config: TelegramConfig, rateLimiter?: RateLimiter) {
    this.config = this.validateAndNormalizeConfig(config);
    this.rateLimiter = rateLimiter ?? createTelegramRateLimiter();
    this.logger = createLogger({ component: "TelegramClient" });

    this.logger.info("Telegram client initialized", {
      timeout: this.config.timeout,
      hasDefaultChatId: !!this.config.defaultChatId,
    });
  }

  /**
   * Send message to Telegram chat
   * Handles rate limiting, HTTP errors, and API errors gracefully
   */
  async sendMessage(params: SendMessageParams): Promise<TelegramResponse> {
    try {
      // Apply rate limiting
      await this.rateLimiter.waitForAvailability();

      const response = await this.makeHttpRequest(params);

      this.logger.info("Message sent successfully", {
        messageLength: params.text.length,
        parseMode: params.parseMode,
      });

      return response;
    } catch (error) {
      const telegramError = this.handleError(error, params);
      // No logging here - boundary handles it
      throw telegramError;
    }
  }

  async sendPhoto(params: SendPhotoParams): Promise<TelegramResponse> {
    if (!(params.photo instanceof Uint8Array)) {
      return this.sendStreamedAttachment(
        "sendPhoto",
        "photo",
        params.photo,
        params,
        TELEGRAM_PHOTO_MAX_BYTES,
      );
    }
    const cancellation = this.attachmentCancellation(params.signal);
    const { controller } = cancellation;
    try {
      if (params.photo.byteLength === 0 || params.photo.byteLength > TELEGRAM_PHOTO_MAX_BYTES)
        throw this.createError(
          TelegramErrorType.API_ERROR,
          `Photo size must be between 1 and ${TELEGRAM_PHOTO_MAX_BYTES} bytes`,
        );
      controller.signal.throwIfAborted();
      await this.rateLimiter.waitForAvailability();
      controller.signal.throwIfAborted();
      if (params.caption && params.caption.length > TELEGRAM_CAPTION_MAX_LENGTH)
        throw this.createError(
          TelegramErrorType.MESSAGE_TOO_LONG,
          `Photo caption exceeds ${TELEGRAM_CAPTION_MAX_LENGTH} characters`,
        );
      const body = new FormData();
      body.set("chat_id", params.chatId);
      const photoBytes = Uint8Array.from(params.photo);
      body.set("photo", new Blob([photoBytes.buffer], { type: params.mimeType }), params.filename);
      if (params.caption) body.set("caption", params.caption);
      if (params.parseMode) body.set("parse_mode", params.parseMode);
      if (params.disableNotification !== undefined)
        body.set("disable_notification", String(params.disableNotification));
      if (params.replyMarkup) body.set("reply_markup", JSON.stringify(params.replyMarkup));
      const response = await fetch(this.buildApiUrl("sendPhoto"), {
        method: "POST",
        body,
        signal: controller.signal,
      });
      const data = (await response.json()) as TelegramResponse;
      controller.signal.throwIfAborted();
      if (!response.ok || !data.ok) throw this.createApiError(response, data);
      return data;
    } catch (error) {
      if (controller.signal.aborted) {
        throw this.createError(
          TelegramErrorType.TIMEOUT_ERROR,
          "Photo request was cancelled or timed out",
        );
      }
      throw this.handleError(error, {
        chatId: params.chatId,
        text: params.caption ?? "",
        parseMode: params.parseMode,
      });
    } finally {
      cancellation.dispose();
    }
  }

  async sendDocument(params: SendDocumentParams): Promise<TelegramResponse> {
    if (!(params.document instanceof Uint8Array)) {
      return this.sendStreamedAttachment(
        "sendDocument",
        "document",
        params.document,
        params,
        TELEGRAM_DOCUMENT_MAX_BYTES,
      );
    }
    if (
      params.document.byteLength === 0 ||
      params.document.byteLength > TELEGRAM_DOCUMENT_MAX_BYTES
    )
      throw this.createError(
        TelegramErrorType.API_ERROR,
        `Document size must be between 1 and ${TELEGRAM_DOCUMENT_MAX_BYTES} bytes`,
      );
    if (params.caption && params.caption.length > TELEGRAM_CAPTION_MAX_LENGTH)
      throw this.createError(
        TelegramErrorType.MESSAGE_TOO_LONG,
        `Document caption exceeds ${TELEGRAM_CAPTION_MAX_LENGTH} characters`,
      );
    const cancellation = this.attachmentCancellation(params.signal);
    const { controller } = cancellation;
    try {
      controller.signal.throwIfAborted();
      await this.rateLimiter.waitForAvailability();
      controller.signal.throwIfAborted();
      const body = new FormData();
      body.set("chat_id", params.chatId);
      const documentBytes = Uint8Array.from(params.document);
      body.set(
        "document",
        new Blob([documentBytes.buffer], { type: params.mimeType }),
        params.filename,
      );
      if (params.caption) body.set("caption", params.caption);
      if (params.parseMode) body.set("parse_mode", params.parseMode);
      if (params.disableNotification !== undefined)
        body.set("disable_notification", String(params.disableNotification));
      if (params.replyMarkup) body.set("reply_markup", JSON.stringify(params.replyMarkup));
      const response = await fetch(this.buildApiUrl("sendDocument"), {
        method: "POST",
        body,
        signal: controller.signal,
      });
      const data = (await response.json()) as TelegramResponse;
      controller.signal.throwIfAborted();
      if (!response.ok || !data.ok) throw this.createApiError(response, data);
      return data;
    } catch (error) {
      if (controller.signal.aborted)
        throw this.createError(
          TelegramErrorType.TIMEOUT_ERROR,
          "Document request was cancelled or timed out",
        );
      throw this.handleError(error, {
        chatId: params.chatId,
        text: params.caption ?? "",
        parseMode: params.parseMode,
      });
    } finally {
      cancellation.dispose();
    }
  }

  private async sendStreamedAttachment(
    method: "sendPhoto" | "sendDocument",
    field: "photo" | "document",
    source: CodespaceVerifiedByteSource,
    params: Pick<
      SendDocumentParams,
      | "chatId"
      | "filename"
      | "mimeType"
      | "caption"
      | "parseMode"
      | "disableNotification"
      | "replyMarkup"
      | "signal"
    >,
    maximum: number,
  ): Promise<TelegramResponse> {
    if (
      !Number.isSafeInteger(source.size) ||
      source.size <= 0 ||
      source.size > maximum ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      typeof source.open !== "function"
    ) {
      throw this.createError(
        TelegramErrorType.API_ERROR,
        "Streamed attachment metadata is invalid",
      );
    }
    if (
      !isSafeAttachmentFilename(params.filename) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/.test(params.mimeType)
    ) {
      throw this.createError(
        TelegramErrorType.API_ERROR,
        "Streamed attachment filename or MIME type is invalid",
      );
    }
    if (params.caption && params.caption.length > TELEGRAM_CAPTION_MAX_LENGTH) {
      throw this.createError(
        TelegramErrorType.MESSAGE_TOO_LONG,
        `Attachment caption exceeds ${TELEGRAM_CAPTION_MAX_LENGTH} characters`,
      );
    }
    const cancellation = this.attachmentCancellation(params.signal);
    const { controller } = cancellation;
    const boundary = `moira-${randomBytes(24).toString("hex")}`;
    const fields: Record<string, string> = { chat_id: params.chatId };
    if (params.caption) fields.caption = params.caption;
    if (params.parseMode) fields.parse_mode = params.parseMode;
    if (params.disableNotification !== undefined)
      fields.disable_notification = String(params.disableNotification);
    if (params.replyMarkup) fields.reply_markup = JSON.stringify(params.replyMarkup);
    const prefix = Buffer.from(
      Object.entries(fields)
        .map(
          ([name, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        )
        .join("") +
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${params.filename.replaceAll('"', '\\"')}"\r\nContent-Type: ${params.mimeType}\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    let complete = false;
    const body = (async function* () {
      controller.signal.throwIfAborted();
      yield prefix;
      const stream = await source.open(controller.signal);
      const hash = createHash("sha256");
      let received = 0;
      for await (const chunk of stream) {
        controller.signal.throwIfAborted();
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > source.size - received) {
          throw new Error("Streamed attachment size mismatch");
        }
        for (let offset = 0; offset < chunk.byteLength; offset += 256 * 1024) {
          controller.signal.throwIfAborted();
          const bytes = chunk.subarray(offset, offset + 256 * 1024);
          hash.update(bytes);
          received += bytes.byteLength;
          yield bytes;
        }
      }
      controller.signal.throwIfAborted();
      if (received !== source.size || hash.digest("hex") !== source.sha256) {
        throw new Error("Streamed attachment size or digest mismatch");
      }
      complete = true;
      yield suffix;
    })();
    try {
      controller.signal.throwIfAborted();
      await this.rateLimiter.waitForAvailability();
      controller.signal.throwIfAborted();
      const response = await fetch(this.buildApiUrl(method), {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(prefix.byteLength + source.size + suffix.byteLength),
        },
        body: body as unknown as BodyInit,
        duplex: "half",
        signal: controller.signal,
      } as RequestInit & { duplex: "half" });
      const data = (await response.json()) as TelegramResponse;
      controller.signal.throwIfAborted();
      if (!response.ok || !data.ok) throw this.createApiError(response, data);
      if (!complete) throw new Error("Streamed attachment was not consumed completely");
      return data;
    } catch (error) {
      if (controller.signal.aborted) {
        throw this.createError(
          TelegramErrorType.TIMEOUT_ERROR,
          "Streamed attachment request was cancelled or timed out",
        );
      }
      throw this.handleError(error, {
        chatId: params.chatId,
        text: params.caption ?? "",
        parseMode: params.parseMode,
      });
    } finally {
      cancellation.dispose();
      await body.return(undefined);
    }
  }

  private attachmentCancellation(signal?: AbortSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout || 5000);
    return {
      controller,
      dispose() {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
      },
    };
  }

  /**
   * Send message with default chat ID if configured
   * Convenience method for simple use cases
   */
  async sendMessageToDefault(
    text: string,
    options: Omit<SendMessageParams, "chatId" | "text"> = {},
  ): Promise<TelegramResponse> {
    if (!this.config.defaultChatId) {
      throw this.createError(TelegramErrorType.INVALID_CHAT_ID, "No default chat ID configured");
    }

    return this.sendMessage({
      chatId: this.config.defaultChatId,
      text,
      ...options,
    });
  }

  /**
   * Answer a callback query from an inline keyboard button press.
   * Dismisses the loading indicator on the user's Telegram client.
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<TelegramResponse> {
    try {
      await this.rateLimiter.waitForAvailability();

      const url = this.buildApiUrl("answerCallbackQuery");
      const body: Record<string, unknown> = {
        callback_query_id: callbackQueryId,
      };
      if (text) {
        body.text = text;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout || 5000);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const responseData = (await response.json()) as TelegramResponse;

        if (!response.ok || !responseData.ok) {
          throw this.createApiError(response, responseData);
        }

        return responseData;
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === "AbortError") {
          throw this.createError(
            TelegramErrorType.TIMEOUT_ERROR,
            `answerCallbackQuery timeout after ${this.config.timeout}ms`,
          );
        }
        throw error;
      }
    } catch (error) {
      // Best-effort: log and rethrow
      const telegramError =
        error && typeof error === "object" && "type" in error
          ? (error as TelegramError)
          : this.createError(TelegramErrorType.API_ERROR, String(error));
      throw telegramError;
    }
  }

  /**
   * Set webhook URL for receiving updates from Telegram.
   * Called when user configures bot token.
   */
  async setWebhook(
    url: string,
    allowedUpdates?: string[],
    secretToken?: string,
  ): Promise<TelegramResponse> {
    await this.rateLimiter.waitForAvailability();

    const apiUrl = this.buildApiUrl("setWebhook");
    const body: Record<string, unknown> = { url };
    if (allowedUpdates) {
      body.allowed_updates = allowedUpdates;
    }
    if (secretToken) {
      body.secret_token = secretToken;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout || 5000);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseData = (await response.json()) as TelegramResponse;

      if (!response.ok || !responseData.ok) {
        throw this.createApiError(response, responseData);
      }

      this.logger.info("Webhook set successfully");
      return responseData;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw this.createError(
          TelegramErrorType.TIMEOUT_ERROR,
          `setWebhook timeout after ${this.config.timeout}ms`,
        );
      }
      throw error;
    }
  }

  /**
   * Test connection to Telegram Bot API
   * Useful for configuration validation
   */
  async testConnection(): Promise<boolean> {
    try {
      // Don't actually send - just test URL construction and token
      this.buildApiUrl("sendMessage");

      this.logger.debug("Connection test");

      return true;
    } catch {
      this.logger.debug("Connection test failed");
      return false;
    }
  }

  /**
   * Get rate limiter status for monitoring
   */
  getRateLimitStatus() {
    return this.rateLimiter.getStatus();
  }

  /**
   * Get default chat ID if configured
   * Used by handlers to determine target chat
   */
  getDefaultChatId(): string | undefined {
    return this.config.defaultChatId;
  }

  /**
   * Make HTTP request to Telegram Bot API
   * Central point for all HTTP communication
   */
  private async makeHttpRequest(params: SendMessageParams): Promise<TelegramResponse> {
    const url = this.buildApiUrl("sendMessage");
    const body = this.buildRequestBody(params);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout || 5000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseData = (await response.json()) as TelegramResponse;

      if (!response.ok || !responseData.ok) {
        throw this.createApiError(response, responseData);
      }

      return responseData;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        throw this.createError(
          TelegramErrorType.TIMEOUT_ERROR,
          `Request timeout after ${this.config.timeout}ms`,
          {},
        );
      }

      throw error;
    }
  }

  /**
   * Build Telegram Bot API URL for specific method
   */
  private buildApiUrl(method: string): string {
    const baseUrl = this.config.apiUrl || "https://api.telegram.org/bot";
    return `${baseUrl}${this.config.botToken}/${method}`;
  }

  /**
   * Build request body for Telegram API
   * Handles message validation and formatting
   */
  private buildRequestBody(params: SendMessageParams): Record<string, unknown> {
    // Validate message length
    if (params.text.length > TELEGRAM_TEXT_MAX_LENGTH) {
      throw this.createError(
        TelegramErrorType.MESSAGE_TOO_LONG,
        `Message too long: ${params.text.length} characters (max 4096)`,
        { messageLength: params.text.length },
      );
    }

    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      text: params.text,
    };

    if (params.parseMode) {
      body.parse_mode = params.parseMode;
    }

    if (params.disableNotification !== undefined) {
      body.disable_notification = params.disableNotification;
    }

    if (params.disableLinkPreview) {
      body.link_preview_options = { is_disabled: true };
    }

    if (params.replyMarkup) {
      body.reply_markup = JSON.stringify(params.replyMarkup);
    }

    return body;
  }

  /**
   * Create TelegramError from API response
   */
  private createApiError(response: Response, data: TelegramResponse): TelegramError {
    const errorType = this.classifyApiError(response.status, data);
    const message = data.description || `HTTP ${response.status}: ${response.statusText}`;

    return this.createError(errorType, message, {
      statusCode: response.status,
      telegramErrorCode: data.errorCode,
      description: data.description,
    });
  }

  /**
   * Classify API error type based on HTTP status and Telegram response
   */
  private classifyApiError(status: number, data: TelegramResponse): TelegramErrorType {
    // Telegram-specific error codes
    if (data.errorCode === 400) {
      if (data.description?.includes("chat not found")) {
        return TelegramErrorType.INVALID_CHAT_ID;
      }
      if (data.description?.includes("message is too long")) {
        return TelegramErrorType.MESSAGE_TOO_LONG;
      }
    }

    if (data.errorCode === 401) {
      return TelegramErrorType.INVALID_TOKEN;
    }

    if (data.errorCode === 429) {
      return TelegramErrorType.RATE_LIMIT_EXCEEDED;
    }

    // HTTP status-based classification
    switch (status) {
      case 401:
        return TelegramErrorType.INVALID_TOKEN;
      case 400:
        return TelegramErrorType.INVALID_CHAT_ID;
      case 429:
        return TelegramErrorType.RATE_LIMIT_EXCEEDED;
      default:
        return TelegramErrorType.API_ERROR;
    }
  }

  /**
   * Handle and classify errors from HTTP requests
   */
  private handleError(error: unknown, _context: SendMessageParams): TelegramError {
    // Check if error is already a TelegramError (has type property)
    if (error && typeof error === "object" && "type" in error) {
      return error as TelegramError;
    }

    if (error instanceof TypeError) {
      return this.createError(TelegramErrorType.NETWORK_ERROR, "Network connectivity issue", {
        originalError: error,
      });
    }

    return this.createError(
      TelegramErrorType.API_ERROR,
      error instanceof Error ? error.message : "Unknown error",
      { originalError: error },
    );
  }

  /**
   * Create structured TelegramError with context
   */
  private createError(
    type: TelegramErrorType,
    message: string,
    context: Record<string, unknown> = {},
  ): TelegramError {
    const error = new Error(message) as TelegramError;
    error.type = type;
    error.context = context;

    if (context.originalError) {
      error.originalError = context.originalError;
    }

    return error;
  }

  /**
   * Validate and normalize configuration
   */
  private validateAndNormalizeConfig(config: TelegramConfig): TelegramConfig {
    if (!config.botToken) {
      throw this.createError(TelegramErrorType.INVALID_TOKEN, "Bot token is required");
    }

    // Basic token format validation (should start with number and contain colon)
    if (!/^\d+:.+/.test(config.botToken)) {
      throw this.createError(TelegramErrorType.INVALID_TOKEN, "Invalid bot token format");
    }

    return {
      ...config,
      apiUrl: config.apiUrl || "https://api.telegram.org/bot",
      timeout: config.timeout || 5000,
    };
  }
}
