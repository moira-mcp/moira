---
description: "Start an authorized, available feature-completion workflow"
---

# Finish feature

Check whether the current development workflow already owns the requested remaining work.
Continue that lifecycle when applicable; do not split implementation, tests, documentation or
review into another run merely because this command exists.

For an intended separate completion task, discover available workflows through the configured
Moira `list` tool and select the exact authorized completion identity. The completion catalog can
be private; this public command does not install it or grant access. If no matching flow exists,
report the available choices without substituting an unrelated workflow or inventing an owner.

Follow the [Agent Guide](../packages/mcp-server/src/help/content/integration/agent-guide.md):
`start` first prepares the selected workflow and explicit intended parent (or `"none"`), then
executes the exact returned `startAttemptId`. Collect the same attempt after a lost execute reply;
do not prepare a replacement. Preserve the process identity in the project's locally ignored
agent workspace and continue with each current Step attempt only after completing its real work.

Use current exposed tool names, not retired aliases. `$ARGUMENTS` provides the feature/task context.
The selected workflow and user's authorization determine Git, publication and deployment effects;
this prompt grants no additional effects or permission to bypass repository protection.
