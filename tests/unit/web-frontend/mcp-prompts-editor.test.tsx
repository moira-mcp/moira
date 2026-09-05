/**
 * @jest-environment jsdom
 */

import React from "react";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import {
  McpPromptsEditor,
  PROMPT_TYPES,
} from "../../../packages/web-frontend/src/components/settings/McpPromptsEditor";
import en from "../../../packages/web-frontend/src/locales/en.json";
import ru from "../../../packages/web-frontend/src/locales/ru.json";

afterEach(cleanup);

describe("MCP prompt editor static-description boundary", () => {
  test("offers only database-backed system prompt and reminder editing", async () => {
    const onFetchValue = jest.fn(async (promptType: (typeof PROMPT_TYPES)[number]) => ({
      key: `mcp.${promptType}`,
      value: promptType,
    }));

    render(
      <I18nextProvider i18n={i18n}>
        <McpPromptsEditor
          onFetchValue={onFetchValue}
          onSave={jest.fn(async () => {})}
          onReset={jest.fn(async () => {})}
        />
      </I18nextProvider>,
    );

    expect(PROMPT_TYPES).toEqual(["systemPrompt", "systemReminder"]);
    expect(screen.getByTestId("prompt-item-systemPrompt")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-item-systemReminder")).toBeInTheDocument();
    expect(screen.queryByText("Tool Descriptions")).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid^="prompt-item-toolDescription-"]')).toBeNull();
    await waitFor(() => expect(onFetchValue).toHaveBeenCalledWith("systemPrompt", "default", null));
  });

  test("keeps English and Russian copy aligned with prompt and reminder editing", () => {
    expect(en.admin.mcpPrompts.systemPrompts).toBe("System Prompts");
    expect(en.admin.mcpPrompts.description).toContain("prompts and reminders");
    expect(ru.admin.mcpPrompts.systemPrompts).toBe("Системные промпты");
    expect(ru.admin.mcpPrompts.description).toContain("промптами и напоминаниями");

    for (const locale of [en, ru]) {
      expect("toolDescriptions" in locale.admin.mcpPrompts).toBe(false);
    }
    expect(en.admin.panel.mcpPrompts.description).not.toContain("tool descriptions");
    expect(en.admin.globalSettings.description).not.toContain("tool descriptions");
    expect(ru.admin.panel.mcpPrompts.description).not.toContain("описаниями инструментов");
    expect(ru.admin.globalSettings.description).not.toContain("описаниями MCP-инструментов");
  });
});
