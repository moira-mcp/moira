/** @jest-environment jsdom */
/**
 * The shared opening placement: a diagram places its viewport once the substrate reports ready,
 * places again only when the thing it follows changes, and never on a plain re-render with the
 * same key — so a polling refetch does not undo the reader's own panning.
 */
import { describe, expect, test } from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { useOpeningPlacement } from "../../../packages/web-frontend/src/components/diagram/placement.js";

type Instance = ReactFlowInstance;
const instance = { id: "rf" } as unknown as Instance;

describe("useOpeningPlacement", () => {
  test("places on ready, again only when the key changes, never on a same-key re-render or a new placement function", () => {
    const placed: Array<string | null> = [];
    // A fresh placement function on every render, as a diagram passes after each refetch: only the
    // key may trigger a placement, never the function's identity.
    const { result, rerender } = renderHook(
      ({ key }) =>
        useOpeningPlacement((_rf: Instance, k: string | null) => {
          placed.push(k);
        }, key),
      { initialProps: { key: "a" as string | null } },
    );
    // Init alone does not place: the substrate has not fitted yet.
    act(() => result.current.onInit(instance));
    expect(placed).toEqual([]);
    act(() => result.current.onReady(instance));
    expect(placed).toEqual(["a"]);
    // A re-render with the same key (a refetch) leaves the viewport alone.
    rerender({ key: "a" });
    expect(placed).toEqual(["a"]);
    // The followed thing moved: placed again, once.
    rerender({ key: "b" });
    expect(placed).toEqual(["a", "b"]);
    rerender({ key: "b" });
    expect(placed).toEqual(["a", "b"]);
  });

  test("a key change before the viewport is ready waits for ready instead of placing early", () => {
    const placed: Array<string | null> = [];
    const place = (_rf: Instance, key: string | null) => {
      placed.push(key);
    };
    const { result, rerender } = renderHook(({ key }) => useOpeningPlacement(place, key), {
      initialProps: { key: null as string | null },
    });
    act(() => result.current.onInit(instance));
    rerender({ key: "scope" });
    expect(placed).toEqual([]);
    act(() => result.current.onReady(instance));
    expect(placed).toEqual(["scope"]);
  });
});
