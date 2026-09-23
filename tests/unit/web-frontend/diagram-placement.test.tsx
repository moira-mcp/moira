/** @jest-environment jsdom */
/**
 * The shared opening placement: a diagram places its viewport once the substrate reports ready,
 * places again only when the thing it follows changes, and never on a plain re-render with the
 * same key — so a polling refetch does not undo the reader's own panning. It reports `placed` only
 * once the camera has arrived for the current key, which is what a diagram publishes as settled.
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

  test("reports placed only after the current key's placement has arrived, never for a superseded one", async () => {
    // Each placement resolves when the test says the camera has arrived.
    const arrivals = new Map<string, () => void>();
    const place = (_rf: Instance, key: string) =>
      new Promise<void>((resolve) => {
        arrivals.set(key, resolve);
      });
    const { result, rerender } = renderHook(({ key }) => useOpeningPlacement(place, key), {
      initialProps: { key: "a" },
    });
    act(() => result.current.onInit(instance));
    expect(result.current.placed).toBe(false);
    act(() => result.current.onReady(instance));
    // Placing is not placed: the camera is still on its way.
    expect(result.current.placed).toBe(false);
    await act(async () => arrivals.get("a")!());
    expect(result.current.placed).toBe(true);
    // The followed thing moves: no longer placed until the new placement arrives.
    rerender({ key: "b" });
    expect(result.current.placed).toBe(false);
    // A newer key starts before "b" arrives; "b" arriving late reports nothing.
    rerender({ key: "c" });
    await act(async () => arrivals.get("b")!());
    expect(result.current.placed).toBe(false);
    await act(async () => arrivals.get("c")!());
    expect(result.current.placed).toBe(true);
  });

  test("a ready report from before a key change places the key as it is now, and counts it as placed", () => {
    const placed: string[] = [];
    const { result, rerender } = renderHook(
      ({ key }) =>
        useOpeningPlacement((_rf: Instance, k: string) => {
          placed.push(k);
        }, key),
      { initialProps: { key: "1|first" } },
    );
    act(() => result.current.onInit(instance));
    // The substrate keeps the callback it was handed at init and reports ready later — here after
    // a second layout pass has already moved the key on.
    const readyFromInit = result.current.onReady;
    rerender({ key: "2|first" });
    act(() => readyFromInit(instance));
    expect(placed).toEqual(["2|first"]);
  });

  test("a camera move begun after the placement closes it, so a pan that cuts it short still settles; an earlier move does not", () => {
    // A placement whose animation never reports its arrival, as when the reader's pan cuts it off.
    const { result, rerender } = renderHook(
      ({ key }) =>
        useOpeningPlacement((_rf: Instance, _k: string) => new Promise<void>(() => {}), key),
      { initialProps: { key: "a" } },
    );
    act(() => result.current.onInit(instance));
    // The opening fit starts moving before the placement exists.
    act(() => result.current.onMoveStart());
    act(() => result.current.onReady(instance));
    // Its end, reported after the placement began, is not the placement's.
    act(() => result.current.onMoveEnd());
    expect(result.current.placed).toBe(false);
    // The reader pans: the move begins and ends after the placement did.
    act(() => result.current.onMoveStart());
    act(() => result.current.onMoveEnd());
    expect(result.current.placed).toBe(true);
    // A new key is a new placement: open until a move that begins after it ends.
    rerender({ key: "b" });
    expect(result.current.placed).toBe(false);
    act(() => result.current.onMoveEnd());
    expect(result.current.placed).toBe(false);
  });
});
