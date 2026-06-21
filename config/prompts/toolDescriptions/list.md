List all available workflows

Usage:

- Call without parameters to list all accessible workflows
- Use 'search' to filter by name or description
- Use 'visibility' to filter by public/private
- Returns workflow ID, name, version, and description

Workflow lifecycle: list() → start(workflowId) → step(processId) → repeat step() until completion

Examples:

- list() - all workflows
- list({ search: "test" }) - workflows containing "test"
- list({ visibility: "public", limit: 10 }) - first 10 public workflows

Next: Use workflow ID from results with start() to begin execution
