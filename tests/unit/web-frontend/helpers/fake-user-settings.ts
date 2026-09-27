/**
 * An in-memory stand-in for the user settings API, for rendered tests of components that read or
 * save a user setting: reads return a copy of what is stored, a bulk save stores every key it is
 * given and refuses none. Install it in `beforeEach`; `jest.restoreAllMocks()` removes it.
 */

import { jest } from "@jest/globals";
import { apiClient } from "../../../../packages/web-frontend/src/services/api-client";

export function fakeUserSettings(initial: Record<string, unknown> = {}): {
  stored: Record<string, unknown>;
} {
  const server = { stored: { ...initial } };
  jest.spyOn(apiClient, "getUserSettings").mockImplementation(async () => ({ ...server.stored }));
  jest.spyOn(apiClient, "updateUserSettings").mockImplementation(async (settings) => {
    server.stored = { ...server.stored, ...settings };
    return { saved: settings, refused: [] };
  });
  return server;
}
