/**
 * @jest-environment jsdom
 */

import React from "react";
import { afterEach, describe, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import type { CodespaceProviderBillingView } from "@mcp-moira/shared";
import i18n from "../../../packages/web-frontend/src/i18n";
import { CodespaceBillingPanel } from "../../../packages/web-frontend/src/pages/settings/CodespaceBillingPanel";

function renderPanel(billing: CodespaceProviderBillingView) {
  return render(
    <I18nextProvider i18n={i18n}>
      <CodespaceBillingPanel billing={billing} />
    </I18nextProvider>,
  );
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("Codespace provider billing", () => {
  test("shows actual personal monthly usage and billed amount", async () => {
    await i18n.changeLanguage("en");
    renderPanel({
      state: "available",
      payer_login: "alice",
      period: { year: 2026, month: 9 },
      retrieved_at: Date.UTC(2026, 8, 28, 10, 0),
      plan: "free",
      compute: { used_core_hours: 12.5, included_core_hours: 120, net_amount_usd: 1.2 },
      storage: { used_gb_month: 2.25, included_gb_month: 15, net_amount_usd: 0.05 },
      net_amount_usd: 1.25,
    });
    const github = screen.getByTestId("github-codespace-billing");
    expect(github).toHaveTextContent("Billed to @alice");
    expect(github).toHaveTextContent("12.5 of 120 core-hours included");
    expect(github).toHaveTextContent("2.25 of 15 GB-month included");
    expect(github).toHaveTextContent("$1.25");
    expect(screen.queryByTestId("github-codespace-limits")).not.toBeInTheDocument();
  });

  test("explains unavailable provider billing without inventing a quota", async () => {
    await i18n.changeLanguage("ru");
    renderPanel("unavailable");
    expect(screen.getByTestId("github-codespace-billing-unavailable")).toHaveTextContent(
      "Plan: read",
    );
    expect(screen.queryByTestId("github-codespace-limits")).not.toBeInTheDocument();
  });
});
