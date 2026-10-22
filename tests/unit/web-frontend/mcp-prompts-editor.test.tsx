/**
 * @jest-environment jsdom
 */

import React from "react";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import {
  McpPromptsEditor,
  parseHistoryChanges,
  PROMPT_TYPES,
  type McpPromptsEditorProps,
} from "../../../packages/web-frontend/src/components/settings/McpPromptsEditor";
import en from "../../../packages/web-frontend/src/locales/en.json";
import ru from "../../../packages/web-frontend/src/locales/ru.json";

afterEach(cleanup);

describe("MCP prompt editor", () => {
  test("offers only database-backed system prompt and reminder editing", async () => {
    const onFetchValue = jest.fn<McpPromptsEditorProps["onFetchValue"]>(async (promptType) => ({
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

  test("loads accepted prompt text and saves the edited value to its exact scope", async () => {
    const onFetchValue = jest.fn<McpPromptsEditorProps["onFetchValue"]>(async () => ({
      key: "mcp.systemPrompt",
      value: "Accepted prompt",
    }));
    const onSave = jest.fn<McpPromptsEditorProps["onSave"]>(async () => {});
    render(
      <I18nextProvider i18n={i18n}>
        <McpPromptsEditor
          onFetchValue={onFetchValue}
          onSave={onSave}
          onReset={jest.fn(async () => {})}
        />
      </I18nextProvider>,
    );

    const input = await screen.findByTestId("mcp-prompt-systemPrompt-input");
    const save = screen.getByTestId("mcp-prompt-systemPrompt-save");
    expect(input).toHaveValue("Accepted prompt");
    expect(onFetchValue).toHaveBeenCalledWith("systemPrompt", "default", null);
    expect(save).toBeDisabled();

    fireEvent.change(input, { target: { value: "Edited prompt" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("systemPrompt", "default", null, "Edited prompt"),
    );
    await waitFor(() => expect(save).toBeDisabled());
    expect(input).toHaveValue("Edited prompt");
  });

  test("switches to the selected prompt and loads that prompt's accepted value", async () => {
    const onFetchValue = jest.fn<McpPromptsEditorProps["onFetchValue"]>(async (promptType) => ({
      key: `mcp.${promptType}`,
      value: `Accepted ${promptType}`,
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
    const prompt = await screen.findByTestId("mcp-prompt-systemPrompt-input");
    expect(prompt).toHaveValue("Accepted systemPrompt");

    fireEvent.click(screen.getByTestId("prompt-item-systemReminder"));

    const reminder = await screen.findByTestId("mcp-prompt-systemReminder-input");
    expect(reminder).toBeVisible();
    expect(reminder).toHaveValue("Accepted systemReminder");
    expect(prompt).not.toBeVisible();
    expect(onFetchValue).toHaveBeenCalledWith("systemReminder", "default", null);
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

describe("prompt history value changes", () => {
  test.each([
    { name: "missing input", input: undefined, expected: {} },
    { name: "empty input", input: "", expected: {} },
    { name: "invalid JSON", input: "not json", expected: {} },
    {
      name: "value change array",
      input: JSON.stringify([{ field: "value", oldValue: "old", newValue: "new" }]),
      expected: { oldValue: "old", newValue: "new" },
    },
    {
      name: "explicit null value",
      input: JSON.stringify([{ field: "value", oldValue: null, newValue: "new" }]),
      expected: { oldValue: null, newValue: "new" },
    },
    {
      name: "unrelated field",
      input: JSON.stringify([{ field: "other", oldValue: "a", newValue: "b" }]),
      expected: {},
    },
    {
      name: "object format",
      input: JSON.stringify({ oldValue: "old", newValue: "new" }),
      expected: { oldValue: "old", newValue: "new" },
    },
    {
      name: "value selected among other fields",
      input: JSON.stringify([
        { field: "metadata", oldValue: "x", newValue: "y" },
        { field: "value", oldValue: "before", newValue: "after" },
      ]),
      expected: { oldValue: "before", newValue: "after" },
    },
  ])("parses $name without losing value semantics", ({ input, expected }) => {
    expect(parseHistoryChanges(input)).toEqual(expected);
  });
});
