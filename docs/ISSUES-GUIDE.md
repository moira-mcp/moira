# Issues Guide

## Labels

### Priority

| Label           | Description  | When to use                   |
| --------------- | ------------ | ----------------------------- |
| `priority:high` | Urgent       | Blocks work, critical bug     |
| `priority:low`  | Nice to have | Can be deferred, improvements |
| _(no label)_    | Normal       | Standard tasks                |

### Type

| Label          | Description   | When to use                        |
| -------------- | ------------- | ---------------------------------- |
| `type:bug`     | Bug           | Something doesn't work as expected |
| `type:feature` | Feature       | New functionality                  |
| `type:docs`    | Documentation | README, guides, API docs           |
| `type:chore`   | Maintenance   | CI/CD, refactoring, dependencies   |

### Component

Use `component:*` labels to indicate the affected module:

- `component:backend` — Server logic, API, engine
- `component:frontend` — Web UI, dashboard
- `component:mcp` — MCP server integration
- `component:workflows` — Workflow system, templates
- `component:docs` — Documentation
- `component:landing` — Landing page
- `component:infrastructure` — Server setup, deployment
- `component:testing` — Testing infrastructure

## Creating an Issue

1. Pick a `type:` label (required)
2. Add a `component:` label if the module is known
3. Add a `priority:` label only if it's urgent (`priority:high`) or unimportant (`priority:low`)

## Project Board

Kanban board: [Development](<your GitHub project board>)

- **Todo** — planned for the near term
- **In Progress** — being worked on
- **Done** — completed
