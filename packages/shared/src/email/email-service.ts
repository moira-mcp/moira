/**
 * Email Service Abstraction
 * Provider-agnostic interface for sending emails
 */

export interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailResult {
  messageId: string;
  success: boolean;
}

export interface EmailProvider {
  send(options: EmailOptions): Promise<EmailResult>;
  getName(): string;
}

export type EmailType = "verification" | "password_reset" | "notification";
