/**
 * Send an operator-requested test message through Moira's configured provider.
 */

import "dotenv/config";
import { getEmailProvider, type EmailOptions, type EmailProvider } from "@mcp-moira/shared/email";

const USAGE = "Usage: npx tsx scripts/test-email.ts --recipient <email>";

export function parseTestEmailRecipient(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--recipient" || !args[1]?.trim()) {
    throw new Error(USAGE);
  }

  const recipient = args[1].trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error(`Invalid recipient email. ${USAGE}`);
  }
  return recipient;
}

export async function sendTestEmail(
  recipient: string,
  provider: EmailProvider = getEmailProvider(),
) {
  const message: EmailOptions = {
    to: recipient,
    subject: "MCP Moira - Test Email",
    text: "This is a test email from MCP Moira to verify the configured provider is working correctly.",
  };

  return provider.send(message);
}

export async function main(
  args: string[] = process.argv.slice(2),
  provider?: EmailProvider,
): Promise<void> {
  try {
    const recipient = parseTestEmailRecipient(args);
    console.log(`Submitting test email for ${recipient}...`);
    const result = await sendTestEmail(recipient, provider ?? getEmailProvider());
    console.log("✓ Email provider request completed.");
    console.log("Provider:", result.provider);
    console.log("Delivery:", result.delivery);
    console.log("Message ID:", result.messageId);
  } catch (error) {
    console.error("✗ Failed to send email:");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
