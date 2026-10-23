---
title: Claude Code Integration
description: Set up Moira with Claude Code for AI workflow execution
---

Claude Code is Anthropic's official CLI and VS Code extension for Claude. This guide covers integrating Moira with Claude Code.

## Prerequisites

- Claude Code installed and configured
- Moira server access (cloud or self-hosted)
- Valid Moira account credentials

## Configuration

Use the Claude Code entry in [MCP Clients](/docs/integration/mcp-clients/) for the server's generated setup and current transport/authentication configuration. Complete OAuth authentication, or use the documented API-token header when OAuth is unavailable. Do not copy credentials into project instructions.

## Verify Connection

Test the connection by asking Claude:

```
List available Moira workflows
```

You should see your workflows listed.

## Using Moira in Claude Code

### Starting a Workflow

```
Find the current software development workflow in Moira and start it for this task
```

Claude will:

1. Call `start` with `action: "prepare"` and the workflow ID
2. Call `start` with `action: "execute"` and the returned Start attempt ID
3. Receive the Process ID, Step attempt ID, and first directive
4. Execute the directive
5. Submit results via `step`
6. Continue until workflow completes

### Continuing a Session

If a session was interrupted, continue with:

```
Continue my Moira workflow with process ID abc-123
```

### Getting Help

```
Show Moira documentation for nodes
```

Claude will call `help` with the topic.

## CLAUDE.md Integration

For project-specific workflows, add to your `CLAUDE.md`:

```markdown
## Moira Workflows

This project uses Moira for development workflows.

### Available Workflows

- `dev-flow` - Main development workflow
- `review-flow` - Code review workflow

### Starting Development

To start a task, run the development workflow:

1. Prepare and execute a start for the `dev-flow` workflow
2. Follow each step directive
3. Submit results before moving to next step
```

:::tip
Keep project-wide workflow selection rules in CLAUDE.md. Store an active Process ID in the task's ignored workspace/handoff so transient run state does not become permanent project instructions.
:::

## Available Tools

The core workflow lifecycle uses these tools:

| Tool       | Description                                     |
| ---------- | ----------------------------------------------- |
| `list`     | List available workflows                        |
| `start`    | Prepare or execute a replay-safe workflow start |
| `step`     | Submit result, get next directive               |
| `help`     | Get documentation                               |
| `settings` | User settings management                        |
| `session`  | Session and execution info                      |

See the [MCP tools reference](/docs/reference/tools/) for the complete current catalog,
input schemas, actions, and examples.

## Troubleshooting

### Connection Issues

1. Verify MCP server URL is correct
2. Check network connectivity
3. Ensure authentication is valid
4. Check Claude Code logs for errors

### Workflow Not Starting

1. Verify workflow ID exists: `list`
2. Check workflow visibility permissions
3. Ensure you have access to the workflow

### Session Lost

If process ID is lost:

1. Check `session({ action: "executions" })` for active executions
2. Resume with the correct process ID
3. Retain the selected Process ID in the task's ignored workspace/handoff

## Best Practices

1. **Save Process IDs** - Retain in the task's ignored workspace/handoff
2. **Follow Directives** - Execute exactly what the directive says
3. **Meet Completion Conditions** - Verify before submitting
4. **Check Help** - Use `help` when unsure

## Related

- [Quick Start](/docs/getting-started/quickstart/) - General setup guide
- [MCP Clients](/docs/integration/mcp-clients/) - Other client integrations
