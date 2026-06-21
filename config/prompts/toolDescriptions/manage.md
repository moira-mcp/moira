Create, edit, or retrieve workflow definitions

Actions (18 total):

Basic operations:

- create: Create new workflow (requires 'workflow' object)
- edit: Modify existing workflow (requires 'workflowId' and 'changes')
- validate: Validate workflow JSON structure
- copy: Copy workflow as template (creates private copy with new ID)

Retrieval (use workflowId from list()):

- get: Full workflow with all nodes (for editing, detailed analysis)
- get-structure: Graph structure only - nodes list + connections (for visualization, flow overview)
- get-node: Single node by ID (when you know exact node)
- search-nodes: Find nodes by text in directive/completionCondition (when searching)
- list-nodes: Compact list of all nodes with types (for navigation)
- get-nodes: Multiple nodes by IDs array (batch retrieval)

Node manipulation:

- clone-node: Clone a node within workflow (creates copy with new ID)
- move-node: Reorder nodes in workflow

Variables:

- list-variables: List all variables in start node initialData
- get-variable: Get specific variable value
- set-variable: Set variable in start node initialData
- delete-variable: Delete variable from start node

Analysis:

- diff: Compare two workflows
- analyze-variables: Analyze variable usage across workflow
- set-visibility: Change workflow visibility (public/private)

Examples:

- manage({ action: "get", workflowId: "john/my-flow" }) - full workflow for editing
- manage({ action: "get-structure", workflowId: "john/my-flow" }) - just the graph
- manage({ action: "search-nodes", workflowId: "john/my-flow", query: "validate" })
- manage({ action: "copy", workflowId: "moira/test-planning", newName: "My Custom Flow" }) - copy public workflow

Related: Use list() to find workflow IDs
