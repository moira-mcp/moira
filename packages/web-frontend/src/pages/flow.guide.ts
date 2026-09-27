/**
 * The flow page's screen tour: who builds flows (the agent, not the reader), the header's facts and
 * the level a flow was built at, the three views and each diagram's note, the flow read as plain
 * steps, block, step, evidence, loop, the panel's tabs, a node's playbook reference, getting a copy
 * or sharing, where the definition is edited, and how to look at it.
 *
 * The steps about the process view are optional: a flow without one has no map to point at, and a
 * flow without a loop has no return port, so those steps are skipped rather than waited for. So are
 * the level badge (only flows built with the Workflow Management Flow carry one), the playbook
 * reference (only on a flow whose node names a playbook) and "Use as Template" (a public flow).
 *
 * The owner and a reader see different steps: the owner is pointed at visibility and sharing and at
 * the edit switch, which only a wide screen draws; a reader learns about getting a copy, and that
 * the owner edits.
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
    { id: "facts", anchor: "flow.facts", kind: "look", revision: 1 },
    { id: "level", anchor: "flow.level", kind: "look", revision: 1, optional: true },
    { id: "modes", anchor: "flow.modes", kind: "look", revision: 1 },
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
      id: "diagram-note",
      anchor: "process.diagram-note",
      views: ["graph", "map"],
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
      id: "panel-tabs",
      // A collapsed panel draws no tabs.
      optional: true,
      anchor: "flow.panel-tabs",
      views: ["graph", "map"],
      kind: "look",
      revision: 1,
    },
    {
      id: "playbook",
      optional: true,
      anchor: "process.node-playbooks",
      views: ["graph", "map"],
      kind: "look",
      revision: 1,
      prepare: { playbookNode: true, panel: "block" },
    },
    {
      id: "template",
      optional: true,
      anchor: "flow.use-template",
      kind: "look",
      revision: 1,
      roles: "reader",
      wide: true,
    },
    {
      id: "visibility",
      anchor: "flow.visibility",
      kind: "look",
      revision: 1,
      roles: "owner",
      wide: true,
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
