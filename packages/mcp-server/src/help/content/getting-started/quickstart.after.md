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

5.  **Run your first flow**

    Ask your agent, in plain words, to run the first learning example on any small task:

    ```
    Use Moira to run Example 1: Simple Steps for this task: rename the file notes.txt to todo.txt
    ```

    The agent starts `moira/example-simple-steps` and goes through its four steps — understand the
    task, do it, check the result, report — one at a time; Moira hands it each step and checks its
    answer before the next. Open **Workflows** in the web app and choose the example to see the
    same steps as a simple diagram.

    From here on you do not have to name flows at all. Describe what you need, and your agent picks
    a ready flow or builds one for the task. The [tutorial](/docs/getting-started/tutorial/) walks
    through all three learning examples; [Which ready flow to use](/docs/getting-started/ready-flows/)
    explains the everyday ones.

    :::tip[Want a guided tour of the catalog?]
    Say `Start user onboarding flow`. The interactive onboarding reads your current authorized
    public catalog, explains how the flows differ, records one exact workflow such as
    `moira/test-planning`, and starts it only if you choose to; deferring changes nothing.
    :::

## Available MCP Tools

The core execution lifecycle uses these Moira tools:

| Tool      | Description                                              |
| --------- | -------------------------------------------------------- |
| `list`    | List authorized workflows with pagination                |
| `start`   | Prepare or execute a standalone or parent-linked start   |
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
       Step attempt ID: 11111111-1111-4111-8111-111111111111
       Your next task: Analyze the requirements document...
       Success criteria: Requirements are documented...

Agent: [analyzes requirements, produces output]
       [calls step with the exact Process ID, current Step attempt ID,
        and schema-valid evidence]

Moira: Process ID: 123e4567-e89b-42d3-a456-426614174000
       Step attempt ID: 22222222-2222-4222-8222-222222222222
       Your next task: Create implementation plan...
       Success criteria: Plan covers all requirements...

[... workflow continues until completion]
```

## Next Steps

- [Tutorial: your first flows](/docs/getting-started/tutorial/) - Three tiny learning flows
- [Which ready flow to use](/docs/getting-started/ready-flows/) - Everyday tasks without building a flow
- [Workflows](/docs/concepts/workflows/) - Understand workflow structure
- [Claude Code Integration](/docs/integration/claude-code/) - Detailed Claude Code setup
- [MCP Clients](/docs/integration/mcp-clients/) - Other MCP client integrations
