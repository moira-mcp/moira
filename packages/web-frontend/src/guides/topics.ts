/**
 * What each screen's tour must explain, as data: screen → topic → the step of that screen's tour
 * that covers it. A check holds every topic to a step whose anchor is written in the page, so a
 * tour cannot quietly lose a topic when its steps change.
 *
 * A topic whose control is hover-only or appears only with data — a note's history, a playbook's
 * visibility — is covered by a step on an element that is always there, whose copy says where the
 * control lives.
 */

export const REQUIRED_TOPICS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  home: {
    "agent-first": "intro",
    "connect-agent": "connect",
    "try-prompt": "try",
    recommended: "recommended",
    "work-area": "work",
    "show-me-around": "show-me-around",
  },
  flows: {
    "create-by-agent": "intro",
    recommended: "recommended",
    "all-flows": "all",
    scopes: "scopes",
    filters: "filters",
    "level-badge": "level",
    "simple-then-full-path": "intro",
  },
  runs: {
    "what-is-a-run": "intro",
    "status-filter": "status",
    "open-run": "list",
  },
  notes: {
    "what-is-a-note": "intro",
    "history-compare": "list",
    quota: "quota",
  },
  playbooks: {
    "what-is-a-playbook": "intro",
    "create-edit": "create",
    "history-restore": "list",
    visibility: "create",
    "linked-read-only": "linked",
  },
  artifacts: {
    "what-is-an-artifact": "intro",
    quota: "quota",
    create: "create",
    "edit-share": "list",
  },
};
