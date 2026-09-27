/**
 * The notes page's tour: what a note is and who writes it, creating one, the list with each note's
 * history and comparison, and the storage quota. History lives in each card's actions, which show
 * only on hover, so the list step names where it is instead of pointing at a hidden control. The
 * quota appears once the reader's storage is read, so its step is optional.
 */

import type { GuideDefinition } from "../guides/types";

export const notesGuide: GuideDefinition = {
  id: "notes",
  kind: "screen",
  screen: "notes",
  routes: ["/notes"],
  steps: [
    { id: "intro", anchor: "notes.header", kind: "look", revision: 1 },
    { id: "create", anchor: "notes.create", kind: "look", revision: 1 },
    { id: "list", anchor: "notes.list", kind: "look", revision: 1 },
    { id: "quota", anchor: "notes.quota", kind: "look", revision: 1, optional: true },
  ],
};
