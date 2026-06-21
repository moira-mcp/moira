/**
 * Unit tests for McpTextService
 * Tests loading tool descriptions and system prompt from database
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { McpTextService, MCP_TOOL_NAMES, MCP_TEXT_KEYS } from "@mcp-moira/shared";
import type { GlobalSettingsRepository } from "@mcp-moira/shared";

describe("McpTextService", () => {
  let service: McpTextService;
  let mockGlobalSettingsRepo: jest.Mocked<GlobalSettingsRepository>;

  beforeEach(() => {
    mockGlobalSettingsRepo = {
      getValue: jest.fn<(key: string) => Promise<unknown>>(),
      getAll: jest.fn(),
      get: jest.fn(),
      getByCategory: jest.fn(),
      setValue: jest.fn(),
    } as unknown as jest.Mocked<GlobalSettingsRepository>;

    service = new McpTextService(mockGlobalSettingsRepo);
  });

  describe("MCP_TOOL_NAMES", () => {
    it("contains all 11 tool names", () => {
      expect(MCP_TOOL_NAMES).toHaveLength(11);
      expect(MCP_TOOL_NAMES).toContain("list");
      expect(MCP_TOOL_NAMES).toContain("start");
      expect(MCP_TOOL_NAMES).toContain("step");
      expect(MCP_TOOL_NAMES).toContain("manage");
      expect(MCP_TOOL_NAMES).toContain("help");
      expect(MCP_TOOL_NAMES).toContain("settings");
      expect(MCP_TOOL_NAMES).toContain("token");
      expect(MCP_TOOL_NAMES).toContain("session");
      expect(MCP_TOOL_NAMES).toContain("notes");
      expect(MCP_TOOL_NAMES).toContain("artifacts");
    });
  });

  describe("MCP_TEXT_KEYS", () => {
    it("generates correct tool description key", () => {
      expect(MCP_TEXT_KEYS.toolDescription("list")).toBe("mcp.toolDescription.list");
      expect(MCP_TEXT_KEYS.toolDescription("manage")).toBe("mcp.toolDescription.manage");
    });

    it("has correct static keys", () => {
      expect(MCP_TEXT_KEYS.systemPrompt).toBe("mcp.systemPrompt");
      expect(MCP_TEXT_KEYS.systemReminder).toBe("mcp.systemReminder");
      expect(MCP_TEXT_KEYS.errorMessages).toBe("mcp.errorMessages");
      expect(MCP_TEXT_KEYS.validationHelp).toBe("mcp.validationHelp");
    });
  });

  describe("getToolDescription", () => {
    it("returns description from database", async () => {
      const expectedDescription = "List all available workflows";
      mockGlobalSettingsRepo.getValue.mockResolvedValue(expectedDescription);

      const result = await service.getToolDescription("list");

      expect(mockGlobalSettingsRepo.getValue).toHaveBeenCalledWith("mcp.toolDescription.list");
      expect(result).toBe(expectedDescription);
    });

    it("returns empty string when not found in DB", async () => {
      mockGlobalSettingsRepo.getValue.mockResolvedValue(null);

      const result = await service.getToolDescription("list");

      expect(result).toBe("");
    });

    it("returns empty string when value is undefined", async () => {
      mockGlobalSettingsRepo.getValue.mockResolvedValue(undefined);

      const result = await service.getToolDescription("start");

      expect(result).toBe("");
    });
  });

  describe("getAllToolDescriptions", () => {
    it("returns all 11 tool descriptions", async () => {
      // Mock each tool description
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        const descriptions: Record<string, string> = {
          "mcp.toolDescription.list": "List workflows",
          "mcp.toolDescription.start": "Start workflow",
          "mcp.toolDescription.step": "Execute step",
          "mcp.toolDescription.manage": "Manage workflow",
          "mcp.toolDescription.help": "Get help",
          "mcp.toolDescription.settings": "Manage settings",
          "mcp.toolDescription.token": "Create token",
          "mcp.toolDescription.session": "Session info",
          "mcp.toolDescription.notes": "Manage notes",
          "mcp.toolDescription.artifacts": "Manage artifacts",
          "mcp.toolDescription.lock": "Manage locks",
        };
        return Promise.resolve(descriptions[key] || null);
      });

      const result = await service.getAllToolDescriptions();

      expect(Object.keys(result)).toHaveLength(11);
      expect(result.list).toBe("List workflows");
      expect(result.start).toBe("Start workflow");
      expect(result.step).toBe("Execute step");
      expect(result.manage).toBe("Manage workflow");
      expect(result.help).toBe("Get help");
      expect(result.settings).toBe("Manage settings");
      expect(result.token).toBe("Create token");
      expect(result.session).toBe("Session info");
      expect(result.notes).toBe("Manage notes");
      expect(result.artifacts).toBe("Manage artifacts");
      expect(result.lock).toBe("Manage locks");
    });

    it("returns empty strings for missing descriptions", async () => {
      mockGlobalSettingsRepo.getValue.mockResolvedValue(null);

      const result = await service.getAllToolDescriptions();

      expect(Object.keys(result)).toHaveLength(11);
      for (const toolName of MCP_TOOL_NAMES) {
        expect(result[toolName]).toBe("");
      }
    });
  });

  describe("getSystemPrompt", () => {
    it("returns system prompt from database", async () => {
      const expectedPrompt = "You are an AI assistant...";
      mockGlobalSettingsRepo.getValue.mockResolvedValue(expectedPrompt);

      const result = await service.getSystemPrompt();

      expect(mockGlobalSettingsRepo.getValue).toHaveBeenCalledWith("mcp.systemPrompt");
      expect(result).toBe(expectedPrompt);
    });

    it("returns empty string when not found", async () => {
      mockGlobalSettingsRepo.getValue.mockResolvedValue(null);

      const result = await service.getSystemPrompt();

      expect(result).toBe("");
    });
  });

  describe("getSystemReminder", () => {
    it("returns system reminder from database", async () => {
      const expectedReminder = "Remember to verify your work";
      mockGlobalSettingsRepo.getValue.mockResolvedValue(expectedReminder);

      const result = await service.getSystemReminder();

      expect(mockGlobalSettingsRepo.getValue).toHaveBeenCalledWith("mcp.systemReminder");
      expect(result).toBe(expectedReminder);
    });

    it("returns empty string when not found", async () => {
      mockGlobalSettingsRepo.getValue.mockResolvedValue(null);

      const result = await service.getSystemReminder();

      expect(result).toBe("");
    });
  });

  describe("getErrorMessages", () => {
    it("returns parsed error messages from database", async () => {
      const errorMessages = {
        workflow_not_found: "Workflow not found",
        process_expired: "Process expired",
      };
      mockGlobalSettingsRepo.getValue.mockResolvedValue(JSON.stringify(errorMessages));

      const result = await service.getErrorMessages();

      expect(result).toEqual(errorMessages);
    });

    it("returns empty object when not found", async () => {
      mockGlobalSettingsRepo.getValue.mockResolvedValue(null);

      const result = await service.getErrorMessages();

      expect(result).toEqual({});
    });

    it("returns empty object on invalid JSON", async () => {
      mockGlobalSettingsRepo.getValue.mockResolvedValue("invalid json {");

      const result = await service.getErrorMessages();

      expect(result).toEqual({});
    });
  });

  describe("getValidationHelp", () => {
    it("returns parsed validation help from database", async () => {
      const validationHelp = {
        general: ["Check field names", "Verify types"],
        json_format: ["Use quotes", "No trailing commas"],
      };
      mockGlobalSettingsRepo.getValue.mockResolvedValue(JSON.stringify(validationHelp));

      const result = await service.getValidationHelp();

      expect(result).toEqual(validationHelp);
    });

    it("returns empty object when not found", async () => {
      mockGlobalSettingsRepo.getValue.mockResolvedValue(null);

      const result = await service.getValidationHelp();

      expect(result).toEqual({});
    });

    it("returns empty object on invalid JSON", async () => {
      mockGlobalSettingsRepo.getValue.mockResolvedValue("not valid json");

      const result = await service.getValidationHelp();

      expect(result).toEqual({});
    });
  });

  // ============================================================================
  // HIERARCHICAL OVERRIDE TESTS
  // ============================================================================

  describe("MCP_TEXT_KEYS - override key generation", () => {
    it("generates correct agent-level tool description key", () => {
      expect(MCP_TEXT_KEYS.agentToolDescription("claude", "list")).toBe(
        "mcp.agent.claude.toolDescription.list",
      );
      expect(MCP_TEXT_KEYS.agentToolDescription("chatgpt", "help")).toBe(
        "mcp.agent.chatgpt.toolDescription.help",
      );
    });

    it("generates correct agent-level system prompt key", () => {
      expect(MCP_TEXT_KEYS.agentSystemPrompt("claude")).toBe("mcp.agent.claude.systemPrompt");
      expect(MCP_TEXT_KEYS.agentSystemPrompt("gemini")).toBe("mcp.agent.gemini.systemPrompt");
    });

    it("generates correct agent-level system reminder key", () => {
      expect(MCP_TEXT_KEYS.agentSystemReminder("claude")).toBe("mcp.agent.claude.systemReminder");
    });

    it("generates correct model-level tool description key (nested under agent)", () => {
      expect(MCP_TEXT_KEYS.modelToolDescription("claude", "claude-opus-4-5-20251101", "list")).toBe(
        "mcp.agent.claude.model.claude-opus-4-5-20251101.toolDescription.list",
      );
      expect(MCP_TEXT_KEYS.modelToolDescription("chatgpt", "gpt-4o", "help")).toBe(
        "mcp.agent.chatgpt.model.gpt-4o.toolDescription.help",
      );
    });

    it("generates correct model-level system prompt key (nested under agent)", () => {
      expect(MCP_TEXT_KEYS.modelSystemPrompt("claude", "claude-opus-4-5-20251101")).toBe(
        "mcp.agent.claude.model.claude-opus-4-5-20251101.systemPrompt",
      );
    });

    it("generates correct model-level system reminder key (nested under agent)", () => {
      expect(MCP_TEXT_KEYS.modelSystemReminder("claude", "claude-opus-4-5-20251101")).toBe(
        "mcp.agent.claude.model.claude-opus-4-5-20251101.systemReminder",
      );
    });
  });

  describe("getToolDescriptionWithOverride - hierarchical resolution", () => {
    it("returns default when no context provided", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.toolDescription.list") return Promise.resolve("Default list description");
        return Promise.resolve(null);
      });

      const result = await service.getToolDescriptionWithOverride("list");

      expect(result).toBe("Default list description");
    });

    it("returns default when agent/model are null", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.toolDescription.list") return Promise.resolve("Default list description");
        return Promise.resolve(null);
      });

      const result = await service.getToolDescriptionWithOverride("list", {
        agent: null,
        model: null,
      });

      expect(result).toBe("Default list description");
    });

    it("returns agent override when agent context provided and override exists", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.agent.claude.toolDescription.list")
          return Promise.resolve("Claude-specific list description");
        if (key === "mcp.toolDescription.list") return Promise.resolve("Default list description");
        return Promise.resolve(null);
      });

      const result = await service.getToolDescriptionWithOverride("list", { agent: "claude" });

      expect(result).toBe("Claude-specific list description");
    });

    it("returns model override when model context provided and override exists", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.agent.claude.model.claude-opus-4-5-20251101.toolDescription.list")
          return Promise.resolve("Opus-specific list description");
        if (key === "mcp.agent.claude.toolDescription.list")
          return Promise.resolve("Claude-specific list description");
        if (key === "mcp.toolDescription.list") return Promise.resolve("Default list description");
        return Promise.resolve(null);
      });

      const result = await service.getToolDescriptionWithOverride("list", {
        agent: "claude",
        model: "claude-opus-4-5-20251101",
      });

      expect(result).toBe("Opus-specific list description");
    });

    it("falls back to agent override when model override is null", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.agent.claude.model.claude-opus-4-5-20251101.toolDescription.list")
          return Promise.resolve(null);
        if (key === "mcp.agent.claude.toolDescription.list")
          return Promise.resolve("Claude-specific list description");
        if (key === "mcp.toolDescription.list") return Promise.resolve("Default list description");
        return Promise.resolve(null);
      });

      const result = await service.getToolDescriptionWithOverride("list", {
        agent: "claude",
        model: "claude-opus-4-5-20251101",
      });

      expect(result).toBe("Claude-specific list description");
    });

    it("falls back to default when both overrides are null", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.toolDescription.list") return Promise.resolve("Default list description");
        return Promise.resolve(null);
      });

      const result = await service.getToolDescriptionWithOverride("list", {
        agent: "claude",
        model: "claude-opus-4-5-20251101",
      });

      expect(result).toBe("Default list description");
    });
  });

  describe("getSystemPromptWithOverride - hierarchical resolution", () => {
    it("returns default when no context provided", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.systemPrompt") return Promise.resolve("Default system prompt");
        return Promise.resolve(null);
      });

      const result = await service.getSystemPromptWithOverride();

      expect(result).toBe("Default system prompt");
    });

    it("returns agent override when agent context provided", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.agent.claude.systemPrompt")
          return Promise.resolve("Claude-specific prompt");
        if (key === "mcp.systemPrompt") return Promise.resolve("Default system prompt");
        return Promise.resolve(null);
      });

      const result = await service.getSystemPromptWithOverride({ agent: "claude" });

      expect(result).toBe("Claude-specific prompt");
    });

    it("returns model override when both agent and model context provided", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.agent.claude.model.claude-opus-4-5-20251101.systemPrompt")
          return Promise.resolve("Opus-specific prompt");
        if (key === "mcp.agent.claude.systemPrompt")
          return Promise.resolve("Claude-specific prompt");
        if (key === "mcp.systemPrompt") return Promise.resolve("Default system prompt");
        return Promise.resolve(null);
      });

      const result = await service.getSystemPromptWithOverride({
        agent: "claude",
        model: "claude-opus-4-5-20251101",
      });

      expect(result).toBe("Opus-specific prompt");
    });
  });

  describe("getSystemReminderWithOverride - hierarchical resolution", () => {
    it("returns default when no context provided", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.systemReminder") return Promise.resolve("Default reminder");
        return Promise.resolve(null);
      });

      const result = await service.getSystemReminderWithOverride();

      expect(result).toBe("Default reminder");
    });

    it("returns agent override when agent context provided", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.agent.claude.systemReminder")
          return Promise.resolve("Claude-specific reminder");
        if (key === "mcp.systemReminder") return Promise.resolve("Default reminder");
        return Promise.resolve(null);
      });

      const result = await service.getSystemReminderWithOverride({ agent: "claude" });

      expect(result).toBe("Claude-specific reminder");
    });

    it("returns model override when both agent and model context provided", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        if (key === "mcp.agent.claude.model.claude-opus-4-5-20251101.systemReminder")
          return Promise.resolve("Opus-specific reminder");
        if (key === "mcp.agent.claude.systemReminder")
          return Promise.resolve("Claude-specific reminder");
        if (key === "mcp.systemReminder") return Promise.resolve("Default reminder");
        return Promise.resolve(null);
      });

      const result = await service.getSystemReminderWithOverride({
        agent: "claude",
        model: "claude-opus-4-5-20251101",
      });

      expect(result).toBe("Opus-specific reminder");
    });
  });

  describe("getAllToolDescriptionsWithOverride", () => {
    it("returns all tool descriptions with override resolution", async () => {
      mockGlobalSettingsRepo.getValue.mockImplementation((key: string) => {
        // Claude has override for list and help
        if (key === "mcp.agent.claude.toolDescription.list") return Promise.resolve("Claude list");
        if (key === "mcp.agent.claude.toolDescription.help") return Promise.resolve("Claude help");
        // Defaults for everything else
        const defaults: Record<string, string> = {
          "mcp.toolDescription.list": "Default list",
          "mcp.toolDescription.start": "Default start",
          "mcp.toolDescription.step": "Default step",
          "mcp.toolDescription.manage": "Default manage",
          "mcp.toolDescription.help": "Default help",
          "mcp.toolDescription.settings": "Default settings",
          "mcp.toolDescription.token": "Default token",
          "mcp.toolDescription.session": "Default session",
        };
        return Promise.resolve(defaults[key] ?? null);
      });

      const result = await service.getAllToolDescriptionsWithOverride({ agent: "claude" });

      expect(result.list).toBe("Claude list");
      expect(result.help).toBe("Claude help");
      expect(result.start).toBe("Default start");
      expect(result.step).toBe("Default step");
      expect(result.manage).toBe("Default manage");
      expect(result.settings).toBe("Default settings");
      expect(result.token).toBe("Default token");
      expect(result.session).toBe("Default session");
    });
  });
});
