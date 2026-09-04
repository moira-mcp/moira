3.  **Authenticate the MCP server**

    After adding the server configuration, complete OAuth authentication.
    Most clients will prompt you automatically or have an "Authenticate" button.

    :::tip[No OAuth support?]
    If your client cannot open a browser for OAuth, create an API token instead:
    1. Log in to Moira web UI → **Settings → API Tokens**
    2. Create a token and copy it (starts with `moira_`)
    3. Add it as `Authorization: Bearer moira_...` header in your client config

    See [MCP Clients → API Tokens](/docs/integration/mcp-clients/#api-tokens) for details.
    :::

4.  **Verify connection**

    Ask your AI client to list available Moira workflows:

    ```
    List available Moira workflows
    ```

    You should see a list of workflows you have access to.

5.  **Start the user onboarding**

    Now simply type in the chat:

    ```
    Start user onboarding flow
    ```

    The interactive onboarding:

    - demonstrates directives, completion conditions, input schemas, and verified step progression;
    - reads every page of your current authorized public workflow catalog instead of relying on a copied list;
    - explains the boundaries between supplied checklists, plan-first tasks, item-by-item task decomposition and recovery, quick and recoverable tasks, full development, bounded verification, filesystem-first iterative research, portable filesystem-or-memory adaptive research, corpus-scale research, supplied-data analysis, test planning, product requirements, content work, and workflow authoring;
    - records one exact qualified workflow identity such as `moira/test-planning`;
    - asks you to explicitly start or defer; defer makes no external change, while start creates the selected workflow as a child execution linked to onboarding.

    Use onboarding for a first Moira orientation. If you already know the workflow you need,
    start that workflow directly.

## Available MCP Tools

The core execution lifecycle uses these Moira tools:

| Tool      | Description                                              |
| --------- | -------------------------------------------------------- |
| `list`    | List authorized workflows with pagination                |
| `start`   | Start a standalone or parent-linked workflow execution   |
| `step`    | Submit a verified step result and get the next directive |
| `session` | Inspect and resume workflow executions                   |
| `help`    | Get Moira documentation and help                         |

Moira also exposes workflow management, settings, notes, artifacts, locks, reconciliation, and
large-file token operations. See the [MCP tools reference](/docs/reference/tools/) for the
complete current catalog, exact input schemas, supported actions, and examples.

## Example Session

Here's what a typical workflow session looks like:

```
Agent: I'll start the full development workflow.
       [calls start with workflowId: "moira/software-development-flow"
        and parentExecutionId: "none"]

Moira: Process ID: 123e4567-e89b-42d3-a456-426614174000
       Your next task: Analyze the requirements document...
       Success criteria: Requirements are documented...

Agent: [analyzes requirements, produces output]
       [calls step with the exact Process ID and schema-valid evidence]

Moira: Process ID: 123e4567-e89b-42d3-a456-426614174000
       Your next task: Create implementation plan...
       Success criteria: Plan covers all requirements...

[... workflow continues until completion]
```

## Next Steps

- [Workflows](/docs/concepts/workflows/) - Understand workflow structure
- [Claude Code Integration](/docs/integration/claude-code/) - Detailed Claude Code setup
- [MCP Clients](/docs/integration/mcp-clients/) - Other MCP client integrations
