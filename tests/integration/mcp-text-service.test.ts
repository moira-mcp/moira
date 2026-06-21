/**
 * MCP Text Service Integration Tests
 * Tests loading tool descriptions from database
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import {
  getDatabase,
  GlobalSettingsRepository,
  McpTextService,
  MCP_TOOL_NAMES,
  MCP_TEXT_KEYS,
  MCP_AGENT_CATEGORY,
  MCP_MODEL_CATEGORY,
} from "@mcp-moira/shared";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

describe("McpTextService Integration", () => {
  let db: BetterSQLite3Database;
  let globalSettingsRepo: GlobalSettingsRepository;
  let service: McpTextService;

  beforeAll(() => {
    db = getDatabase();
    globalSettingsRepo = new GlobalSettingsRepository(db);
    service = new McpTextService(globalSettingsRepo);
  });

  describe("Tool Descriptions from Database", () => {
    test("getToolDescription returns seeded value for list tool", async () => {
      const description = await service.getToolDescription("list");

      expect(description).toBeDefined();
      expect(description.length).toBeGreaterThan(0);
      expect(description).toContain("workflow"); // Should mention workflows
    });

    test("getAllToolDescriptions returns all 11 tool descriptions", async () => {
      const descriptions = await service.getAllToolDescriptions();

      expect(Object.keys(descriptions)).toHaveLength(11);

      for (const toolName of MCP_TOOL_NAMES) {
        expect(descriptions[toolName]).toBeDefined();
        // artifacts tool may not be seeded yet, so we check for defined rather than non-empty
      }
    });

    test("getSystemPrompt returns string (may be empty in test DB)", async () => {
      const systemPrompt = await service.getSystemPrompt();

      expect(systemPrompt).toBeDefined();
      expect(typeof systemPrompt).toBe("string");
      // In test DB, system prompt may be empty if SYSTEM-PROMPT.md was not found during seeding
      // In production DB, it should contain workflow-related content
    });

    test("getSystemReminder returns system reminder", async () => {
      const reminder = await service.getSystemReminder();

      expect(reminder).toBeDefined();
      // May or may not be seeded, but should return string
      expect(typeof reminder).toBe("string");
    });
  });

  describe("Dynamic Update Verification", () => {
    const TEST_TOOL_KEY = MCP_TEXT_KEYS.toolDescription("list");
    let originalValue: string | null;

    beforeAll(async () => {
      // Save original value
      originalValue = await globalSettingsRepo.getValue<string>(TEST_TOOL_KEY);
    });

    afterAll(async () => {
      // Restore original value
      if (originalValue !== null) {
        await globalSettingsRepo.setValue(TEST_TOOL_KEY, originalValue, "system-admin");
      }
    });

    test("changing tool description in DB reflects in service", async () => {
      const testDescription = "TEST_DESCRIPTION_" + Date.now();

      // Update value in DB
      await globalSettingsRepo.setValue(TEST_TOOL_KEY, testDescription, "system-admin");

      // Read through service - should get new value
      const description = await service.getToolDescription("list");

      expect(description).toBe(testDescription);
    });

    test("empty description returns empty string", async () => {
      // Set empty value
      await globalSettingsRepo.setValue(TEST_TOOL_KEY, "", "system-admin");

      const description = await service.getToolDescription("list");

      expect(description).toBe("");
    });
  });

  describe("Error Messages and Validation Help", () => {
    test("getErrorMessages returns seeded error messages", async () => {
      const messages = await service.getErrorMessages();

      expect(typeof messages).toBe("object");
      expect(Object.keys(messages).length).toBeGreaterThan(0);
      // Should contain known error keys
      expect(messages).toHaveProperty("unknown_error");
      expect(messages).toHaveProperty("workflow_id_required");
    });

    test("getValidationHelp returns seeded validation help", async () => {
      const help = await service.getValidationHelp();

      expect(typeof help).toBe("object");
      expect(Object.keys(help).length).toBeGreaterThan(0);
      // Should contain known help categories
      expect(help).toHaveProperty("general");
      expect(Array.isArray(help.general)).toBe(true);
    });
  });

  describe("Agent and Model Override Resolution (Dynamic Creation)", () => {
    // Note: Agent/model override settings are NOT seeded - they are created dynamically
    // when first saved via the Admin UI. This tests the hierarchical resolution logic.

    test("hierarchical resolution returns default when no overrides exist", async () => {
      // Without any override entries, resolution should return default
      const description = await service.getToolDescriptionWithOverride("list", {
        agent: "test-agent",
        model: "test-model",
      });

      // Should return default description since no overrides exist
      const defaultDescription = await service.getToolDescription("list");
      expect(description).toBe(defaultDescription);
    });

    test("dynamically created agent override is used in resolution", async () => {
      const testDescription = "TEST_AGENT_OVERRIDE_" + Date.now();
      const agentOverrideKey = MCP_TEXT_KEYS.agentToolDescription("test-claude", "list");

      // Create the setting dynamically (simulating admin UI save)
      await globalSettingsRepo.create(
        {
          key: agentOverrideKey,
          value: testDescription,
          type: "text",
          label: "Test Agent Override",
          description: null,
          category: MCP_AGENT_CATEGORY,
        },
        "system-admin",
      );

      try {
        // Resolution should now return agent override
        const description = await service.getToolDescriptionWithOverride("list", {
          agent: "test-claude",
        });

        expect(description).toBe(testDescription);
      } finally {
        // Clean up by setting to null (can't delete, just nullify)
        await globalSettingsRepo.setValue(agentOverrideKey, null, "system-admin");
      }
    });

    test("dynamically created model override takes precedence over agent override", async () => {
      const agentDescription = "TEST_AGENT_" + Date.now();
      const modelDescription = "TEST_MODEL_" + Date.now();
      const agentOverrideKey = MCP_TEXT_KEYS.agentToolDescription("test-claude-2", "list");
      const modelOverrideKey = MCP_TEXT_KEYS.modelToolDescription(
        "test-claude-2",
        "test-opus",
        "list",
      );

      // Create both settings dynamically
      await globalSettingsRepo.create(
        {
          key: agentOverrideKey,
          value: agentDescription,
          type: "text",
          label: "Test Agent Override",
          description: null,
          category: MCP_AGENT_CATEGORY,
        },
        "system-admin",
      );

      await globalSettingsRepo.create(
        {
          key: modelOverrideKey,
          value: modelDescription,
          type: "text",
          label: "Test Model Override",
          description: null,
          category: MCP_MODEL_CATEGORY,
        },
        "system-admin",
      );

      try {
        // Resolution should return model override (highest priority)
        const description = await service.getToolDescriptionWithOverride("list", {
          agent: "test-claude-2",
          model: "test-opus",
        });

        expect(description).toBe(modelDescription);

        // With only agent context, should return agent override
        const agentOnlyDescription = await service.getToolDescriptionWithOverride("list", {
          agent: "test-claude-2",
        });

        expect(agentOnlyDescription).toBe(agentDescription);
      } finally {
        // Clean up
        await globalSettingsRepo.setValue(agentOverrideKey, null, "system-admin");
        await globalSettingsRepo.setValue(modelOverrideKey, null, "system-admin");
      }
    });

    test("null override value falls back to next level in hierarchy", async () => {
      const agentDescription = "TEST_AGENT_FALLBACK_" + Date.now();
      const agentOverrideKey = MCP_TEXT_KEYS.agentToolDescription("test-claude-3", "list");
      const modelOverrideKey = MCP_TEXT_KEYS.modelToolDescription(
        "test-claude-3",
        "test-sonnet",
        "list",
      );

      // Create agent override with value
      await globalSettingsRepo.create(
        {
          key: agentOverrideKey,
          value: agentDescription,
          type: "text",
          label: "Test Agent Override",
          description: null,
          category: MCP_AGENT_CATEGORY,
        },
        "system-admin",
      );

      // Create model override with null value (inactive)
      await globalSettingsRepo.create(
        {
          key: modelOverrideKey,
          value: null,
          type: "text",
          label: "Test Model Override",
          description: null,
          category: MCP_MODEL_CATEGORY,
        },
        "system-admin",
      );

      try {
        // Resolution should fall back to agent override since model override is null
        const description = await service.getToolDescriptionWithOverride("list", {
          agent: "test-claude-3",
          model: "test-sonnet",
        });

        expect(description).toBe(agentDescription);
      } finally {
        // Clean up
        await globalSettingsRepo.setValue(agentOverrideKey, null, "system-admin");
        await globalSettingsRepo.setValue(modelOverrideKey, null, "system-admin");
      }
    });
  });
});
