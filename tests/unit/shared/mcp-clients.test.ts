import { describe, it, expect } from "@jest/globals";
import {
  mcpClients,
  getClientById,
  getClientsByCategory,
  getClientIds,
  CLIENT_COUNT,
  generateMcpConfig,
  generateClaudeCodeCommand,
  generateCopilotCliConfig,
  generateCursorDeeplink,
  generateVSCodeDeeplink,
  generateContinueConfig,
  generateZedConfig,
  generateGeminiCliConfig,
  configGenerators,
  deeplinkGenerators,
  generateMcpConfigWithToken,
  generateCopilotCliConfigWithToken,
  generateContinueConfigWithToken,
  generateZedConfigWithToken,
  generateGeminiCliConfigWithToken,
  tokenConfigGenerators,
} from "@mcp-moira/shared/mcp-clients";
import type { McpClient } from "@mcp-moira/shared/mcp-clients";

describe("mcp-clients", () => {
  describe("client registry", () => {
    it("has all 11 clients", () => {
      expect(mcpClients).toHaveLength(11);
      expect(CLIENT_COUNT).toBe(11);
    });

    it("each client has required fields", () => {
      for (const client of mcpClients) {
        expect(client.id).toBeTruthy();
        expect(client.name).toBeTruthy();
        expect(client.description).toBeTruthy();
        expect(client.configLanguage).toBeTruthy();
        expect(client.setupType).toBeTruthy();
        expect(client.category).toBeTruthy();
        expect(typeof client.requiresOAuth).toBe("boolean");
      }
    });

    it("each client has setup panel data", () => {
      for (const client of mcpClients) {
        expect(client.setup).toBeDefined();
        expect(typeof client.setup).toBe("object");
      }
    });

    it("client IDs are unique", () => {
      const ids = mcpClients.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("setup panel structure by setupType", () => {
    function getClientsBySetupType(type: string): McpClient[] {
      return mcpClients.filter((c) => c.setupType === type);
    }

    it("gui clients have primaryTitle", () => {
      const guiClients = getClientsBySetupType("gui");
      expect(guiClients.length).toBeGreaterThan(0);
      for (const client of guiClients) {
        expect(client.setup.primaryTitle).toBeTruthy();
      }
    });

    it("cli clients have primaryGenerator, auth, and alternative", () => {
      const cliClients = getClientsBySetupType("cli");
      expect(cliClients.length).toBeGreaterThan(0);
      for (const client of cliClients) {
        expect(client.setup.primaryGenerator).toBeTruthy();
        expect(client.setup.auth).toBeDefined();
        expect(client.setup.auth!.language).toBeTruthy();
        expect(client.setup.auth!.title).toBeTruthy();
        expect(client.setup.alternative).toBeDefined();
        expect(client.setup.alternative!.language).toBeTruthy();
      }
    });

    it("deeplink clients have deeplinkGenerator, auth, and alternative", () => {
      const deeplinkClients = getClientsBySetupType("deeplink");
      expect(deeplinkClients.length).toBeGreaterThan(0);
      for (const client of deeplinkClients) {
        expect(client.deeplinkGenerator).toBeTruthy();
        expect(client.setup.auth).toBeDefined();
        expect(client.setup.auth!.language).toBeTruthy();
        expect(client.setup.auth!.title).toBeTruthy();
        expect(client.setup.alternative).toBeDefined();
        expect(client.setup.alternative!.language).toBeTruthy();
      }
    });

    it("config clients have primaryTitle and primaryGenerator", () => {
      const configClients = getClientsBySetupType("config");
      expect(configClients.length).toBeGreaterThan(0);
      for (const client of configClients) {
        expect(client.setup.primaryTitle).toBeTruthy();
        expect(client.setup.primaryGenerator).toBeTruthy();
      }
    });

    it("non-gui clients have tokenAuth setup", () => {
      const nonGuiClients = mcpClients.filter((c) => c.setupType !== "gui");
      expect(nonGuiClients.length).toBeGreaterThan(0);
      for (const client of nonGuiClients) {
        expect(client.setup.tokenAuth).toBeDefined();
        expect(client.setup.tokenAuth!.language).toBeTruthy();
        expect(client.setup.tokenAuth!.generator).toBeTruthy();
      }
    });

    it("gui clients do not have tokenAuth setup", () => {
      const guiClients = getClientsBySetupType("gui");
      for (const client of guiClients) {
        expect(client.setup.tokenAuth).toBeUndefined();
      }
    });
  });

  describe("client ordering", () => {
    it("has claude-code first, copilot-cli second, cursor third", () => {
      expect(mcpClients[0].id).toBe("claude-code");
      expect(mcpClients[1].id).toBe("copilot-cli");
      expect(mcpClients[2].id).toBe("cursor");
    });
  });

  describe("no mcp-remote in HTTP-capable generators", () => {
    const testUrl = "https://moira.example.com/mcp";

    it("generateMcpConfig does not use mcp-remote", () => {
      expect(generateMcpConfig(testUrl)).not.toContain("mcp-remote");
    });

    it("generateClaudeCodeCommand does not use mcp-remote", () => {
      expect(generateClaudeCodeCommand(testUrl)).not.toContain("mcp-remote");
    });

    it("generateContinueConfig does not use mcp-remote", () => {
      expect(generateContinueConfig(testUrl)).not.toContain("mcp-remote");
    });

    it("generateCopilotCliConfig does not use mcp-remote", () => {
      expect(generateCopilotCliConfig(testUrl)).not.toContain("mcp-remote");
    });

    it("generateZedConfig does not use mcp-remote", () => {
      expect(generateZedConfig(testUrl)).not.toContain("mcp-remote");
    });

    it("generateGeminiCliConfig does not use mcp-remote", () => {
      expect(generateGeminiCliConfig(testUrl)).not.toContain("mcp-remote");
    });
  });

  describe("generator references resolve correctly", () => {
    it("all primaryGenerator references exist in configGenerators", () => {
      for (const client of mcpClients) {
        if (client.setup.primaryGenerator) {
          expect(configGenerators[client.setup.primaryGenerator]).toBeDefined();
          expect(typeof configGenerators[client.setup.primaryGenerator]).toBe("function");
        }
      }
    });

    it("all alternative generator references exist in configGenerators", () => {
      for (const client of mcpClients) {
        if (client.setup.alternative?.generator) {
          expect(configGenerators[client.setup.alternative.generator]).toBeDefined();
          expect(typeof configGenerators[client.setup.alternative.generator]).toBe("function");
        }
      }
    });

    it("all deeplinkGenerator references exist in deeplinkGenerators", () => {
      for (const client of mcpClients) {
        if (client.deeplinkGenerator) {
          expect(deeplinkGenerators[client.deeplinkGenerator]).toBeDefined();
          expect(typeof deeplinkGenerators[client.deeplinkGenerator]).toBe("function");
        }
      }
    });

    it("all configGenerators produce non-empty string output", () => {
      const testUrl = "https://moira.example.com/mcp";
      for (const [id, generator] of Object.entries(configGenerators)) {
        const result = generator(testUrl);
        expect(result).toBeTruthy();
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }
    });

    it("all deeplinkGenerators produce valid URL output", () => {
      const testUrl = "https://moira.example.com/mcp";
      for (const [id, generator] of Object.entries(deeplinkGenerators)) {
        const result = generator(testUrl);
        expect(result).toBeTruthy();
        expect(typeof result).toBe("string");
        expect(result).toMatch(/^(cursor|vscode):/);
      }
    });

    it("all tokenAuth generator references exist in tokenConfigGenerators", () => {
      for (const client of mcpClients) {
        if (client.setup.tokenAuth?.generator) {
          expect(tokenConfigGenerators[client.setup.tokenAuth.generator]).toBeDefined();
          expect(typeof tokenConfigGenerators[client.setup.tokenAuth.generator]).toBe("function");
        }
      }
    });

    it("all tokenConfigGenerators produce non-empty string with Bearer token placeholder", () => {
      const testUrl = "https://moira.example.com/mcp";
      for (const [id, generator] of Object.entries(tokenConfigGenerators)) {
        const result = generator(testUrl);
        expect(result).toBeTruthy();
        expect(typeof result).toBe("string");
        expect(result).toContain("moira_YOUR_TOKEN");
        expect(result).toContain("Bearer");
        expect(result).toContain(testUrl);
      }
    });
  });

  describe("getClientById", () => {
    it("finds existing client", () => {
      const client = getClientById("cursor");
      expect(client).toBeDefined();
      expect(client?.name).toBe("Cursor");
    });

    it("returns undefined for unknown id", () => {
      expect(getClientById("nonexistent")).toBeUndefined();
    });
  });

  describe("getClientsByCategory", () => {
    it("filters by IDE category", () => {
      const ideClients = getClientsByCategory("ide");
      expect(ideClients.length).toBeGreaterThan(0);
      for (const c of ideClients) {
        expect(c.category).toBe("ide");
      }
    });

    it("returns empty for unknown category", () => {
      expect(getClientsByCategory("unknown" as never)).toHaveLength(0);
    });
  });

  describe("getClientIds", () => {
    it("returns all IDs", () => {
      const ids = getClientIds();
      expect(ids).toHaveLength(11);
      expect(ids).toContain("cursor");
      expect(ids).toContain("claude-code");
      expect(ids).toContain("copilot-cli");
      expect(ids).toContain("zed");
      expect(ids).toContain("gemini-cli");
    });
  });

  describe("config generators", () => {
    const testUrl = "https://moira.example.com/mcp";

    describe("generateMcpConfig", () => {
      it("generates valid JSON config with HTTP url", () => {
        const config = generateMcpConfig(testUrl);
        const parsed = JSON.parse(config);
        expect(parsed.mcpServers.moira.url).toBe(testUrl);
        expect(parsed.mcpServers.moira.command).toBeUndefined();
      });
    });

    describe("generateClaudeCodeCommand", () => {
      it("generates CLI command with --transport http", () => {
        const cmd = generateClaudeCodeCommand(testUrl);
        expect(cmd).toBe(`claude mcp add --transport http moira ${testUrl}`);
      });
    });

    describe("generateCursorDeeplink", () => {
      it("generates cursor:// protocol link", () => {
        const link = generateCursorDeeplink(testUrl);
        expect(link).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install/);
        expect(link).toContain("name=moira");
      });
    });

    describe("generateVSCodeDeeplink", () => {
      it("generates vscode: protocol link", () => {
        const link = generateVSCodeDeeplink(testUrl);
        expect(link).toMatch(/^vscode:mcp\/install\?/);
        expect(link).toContain("moira");
      });
    });

    describe("generateCopilotCliConfig", () => {
      it("generates JSON config with type http", () => {
        const config = generateCopilotCliConfig(testUrl);
        const parsed = JSON.parse(config);
        expect(parsed.mcpServers.moira.type).toBe("http");
        expect(parsed.mcpServers.moira.url).toBe(testUrl);
      });
    });

    describe("generateContinueConfig", () => {
      it("generates YAML config with HTTP url", () => {
        const config = generateContinueConfig(testUrl);
        expect(config).toContain("mcpServers:");
        expect(config).toContain("name: moira");
        expect(config).toContain(`url: ${testUrl}`);
        expect(config).not.toContain("mcp-remote");
      });
    });

    describe("generateZedConfig", () => {
      it("generates JSON config with context_servers", () => {
        const config = generateZedConfig(testUrl);
        const parsed = JSON.parse(config);
        expect(parsed.context_servers.moira.url).toBe(testUrl);
      });
    });

    describe("generateGeminiCliConfig", () => {
      it("generates JSON config with httpUrl", () => {
        const config = generateGeminiCliConfig(testUrl);
        const parsed = JSON.parse(config);
        expect(parsed.mcpServers.moira.httpUrl).toBe(testUrl);
      });
    });
  });

  describe("token config generators", () => {
    const testUrl = "https://moira.example.com/mcp";

    describe("generateMcpConfigWithToken", () => {
      it("generates JSON config with headers containing Bearer token", () => {
        const config = generateMcpConfigWithToken(testUrl);
        const parsed = JSON.parse(config);
        expect(parsed.mcpServers.moira.url).toBe(testUrl);
        expect(parsed.mcpServers.moira.headers.Authorization).toContain("Bearer moira_YOUR_TOKEN");
      });
    });

    describe("generateCopilotCliConfigWithToken", () => {
      it("generates JSON config with type http and Bearer token", () => {
        const config = generateCopilotCliConfigWithToken(testUrl);
        const parsed = JSON.parse(config);
        expect(parsed.mcpServers.moira.type).toBe("http");
        expect(parsed.mcpServers.moira.url).toBe(testUrl);
        expect(parsed.mcpServers.moira.headers.Authorization).toContain("Bearer moira_YOUR_TOKEN");
      });
    });

    describe("generateContinueConfigWithToken", () => {
      it("generates YAML config with Bearer token in headers", () => {
        const config = generateContinueConfigWithToken(testUrl);
        expect(config).toContain("mcpServers:");
        expect(config).toContain("name: moira");
        expect(config).toContain(`url: ${testUrl}`);
        expect(config).toContain("Authorization:");
        expect(config).toContain("Bearer moira_YOUR_TOKEN");
      });
    });

    describe("generateZedConfigWithToken", () => {
      it("generates JSON config with context_servers and Bearer token", () => {
        const config = generateZedConfigWithToken(testUrl);
        const parsed = JSON.parse(config);
        expect(parsed.context_servers.moira.url).toBe(testUrl);
        expect(parsed.context_servers.moira.headers.Authorization).toContain(
          "Bearer moira_YOUR_TOKEN",
        );
      });
    });

    describe("generateGeminiCliConfigWithToken", () => {
      it("generates JSON config with httpUrl and Bearer token", () => {
        const config = generateGeminiCliConfigWithToken(testUrl);
        const parsed = JSON.parse(config);
        expect(parsed.mcpServers.moira.httpUrl).toBe(testUrl);
        expect(parsed.mcpServers.moira.headers.Authorization).toContain("Bearer moira_YOUR_TOKEN");
      });
    });
  });
});
