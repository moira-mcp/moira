/**
 * The overview's tour: what the cards are, who has the move, the recent activity and idle filters,
 * stable ordering, what a card and its detail show, and stopping a run when available —
 * and that the page keeps itself current. Every anchor is on the page even before the first run.
 */

import type { GuideDefinition } from "../guides/types";

export const overviewGuide: GuideDefinition = {
  id: "overview",
  kind: "screen",
  screen: "overview",
  routes: ["/overview"],
  steps: [
    { id: "intro", anchor: "overview.header", kind: "look", revision: 2 },
    { id: "status", anchor: "overview.status", kind: "look", revision: 3 },
    { id: "idle", anchor: "overview.idle", kind: "look", revision: 2 },
    { id: "board", anchor: "overview.board", kind: "look", revision: 2 },
    { id: "live", anchor: "overview.live", kind: "look", revision: 1 },
  ],
};
