/** @jest-environment jsdom */
import React, { useState } from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import {
  observeReadSession,
  observeReadBackend,
  suspendReadSession,
} from "../../../packages/web-frontend/src/services/read-scope";

let authError: { status: number; message: string } | null = null;
const refetch = jest.fn<() => Promise<void>>();
jest.unstable_mockModule("../../../packages/web-frontend/src/auth/better-auth-client", () => ({
  authClient: { useSession: () => ({ data: null, error: authError, refetch }) },
}));
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({ deploymentMode: "saas", features: {}, loaded: true, error: false }),
}));
const { ReadScopeBoundary, PrivateReadScopeBoundary } =
  await import("../../../packages/web-frontend/src/auth/ReadScopeBoundary");
const { useResource } = await import("../../../packages/web-frontend/src/hooks/useResource");
beforeEach(() => {
  globalThis.React = React;
  authError = null;
  refetch.mockReset();
});

test("failed authoritative session check exposes a retry outside private holdings and resumes the same draft", async () => {
  await i18n.changeLanguage("en");
  observeReadSession("owner-a", "credential-a");
  render(
    <I18nextProvider i18n={i18n}>
      <PrivateReadScopeBoundary>
        <Holdings />
      </PrivateReadScopeBoundary>
    </I18nextProvider>,
  );
  fireEvent.change(screen.getByLabelText("draft"), { target: { value: "preserved" } });
  authError = { status: 500, message: "cannot check session" };
  act(() => suspendReadSession());
  expect(screen.getByLabelText("draft")).not.toBeVisible();
  refetch.mockImplementation(async () => {
    authError = null;
    observeReadSession("owner-a", "credential-a");
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  expect(screen.getByLabelText("draft")).toBeVisible();
  expect(screen.getByLabelText("draft")).toHaveValue("preserved");
});
afterEach(() => {
  cleanup();
  observeReadSession(null, null);
});

function Holdings() {
  const [draft, setDraft] = useState("unsaved");
  return (
    <label>
      Private draft
      <input aria-label="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    </label>
  );
}

test("cookie-changing auth gap hides manual private holdings, then same-account recheck preserves the draft", () => {
  observeReadSession("owner-a", "credential-a");
  render(
    <PrivateReadScopeBoundary>
      <Holdings />
    </PrivateReadScopeBoundary>,
  );
  fireEvent.change(screen.getByLabelText("draft"), { target: { value: "my draft" } });
  act(() => suspendReadSession());
  expect(screen.getByLabelText("draft")).not.toBeVisible();
  expect(screen.getByLabelText("draft").closest("div")).toHaveAttribute("inert");
  expect(screen.getByLabelText("draft").closest("div")).toHaveAttribute("aria-hidden", "true");
  act(() => observeReadSession("owner-a", "renewed-credential"));
  expect(screen.getByLabelText("draft")).toBeVisible();
  expect(screen.getByLabelText("draft")).toHaveValue("my draft");
  act(() => observeReadSession("owner-b", "credential-b"));
  expect(screen.getByLabelText("draft")).toHaveValue("unsaved");
});

test("anonymous auth attempt/error does not remount the form and ordinary same-account renewal keeps drafts visible", () => {
  observeReadSession(null, null);
  render(
    <ReadScopeBoundary>
      <Holdings />
    </ReadScopeBoundary>,
  );
  fireEvent.change(screen.getByLabelText("draft"), { target: { value: "typed login" } });
  act(() => suspendReadSession());
  expect(screen.getByLabelText("draft")).toBeVisible();
  act(() => observeReadSession(null, null));
  expect(screen.getByLabelText("draft")).toHaveValue("typed login");
});

test("resource holds no private data during uncertain credentials even before an account change is known", async () => {
  observeReadSession("owner-a", "credential-a");
  const { result } = renderHook(() => useResource("same-key", async () => "private value"));
  await act(async () => {});
  expect(result.current.data).toBe("private value");
  act(() => suspendReadSession());
  expect(result.current.data).toBeUndefined();
  expect(result.current.dataKey).toBeNull();
});

test("first accepted session preserves the public form's mounted draft and operation identity", () => {
  observeReadSession(null, null);
  render(
    <ReadScopeBoundary>
      <Holdings />
    </ReadScopeBoundary>,
  );
  const input = screen.getByLabelText("draft");
  fireEvent.change(input, { target: { value: "in-progress public operation" } });
  act(() => observeReadSession("first-owner", "first-session"));
  expect(screen.getByLabelText("draft")).toBe(input);
  expect(input).toHaveValue("in-progress public operation");
});

test("a backend switch clears known private holdings even when the account identifier stays the same", () => {
  observeReadSession("owner", "session");
  render(
    <PrivateReadScopeBoundary>
      <Holdings />
    </PrivateReadScopeBoundary>,
  );
  fireEvent.change(screen.getByLabelText("draft"), { target: { value: "private backend draft" } });
  act(() => observeReadBackend("https://another-backend.example"));
  expect(screen.getByLabelText("draft")).toHaveValue("unsaved");
  act(() => observeReadBackend(""));
});
