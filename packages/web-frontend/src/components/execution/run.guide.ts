/**
 * The run page's screen tour: what a run shows — the process, its two views, the agent on its step,
 * the evidence it owes, the loop a failed review takes, the route the run leaves, the panel's tabs,
 * answering a step that waits for the person, where Moira's notifications about the run lead, and
 * how to look at it.
 *
 * Every anchor is drawn beside both diagrams (the contents, the block panel, the return ports and
 * the route cursor sit next to the map and the graph alike), so no step moves the reader to a view
 * they did not choose; the toolbar is the one element each view draws for itself.
 */

import type { GuideDefinition } from "../../guides/types";

export const runGuide: GuideDefinition = {
  id: "run",
  kind: "screen",
  screen: "run",
  routes: ["/executions/:id"],
  views: ["map", "graph"],
  panels: ["block", "variables", "errors", "steps", "locks"],
  sections: ["steps"],
  steps: [
    { id: "process", anchor: "process.contents-row", kind: "look", revision: 1 },
    { id: "modes", anchor: "run.modes", kind: "look", revision: 1 },
    {
      id: "agent",
      anchor: "process.current-step",
      kind: "look",
      revision: 1,
      prepare: { currentBlock: true, panel: "block", section: "steps" },
    },
    {
      id: "evidence",
      anchor: "process.current-step-inputs",
      kind: "look",
      revision: 1,
      prepare: { currentBlock: true, panel: "block", section: "steps" },
    },
    // A run of a flow without a loop has no return port to show.
    { id: "loop", anchor: "process.return-port", kind: "look", revision: 1, optional: true },
    {
      id: "route",
      anchor: "run.route-cursor",
      kind: "look",
      revision: 1,
      prepare: { route: true, panel: "variables" },
    },
    // A collapsed panel draws no tabs.
    { id: "panel-tabs", anchor: "run.panel-tabs", kind: "look", revision: 1, optional: true },
    // Only a run that waits for the person has an answer form.
    {
      id: "answer",
      anchor: "run.answer",
      kind: "look",
      revision: 1,
      optional: true,
      prepare: { panel: "variables" },
    },
    { id: "notifications", anchor: "run.header", kind: "look", revision: 1 },
    {
      id: "explore",
      anchor: { map: "process.map-toolbar", graph: "process.graph-toolbar" },
      kind: "look",
      revision: 1,
    },
  ],
};
