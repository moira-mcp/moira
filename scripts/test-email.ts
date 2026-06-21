/**
 * Test email sending via Brevo
 */

import "dotenv/config";
import * as brevo from "@getbrevo/brevo";
import { getEmailFrom } from "@mcp-moira/shared";

async function testEmail() {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error("BREVO_API_KEY not set");
    process.exit(1);
  }

  const apiInstance = new brevo.TransactionalEmailsApi();
  apiInstance.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, apiKey);

  const sendSmtpEmail = new brevo.SendSmtpEmail();
  sendSmtpEmail.sender = {
    email: getEmailFrom(),
    name: process.env.EMAIL_FROM_NAME || "MCP Moira",
  };
  sendSmtpEmail.to = [{ email: "witreg@mail.ru" }];
  sendSmtpEmail.subject = "MCP Moira - Test Email";
  sendSmtpEmail.textContent =
    "This is a test email from MCP Moira to verify Brevo integration is working correctly.";

  try {
    console.log("Sending test email to witreg@mail.ru...");
    const response = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log("✓ Email sent successfully!");
    console.log("Message ID:", response.body.messageId);
  } catch (error) {
    console.error("✗ Failed to send email:");
    console.error(error);
    process.exit(1);
  }
}

testEmail();
