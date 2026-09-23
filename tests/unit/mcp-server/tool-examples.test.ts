import { describe, expect, it, jest } from "@jest/globals";

import { readSettingsForMcp } from "../../../packages/mcp-server/src/tools/manage-settings.js";
import { TOOL_DEFINITIONS } from "../../../packages/mcp-server/src/tools/tool-definitions.js";

describe("MCP registry examples", () => {
  it("runs every settings get selector through the masked read projection", async () => {
    const settings = TOOL_DEFINITIONS.find(
      (definition) => definition.name === "settings",
    ) as unknown as {
      examples: readonly { action: "get"; category?: string; key?: string }[];
    };
    const [exact, category, all] = settings.examples;
    const repository = {
      getSettingsForApi: jest.fn(async (_userId: string, selectedCategory?: string) =>
        selectedCategory === "notifications"
          ? { "telegram.enabled": false, "telegram.chat_id": "123" }
          : { "profile.display_name": "Ada" },
      ),
      // The read audits through the repository's own logAudit, reached by a cast in production
      // because the read contract does not name it; the double therefore declares its arguments.
      logAudit: jest.fn(async (_entry: Record<string, unknown>) => undefined),
    };

    // An exact key is read through its definition's category, as the tool does.
    await expect(
      readSettingsForMcp(repository, "user-1", "notifications", exact.key),
    ).resolves.toEqual({
      success: true,
      data: { "telegram.enabled": false },
    });
    await expect(readSettingsForMcp(repository, "user-1", category.category)).resolves.toEqual({
      success: true,
      data: { "telegram.enabled": false, "telegram.chat_id": "123" },
    });
    await expect(readSettingsForMcp(repository, "user-1", all.category)).resolves.toEqual({
      success: true,
      data: { "profile.display_name": "Ada" },
    });

    expect(repository.getSettingsForApi).toHaveBeenNthCalledWith(1, "user-1", "notifications");
    expect(repository.getSettingsForApi).toHaveBeenNthCalledWith(2, "user-1", "notifications");
    expect(repository.getSettingsForApi).toHaveBeenNthCalledWith(3, "user-1", undefined);
    expect(repository.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        resourceId: "telegram.enabled",
        metadata: JSON.stringify({
          action: "get",
          category: "notifications",
          key: "telegram.enabled",
        }),
      }),
    );
  });
});
