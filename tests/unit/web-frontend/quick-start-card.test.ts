/**
 * Tests for QuickStartCard component logic:
 * - All client i18n keys exist in both locales
 * - Config generators produce valid output for each client
 * - setupType-specific fields are consistent
 */

import { describe, test, expect } from "@jest/globals";
import {
  mcpClients,
  configGenerators,
  deeplinkGenerators,
} from "../../../packages/shared/src/mcp-clients";
import { resolveMcpUrl } from "../../../packages/web-frontend/src/components/QuickStartCard";
import en from "../../../packages/web-frontend/src/locales/en.json";
import ru from "../../../packages/web-frontend/src/locales/ru.json";

const MCP_URL = "http://localhost:3031/mcp";

// Helper to get nested value from i18n JSON
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce((acc: unknown, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

describe("QuickStartCard i18n completeness", () => {
  const basePath = "pages.dashboard.quickStart";

  test("common quickStart keys exist in both locales", () => {
    const commonKeys = ["title", "description", "documentation", "copy", "copied"];
    for (const key of commonKeys) {
      const fullPath = `${basePath}.${key}`;
      expect(getNestedValue(en, fullPath)).toBeDefined();
      expect(getNestedValue(ru, fullPath)).toBeDefined();
    }
  });

  test("all clients have required i18n keys in English per setupType", () => {
    for (const client of mcpClients) {
      const clientPath = `${basePath}.clients.${client.id}`;

      // GUI clients use description text
      if (client.setupType === "gui") {
        expect(getNestedValue(en, `${clientPath}.description`)).toBeDefined();
      }
      // CLI and deeplink clients with auth need auth keys
      if (client.setup.auth) {
        expect(getNestedValue(en, `${clientPath}.authIntro`)).toBeDefined();
        expect(getNestedValue(en, `${clientPath}.authContent`)).toBeDefined();
      }
      // Clients with alternatives need alternativeTitle
      if (client.setup.alternative) {
        expect(getNestedValue(en, `${clientPath}.alternativeTitle`)).toBeDefined();
      }
      // Deeplink clients need deeplinkButton
      if (client.setupType === "deeplink") {
        expect(getNestedValue(en, `${clientPath}.deeplinkButton`)).toBeDefined();
      }
    }
  });

  test("all clients have required i18n keys in Russian per setupType", () => {
    for (const client of mcpClients) {
      const clientPath = `${basePath}.clients.${client.id}`;

      if (client.setupType === "gui") {
        expect(getNestedValue(ru, `${clientPath}.description`)).toBeDefined();
      }
      if (client.setup.auth) {
        expect(getNestedValue(ru, `${clientPath}.authIntro`)).toBeDefined();
        expect(getNestedValue(ru, `${clientPath}.authContent`)).toBeDefined();
      }
      if (client.setup.alternative) {
        expect(getNestedValue(ru, `${clientPath}.alternativeTitle`)).toBeDefined();
      }
      if (client.setupType === "deeplink") {
        expect(getNestedValue(ru, `${clientPath}.deeplinkButton`)).toBeDefined();
      }
    }
  });
});

describe("QuickStartCard config generation", () => {
  test("CLI clients produce valid primary commands", () => {
    const cliClients = mcpClients.filter((c) => c.setupType === "cli");
    expect(cliClients.length).toBeGreaterThan(0);

    for (const client of cliClients) {
      expect(client.setup.primaryGenerator).toBeDefined();
      const generator = configGenerators[client.setup.primaryGenerator!];
      expect(generator).toBeDefined();
      const result = generator(MCP_URL);
      expect(result).toContain(MCP_URL);
      expect(result.length).toBeGreaterThan(10);
    }
  });

  test("Config clients produce valid JSON configs", () => {
    const configClients = mcpClients.filter((c) => c.setupType === "config");
    expect(configClients.length).toBeGreaterThan(0);

    for (const client of configClients) {
      expect(client.setup.primaryGenerator).toBeDefined();
      const generator = configGenerators[client.setup.primaryGenerator!];
      const result = generator(MCP_URL);
      expect(result).toContain(MCP_URL);
    }
  });

  test("Deeplink clients produce valid URLs", () => {
    const deeplinkClients = mcpClients.filter((c) => c.setupType === "deeplink");
    expect(deeplinkClients.length).toBeGreaterThan(0);

    for (const client of deeplinkClients) {
      expect(client.deeplinkGenerator).toBeDefined();
      const generator = deeplinkGenerators[client.deeplinkGenerator!];
      expect(generator).toBeDefined();
      const url = generator(MCP_URL);
      expect(url.length).toBeGreaterThan(10);
    }
  });

  test("clients with alternatives have valid alternative generators", () => {
    const clientsWithAlts = mcpClients.filter((c) => c.setup.alternative?.generator);
    expect(clientsWithAlts.length).toBeGreaterThan(0);

    for (const client of clientsWithAlts) {
      const gen = configGenerators[client.setup.alternative!.generator!];
      expect(gen).toBeDefined();
      const result = gen(MCP_URL);
      expect(result).toContain(MCP_URL);
    }
  });
});

describe("resolveMcpUrl deployment-mode gating", () => {
  const BAKED = "https://example.com/mcp";
  const RUNTIME = "http://localhost:8077/mcp";

  test("self-host uses the runtime URL when available", () => {
    expect(resolveMcpUrl("self-host", RUNTIME, BAKED)).toBe(RUNTIME);
  });

  test("self-host falls back to the baked URL while runtime is still loading", () => {
    expect(resolveMcpUrl("self-host", null, BAKED)).toBe(BAKED);
  });

  test("saas keeps the build-time-baked URL even if a runtime URL is present", () => {
    expect(resolveMcpUrl("saas", RUNTIME, BAKED)).toBe(BAKED);
  });

  test("unknown mode (not yet loaded) keeps the baked URL", () => {
    expect(resolveMcpUrl(null, RUNTIME, BAKED)).toBe(BAKED);
  });
});

describe("QuickStartCard setupType consistency", () => {
  test("GUI clients have no generators", () => {
    const guiClients = mcpClients.filter((c) => c.setupType === "gui");
    for (const client of guiClients) {
      expect(client.setup.primaryGenerator).toBeUndefined();
      expect(client.deeplinkGenerator).toBeUndefined();
    }
  });

  test("deeplink clients have deeplinkGenerator set", () => {
    const deeplinkClients = mcpClients.filter((c) => c.setupType === "deeplink");
    for (const client of deeplinkClients) {
      expect(client.deeplinkGenerator).toBeDefined();
    }
  });

  test("all 11 clients are present", () => {
    expect(mcpClients.length).toBe(11);
    const ids = mcpClients.map((c) => c.id);
    expect(ids).toContain("claude-web");
    expect(ids).toContain("chatgpt");
    expect(ids).toContain("claude-code");
    expect(ids).toContain("copilot-cli");
    expect(ids).toContain("claude-desktop");
    expect(ids).toContain("cursor");
    expect(ids).toContain("vscode");
    expect(ids).toContain("perplexity");
    expect(ids).toContain("continue");
  });
});
