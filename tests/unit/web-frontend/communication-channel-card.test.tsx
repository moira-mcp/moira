/**
 * @jest-environment jsdom
 */

/**
 * The documentation link of a notification channel's card: named with the channel's title in the
 * reader's language rather than the server's, and opening the documentation page in that language.
 */

import React from "react";
import { afterEach, describe, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import {
  CommunicationChannelCard,
  type CommunicationChannelDescriptor,
} from "../../../packages/web-frontend/src/components/settings/CommunicationChannelCard";

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

const telegram: CommunicationChannelDescriptor = {
  id: "telegram",
  // The server's own words, which the reader's locale overrides for a built-in channel.
  title: "Server Telegram",
  description: null,
  origin: "builtin",
  extensionName: null,
  extensionVersion: null,
  settingKeys: [],
  helpUrl: "/docs/integration/telegram-setup/",
  capabilities: { text: true, image: false, document: false },
  enabled: false,
  configured: false,
  available: true,
  state: "disabled",
  trustedDelivery: null,
};

function renderCard(channel: CommunicationChannelDescriptor = telegram) {
  return render(
    <I18nextProvider i18n={i18n}>
      <CommunicationChannelCard
        channel={channel}
        definitions={[]}
        values={{}}
        testing={false}
        onSave={async () => {}}
        onTest={async () => {}}
      />
    </I18nextProvider>,
  );
}

describe("CommunicationChannelCard documentation link", () => {
  test.each([
    ["en", "Telegram setup in the documentation", "/docs/integration/telegram-setup/"],
    ["ru", "Настройка Telegram в документации", "/ru/docs/integration/telegram-setup/"],
  ])("in %s reads %s and opens %s", async (language, label, href) => {
    await i18n.changeLanguage(language);
    renderCard();
    const link = screen.getByTestId("user-channel-telegram-docs-link");
    expect(link).toHaveTextContent(label);
    expect(link).not.toHaveTextContent("Server Telegram");
    expect(link).toHaveAttribute("href", href);
  });

  test("an extension channel keeps its own title and its own help link", async () => {
    await i18n.changeLanguage("ru");
    renderCard({
      ...telegram,
      id: "probe",
      origin: "extension",
      title: "Probe messenger",
      helpUrl: "https://example.test/probe-help",
    });
    const link = screen.getByTestId("user-channel-probe-docs-link");
    expect(link).toHaveTextContent("Настройка Probe messenger в документации");
    expect(link).toHaveAttribute("href", "https://example.test/probe-help");
  });
});
