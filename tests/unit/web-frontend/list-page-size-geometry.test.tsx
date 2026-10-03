/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { useListPageSize } from "../../../packages/web-frontend/src/hooks/useListPageSize";

class GeometryObserver {
  static observers = new Set<GeometryObserver>();
  private targets = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) {
    GeometryObserver.observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    GeometryObserver.observers.delete(this);
  }
  static resize(target: Element) {
    for (const observer of GeometryObserver.observers) {
      if (observer.targets.has(target)) {
        observer.callback([], observer as unknown as ResizeObserver);
      }
    }
  }
}

const originalObserver = globalThis.ResizeObserver;
const originalWidth = window.innerWidth;
beforeEach(() => {
  jest.useFakeTimers();
  globalThis.ResizeObserver = GeometryObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
});
afterEach(() => {
  cleanup();
  GeometryObserver.observers.clear();
  globalThis.ResizeObserver = originalObserver;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  jest.useRealTimers();
  document.body.replaceChildren();
});

// Model the browser's reported geometry explicitly: concealed ancestors make both the retained
// list and its cards zero-height. This does not depend on JSDOM's default lack of layout.
function geometry(hidden = false, heights = [92, 92]) {
  const ancestor = document.createElement("div");
  ancestor.hidden = hidden;
  const box = document.createElement("div");
  ancestor.append(box);
  document.body.append(ancestor);
  let available = 608;
  Object.defineProperty(box, "clientHeight", {
    get: () => (ancestor.hidden ? 0 : available),
  });
  function rows(values: number[]) {
    box.replaceChildren(
      ...values.map((height) => {
        const card = document.createElement("div");
        card.dataset.slotted = "true";
        Object.defineProperty(card, "offsetHeight", {
          get: () => (ancestor.hidden ? 0 : height),
        });
        return card;
      }),
    );
  }
  rows(heights);
  function resize(height = available) {
    available = height;
    act(() => {
      GeometryObserver.resize(box);
      jest.advanceTimersByTime(500);
    });
  }
  return { ancestor, box, rows, resize };
}

describe("list page size from actual card geometry", () => {
  test("concealed retained cards do not settle the view; revealing measures them before paging", () => {
    const nodes = geometry(true);
    const { result } = renderHook(() => {
      const [page, setPage] = useState(3);
      return { ...useListPageSize(() => setPage(1)), page, setPage };
    });
    act(() => result.current.containerRef(nodes.box));
    expect(result.current.pageSize).toBe(20);
    expect(result.current.page).toBe(3);

    nodes.ancestor.hidden = false;
    nodes.resize();
    expect(result.current.pageSize).toBe(6);
    expect(result.current.page).toBe(1);
    act(() => result.current.setPage(3));

    // Later-page content cannot revise the already accepted row height or reset that page.
    act(() => nodes.rows([192, 192]));
    nodes.resize();
    expect(result.current.pageSize).toBe(6);
    expect(result.current.page).toBe(3);
    nodes.resize(808);
    expect(result.current.pageSize).toBe(8);
    expect(result.current.page).toBe(1);
  });

  test("a partially unmeasured row set is retried when real sizes arrive", () => {
    const nodes = geometry(false, [92, 0]);
    const { result } = renderHook(() => useListPageSize());
    act(() => result.current.containerRef(nodes.box));
    expect(result.current.pageSize).toBe(5);
    act(() => nodes.rows([92, 92]));
    nodes.resize();
    expect(result.current.pageSize).toBe(6);
  });

  test("each view settles independently and a grid resize keeps the accepted row height", () => {
    const nodes = geometry();
    const { result } = renderHook(() => useListPageSize());
    act(() => result.current.containerRef(nodes.box));
    expect(result.current.pageSize).toBe(6);

    nodes.ancestor.hidden = true;
    act(() => result.current.onViewModeChange("grid"));
    act(() => nodes.rows([188, 188]));
    nodes.ancestor.hidden = false;
    nodes.resize();
    expect(result.current.pageSize).toBe(9);

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 700 });
    act(() => nodes.rows([288, 288]));
    nodes.resize();
    expect(result.current.pageSize).toBe(6);
    act(() => result.current.onViewModeChange("list"));
    expect(result.current.pageSize).toBe(6);
  });
});
