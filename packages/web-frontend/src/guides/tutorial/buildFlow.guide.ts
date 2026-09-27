/**
 * The tutorial "Build your first flow": lessons done in the flow page's editor on the reader's own
 * copy of the learning example, each checked on the definition. Lesson 0 explains how flows are
 * really made (by the agent, at an agreed level); lesson 1 makes the copy; lessons 2 and 3 add a
 * step and connect it. A lesson's anchor is the control its work starts from.
 */

import type { GuideDefinition } from "../types";

export const BUILD_FLOW_ID = "build-flow";

export const buildFlowTutorial: GuideDefinition = {
  id: BUILD_FLOW_ID,
  kind: "tutorial",
  screen: "flow",
  routes: ["/workflows/:handle/:slug", "/workflows/:id"],
  views: ["steps", "map", "graph"],
  panels: ["block", "variables"],
  sections: ["steps"],
  steps: [
    { id: "lesson-0", anchor: "flow.header", kind: "look", revision: 1 },
    { id: "lesson-1", anchor: "flow.use-template", kind: "do", revision: 1 },
    { id: "lesson-2", anchor: "flow.edit-add-step", kind: "do", revision: 1 },
    { id: "lesson-3", anchor: "flow.edit-connections", kind: "do", revision: 1 },
  ],
};
