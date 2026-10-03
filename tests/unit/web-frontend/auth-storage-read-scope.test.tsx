/** @jest-environment jsdom */
import React, { useState } from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import {
  getReadIdentity,
  getReadOwner,
} from "../../../packages/web-frontend/src/services/read-scope";
import { useResource } from "../../../packages/web-frontend/src/hooks/useResource";

jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({ deploymentMode: "self-host", features: {}, loaded: true, error: false }),
}));
const { ReadScopeBoundary, PrivateReadScopeBoundary } =
  await import("../../../packages/web-frontend/src/auth/ReadScopeBoundary");
const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
const session = (id: string) => ({
  user: { id, email: `${id}@example.test`, name: id, emailVerified: true },
  session: {
    id: `session-${id}`,
    userId: id,
    token: `test-${id}`,
    expiresAt: "2099-01-01",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
});
let current: ReturnType<typeof session> | null;
let hold = false;
let dispatched: Promise<void>;
let started: () => void;
let finish: (response: Response) => void;
let privateReads = 0;
function Draft({ label }: { label: string }) {
  const [value, setValue] = useState("unsaved");
  return (
    <input aria-label={label} value={value} onChange={(event) => setValue(event.target.value)} />
  );
}
function PrivateHoldings() {
  const resource = useResource("private-query", async () => {
    privateReads++;
    return current?.user.id;
  });
  return (
    <>
      <Draft label="private draft" />
      <output data-testid="private-value">{resource.data}</output>
    </>
  );
}
beforeEach(async () => {
  globalThis.React = React;
  current = session("owner-a");
  hold = false;
  privateReads = 0;
  dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async () => {
    if (hold) {
      started();
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return Response.json(current);
  });
  await authClient.$store.atoms.session.get().refetch();
  render(
    <I18nextProvider i18n={i18n}>
      <ReadScopeBoundary>
        <Draft label="public draft" />
        <PrivateReadScopeBoundary>
          <PrivateHoldings />
        </PrivateReadScopeBoundary>
      </ReadScopeBoundary>
    </I18nextProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("private-value")).toHaveTextContent("owner-a"));
});
afterEach(async () => {
  cleanup();
  finish?.(Response.json(null));
  hold = false;
  current = null;
  await authClient.$store.atoms.session.get().refetch();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  jest.restoreAllMocks();
});

test.each(["same owner", "replacement", "signed out"])(
  "installed provider storage event conceals old private holdings until authoritative %s response",
  async (outcome) => {
    const draft = screen.getByLabelText("private draft");
    const publicDraft = screen.getByLabelText("public draft");
    fireEvent.change(draft, { target: { value: "retained private draft" } });
    fireEvent.change(publicDraft, { target: { value: "public operation" } });
    const owner = getReadOwner();
    const reads = privateReads;
    hold = true;
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "better-auth.message",
          newValue: JSON.stringify({
            event: "session",
            data: { trigger: outcome === "signed out" ? "signout" : "updateUser" },
            clientId: "another-tab",
            timestamp: Math.floor(Date.now() / 1000),
          }),
        }),
      ),
    );
    await dispatched;
    const snapshot = authClient.$store.atoms.session.get();
    expect(snapshot.data?.user.id).toBe("owner-a");
    expect(snapshot.isPending).toBe(false);
    expect(snapshot.isRefetching).toBe(true);
    expect(draft).not.toBeVisible();
    expect(getReadIdentity()).toBeNull();
    expect(draft.closest("div")).toHaveAttribute("inert");
    expect(draft.closest("div")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("private-value")).toBeEmptyDOMElement();
    expect(privateReads).toBe(reads);
    expect(publicDraft).toBeVisible();
    expect(publicDraft).toHaveValue("public operation");
    current =
      outcome === "signed out" ? null : session(outcome === "replacement" ? "owner-b" : "owner-a");
    hold = false;
    await act(async () => finish(Response.json(current)));
    await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
    expect(screen.getByLabelText("public draft")).toBe(publicDraft);
    expect(publicDraft).toHaveValue("public operation");
    if (outcome === "same owner") {
      await waitFor(() => expect(draft).toBeVisible());
      expect(getReadOwner()).toBe(owner);
      expect(screen.getByLabelText("private draft")).toBe(draft);
      expect(draft).toHaveValue("retained private draft");
      expect(screen.getByTestId("private-value")).toHaveTextContent("owner-a");
    } else {
      expect(getReadOwner()).not.toBe(owner);
      expect(screen.getByLabelText("private draft")).not.toBe(draft);
      expect(screen.getByLabelText("private draft")).toHaveValue("unsaved");
      if (outcome === "replacement") {
        await waitFor(() =>
          expect(screen.getByTestId("private-value")).toHaveTextContent("owner-b"),
        );
      } else {
        expect(getReadIdentity()).toBeNull();
        expect(screen.getByLabelText("private draft")).not.toBeVisible();
      }
    }
  },
);

test("ordinary same-account provider refresh keeps drafts visible while awaiting renewal", async () => {
  const draft = screen.getByLabelText("private draft");
  fireEvent.change(draft, { target: { value: "normal renewal draft" } });
  const identity = getReadIdentity();
  hold = true;
  let refresh!: Promise<void>;
  act(() => {
    refresh = authClient.$store.atoms.session.get().refetch();
  });
  await dispatched;
  expect(getReadIdentity()).toBe(identity);
  expect(draft).toBeVisible();
  current!.session.updatedAt = "2026-02-01";
  current!.session.expiresAt = "2099-02-01";
  hold = false;
  await act(async () => {
    finish(Response.json(current));
    await refresh;
  });
  expect(getReadIdentity()).not.toBe(identity);
  expect(screen.getByLabelText("private draft")).toBe(draft);
  expect(draft).toBeVisible();
  expect(draft).toHaveValue("normal renewal draft");
});

test("a settlement notification cancels the earlier pre-cookie-change provider check", async () => {
  const pending: Array<{ finish: (response: Response) => void; signal?: AbortSignal | null }> = [];
  globalThis.fetch = jest
    .fn<typeof fetch>()
    .mockImplementation(
      async (_input, init) =>
        new Promise<Response>((resolve) => pending.push({ finish: resolve, signal: init?.signal })),
    );
  const notify = () =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "better-auth.message",
        newValue: JSON.stringify({
          event: "session",
          data: { trigger: "getSession" },
          clientId: "peer",
          timestamp: Date.now(),
        }),
      }),
    );
  try {
    act(notify);
    await waitFor(() => expect(pending).toHaveLength(1));
    current = session("owner-b");
    act(notify);
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].signal?.aborted).toBe(true);
    await act(async () => pending[0].finish(Response.json(session("owner-a"))));
    expect(screen.getByLabelText("private draft")).not.toBeVisible();
    expect(getReadIdentity()).toBeNull();
    await act(async () => pending[1].finish(Response.json(current)));
    await waitFor(() => expect(screen.getByTestId("private-value")).toHaveTextContent("owner-b"));
    expect(screen.getByLabelText("private draft")).toBeVisible();
  } finally {
    pending.forEach((request) => request.finish(Response.json(null)));
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(Response.json(current));
  }
});
