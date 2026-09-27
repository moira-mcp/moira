/**
 * The playbooks page's tour: what a playbook is and how a flow's step refers to one, creating and
 * editing with the visibility the editor sets, the list with each playbook's history, and the
 * read-only view of someone else's playbook a flow links to.
 *
 * History lives in each card's actions, which show only on hover, so the list step names where it
 * is. The read-only view is open only when a link brought the reader here, so its step is optional.
 */

import type { GuideDefinition } from "../guides/types";

export const playbooksGuide: GuideDefinition = {
  id: "playbooks",
  kind: "screen",
  screen: "playbooks",
  routes: ["/playbooks"],
  steps: [
    { id: "intro", anchor: "playbooks.header", kind: "look", revision: 1 },
    {
      id: "linked",
      anchor: "playbooks.linked",
      kind: "look",
      revision: 1,
      optional: true,
      // The view is open only when a link names a playbook (`?name=…`).
      absentWhen: { queryMissing: "name" },
    },
    { id: "create", anchor: "playbooks.create", kind: "look", revision: 1 },
    { id: "list", anchor: "playbooks.list", kind: "look", revision: 1 },
  ],
};
