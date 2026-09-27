/** @jest-environment jsdom */
/**
 * The in-page store of a user setting belongs to one account. After a sign-in as someone else
 * without a reload, nothing of the previous account's value may show through: while the new
 * account's value is unknown, a change keeps it unknown instead of applying itself to the previous
 * account's copy.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react";

let currentUser = "account-a";
jest.unstable_mockModule("../../../packages/web-frontend/src/auth/better-auth-client", () => ({
  useSession: () => ({ data: { user: { id: currentUser } } }),
}));

const { apiClient } = await import("../../../packages/web-frontend/src/services/api-client");
const { createUserSettingStore } =
  await import("../../../packages/web-frontend/src/lib/userSettingStore");

afterEach(() => {
  jest.restoreAllMocks();
  currentUser = "account-a";
});

describe("a user-setting store across an account switch", () => {
  test("the previous account's value does not show through the next account's unknown one", async () => {
    const store = createUserSettingStore<{ answer?: string }>("ui.example", {
      parse: (value) => (value && typeof value === "object" ? (value as { answer?: string }) : {}),
    });
    const read = jest
      .spyOn(apiClient, "getUserSettings")
      .mockResolvedValueOnce({ "ui.example": { answer: "declined" } });
    jest.spyOn(apiClient, "updateUserSettings").mockResolvedValue({ saved: {}, refused: [] });

    const { result, rerender } = renderHook(() => store.useValue());
    await waitFor(() => expect(result.current.value).toEqual({ answer: "declined" }));

    // Another account signs in; its settings are still on their way when a change is made.
    let answerB: (settings: Record<string, unknown>) => void = () => {};
    read.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerB = resolve;
        }),
    );
    currentUser = "account-b";
    rerender();
    await waitFor(() => expect(result.current.loaded).toBe(false));

    act(() => {
      void store.change((value) => ({ ...value, touched: "yes" }) as { answer?: string });
    });
    // Nothing of account A's value shows through while B's is unknown.
    expect(result.current.value).toBeNull();

    // B's own value arrives: the change is applied to it, and A's answer never appears.
    await act(async () => {
      answerB({ "ui.example": {} });
    });
    await waitFor(() => expect(result.current.value).toEqual({ touched: "yes" }));
  });
});
