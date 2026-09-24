/** @jest-environment jsdom */
/**
 * A highlight request owns the visible mark it adds. A newer request removes the older mark
 * immediately, and unmounting removes the current one instead of leaving either target pulsing.
 * The scroll is instant for a reader who asked for reduced motion, and a caller can send focus
 * along with the jump.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import {
  HIGHLIGHT_CLASSES,
  useHighlightTarget,
  type HighlightRequest,
} from "../../../packages/web-frontend/src/components/diagram/useHighlightTarget.js";

afterEach(() => {
  jest.useRealTimers();
  document.body.replaceChildren();
  jest.restoreAllMocks();
});

function mount(): { container: HTMLElement; target: HTMLElement } {
  const container = document.createElement("div");
  const target = document.createElement("div");
  target.dataset.target = "only";
  target.tabIndex = -1;
  target.scrollIntoView = jest.fn();
  container.append(target);
  document.body.append(container);
  return { container, target };
}

describe("useHighlightTarget", () => {
  test("clears a superseded highlight before its timeout and clears the replacement on unmount", () => {
    jest.useFakeTimers();
    const container = document.createElement("div");
    const first = document.createElement("div");
    const second = document.createElement("div");
    first.dataset.target = "first";
    second.dataset.target = "second";
    first.scrollIntoView = jest.fn();
    second.scrollIntoView = jest.fn();
    container.append(first, second);
    document.body.append(container);

    const containerRef: RefObject<HTMLElement> = { current: container };
    const selectorFor = (name: string) => `[data-target="${name}"]`;
    const { rerender, unmount } = renderHook(
      ({ request }: { request: HighlightRequest }) =>
        useHighlightTarget(containerRef, request, selectorFor, 2_200),
      { initialProps: { request: { name: "first", token: 1 } } },
    );

    expect(first.getAttribute("data-highlighted")).toBe("true");
    expect(HIGHLIGHT_CLASSES.every((className) => first.classList.contains(className))).toBe(true);

    rerender({ request: { name: "second", token: 2 } });

    expect(first.hasAttribute("data-highlighted")).toBe(false);
    expect(HIGHLIGHT_CLASSES.some((className) => first.classList.contains(className))).toBe(false);
    expect(second.getAttribute("data-highlighted")).toBe("true");
    expect(HIGHLIGHT_CLASSES.every((className) => second.classList.contains(className))).toBe(true);

    unmount();

    expect(second.hasAttribute("data-highlighted")).toBe(false);
    expect(HIGHLIGHT_CLASSES.some((className) => second.classList.contains(className))).toBe(false);
  });

  test.each([
    { reduce: false, behavior: "smooth" },
    { reduce: true, behavior: "auto" },
  ] as const)("scrolls $behavior when reduced motion is $reduce", ({ reduce, behavior }) => {
    const media = window.matchMedia("");
    jest
      .spyOn(window, "matchMedia")
      .mockImplementation((query) => ({ ...media, matches: reduce && query.includes("reduce") }));
    const { container, target } = mount();
    renderHook(() =>
      useHighlightTarget(
        { current: container },
        { name: "only", token: 1 },
        (name) => `[data-target="${name}"]`,
      ),
    );
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior });
  });

  test.each([
    { focus: true, focused: true },
    { focus: false, focused: false },
  ])("moves focus to the target only when asked (focus: $focus)", ({ focus, focused }) => {
    const { container, target } = mount();
    renderHook(() =>
      useHighlightTarget(
        { current: container },
        { name: "only", token: 1 },
        (name) => `[data-target="${name}"]`,
        undefined,
        { focus },
      ),
    );
    expect(document.activeElement === target).toBe(focused);
  });
});
