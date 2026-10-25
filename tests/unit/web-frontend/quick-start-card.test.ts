/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { getClientSetupPresentation } from "@mcp-moira/shared/mcp-clients";
import en from "../../../packages/web-frontend/src/locales/en.json";
import ru from "../../../packages/web-frontend/src/locales/ru.json";

const MCP_URL = "https://chosen.example.test:8443/mcp";
const verbatim = { normalizer: (value: string) => value };
let visible = true;
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({ deploymentMode: "self-host", mcpUrl: MCP_URL }),
}));
jest.unstable_mockModule(
  "../../../packages/web-frontend/src/components/onboarding/beginnerPanels",
  () => ({
    usePanelVisible: () => visible,
  }),
);
jest.unstable_mockModule(
  "../../../packages/web-frontend/src/components/onboarding/HidePanelButton",
  () => ({
    HidePanelButton: () => null,
  }),
);
const { QuickStartCard, resolveMcpUrl } =
  await import("../../../packages/web-frontend/src/components/QuickStartCard");
const translations = createInstance();
await translations.init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: en }, ru: { translation: ru } },
  interpolation: { escapeValue: false },
});
const originalReact = globalThis.React;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let copiedText: string | undefined;
beforeEach(() => {
  globalThis.React = React;
  visible = true;
  copiedText = undefined;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copiedText = text;
      },
    },
  });
});
afterEach(() => {
  cleanup();
  globalThis.React = originalReact;
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});
async function mount(language: "en" | "ru") {
  await translations.changeLanguage(language);
  return render(
    React.createElement(
      I18nextProvider,
      { i18n: translations },
      React.createElement(QuickStartCard),
    ),
  );
}
function select(label: string) {
  const tab = screen.getByRole("tab", { name: label });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
  return within(screen.getByRole("tabpanel"));
}

test.each(["en", "ru"] as const)(
  "%s tabs render complete setup, authentication, verification and official sources",
  async (language) => {
    await mount(language);
    for (const presentation of getClientSetupPresentation(language, MCP_URL)) {
      const panel = select(presentation.label);
      expect(panel.getByText(presentation.setup, verbatim)).toBeVisible();
      expect(panel.getByText(presentation.authIntro, verbatim)).toBeVisible();
      expect(panel.getByText(presentation.verification, verbatim)).toBeVisible();
      expect(panel.getByRole("link", { name: presentation.officialDocs.label })).toHaveAttribute(
        "href",
        presentation.officialDocs.url,
      );
    }
    expect(screen.getByTestId("quick-start-card")).toHaveAttribute("data-guide", "home.connect");
    expect(screen.queryByText(/quickStart\.(clients|tabs)\./)).toBeNull();
  },
);

test.each(["en", "ru"] as const)(
  "%s GUI URL copies the self-host endpoint and install links preserve it",
  async (language) => {
    await mount(language);
    const panel = select("ChatGPT");
    expect(panel.getByText(MCP_URL)).toBeVisible();
    expect(
      panel.getByRole("link", {
        name:
          language === "ru"
            ? "Открыть плагины ChatGPT для добавления пользовательского MCP-сервера"
            : "Open ChatGPT plugins to add a custom MCP server",
      }),
    ).toHaveAttribute("href", "https://chatgpt.com/plugins");
    await act(async () => {
      fireEvent.click(
        panel.getByRole("button", { name: translations.t("pages.dashboard.quickStart.copy") }),
      );
    });
    expect(copiedText).toBe(MCP_URL);
    expect(panel.getByText(translations.t("pages.dashboard.quickStart.copied"))).toBeVisible();
    const cursor = select("Cursor");
    const cursorLink = cursor
      .getAllByRole("link")
      .find((item) => item.getAttribute("href")?.startsWith("cursor:"));
    if (!cursorLink) throw new Error("Cursor install link missing");
    const encoded = new URL(cursorLink.getAttribute("href") ?? "").searchParams.get("config");
    if (!encoded) throw new Error("Cursor configuration missing");
    expect(JSON.parse(atob(encoded))).toEqual({ url: MCP_URL });
    const vscode = select("VS Code");
    const vscodeLink = vscode
      .getAllByRole("link")
      .find((item) => item.getAttribute("href")?.startsWith("vscode:"));
    if (!vscodeLink) throw new Error("VS Code install link missing");
    expect(
      JSON.parse(decodeURIComponent((vscodeLink.getAttribute("href") ?? "").split("?")[1])),
    ).toEqual({ name: "moira", type: "http", url: MCP_URL });
  },
);

test.each(["en", "ru"] as const)(
  "%s alternatives expose token configuration and the hosted Kimi warning",
  async (language) => {
    await mount(language);
    const presentations = getClientSetupPresentation(language, MCP_URL);
    const kimi = presentations.find((item) => item.client.id === "kimi-code");
    if (!kimi?.alternative || !kimi.alternativeDescription)
      throw new Error("Kimi hosted alternative fixture missing");
    const kimiPanel = select(kimi.label);
    expect(kimiPanel.queryByText(kimi.alternative.code, verbatim)).toBeNull();
    fireEvent.click(kimiPanel.getByRole("button", { name: kimi.alternativeTitle }));
    expect(kimiPanel.getByText(kimi.alternativeDescription, verbatim)).toBeVisible();
    expect(kimiPanel.getByText(kimi.alternative.code, verbatim)).toBeVisible();
    const codex = presentations.find((item) => item.client.id === "codex");
    if (!codex?.tokenAuth) throw new Error("Codex token alternative fixture missing");
    const codexPanel = select(codex.label);
    fireEvent.click(codexPanel.getByRole("button", { name: codex.tokenAuth.sectionTitle }));
    expect(codexPanel.getByText(codex.tokenAuth.description, verbatim)).toBeVisible();
    expect(codexPanel.getByText(codex.tokenAuth.steps, verbatim)).toBeVisible();
    expect(codexPanel.getByText(codex.tokenAuth.code.code, verbatim)).toBeVisible();
  },
);

test("a hidden beginner panel remains hidden", async () => {
  visible = false;
  await mount("en");
  expect(screen.queryByTestId("quick-start-card")).toBeNull();
});

describe("resolveMcpUrl deployment-mode gating", () => {
  const BAKED = "https://example.com/mcp";
  const RUNTIME = "http://localhost:8077/mcp";
  test("self-host uses the runtime URL when available", () => {
    expect(resolveMcpUrl("self-host", RUNTIME, BAKED)).toBe(RUNTIME);
  });
  test("self-host falls back while runtime is loading", () => {
    expect(resolveMcpUrl("self-host", null, BAKED)).toBe(BAKED);
  });
  test("saas keeps the build-time URL", () => {
    expect(resolveMcpUrl("saas", RUNTIME, BAKED)).toBe(BAKED);
  });
  test("unknown mode keeps the baked URL", () => {
    expect(resolveMcpUrl(null, RUNTIME, BAKED)).toBe(BAKED);
  });
});
