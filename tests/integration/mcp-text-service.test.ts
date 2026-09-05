import { describe, expect, test } from "@jest/globals";
import {
  getDatabase,
  GlobalSettingsRepository,
  McpTextService,
  MCP_TEXT_KEYS,
} from "@mcp-moira/shared";

describe("McpTextService database integration", () => {
  const repository = new GlobalSettingsRepository(getDatabase());
  const service = new McpTextService(repository);

  test("loads the separately managed system prompt, reminder, errors, and validation help", async () => {
    await expect(service.getSystemPrompt()).resolves.toEqual(expect.any(String));
    await expect(service.getSystemReminder()).resolves.toEqual(expect.any(String));
    await expect(service.getErrorMessages()).resolves.toEqual(expect.any(Object));
    await expect(service.getValidationHelp()).resolves.toEqual(expect.any(Object));
  });

  test("uses a database agent system-reminder override without defining tool-description keys", async () => {
    const key = MCP_TEXT_KEYS.agentSystemReminder("integration-static-description-test");
    const existing = await repository.get(key);
    if (!existing) {
      await repository.create(
        {
          key,
          value: "integration reminder",
          type: "text",
          label: "Integration reminder",
          description: null,
          category: "mcp-agent-prompts",
        },
        "system-admin",
      );
    } else {
      await repository.setValue(key, "integration reminder", "system-admin");
    }

    try {
      await expect(
        service.getSystemReminderWithOverride({ agent: "integration-static-description-test" }),
      ).resolves.toBe("integration reminder");
      expect(Object.keys(MCP_TEXT_KEYS)).not.toContain("toolDescription");
    } finally {
      await repository.setValue(key, null, "system-admin");
    }
  });
});
