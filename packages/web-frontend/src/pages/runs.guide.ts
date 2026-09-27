/**
 * The runs list's tour: what a run is, how to narrow the list by status, and that a run opens to
 * show its progress. The list area is there even before the first run, so no step is optional.
 */

import type { GuideDefinition } from "../guides/types";

export const runsGuide: GuideDefinition = {
  id: "runs",
  kind: "screen",
  screen: "runs",
  routes: ["/executions"],
  steps: [
    { id: "intro", anchor: "runs.header", kind: "look", revision: 1 },
    { id: "status", anchor: "runs.status", kind: "look", revision: 1 },
    { id: "list", anchor: "runs.list", kind: "look", revision: 1 },
  ],
};
