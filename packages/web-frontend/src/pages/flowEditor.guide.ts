/**
 * The editor tour: a task tour of the flow page's edit mode, offered once the first time the owner
 * switches editing on. Look steps only — practising is the tutorial's job — on any flow the reader
 * owns: where edits collect and are undone, creating, renaming and deleting steps, blocks,
 * connections and their labels, a choice, and what stops a save.
 */

import type { GuideDefinition } from "../guides/types";

export const EDITOR_GUIDE_ID = "flow-editor";

export const flowEditorGuide: GuideDefinition = {
  id: EDITOR_GUIDE_ID,
  kind: "task",
  screen: "flow",
  routes: ["/workflows/:handle/:slug", "/workflows/:id"],
  views: ["steps", "map", "graph"],
  panels: ["block", "variables"],
  sections: ["steps"],
  steps: [
    { id: "bar", anchor: "flow.edit-bar", kind: "look", revision: 2, roles: "owner" },
    {
      id: "add-step",
      anchor: "flow.edit-add-step",
      kind: "look",
      revision: 1,
      roles: "owner",
      views: ["map", "graph"],
      prepare: { panel: "block", section: "steps" },
    },
    {
      id: "step-actions",
      anchor: "flow.edit-step-actions",
      kind: "look",
      revision: 1,
      roles: "owner",
      views: ["map", "graph"],
      prepare: { panel: "block", section: "steps" },
    },
    {
      id: "blocks",
      anchor: "flow.edit-blocks",
      kind: "look",
      revision: 1,
      roles: "owner",
      optional: true,
      wide: true,
    },
    {
      id: "connections",
      anchor: "flow.edit-connections",
      kind: "look",
      revision: 1,
      roles: "owner",
      views: ["map", "graph"],
      prepare: { panel: "block", section: "steps" },
    },
    {
      id: "choice",
      anchor: "flow.edit-choice",
      kind: "look",
      revision: 1,
      roles: "owner",
      optional: true,
      views: ["map", "graph"],
      prepare: { panel: "block", section: "steps" },
    },
    { id: "validation", anchor: "flow.edit-save", kind: "look", revision: 1, roles: "owner" },
    { id: "stale", anchor: "flow.edit-revision", kind: "look", revision: 1, roles: "owner" },
  ],
};
