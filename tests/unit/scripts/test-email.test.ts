import { jest } from "@jest/globals";
import type { EmailOptions, EmailProvider } from "@mcp-moira/shared/email";
import { main, parseTestEmailRecipient } from "../../../scripts/test-email.js";

describe("test-email operator script", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    jest.restoreAllMocks();
  });

  it("refuses to infer a recipient when main receives no explicit option", async () => {
    const provider: EmailProvider = {
      getName: () => "test",
      send: jest.fn(),
    };
    const error = jest.spyOn(console, "error").mockImplementation();

    await main([], provider);

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("Usage: npx tsx scripts/test-email.ts --recipient <email>");
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("rejects a malformed explicit recipient", () => {
    expect(() => parseTestEmailRecipient(["--recipient", "not-an-email"])).toThrow(
      "Invalid recipient email",
    );
  });

  it("submits main's explicit reserved recipient through the provider boundary", async () => {
    const requests: EmailOptions[] = [];
    const provider: EmailProvider = {
      getName: () => "test",
      send: async (options) => {
        requests.push(options);
        return {
          success: true,
          messageId: "captured-message",
          provider: "test",
          delivery: "logged",
        };
      },
    };

    jest.spyOn(console, "log").mockImplementation();

    await main(["--recipient", "operator@example.com"], provider);

    expect(requests).toEqual([
      {
        to: "operator@example.com",
        subject: "MCP Moira - Test Email",
        text: "This is a test email from MCP Moira to verify the configured provider is working correctly.",
      },
    ]);
    expect(process.exitCode).not.toBe(1);
  });
});
