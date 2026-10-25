/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import {
  RevisionHistoryDialog,
  type RevisionHistorySource,
} from "../../../packages/web-frontend/src/components/history/RevisionHistoryDialog";
import { observeReadSession } from "../../../packages/web-frontend/src/services/read-scope";

const originalReact = globalThis.React;
const originalObserver = globalThis.ResizeObserver;
beforeEach(async () => {
  globalThis.React = React;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  observeReadSession("history-owner", "history-session");
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  observeReadSession(null, null);
  globalThis.React = originalReact;
  globalThis.ResizeObserver = originalObserver;
  jest.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function source(overrides: Partial<RevisionHistorySource> = {}): RevisionHistorySource {
  return {
    label: "Owned definition",
    listRevisions: async () =>
      [3, 2, 1].map((revision) => ({ revision, size: 10, preview: "", createdAt: Date.now() })),
    readRevision: async (revision) => `definition ${revision}`,
    readCurrent: async () => "definition 3",
    restore: async () => {},
    ...overrides,
  };
}
function dialog(value: RevisionHistorySource, onClose = jest.fn<(restored: boolean) => void>()) {
  return (
    <I18nextProvider i18n={i18n}>
      <RevisionHistoryDialog open source={value} onClose={onClose} />
    </I18nextProvider>
  );
}

test("a late selected revision cannot replace the newer selection or its read failure", async () => {
  const first = deferred<string>();
  const read = jest
    .fn<(revision: number) => Promise<string | null>>()
    .mockImplementationOnce(() => first.promise)
    .mockRejectedValueOnce(new Error("Revision unavailable"))
    .mockResolvedValueOnce("definition 2 retried");
  render(dialog(source({ readRevision: read })));
  fireEvent.click(await screen.findByTestId("version-1"));
  fireEvent.click(screen.getByTestId("version-2"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Revision unavailable");
  await act(async () => first.resolve("obsolete definition 1"));
  expect(screen.queryByText("obsolete definition 1")).toBeNull();
  expect(screen.getByTestId("restore-version-button")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("common.retry") }));
  expect(await screen.findByTestId("version-content")).toHaveTextContent("definition 2 retried");
});

test("replacement sources retire pending reads and old private content", async () => {
  const old = deferred<string>();
  const previous = source({ label: "Previous owner", readRevision: () => old.promise });
  const next = source({
    label: "Current owner",
    readRevision: async () => "current private content",
  });
  const view = render(dialog(previous));
  fireEvent.click(await screen.findByTestId("version-1"));
  view.rerender(dialog(next));
  fireEvent.click(await screen.findByTestId("version-2"));
  expect(await screen.findByTestId("version-content")).toHaveTextContent("current private content");
  await act(async () => old.resolve("former private content"));
  expect(screen.queryByText("former private content")).toBeNull();
  expect(screen.queryByText(/Previous owner/)).toBeNull();
});

test("a restore refusal stays visible and keeps confirmation open for a deliberate retry", async () => {
  const restore = jest
    .fn<(revision: number) => Promise<void>>()
    .mockRejectedValueOnce(new Error("Workflow changed elsewhere"))
    .mockResolvedValueOnce(undefined);
  const close = jest.fn<(restored: boolean) => void>();
  render(dialog(source({ restore }), close));
  fireEvent.click(await screen.findByTestId("version-1"));
  await screen.findByTestId("version-content");
  fireEvent.click(screen.getByTestId("restore-version-button"));
  fireEvent.click(screen.getByTestId("confirm-restore-button"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Workflow changed elsewhere");
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("confirm-restore-button"));
  await waitFor(() => expect(close).toHaveBeenCalledWith(true));
  expect(restore.mock.calls).toEqual([[1], [1]]);
});

test("a protected draft still permits inspection and comparison while preventing restore", async () => {
  const restore = jest.fn<(revision: number) => Promise<void>>();
  render(dialog(source({ restore, restoreDisabledReason: "Save or undo your draft first" })));
  const entry = await screen.findByTestId("version-1");
  entry.focus();
  expect(entry).toHaveFocus();
  fireEvent.click(entry);
  await screen.findByTestId("version-content");
  expect(screen.getByText("Save or undo your draft first")).toBeVisible();
  expect(screen.getByTestId("restore-version-button")).toBeDisabled();
  fireEvent.mouseDown(screen.getByRole("tab", { name: i18n.t("history.diff") }), {
    button: 0,
    ctrlKey: false,
  });
  expect(screen.getByTestId("diff-view")).toBeVisible();
  expect(restore).not.toHaveBeenCalled();
});

test("changing accounts hides retained source data and retires an in-flight restore", async () => {
  const pending = deferred<void>();
  const list = jest.fn<RevisionHistorySource["listRevisions"]>().mockImplementation(async () => [
    { revision: 2, size: 10, preview: "", createdAt: Date.now() },
    { revision: 1, size: 10, preview: "", createdAt: Date.now() },
  ]);
  const close = jest.fn<(restored: boolean) => void>();
  render(dialog(source({ listRevisions: list, restore: () => pending.promise }), close));
  fireEvent.click(await screen.findByTestId("version-1"));
  await screen.findByTestId("version-content");
  fireEvent.click(screen.getByTestId("restore-version-button"));
  fireEvent.click(screen.getByTestId("confirm-restore-button"));
  act(() => observeReadSession("different-owner", "different-session"));
  expect(screen.queryByTestId("version-content")).toBeNull();
  expect(screen.queryByText(/Owned definition/)).toBeNull();
  await act(async () => pending.resolve());
  expect(close).not.toHaveBeenCalled();
  expect(list).toHaveBeenCalledTimes(1);
});
