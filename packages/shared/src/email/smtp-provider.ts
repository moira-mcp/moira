import nodemailer, { type Transporter } from "nodemailer";

import { getEmailFrom, getEmailFromName, getSmtpConfig } from "../config/env.js";
import type { EmailOptions, EmailProvider, EmailResult } from "./email-service.js";

export class SmtpProvider implements EmailProvider {
  private readonly transporter: Transporter;

  constructor() {
    const config = getSmtpConfig();
    if (!config) throw new Error("SMTP provider is not fully configured");
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTls,
      ...(config.user ? { auth: { user: config.user, pass: config.password } } : {}),
    });
  }

  async send(options: EmailOptions): Promise<EmailResult> {
    const result = await this.transporter.sendMail({
      from: { name: getEmailFromName(), address: getEmailFrom() },
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
    return { messageId: result.messageId, success: true, provider: "smtp", delivery: "sent" };
  }

  getName(): string {
    return "smtp";
  }
}
