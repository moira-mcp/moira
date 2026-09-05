import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { MCP_TEXT_KEYS, McpTextService } from "@mcp-moira/shared";
import type { GlobalSettingsRepository } from "@mcp-moira/shared";

describe("McpTextService", () => {
  let service: McpTextService;
  let repository: jest.Mocked<GlobalSettingsRepository>;

  beforeEach(() => {
    repository = {
      getValue: jest.fn<(key: string) => Promise<unknown>>(),
      getAll: jest.fn(),
      get: jest.fn(),
      getByCategory: jest.fn(),
      setValue: jest.fn(),
    } as unknown as jest.Mocked<GlobalSettingsRepository>;
    service = new McpTextService(repository);
  });

  it("defines only database-backed prompt, reminder, error, and validation keys", () => {
    expect(MCP_TEXT_KEYS).toEqual(
      expect.objectContaining({
        systemPrompt: "mcp.systemPrompt",
        systemReminder: "mcp.systemReminder",
        errorMessages: "mcp.errorMessages",
        validationHelp: "mcp.validationHelp",
      }),
    );
    expect(Object.keys(MCP_TEXT_KEYS)).not.toContain("toolDescription");
    expect(Object.keys(MCP_TEXT_KEYS)).not.toContain("agentToolDescription");
    expect(Object.keys(MCP_TEXT_KEYS)).not.toContain("modelToolDescription");
  });

  it("loads system prompt and reminder defaults from the repository", async () => {
    repository.getValue.mockImplementation((key: string) =>
      Promise.resolve(key === MCP_TEXT_KEYS.systemPrompt ? "prompt" : "reminder"),
    );

    await expect(service.getSystemPrompt()).resolves.toBe("prompt");
    await expect(service.getSystemReminder()).resolves.toBe("reminder");
    expect(repository.getValue).toHaveBeenCalledWith(MCP_TEXT_KEYS.systemPrompt);
    expect(repository.getValue).toHaveBeenCalledWith(MCP_TEXT_KEYS.systemReminder);
  });

  it("returns empty defaults and safe parsed structured text", async () => {
    repository.getValue.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    await expect(service.getSystemPrompt()).resolves.toBe("");
    await expect(service.getSystemReminder()).resolves.toBe("");

    repository.getValue.mockResolvedValueOnce('{"missing":"Missing"}');
    await expect(service.getErrorMessages()).resolves.toEqual({ missing: "Missing" });
    repository.getValue.mockResolvedValueOnce('{"general":["Check input"]}');
    await expect(service.getValidationHelp()).resolves.toEqual({ general: ["Check input"] });
    repository.getValue.mockResolvedValue("invalid");
    await expect(service.getErrorMessages()).resolves.toEqual({});
    await expect(service.getValidationHelp()).resolves.toEqual({});
  });

  it("resolves system prompts model then agent then default", async () => {
    repository.getValue.mockImplementation((key: string) => {
      const values: Record<string, string> = {
        [MCP_TEXT_KEYS.systemPrompt]: "default",
        [MCP_TEXT_KEYS.agentSystemPrompt("cursor")]: "agent",
        [MCP_TEXT_KEYS.modelSystemPrompt("cursor", "small")]: "model",
      };
      return Promise.resolve(values[key] ?? null);
    });

    await expect(service.getSystemPromptWithOverride()).resolves.toBe("default");
    await expect(service.getSystemPromptWithOverride({ agent: "cursor" })).resolves.toBe("agent");
    await expect(
      service.getSystemPromptWithOverride({ agent: "cursor", model: "small" }),
    ).resolves.toBe("model");
  });

  it("resolves system reminders model then agent then default and preserves empty overrides", async () => {
    repository.getValue.mockImplementation((key: string) => {
      const values: Record<string, string> = {
        [MCP_TEXT_KEYS.systemReminder]: "default",
        [MCP_TEXT_KEYS.agentSystemReminder("cursor")]: "agent",
        [MCP_TEXT_KEYS.modelSystemReminder("cursor", "small")]: "",
      };
      return Promise.resolve(key in values ? values[key] : null);
    });

    await expect(service.getSystemReminderWithOverride()).resolves.toBe("default");
    await expect(service.getSystemReminderWithOverride({ agent: "cursor" })).resolves.toBe("agent");
    await expect(
      service.getSystemReminderWithOverride({ agent: "cursor", model: "small" }),
    ).resolves.toBe("");
  });
});
