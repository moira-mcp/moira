Inspect and resolve managed workflow reconciliation conflicts.

Use this tool when startup or MCP responses report that bundled workflows diverged from both their previous managed baseline and the incoming application version.

Actions:

- `status`: List unresolved conflicts. All authenticated users receive conflict summaries and candidate references; administrators also receive full candidate states.
- `get`: Load one conflict and its candidate states. Administrator only.
- `resolve`: Accept a revision-bound `current`, `incoming`, or `previous` candidate with rationale, or submit a semantically merged current graph with visibility. Administrator only.

Do not choose a candidate mechanically. Inspect the previous managed state, the current database state, and the incoming bundled state, preserve intentional user changes, and validate any merged graph before resolving.
