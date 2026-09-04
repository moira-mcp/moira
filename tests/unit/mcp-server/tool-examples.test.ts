import { describe, expect, it, jest } from "@jest/globals";

import { readSettingsForMcp } from "../../../packages/mcp-server/src/tools/manage-settings.js";
import { TOOL_DEFINITIONS } from "../../../packages/mcp-server/src/tools/tool-definitions.js";

describe("MCP registry examples", () => {
  it("runs every settings get selector through the masked read projection", async () => {
    const settings = TOOL_DEFINITIONS.find((definition) => definition.name === "settings") as {
      examples: readonly { action: "get"; category?: string; key?: string }[];
    };
    const [exact, category, all] = settings.examples;
    const repository = {
      getSettingsForApi: jest.fn(async (_userId: string, selectedCategory?: string) =>
        selectedCategory === "ui"
          ? { "ui.theme": "dark", "ui.other": "ignored" }
          : { "telegram.chat_id": "123" },
      ),
      logAudit: jest.fn(async () => undefined),
    };

    await expect(readSettingsForMcp(repository, "user-1", "ui", exact.key)).resolves.toEqual({
      success: true,
      data: { "ui.theme": "dark" },
    });
    await expect(
      readSettingsForMcp(repository, "user-1", category.category),
    ).resolves.toEqual({ success: true, data: { "telegram.chat_id": "123" } });
    await expect(readSettingsForMcp(repository, "user-1", all.category)).resolves.toEqual({
      success: true,
      data: { "telegram.chat_id": "123" },
    });

    expect(repository.getSettingsForApi).toHaveBeenNthCalledWith(1, "user-1", "ui");
    expect(repository.getSettingsForApi).toHaveBeenNthCalledWith(2, "user-1", "notifications");
    expect(repository.getSettingsForApi).toHaveBeenNthCalledWith(3, "user-1", undefined);
    expect(repository.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        resourceId: "ui.theme",
        metadata: JSON.stringify({ action: "get", category: "ui", key: "ui.theme" }),
      }),
    );
  });
});
