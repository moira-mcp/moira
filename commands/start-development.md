---
description: "Start the available Software Development Flow in Moira"
---

# Start development

Use the configured Moira MCP connection and its current tool names. Read the repository's
contribution and issue-coordination contract. Check the current branch and working tree without
discarding unrelated work. Continue a matching active development execution rather than starting
a second lifecycle for the same implementation.

Discover the current executable `software-development-flow` through `list`; select the exact
authorized workflow identity returned by discovery. Do not hardcode a version or substitute a
different owner's flow. If it is unavailable, report that fact rather than creating or publishing it.

Use `start` with `action: "prepare"`, the selected `workflowId` and an explicit intended
`parentExecutionId` (or `"none"` for a new top-level task). Pass task context only through fields
supported by the current tool contract. Then call `start` with `action: "execute"` and the exact
returned `startAttemptId`. If execute loses its response, collect/retry that same start attempt;
preparing again requests a separate execution.

Preserve the returned process identity in the project's locally ignored agent workspace. Execute
the presented directive and its completion condition, then submit its actual schema with that
presentation's `attemptId`. Follow the existing [Agent Guide](../packages/mcp-server/src/help/content/integration/agent-guide.md)
for continuation and uncertainty. Do not simulate evidence or add commit, publication or deployment
effects beyond the selected workflow and the user's authorization. `$ARGUMENTS` supplies task context.
