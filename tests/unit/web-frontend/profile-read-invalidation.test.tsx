/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axios from "axios";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { MoiraApiClient } from "../../../packages/web-frontend/src/services/api-client";
import { observeReadSession } from "../../../packages/web-frontend/src/services/read-scope";
import { productFetch } from "../../../packages/web-frontend/src/services/product-fetch";

jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({ isEnabled: () => false, emailDelivery: { available: false } }),
}));
const { ProfileSettings } =
  await import("../../../packages/web-frontend/src/pages/settings/ProfileSettings");
const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  axios.defaults.adapter = originalAdapter;
  observeReadSession(null, null);
  jest.restoreAllMocks();
});

test("the real profile form retires reads on a refused raw effect while preserving its error display", async () => {
  globalThis.React = React;
  await i18n.changeLanguage("en");
  observeReadSession("profile-owner", "profile-session");
  const validators: unknown[] = [];
  axios.defaults.adapter = async (config) => {
    validators.push(config.headers.get("If-None-Match"));
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: { etag: 'W/"notes"' },
      data: { success: true, data: { notes: [], total: 0, allTags: [] } },
    };
  };
  const client = new MoiraApiClient();
  await client.getNotes();
  globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue({
    ok: false,
    status: 400,
    json: async () => ({ success: false, error: "persisted operation was refused" }),
  } as Response);
  render(
    <I18nextProvider i18n={i18n}>
      <ProfileSettings
        profile={{
          id: "profile-owner",
          name: "Initial",
          handle: "owner",
          email: "owner@example.test",
          emailVerified: true,
          image: null,
          createdAt: "2026-09-01T00:00:00Z",
        }}
        onProfileUpdate={() => {}}
      />
    </I18nextProvider>,
  );
  const input = screen.getByTestId("profile-name-input");
  fireEvent.change(input, { target: { value: "Changed" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("persisted operation was refused"),
  );
  await client.getNotes();
  expect(validators).toEqual([undefined, undefined]);
});

test("raw partial 207 preserves the native Response even when the body reports refused values", async () => {
  const response = {
    ok: true,
    status: 207,
    json: async () => ({ saved: { one: true }, refused: [{ key: "two" }] }),
  } as Response;
  globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(response);
  const result = await productFetch("/api/settings", { method: "PUT", body: "{}" });
  expect(result).toBe(response);
  expect(await result.json()).toEqual({ saved: { one: true }, refused: [{ key: "two" }] });
});
