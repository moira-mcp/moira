/**
 * The flow page's screen tour: who builds flows (the agent, not the reader), the flow read as plain
 * steps, block, step, evidence, loop, where the definition is edited, and how to look at it.
 *
 * The steps about the process view are optional: a flow without one has no map to point at, and a
 * flow without a loop has no return port, so those steps are skipped rather than waited for.
 *
 * The owner and a reader see different editing steps: the owner is pointed at the edit switch,
 * which only a wide screen draws; a reader learns that the owner edits and how to get a copy.
 */

import type { GuideDefinition } from "../guides/types";

const PROCESS_VIEWS = ["map", "graph"];

export const flowGuide: GuideDefinition = {
  id: "flow",
  kind: "screen",
  screen: "flow",
  routes: ["/workflows/:handle/:slug", "/workflows/:id"],
  views: ["steps", "map", "graph"],
  panels: ["block", "variables"],
  sections: ["steps"],
  steps: [
    { id: "intro", anchor: "flow.header", kind: "look", revision: 1 },
    {
      id: "steps",
      anchor: {
        steps: "flow.instruction-card",
        map: "flow.steps-view-switch",
        graph: "flow.steps-view-switch",
      },
      kind: "look",
      revision: 1,
    },
    {
      id: "process",
      optional: true,
      anchor: "process.contents-row",
      views: PROCESS_VIEWS,
      kind: "look",
      revision: 1,
    },
    {
      id: "agent",
      optional: true,
      anchor: "process.step",
      views: PROCESS_VIEWS,
      kind: "look",
      revision: 1,
      prepare: { panel: "block", section: "steps" },
    },
    {
      id: "evidence",
      optional: true,
      anchor: "process.step-inputs",
      views: PROCESS_VIEWS,
      kind: "look",
      revision: 1,
      prepare: { panel: "block", section: "steps" },
    },
    {
      id: "loop",
      optional: true,
      anchor: "process.return-port",
      views: PROCESS_VIEWS,
      kind: "look",
      revision: 1,
    },
    {
      id: "edit",
      anchor: "flow.edit-toggle",
      kind: "look",
      revision: 1,
      roles: "owner",
      wide: true,
    },
    { id: "edit-reader", anchor: "flow.header", kind: "look", revision: 1, roles: "reader" },
    {
      id: "explore",
      anchor: {
        map: "process.map-toolbar",
        graph: "process.graph-toolbar",
        steps: "flow.steps-toolbar",
      },
      kind: "look",
      revision: 1,
    },
  ],
};
