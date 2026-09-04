Create, inspect, validate, compare, modify, and share workflow definitions

The input schema's `action` enum is the authoritative operation list. It covers:

- creating, editing, validating, copying, comparing, and changing visibility;
- retrieving a complete definition, its structure, selected nodes, or search results;
- cloning and reordering nodes;
- reading and changing declared `variableRegistry` entries and analyzing their usage;
- creating and revoking invitations, listing invitations and access, and revoking access.

Use `workflowId` from list() for operations on an existing workflow. The schema describes the
additional fields required by each action. Mutations validate the resulting definition before save.

Retrieval guidance:

- Use `get` for the complete authored definition and optional validation.
- Use `list-nodes` for compact discovery, `get-nodes` for a known batch, and `get-node` for one node.
- Use `search-nodes` to locate directive, completion-condition, or optional variable matches.
- Use `get-structure` for metadata and graph shape without full directive content.

Examples:

- manage({ action: "get", workflowId: "john/my-flow" }) - full workflow for editing
- manage({ action: "get-structure", workflowId: "john/my-flow" }) - just the graph
- manage({ action: "search-nodes", workflowId: "john/my-flow", query: "validate" })
- manage({ action: "copy", workflowId: "moira/test-planning", newName: "My Custom Flow" }) - copy public workflow
- manage({ action: "list-invites", workflowId: "john/my-flow" }) - inspect sharing invitations

Related: Use list() to find workflow IDs
