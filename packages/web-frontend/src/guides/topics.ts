/**
 * What each tour must explain, as data: guide → topic → the step of that tour that covers it.
 * Every screen tour has a list, and so does the editor's task tour. A check holds every topic to a step whose anchor is written in the page, so a
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
  flow: {
    "agent-first": "intro",
    "header-facts": "facts",
    "level-badge": "level",
    views: "modes",
    "diagram-note": "diagram-note",
    "panel-tabs": "panel-tabs",
    "playbook-reference": "playbook",
    "use-as-template": "template",
    "sharing-visibility": "visibility",
    "edit-mode": "edit",
  },
  "flow-editor": {
    "create-step": "add-step",
    "insert-on-edge": "add-step",
    "delete-rename-step": "step-actions",
    "add-remove-block": "blocks",
    "reconnect-label": "connections",
    "add-choice": "choice",
    "undo-reset": "bar",
    "inline-validation": "validation",
    "stale-revision": "stale",
  },
  run: {
    "what-is-a-process": "process",
    views: "modes",
    "route-cursor": "route",
    "panel-tabs": "panel-tabs",
    "answer-waiting-step": "answer",
    "notification-link": "notifications",
  },
  overview: {
    "runs-in-progress": "intro",
    "waiting-for-you-first": "status",
    "answer-in-chat": "status",
    "find-stalled": "idle",
    "filters-in-url": "idle",
    "last-step-meaning": "board",
    "open-details": "board",
    "live-updates": "live",
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
  settings: {
    sections: "nav",
    account: "account",
    security: "security",
    "notifications-purpose": "notifications",
    github: "github",
    apps: "apps",
    tokens: "tokens",
    preferences: "preferences",
  },
  artifacts: {
    "what-is-an-artifact": "intro",
    quota: "quota",
    create: "create",
    "edit-share": "list",
  },
};
