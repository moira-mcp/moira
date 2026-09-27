/** @jest-environment jsdom */
/**
 * A tutorial's check result reaches the polite live region exactly once: a new result is announced,
 * the same result on another render is not, and a result that goes back to an earlier one is
 * announced again, because it changed.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { renderHook } from "@testing-library/react";
import { useResultAnnouncement } from "../../../packages/web-frontend/src/guides/tutorial/announce";

describe("the tutorial's result announcement", () => {
  test("one result is announced once, an unchanged one not at all", () => {
    const announce = jest.fn<(message: string) => void>();
    // A page re-render hands over a new function each time; that alone is no new result.
    const { rerender } = renderHook(
      ({ key, message }: { key: string; message: string | null }) =>
        useResultAnnouncement(key, message, (said) => announce(said)),
      { initialProps: { key: "lesson-2:findings:new-step-missing", message: "1 thing to fix" } },
    );
    expect(announce.mock.calls).toEqual([["1 thing to fix"]]);
    rerender({ key: "lesson-2:findings:new-step-missing", message: "1 thing to fix" });
    rerender({ key: "lesson-2:findings:new-step-missing", message: "1 thing to fix" });
    expect(announce).toHaveBeenCalledTimes(1);
    rerender({ key: "lesson-2:save:", message: "Looks right" });
    expect(announce.mock.calls).toEqual([["1 thing to fix"], ["Looks right"]]);
  });

  test("a result with nothing to say is heard but not announced", () => {
    const announce = jest.fn<(message: string) => void>();
    const { rerender } = renderHook(
      ({ key, message }: { key: string; message: string | null }) =>
        useResultAnnouncement(key, message, announce),
      { initialProps: { key: "lesson-0:instruction:", message: null as string | null } },
    );
    rerender({ key: "lesson-0:instruction:", message: null });
    expect(announce).not.toHaveBeenCalled();
  });
});
