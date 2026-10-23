# Claude Code commands

These optional prompts use the tools exposed by the configured Moira MCP connection.
They compose the current [Agent Guide](../packages/mcp-server/src/help/content/integration/agent-guide.md)
and [execution contract](../docs/reference/execution.md); they do not define another workflow API.

| Command                           | Purpose                                                                     |
| --------------------------------- | --------------------------------------------------------------------------- |
| `/start-development`              | Discover and start the available Software Development Flow                  |
| `/resume-workflow [execution ID]` | Restore the original run without replacing it                               |
| `/finish-feature`                 | Start an available completion flow when that separate lifecycle is intended |

To install a prompt, run from this checkout's root and choose an unused destination:

```bash
mkdir -p ~/.claude/commands
ln -s "$PWD/commands/resume-workflow.md" ~/.claude/commands/resume-workflow.md
```

Use the corresponding filename for another command. Inspect an existing destination rather than
overwriting it. The MCP server name and host-specific tool prefixes come from the client setup.

Keep local process IDs and workflow material in the project's locally ignored
`agent_temp_files_local/moira-ws/` workspace. The run's presented paths and requirements determine
its internal layout; do not create a tracked plan or infer a workflow version from this directory.
Private completion flows appear only when their catalog and caller authorization make them available.
