/**
 * Brevo (ex-Sendinblue) Email Provider
 * Free tier: 300 emails/day
 */

import * as brevo from "@getbrevo/brevo";
import type { EmailProvider, EmailOptions, EmailResult } from "./email-service.js";
import { getBrevoApiKey, getEmailFrom, getEmailFromName } from "../config/env.js";

export class BrevoProvider implements EmailProvider {
  private apiInstance: brevo.TransactionalEmailsApi;
  private fromEmail: string;
  private fromName: string;

  constructor() {
    const apiKey = getBrevoApiKey();
    if (!apiKey) {
      throw new Error("BREVO_API_KEY environment variable is required");
    }

    this.apiInstance = new brevo.TransactionalEmailsApi();
    this.apiInstance.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, apiKey);

    this.fromEmail = getEmailFrom();
    this.fromName = getEmailFromName();
  }

  getName(): string {
    return "brevo";
  }

  async send(options: EmailOptions): Promise<EmailResult> {
    const sendSmtpEmail = new brevo.SendSmtpEmail();

    sendSmtpEmail.sender = {
      email: this.fromEmail,
      name: this.fromName,
    };
    sendSmtpEmail.to = [{ email: options.to }];
    sendSmtpEmail.subject = options.subject;
    sendSmtpEmail.textContent = options.text;

    if (options.html) {
      sendSmtpEmail.htmlContent = options.html;
    }

    // Note: No try/catch here - let original HttpError with statusCode bubble up
    // for proper error classification in sendEmail()
    const response = await this.apiInstance.sendTransacEmail(sendSmtpEmail);
    return {
      messageId: response.body.messageId || `brevo-${Date.now()}`,
      success: true,
    };
  }
}
