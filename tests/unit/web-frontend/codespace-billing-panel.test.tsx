/**
 * @jest-environment jsdom
 */

import React from "react";
import { afterEach, describe, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import {
  evaluateCodespaceResourcePolicy,
  projectCodespaceLimits,
  type CodespaceLimitsView,
} from "@mcp-moira/shared";
import i18n from "../../../packages/web-frontend/src/i18n";
import { CodespaceLimitsPanel } from "../../../packages/web-frontend/src/pages/settings/CodespaceLimitsPanel";

const localLimits = projectCodespaceLimits({
  policy: evaluateCodespaceResourcePolicy(() => undefined),
  held: 2,
  instanceHeld: 3,
  activeOperations: 1,
  transfers: { objects: 1, bytes: 2048, inflightBytes: 0 },
  idle: { autoStopEnabled: true, idleTimeoutMinutes: 30 },
  providerIdleMaxMinutes: 240,
});

function renderPanel(limits: CodespaceLimitsView) {
  return render(
    <I18nextProvider i18n={i18n}>
      <CodespaceLimitsPanel limits={limits} />
    </I18nextProvider>,
  );
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("Codespace billing beside Moira limits", () => {
  test("shows personal monthly usage and billed amount apart from local capacity", async () => {
    await i18n.changeLanguage("en");
    renderPanel({
      ...localLimits,
      provider: {
        billing: {
          state: "available",
          payer_login: "alice",
          period: { year: 2026, month: 9 },
          retrieved_at: Date.UTC(2026, 8, 28, 10, 0),
          plan: "free",
          compute: { used_core_hours: 12.5, included_core_hours: 120, net_amount_usd: 1.2 },
          storage: { used_gb_month: 2.25, included_gb_month: 15, net_amount_usd: 0.05 },
          net_amount_usd: 1.25,
        },
      },
    });
    const github = screen.getByTestId("github-codespace-billing");
    expect(github).toHaveTextContent("Billed to @alice");
    expect(github).toHaveTextContent("12.5 of 120 core-hours included");
    expect(github).toHaveTextContent("2.25 of 15 GB-month included");
    expect(github).toHaveTextContent("$1.25");
    const moira = screen.getByTestId("github-codespace-limits");
    expect(moira).toHaveTextContent("Moira limits");
    expect(moira).toHaveTextContent("Codespaces held");
  });

  test("keeps local limits visible when provider billing cannot be read", async () => {
    await i18n.changeLanguage("ru");
    renderPanel(localLimits);
    expect(screen.getByTestId("github-codespace-billing-unavailable")).toHaveTextContent(
      "Plan: read",
    );
    expect(screen.getByTestId("github-codespace-limits")).toHaveTextContent("Лимиты Moira");
    expect(screen.getByTestId("codespace-limit-held")).toHaveTextContent("2 из");
  });
});
