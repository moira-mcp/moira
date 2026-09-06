/**
 * @jest-environment jsdom
 */

/**
 * The field of a structural (`json`) setting on the settings screen.
 *
 * Extensions made such settings reachable on the user screen for the first time, and the field is a
 * textarea: whatever it shows is what a user saves when the button is pressed without editing. An
 * unset setting must therefore show nothing, not a rendering of its absence.
 */

import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { I18nextProvider } from "react-i18next";
import type { SettingDefinition } from "../../../packages/web-frontend/src/components/settings/SettingsEditor";
import i18n from "../../../packages/web-frontend/src/i18n";

const toastError = jest.fn();
jest.unstable_mockModule("sonner", () => ({ toast: { error: toastError } }));

let SettingsEditor: typeof import("../../../packages/web-frontend/src/components/settings/SettingsEditor").SettingsEditor;

beforeAll(async () => {
  SettingsEditor = (
    await import("../../../packages/web-frontend/src/components/settings/SettingsEditor")
  ).SettingsEditor;
});

beforeEach(async () => {
  toastError.mockClear();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

const routing: SettingDefinition = {
  key: "probe.routing",
  type: "json",
  category: "extension:probe",
  label: "Routing table",
  description: null,
  defaultValue: null,
  required: false,
  validation: null,
};

function field(): HTMLTextAreaElement {
  return screen.getByTestId("setting-probe.routing-input") as HTMLTextAreaElement;
}

function renderEditor(
  values: Record<string, unknown>,
  onSave: (key: string, value: unknown) => Promise<void> = async () => {},
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SettingsEditor
        definitions={[routing]}
        values={values}
        onSave={onSave}
        testIdPrefix="setting"
        collapsible={false}
        enableFullscreenEdit
      />
    </I18nextProvider>,
  );
}

describe("A structural setting's field", () => {
  test("is empty while the setting has no value", () => {
    // Required state: an unset setting shows an empty field. Plausible wrong state: the value is
    // rendered with JSON.stringify, so absence appears as the word `null` and saving without
    // editing sends that word — a value no schema of an object accepts.
    renderEditor({});

    expect(field().value).toBe("");
  });

  test("shows a stored structural value as formatted JSON", () => {
    renderEditor({ "probe.routing": { default: "ops" } });

    expect(field().value).toBe('{\n  "default": "ops"\n}');
  });

  test("shows text the user is typing exactly as typed", () => {
    renderEditor({ "probe.routing": '{"default":"ops"}' });

    expect(field().value).toBe('{"default":"ops"}');
  });

  test("opens in the fullscreen editor as editable JSON, not as a stringified object", () => {
    // The same field, edited through the fullscreen button the settings screen enables. Required
    // state: the modal shows the value a user can edit. Plausible wrong state: the value is passed
    // through `String(...)`, so a stored structure appears as `[object Object]` and saving from the
    // modal replaces the setting with that text.
    renderEditor({ "probe.routing": { default: "ops" } });

    fireEvent.click(screen.getByTestId("setting-probe.routing-fullscreen"));

    const modalField = screen.getByTestId("fullscreen-textarea") as HTMLTextAreaElement;
    expect(modalField.value).toBe('{\n  "default": "ops"\n}');
  });

  test("shows extension ownership in the active locale", async () => {
    renderEditor({});
    expect(screen.getByText("Extension: probe")).toBeInTheDocument();

    cleanup();
    await i18n.changeLanguage("ru");
    renderEditor({});
    expect(screen.getByText("Расширение: probe")).toBeInTheDocument();
    expect(screen.queryByText("Extension: probe")).not.toBeInTheDocument();
  });

  test("keeps a refused edit dirty and shows the server's reason", async () => {
    renderEditor({}, async () => {
      throw new Error("Value does not match the declared schema");
    });

    fireEvent.change(field(), { target: { value: '{"default":"ops"}' } });
    fireEvent.click(screen.getByTestId("setting-probe.routing-save"));

    expect(await screen.findByDisplayValue('{"default":"ops"}')).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith("Value does not match the declared schema");
    expect(screen.getByTestId("setting-probe.routing-save")).toBeEnabled();
  });
});
