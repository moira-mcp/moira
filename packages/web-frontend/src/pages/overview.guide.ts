/**
 * The overview's tour: what the cards are, who has the move (and that runs waiting for you come
 * first), how to find what stalled, what a card and its panel show — with what "last step" means —
 * and that the page keeps itself current. Every anchor is on the page even before the first run.
 */

import type { GuideDefinition } from "../guides/types";

export const overviewGuide: GuideDefinition = {
  id: "overview",
  kind: "screen",
  screen: "overview",
  routes: ["/overview"],
  steps: [
    { id: "intro", anchor: "overview.header", kind: "look", revision: 1 },
    { id: "status", anchor: "overview.status", kind: "look", revision: 2 },
    { id: "idle", anchor: "overview.idle", kind: "look", revision: 1 },
    { id: "board", anchor: "overview.board", kind: "look", revision: 1 },
    { id: "live", anchor: "overview.live", kind: "look", revision: 1 },
  ],
};
