/**
 * Email Service Module
 * Provides provider-agnostic email sending with logging
 */

import type { EmailProvider, EmailOptions, EmailResult, EmailType } from "./email-service.js";
import { BrevoProvider } from "./brevo-provider.js";
import { TestEmailProvider } from "./test-provider.js";
import { SmtpProvider } from "./smtp-provider.js";
import { getDatabase } from "../database/connection.js";
import { emailLog } from "../database/schema.js";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../logging/logger.js";
import {
  getEmailDeliveryStatus,
  isTestRecipientSuppressionEnabled,
  type EmailDeliveryStatus,
} from "../config/env.js";

// Email service logger for Grafana/Loki
const logger = createLogger({ component: "email" });

/**
 * Email error types for classification
 */
export enum EmailErrorType {
  RATE_LIMIT = "rate_limit", // HTTP 429 - too many requests
  QUOTA_EXCEEDED = "quota_exceeded", // Daily limit reached
  AUTH_ERROR = "auth_error", // Invalid API key
  INVALID_RECIPIENT = "invalid_recipient", // Bad email address
  NETWORK_ERROR = "network_error", // Connection issues
  UNKNOWN = "unknown",
}

/**
 * Classify email error based on error object
 * Works with Brevo SDK HttpError (has statusCode, body)
 * Exported for unit testing
 */
export function classifyEmailError(error: unknown): { type: EmailErrorType; details: string } {
  // Brevo SDK throws HttpError with statusCode and body
  const httpError = error as { statusCode?: number; body?: unknown; message?: string };
  const statusCode = httpError.statusCode;
  const body = httpError.body as { code?: string; message?: string } | undefined;

  // Rate limit (HTTP 429)
  if (statusCode === 429) {
    return { type: EmailErrorType.RATE_LIMIT, details: "Rate limit exceeded, retry after delay" };
  }

  // Authentication error (HTTP 401/403)
  if (statusCode === 401 || statusCode === 403) {
    return { type: EmailErrorType.AUTH_ERROR, details: "Invalid or expired API key" };
  }

  // Bad request - usually invalid recipient (HTTP 400)
  if (statusCode === 400) {
    const message = body?.message || httpError.message || "Bad request";
    if (message.toLowerCase().includes("email") || message.toLowerCase().includes("recipient")) {
      return { type: EmailErrorType.INVALID_RECIPIENT, details: message };
    }
    // Quota exceeded often comes as 400 with specific message
    if (message.toLowerCase().includes("quota") || message.toLowerCase().includes("limit")) {
      return { type: EmailErrorType.QUOTA_EXCEEDED, details: message };
    }
    return { type: EmailErrorType.UNKNOWN, details: message };
  }

  // Network errors (no status code, or connection refused)
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("etimedout") ||
      msg.includes("network")
    ) {
      return { type: EmailErrorType.NETWORK_ERROR, details: error.message };
    }
  }

  // Unknown error
  const details = error instanceof Error ? error.message : String(error);
  return { type: EmailErrorType.UNKNOWN, details };
}

/**
 * Mask email for logging (show first 2 chars + domain)
 * Exported for unit testing
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***@***";
  const masked = local.length > 2 ? local.slice(0, 2) + "***" : "***";
  return `${masked}@${domain}`;
}

export * from "./email-service.js";
export type { EmailDeliveryStatus } from "../config/env.js";

let emailProvider: EmailProvider | null = null;

/**
 * Check if email is a test user
 * Test users: emails matching patterns used in tests
 */
function isTestEmail(email: string): boolean {
  const testPatterns = [
    /^[^@]+@example\.com$/i, // IANA-reserved example domain used by automated tests
    /^[^@]+@test\.com$/i, // legacy CI fixture domain; suppression requires the explicit switch
    /^[^@]+@test\.local$/i,
    /^[^@]+@moira\.local$/i,
    /^[^@]+@load-testing-noverify\.local$/i,
    /^[^@]+@[^@]+\.test$/i, // IANA-reserved .test TLD
  ];

  return testPatterns.some((pattern) => pattern.test(email));
}

export function shouldSuppressTestRecipient(email: string): boolean {
  return isTestRecipientSuppressionEnabled() && isTestEmail(email);
}

/**
 * Get configured email provider
 */
export function getEmailProvider(): EmailProvider {
  if (emailProvider) {
    return emailProvider;
  }

  const status = getEmailDeliveryStatus();
  if (status.state === "configuration-error" || status.state === "unavailable") {
    throw new EmailDeliveryUnavailableError(status);
  }
  emailProvider =
    status.provider === "smtp"
      ? new SmtpProvider()
      : status.provider === "brevo"
        ? new BrevoProvider()
        : new TestEmailProvider();
  return emailProvider;
}

export class EmailDeliveryUnavailableError extends Error {
  readonly code = "EMAIL_DELIVERY_UNAVAILABLE";

  constructor(readonly status: EmailDeliveryStatus) {
    super(status.reason || "Email delivery is unavailable");
    this.name = "EmailDeliveryUnavailableError";
  }
}

/**
 * Send email and log to database
 * For test users in production: use TestEmailProvider
 */
export async function sendEmail(
  userId: string,
  type: EmailType,
  options: EmailOptions,
): Promise<EmailResult> {
  // Reserved recipients use the local provider but still share durable attempt history.
  const provider = shouldSuppressTestRecipient(options.to)
    ? new TestEmailProvider()
    : getEmailProvider();
  const db = getDatabase();
  const logId = uuidv4();
  const now = new Date().toISOString();

  try {
    const result = await provider.send(options);

    // Log successful email
    await db.insert(emailLog).values({
      id: logId,
      userId,
      type,
      to: options.to,
      subject: options.subject,
      messageId: result.messageId,
      status: result.delivery === "sent" ? "sent" : "logged",
      createdAt: now,
    });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Classify error for structured logging
    const { type: errorType, details } = classifyEmailError(error);

    // Log to stdout for Grafana/Loki
    logger.error("Email send failed", error, {
      emailType: type,
      recipient: maskEmail(options.to),
      errorType,
      errorDetails: details,
      provider: provider.getName(),
    });

    // Log failed email to database
    await db.insert(emailLog).values({
      id: logId,
      userId,
      type,
      to: options.to,
      subject: options.subject,
      messageId: "",
      status: "failed",
      error: `[${errorType}] ${errorMessage}`,
      createdAt: now,
    });

    throw error;
  }
}

/**
 * Check if email service is configured
 */
export function isEmailConfigured(): boolean {
  return getEmailDeliveryStatus().state === "real";
}

export { getEmailDeliveryStatus };
