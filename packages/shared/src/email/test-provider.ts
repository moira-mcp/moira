/**
 * Test Email Provider - logs emails but doesn't send them
 * Used in development and for test users in production
 *
 * URLs are extracted and logged separately for easy manual testing
 */

import { createLogger } from "../logging/logger.js";
import type { EmailProvider, EmailOptions, EmailResult } from "./email-service.js";

export class TestEmailProvider implements EmailProvider {
  private logger = createLogger({ component: "TestEmail" });

  getName(): string {
    return "test";
  }

  async send(options: EmailOptions): Promise<EmailResult> {
    // Extract URLs from email content for easy testing
    const urls = this.extractUrls(options.text || options.html || "");

    this.logger.info("TEST MODE: Email logged (not sent)", {
      to: options.to,
      subject: options.subject,
      textPreview: options.text?.substring(0, 200),
    });

    // Log URLs separately with full content (no truncation)
    if (urls.length > 0) {
      this.logger.info("TEST MODE: Email URLs for manual testing", {
        to: options.to,
        urls: urls,
      });
    }

    return {
      success: true,
      messageId: `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };
  }

  /**
   * Extract all URLs from email content
   */
  private extractUrls(content: string): string[] {
    const urlRegex = /https?:\/\/[^\s<>"']+/g;
    const matches = content.match(urlRegex);
    return matches ? [...new Set(matches)] : [];
  }
}
