/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, useLocation } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { DataRegion } from "../../../packages/web-frontend/src/components/DataRegion";
import { DataListView } from "../../../packages/web-frontend/src/components/DataListView";
import { PageHeader as CompactHeader } from "../../../packages/web-frontend/src/components/diagram/PageHeader";
import { PageHeader as StandardHeader } from "../../../packages/web-frontend/src/components/page-header";
import { GuideProvider } from "../../../packages/web-frontend/src/guides/GuideContext";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
const originalReact = globalThis.React;
beforeEach(async () => {
  globalThis.React = React;
  await i18n.changeLanguage("en");
  jest.spyOn(apiClient, "getUserSettings").mockResolvedValue({});
  jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(null));
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  globalThis.React = originalReact;
  localStorage.clear();
});
const locale = (children: React.ReactNode) => (
  <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
);

test("a retained region keeps an input and its focus beside refresh/error feedback and invokes retry", () => {
  const retry = jest.fn<() => void>();
  const view = (pending: boolean, error: string | null) =>
    locale(
      <DataRegion
        hasResult
        pending={pending}
        error={error}
        onRetry={retry}
        resultScope="Accepted page 2"
      >
        <input aria-label="Draft" defaultValue="kept" />
      </DataRegion>,
    );
  const { rerender } = render(view(false, null));
  const input = screen.getByLabelText("Draft");
  fireEvent.change(input, { target: { value: "unsaved" } });
  input.focus();
  rerender(view(true, null));
  expect(screen.getByLabelText("Draft")).toBe(input);
  expect(input).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Updating; showing the last loaded results.",
  );
  rerender(view(false, "source refused"));
  expect(input).toHaveValue("unsaved");
  expect(input).toHaveFocus();
  expect(screen.getByText("Accepted page 2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledTimes(1);
});

test("an accepted empty list retains its toolbar and empty state through refresh and error", () => {
  const retry = jest.fn<() => void>();
  const refresh = jest.fn<() => void>();
  const view = (hasResult: boolean, loading: boolean, error: string | null) =>
    locale(
      <DataListView<string>
        items={[]}
        hasResult={hasResult}
        loading={loading}
        error={error}
        onRetry={retry}
        onRefresh={refresh}
        storageKey="empty-region"
        emptyTitle="Accepted empty"
        toolbar={<input aria-label="Search" defaultValue="old query" />}
        renderCard={(item) => item}
        keyExtractor={(item) => item}
      />,
    );
  const { rerender } = render(view(false, true, null));
  const search = screen.getByLabelText("Search");
  expect(screen.queryByText("Accepted empty")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  rerender(view(true, false, null));
  const empty = screen.getByText("Accepted empty");
  search.focus();
  rerender(view(true, true, null));
  expect(screen.getByText("Accepted empty")).toBe(empty);
  expect(search).toHaveFocus();
  rerender(view(true, false, "offline"));
  expect(screen.getByText("Accepted empty")).toBe(empty);
  expect(screen.getByLabelText("Search")).toBe(search);
  expect(search).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("the list footer reports actual loaded rows and permits recovery from an empty page after totals shrink", () => {
  const page = jest.fn();
  const view = (items: string[], total: number) =>
    locale(
      <DataListView
        items={items}
        hasResult
        keyExtractor={(item) => item}
        renderCard={(item) => <span>{item}</span>}
        storageKey="count-region"
        emptyTitle="Empty current page"
        pagination={{
          mode: "total",
          currentPage: 2,
          pageSize: 20,
          totalItems: total,
          totalPages: Math.ceil(total / 20),
          onPageChange: page,
        }}
      />,
    );
  const { rerender } = render(view(["one", "two"], 50));
  expect(screen.getByTestId("data-list-pagination")).toHaveTextContent("Showing 21-22 of 50");
  rerender(view([], 0));
  const footer = screen.getByTestId("data-list-pagination");
  expect(footer).toHaveTextContent("Showing 0-0 of 0");
  expect(footer).toHaveTextContent("Page 2 (0 entries)");
  expect(within(footer).getByRole("button", { name: "Go to next page" })).toBeDisabled();
  fireEvent.click(within(footer).getByRole("button", { name: "Go to previous page" }));
  expect(page).toHaveBeenLastCalledWith(1);
  fireEvent.click(within(footer).getByRole("button", { name: "Go to first page" }));
  expect(page).toHaveBeenLastCalledWith(1);
});

test("the compact header works without Router and keeps process identity, facts, actions and guide slots", () => {
  const back = jest.fn();
  const action = jest.fn();
  const { rerender } = render(
    locale(
      <CompactHeader
        testId="run-header"
        guide={{ "data-guide": "run.identity" }}
        detailsGuide={{ "data-guide": "run.details" }}
        title="Process title"
        meta="revision 7"
        badges={<span>Waiting</span>}
        facts={<span>3 completed steps</span>}
        description="The task goal"
        back={{ label: "Runs", onClick: back, testId: "run-back" }}
        actions={<button onClick={action}>Refresh run</button>}
      />,
    ),
  );
  const header = screen.getByTestId("run-header");
  expect(header).toHaveAttribute("data-guide", "run.identity");
  expect(screen.getByRole("heading", { level: 1, name: "Process title" })).toHaveAttribute(
    "data-testid",
    "page-title",
  );
  expect(header).toHaveTextContent("revision 7");
  expect(header).toHaveTextContent("Waiting");
  expect(header).toHaveTextContent("3 completed steps");
  expect(screen.getByTestId("page-description").parentElement).toHaveAttribute(
    "data-guide",
    "run.details",
  );
  fireEvent.click(screen.getByTestId("run-back"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh run" }));
  expect(back).toHaveBeenCalledTimes(1);
  expect(action).toHaveBeenCalledTimes(1);
  rerender(
    locale(
      <CompactHeader testId="run-header" actions={<button onClick={action}>Refresh run</button>}>
        <input aria-label="Custom process identity" defaultValue="custom" />
      </CompactHeader>,
    ),
  );
  expect(screen.getByLabelText("Custom process identity")).toHaveValue("custom");
  expect(screen.queryByTestId("page-title")).toBeNull();
});

test("a standard header retains its routed screen tour with title, description and caller actions", () => {
  function Location() {
    return <output aria-label="Address">{useLocation().search}</output>;
  }
  render(
    locale(
      <MemoryRouter initialEntries={["/notes?keep=yes"]}>
        <GuideProvider>
          <StandardHeader
            title="Notes"
            description="Persistent notes"
            guide={{ "data-guide": "notes.header" }}
          >
            <button>New note</button>
          </StandardHeader>
          <Location />
        </GuideProvider>
      </MemoryRouter>,
    ),
  );
  expect(screen.getByRole("heading", { level: 1, name: "Notes" }).parentElement).toHaveAttribute(
    "data-guide",
    "notes.header",
  );
  expect(screen.getByText("Persistent notes")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New note" })).toBeEnabled();
  const tour = screen.getByTestId("guide-open");
  expect(tour).toHaveAttribute("data-guide-id", "notes");
  fireEvent.click(tour);
  expect(screen.getByLabelText("Address")).toHaveTextContent("guide=notes");
  expect(screen.getByLabelText("Address")).toHaveTextContent("keep=yes");
});
