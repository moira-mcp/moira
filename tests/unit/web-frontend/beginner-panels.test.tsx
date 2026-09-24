/** @jest-environment jsdom */
/**
 * The hidden-panel store behind every beginner panel and the Settings switches: it reads the stored
 * list once, keeps only panel ids this build knows, applies a hide at once, and takes the hide back
 * when the server does not store it — so a panel never stays hidden on screen while the account
 * still has it shown. A hide is applied to the stored list, so it never undoes another device's.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  HIDDEN_PANELS_KEY,
  resetBeginnerPanels,
  setPanelHidden,
  useBeginnerPanels,
} from "../../../packages/web-frontend/src/components/onboarding/beginnerPanels";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";

beforeEach(() => {
  resetBeginnerPanels();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("beginner panels store", () => {
  test("reads the stored list and ignores ids this build does not know", async () => {
    jest
      .spyOn(apiClient, "getUserSettings")
      .mockResolvedValue({ [HIDDEN_PANELS_KEY]: ["quick-start", "retired-panel"] });
    const { result } = renderHook(() => useBeginnerPanels());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.isHidden("quick-start")).toBe(true);
    expect(result.current.isHidden("home-intro")).toBe(false);
  });

  test("a hide keeps what another device hid since this page read the list", async () => {
    jest
      .spyOn(apiClient, "getUserSettings")
      .mockResolvedValueOnce({ [HIDDEN_PANELS_KEY]: [] })
      .mockResolvedValue({ [HIDDEN_PANELS_KEY]: ["quick-start"] });
    const save = jest
      .spyOn(apiClient, "updateUserSettings")
      .mockResolvedValue({ saved: {}, refused: [] });
    const { result } = renderHook(() => useBeginnerPanels());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      await setPanelHidden("home-intro", true);
    });

    expect(save).toHaveBeenCalledWith({ [HIDDEN_PANELS_KEY]: ["home-intro", "quick-start"] });
    expect(result.current.isHidden("quick-start")).toBe(true);
  });

  test("hides made one right after another are all stored", async () => {
    // The server's list, read and written the way the settings API does; each write lands only
    // after a delay, so a second hide that read the list before the first write would lose it.
    let server: string[] = [];
    jest
      .spyOn(apiClient, "getUserSettings")
      .mockImplementation(async () => ({ [HIDDEN_PANELS_KEY]: [...server] }));
    jest.spyOn(apiClient, "updateUserSettings").mockImplementation(async (settings) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      server = settings[HIDDEN_PANELS_KEY] as string[];
      return { saved: settings, refused: [] };
    });
    const { result } = renderHook(() => useBeginnerPanels());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      await Promise.all([
        setPanelHidden("home-intro", true),
        setPanelHidden("quick-start", true),
        setPanelHidden("home-recommended", true),
      ]);
    });

    expect(server).toEqual(["home-intro", "quick-start", "home-recommended"]);
    expect(result.current.isHidden("quick-start")).toBe(true);
  });

  test("a hide the server refuses is taken back and reported", async () => {
    jest.spyOn(apiClient, "getUserSettings").mockResolvedValue({});
    const save = jest.spyOn(apiClient, "updateUserSettings").mockResolvedValue({
      saved: {},
      refused: [{ key: HIDDEN_PANELS_KEY, reason: "Setting definition not found" }],
    });
    const { result } = renderHook(() => useBeginnerPanels());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let failure: unknown;
    await act(async () => {
      await setPanelHidden("home-intro", true).catch((error) => {
        failure = error;
      });
    });

    expect(save).toHaveBeenCalledWith({ [HIDDEN_PANELS_KEY]: ["home-intro"] });
    expect(failure).toBeInstanceOf(Error);
    expect(result.current.isHidden("home-intro")).toBe(false);
  });
});
