List your workflow library

`list()` returns YOUR LIBRARY, not the whole public catalog:

- core — official bundled flows (quick-task, robust-task, …), available to everyone
- own — workflows you created
- added — marketplace flows you adopted (via `marketplace add`)
- shared — private flows shared with you by link

The marketplace's public flows are NOT here until you add them — browse the store with the `marketplace` tool (`marketplace search` / `info` / `add`). This keeps your working set small and intentional.

Usage:

- Call without parameters to list the whole library
- `source` filters by origin: core | own | added | shared (default: all)
- `search` filters by workflow name

Each result has an `id` ("handle/slug" when known, else the workflow id) you pass to `start()`, plus `origin` (core/own/added/shared).

Workflow lifecycle: list() → start(id) → step(processId) → repeat step() until completion

Examples:

- list() — your whole library
- list({ source: "added" }) — only flows you adopted from the marketplace
- list({ search: "test" }) — library flows whose name contains "test"

Next: pass a result's `id` to start() to begin execution
