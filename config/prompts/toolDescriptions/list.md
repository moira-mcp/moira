Discover workflows accessible to the current user

Usage:

- Results are paginated. A call without parameters returns the first page, not the complete catalog.
- Use `search` to filter by name or description and `visibility` to filter by access level.
- Use `sort` and `sortOrder` to choose the ordering of each result page.
- The response includes `offset`, `limit`, `returnedCount`, `hasMore`, and `nextOffset`.
- When `nextOffset` is not null, pass it as the next request's `offset`.

Workflow lifecycle: list() → start(workflowId) → step(processId) → repeat step() until completion

Examples:

- list() - first page of accessible workflows
- list({ search: "test" }) - first page of workflows containing "test"
- list({ visibility: "public", limit: 10, offset: 0 }) - first 10 public workflows
- list({ visibility: "public", limit: 10, offset: 10 }) - next page

Next: Use workflow ID from results with start() to begin execution
