/**
 * The home screen's tour: that the reader's agent does the work and Moira keeps it on track, the
 * beginner panels that connect an agent and suggest a first prompt and flows, the reader's own work,
 * and "Show me around" in the sidebar, where every other tour starts.
 *
 * The beginner panels can be hidden, so their steps are optional and skipped when a panel is gone.
 * The last step points into the sidebar, which on a phone is a closed sheet the runner opens.
 */

import type { GuideDefinition } from "../guides/types";

export const homeGuide: GuideDefinition = {
  id: "home",
  kind: "screen",
  screen: "home",
  routes: ["/"],
  steps: [
    { id: "intro", anchor: "home.header", kind: "look", revision: 1 },
    {
      id: "how",
      anchor: "home.how-it-works",
      kind: "look",
      revision: 1,
      optional: true,
      absentWhen: { panelHidden: "home-intro" },
    },
    {
      id: "connect",
      anchor: "home.connect",
      kind: "look",
      revision: 1,
      optional: true,
      absentWhen: { panelHidden: "quick-start" },
    },
    {
      id: "try",
      anchor: "home.try",
      kind: "look",
      revision: 1,
      optional: true,
      absentWhen: { panelHidden: "home-intro" },
    },
    {
      id: "recommended",
      anchor: "home.recommended",
      kind: "look",
      revision: 1,
      optional: true,
      absentWhen: { panelHidden: "home-recommended" },
    },
    {
      id: "practice",
      anchor: "home.practice",
      kind: "look",
      revision: 1,
      optional: true,
      absentWhen: { panelHidden: "home-recommended" },
    },
    { id: "work", anchor: "home.work", kind: "look", revision: 2 },
    {
      id: "show-me-around",
      anchor: "home.show-me-around",
      kind: "look",
      revision: 1,
      prepare: { sidebar: true },
    },
  ],
};
