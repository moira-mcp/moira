/**
 * The artifacts page's tour: what an artifact is, the storage quota, creating one, and the list,
 * whose cards open, copy the link to, edit and delete an artifact. Those actions show only when a
 * card is pointed at or focused, so the list step names where they are. The quota appears once the
 * reader's storage is read, so its step is optional.
 */

import type { GuideDefinition } from "../guides/types";

export const artifactsGuide: GuideDefinition = {
  id: "artifacts",
  kind: "screen",
  screen: "artifacts",
  routes: ["/artifacts"],
  steps: [
    { id: "intro", anchor: "artifacts.header", kind: "look", revision: 1 },
    { id: "quota", anchor: "artifacts.quota", kind: "look", revision: 1, optional: true },
    { id: "create", anchor: "artifacts.create", kind: "look", revision: 1 },
    { id: "list", anchor: "artifacts.list", kind: "look", revision: 1 },
  ],
};
