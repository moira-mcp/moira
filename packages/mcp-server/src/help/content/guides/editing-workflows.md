---
title: Editing Workflows
description: How to modify existing workflows safely
---

## Editing Methods

### Via MCP Tools

Use the `workflow` tool with edit action:

```typescript
mcp__moira__workflow({
  action: "edit",
  workflowId: "my-workflow",
  changes: {
    // changes go here
  },
});
```

### Via workflow-management-flow

Start the management workflow:

```typescript
mcp__moira__execution({
  action: "prepare",
  workflowId: "moira/workflow-management-flow",
  parentExecutionId: "none",
});
mcp__moira__execution({ action: "execute", startAttemptId: "<Start attempt ID from prepare>" });
```

Select "edit" when prompted for action.

:::tip
Use workflow-management-flow for complex edits. It reviews the design before mutation, validates
the resulting graph, and independently reviews the completed workflow.
:::

### Via the Workflow CLI

Repository authors can use the official `moira-workflow` CLI for file-backed edits. First confirm
which checkout supplies a globally linked command, especially when several Moira worktrees exist:

```bash
moira-workflow --version
```

The output includes both the package version and exact source path. Long descriptions and complete
variable schemas can be read from files, avoiding fragile shell quoting:

```bash
moira-workflow ./workflow.json set-description --file ./description.txt
moira-workflow ./workflow.json set-system-reminder --file ./reminder.txt
moira-workflow ./workflow.json set-tags research,verification
moira-workflow ./workflow.json set-variable-schema result --file ./result-schema.json
```

`set-tags` replaces the whole tag list. A workflow authored by the Workflow Management Flow carries
exactly one level tag, `complexity:simple`, `complexity:standard` or `complexity:complex`; keep it in
the list you pass, or the next edit treats the workflow as having an unknown history.

Routing is edited through the same `update` command. `--cases` replaces the ordered cases of a
`condition` or `agent-directive` node, `--expressions` replaces the expressions it evaluates before
them (an empty array `[]` removes them), and connections are edited by key:

```bash
moira-workflow ./workflow.json update review \
  --cases '[{"when":{"operator":"eq","left":{"contextPath":"review.verdict"},"right":"blocked"},"output":"blocked"}]'
moira-workflow ./workflow.json update review --expressions '["attempts = attempts + 1"]'
moira-workflow ./workflow.json update review --add-connection blocked fix-issues
```

All three target the directive node that produced the verdict: its cases, the counter it keeps, and
the connection a case names. Here `verdict` is a field in `review`'s declared response schema;
`attempts` must already be a declared numeric global with an initial value in `variableRegistry`.
Node-local answers use `node-id.field`; bare template and condition names require declared globals.

The read-only commands show the result: `schema` prints one `CASE <output> WHEN <condition>` line
per case plus an `EDGE` line per connection, `structure --detailed` lists each case as
`Case: <output> when …`, and `diff` names `cases` among a node's changed fields — so a routing
change is reviewable without reading the raw JSON.

Structure is changed with `rename` and `delete`. `rename` gives a node a new kebab-case id and
rewrites every reference to it — connection targets, `{{node.name}}` templates, routing case and human-gate condition paths,
expressions, list bindings, subgraph mappings and write allowances — and prints each location it
changed. Prose that mentions the id outside a reference stays as it is. `delete` refuses while
another node still leads to the node being removed and names each such edge; decide every one with
`--retarget <source.key>=<target>`, or with `--drop <source.key>` for an output that is not the
source node's main one:

```bash
moira-workflow ./workflow.json rename review independent-review
moira-workflow ./workflow.json delete legacy-check --retarget review.success=deliver
```

To bring a file up to the current definition schema, run `migrate`. When a migration is needed,
it backs up the existing file before rewriting it. Otherwise it reports «Already at schema
version 1; nothing to migrate» without rewriting:

```bash
moira-workflow ./workflow.json migrate
```

Existing-file mutations keep a unique pre-write copy under `workflow-backups/` in the caller's
working directory. This is not a backup of every output: `create` and `copy` create new workflow
files, while `export-node` writes its selected output without automatically backing that output up.

The process view uses the same file-backed authoring surface. Set the complete block list from
JSON with `set-progress` (or grow it with `add-block` / `edit-block`), then give every node its
block with `set-block` — routing nodes included, since the derivation refuses an unowned node. Progress attachment is available on
`user-notification` and deprecated `telegram-notification` nodes; `none` and `false` clear the
corresponding optional fields.

```bash
moira-workflow ./workflow.json set-progress --file ./progress.json
moira-workflow ./workflow.json update implement --progress-node-id implementation
moira-workflow ./workflow.json update implement --progress-active-label "Implement {{unit}}/{{total}}"
moira-workflow ./workflow.json update notify --progress-node-id review --attach-progress-image true
moira-workflow ./workflow.json update approve --human-gate '{"label":"Approve the plan","notify":"off","remindAfter":"1d"}'
```

`--human-gate` marks an `agent-directive` as a step that waits for a person's decision (see
`humanGate` in the node reference) and `--human-gate none` removes the mark; `schema`, `structure` and
`diff` show it.

The block contract has its own commands: own a node by a block, add or edit a block with its
description, bind a block to the list its steps work through, label a connection that leaves a
block, and explain a return with the cause of the loop and the condition that ends it. Each write
reports how many block-contract diagnostics
remain, so a flow is annotated iteratively until `derive` shows none; `--no-version-bump` keeps
the version while iterating. `--list`, accepted by `add-block` and `edit-block`, takes the binding
as JSON (`items`, `title`, `current`, `done`, `total`, `indexBase`) and `--list none` removes it;
an unknown field, an empty path, an `indexBase` other than `0` or `1` and a binding naming none of
`items`, `current` or `total` are refused on write.

```bash
moira-workflow ./workflow.json set-block present-plan plan
moira-workflow ./workflow.json add-block deliver "Deliver" "Hand the result over" --after execute
moira-workflow ./workflow.json edit-block deliver --summary "Present the result"
moira-workflow ./workflow.json edit-block work \
  --list '{"items":"tasks","title":"action","current":"current_task","total":"total_tasks"}'
moira-workflow ./workflow.json set-label present-plan approved "plan approved"
moira-workflow ./workflow.json set-label review success "review found defects" \
  --cause "The independent review reported blocking findings." --exit "The review passes."
moira-workflow ./workflow.json derive
```

These commands persist schema fields; they do not derive the process or judge its meaning, and
they do not replace the final `validate`, `derive`, `schema`, behavioral scenarios, or independent
semantic review.

For a complete planned rewrite, `sync` preserves the destination identity and its catalog migration
aliases in `previousSlugs`. The catalog reader validates those aliases separately; only the
executable graph is passed to the engine validator. Aliases always come from the real destination,
not from a workspace copy. A metadata or graph validation failure leaves the destination unchanged.
The standalone `validate` command exits unsuccessfully for either class of error, so an agent or CI
script can use it as a real gate without weakening runtime/upload graph validation.

```bash
moira-workflow ./workspace/workflow.json sync ./workflows/production/flows/<flow>.json
moira-workflow ./workflows/production/flows/<flow>.json validate
```

Before reviewing or changing a large graph, print its complete deterministic control-flow schema:

```bash
moira-workflow ./workflows/production/flows/<flow>.json schema
```

The schema names every real node and labelled connection, conditions, cycles, declared outputs and
mappings, context references, normal start paths, explicit teleport-only regions, and disconnected
components. When the workflow defines a process view, the same projection includes every
ordered block, any legacy display edge still stored on it, and every node-to-block mapping. It is a read-only structural
projection for agent or human reasoning; it does not run the workflow, interpret workflow-specific
meaning, or claim that a structurally visible route is semantically correct.

### How workflow-management-flow handles edits

For an edit, the management workflow loads the complete current workflow and records the edit
requirements, analysis, plan, and review reports in its workspace. Their contents stay in files;
the graph carries only small values that affect routing.

The initial choice also records whether server access is allowed. An explicit local-only or
offline instruction is reused without asking again and prevents the edit path from downloading or
comparing a server definition.

The same first step records the operating mode. In `interactive` mode every approval stays as it
is: design, plan, and result are confirmed by you. In `autonomous` mode the workflow routes around
those three approvals and delivers a single final report at the end instead. The agent reuses a
mode you already stated, infers an unambiguous one — including a run started as a child of an
already autonomous process — and asks once only when the mode is neither stated nor derivable.

Autonomy removes waiting for a person, not authority. Uploading still requires an explicit
decision, and in autonomous mode an upload without prior authorization resolves to "no" instead of
escalating to a non-standard method. Writing the edited definition back to its already resolved
local target is the requested work of the run, so it needs no separate approval in either mode.

Before planning, the workflow decides whether to audit the whole source workflow against the known
anti-pattern catalog. In interactive mode it asks, reports concrete existing findings, and asks
which of them should join the edit scope. In autonomous mode the agent makes both choices itself
from the requested change and the available evidence, and leaves the findings it did not take in
the audit report. When the audit is skipped, the analysis remains limited to the requested change
and its necessary dependencies.

The plan describes outcomes, affected contracts, invariants, acceptance criteria, evidence methods,
and risks. Before it requires a validation or proof mechanism, it must identify the required state,
a plausible wrong state, and an observation that reliably distinguishes them. An unprovable derived
criterion is revised instead of being replaced with a surrogate signal. The plan does not prescribe
an exhaustive file list, exact commands, pseudocode, or a fixed sequence of local edits unless an
external contract requires them.

Create and edit use the same independent pre-mutation design review. Reviews record detailed
findings in a stable workspace file and return only `pass`, `repair`, or `replan` for routing.
`repair` is reserved for a confirmed defect owned by the reviewed artifact; an invalid criterion,
evidence model, requirement interpretation, plan, or process returns to its earliest contract owner.
After a real repair, the reviewer receives the bounded root class and changed knowledge. A repeated
same-root finding without stronger evidence and validation-only work both trigger reassessment rather
than another validation layer. Structural validation remains the responsibility of the node that
creates or changes the workflow and uses Moira's official validator.

## Change Types

### Update Metadata

```typescript
mcp__moira__workflow({
  action: "edit",
  workflowId: "my-workflow",
  changes: {
    metadata: {
      version: "2.0.0",
      description: "Updated description",
    },
  },
});
```

### Update Node Content

```typescript
mcp__moira__workflow({
  action: "edit",
  workflowId: "my-workflow",
  changes: {
    updateNodes: [
      {
        nodeId: "task-node",
        changes: {
          directive: "New directive text",
          completionCondition: "New condition",
        },
      },
    ],
  },
});
```

### Add Nodes

```typescript
mcp__moira__workflow({
  action: "edit",
  workflowId: "my-workflow",
  changes: {
    addNodes: [
      {
        type: "agent-directive",
        id: "new-node",
        directive: "New task",
        completionCondition: "Task complete",
        connections: { success: "existing-node" },
      },
    ],
  },
});
```

### Remove Nodes

```typescript
mcp__moira__workflow({
  action: "edit",
  workflowId: "my-workflow",
  changes: {
    removeNodes: ["node-to-remove"],
  },
});
```

:::caution
When removing nodes, update connections in other nodes that referenced the removed node. The
CLI's `delete` does this with you: it refuses until every incoming edge is retargeted or dropped.
:::

## Safe Editing Process

1. **Load the complete baseline**

   ```typescript
   mcp__moira__workflow({
     action: "get",
     workflowId: "my-workflow",
     includeNodes: true,
     includeValidation: true,
   });
   ```

   Keep the returned revision and read all node definitions, connections, variable declarations,
   runtime policy and progress bindings before choosing the affected dependency set. Omit node
   pagination here; if you deliberately paginate, collect every page. `get-structure` is a summary,
   not an editing baseline. Inspect referenced subgraphs or playbooks when the change depends on
   them, within the authorized scope.

2. **Find nodes to edit**

   ```typescript
   mcp__moira__workflow({
     action: "search-nodes",
     workflowId: "my-workflow",
     query: "search term",
   });
   ```

3. **Get node details**

   ```typescript
   mcp__moira__workflow({
     action: "get-node",
     workflowId: "my-workflow",
     nodeId: "node-id",
   });
   ```

4. **Apply changes**

   Pass the baseline's returned revision as `expectedRevision`. On conflict, reload the current
   definition and reconcile the intended change; do not overwrite a newer graph blindly.

   ```typescript
   mcp__moira__workflow({
     action: "edit",
     workflowId: "my-workflow",
     expectedRevision: baselineRevision,
     changes: {/* ... */},
   });
   ```

5. **Check the saved definition**

   ```typescript
   mcp__moira__workflow({
     action: "get",
     workflowId: "my-workflow",
     includeNodes: true,
     includeValidation: true,
   });
   ```

   Read the returned `validation` alongside the complete saved definition. To validate an authored
   definition before saving, call `workflow({ action: "validate", workflow: completeWorkflow })`.
   Here `completeWorkflow` is the complete authored workflow JSON, not a workflow ID, structure
   summary or the response envelope from `get`. Preserve its graph and extension fields.

## Editing Without Extra Machinery

Make the change with the official MCP actions or the workflow CLI, and validate the real artifact
before you finish. A one-off generator, a migration script, or an intermediate format written to make
one edit becomes an undeclared dependency: the workflow then only round-trips correctly where that
tool exists, and nothing in the definition says so. The workflow JSON is the artifact of record.

## Reconciling Repository and Server Copies

A bundled workflow exists twice: as a file in the repository and as a catalog entry on the instance
that serves it. Before editing, resolve which identities refer to the same workflow — the public
`owner/slug`, the internal UUID, and any local path — and compare the two definitions rather than
assuming they match.

```bash
# Fetch the served definition through a one-time download token
mcp__moira__workflow({ action: "download", workflowId: "moira/quick-task" })
```

When the two differ, decide the baseline deliberately: which definition the requested change actually
targets, which is newer by `metadata.version`, and what each one would lose. Combining the two JSON
documents mechanically produces a graph neither side reviewed.

Changing a bundled workflow's slug changes its catalog identity. To rename it without leaving the old
entry active after an upgrade, add the old slug to the catalog-only `previousSlugs` array. The loader
migrates that entry under the same owner and preserves its database ID; it fails if more than one
declared previous identity exists, rather than guessing or creating a duplicate. Do not use
`previousSlugs` to merge unrelated workflows.

## Updating Connections

### Single Connection Update

```typescript
{
  updateNodes: [
    {
      nodeId: "source-node",
      changes: {
        connections: {
          success: "new-target-node",
        },
      },
    },
  ];
}
```

### Routing

Both routing node types — `condition` and `agent-directive` — decide through ordered `cases`, and
both accept `expressions` that run before them. A node's outcomes are its `cases` and the
`connections` keys they name, so change the two together and every case still names an existing key:

```typescript
{
  updateNodes: [
    {
      nodeId: "condition-node",
      changes: {
        cases: [
          {
            when: { operator: "eq", left: { contextPath: "inspection.status" }, right: "success" },
            output: "passed",
          },
        ],
        connections: {
          passed: "success-node",
          default: "retry-node",
        },
      },
    },
  ];
}
```

Here `inspection.status` is a field produced by an existing inspection node. On an agent-directive
node the same three fields are edited the same way. Its default output is
`success` rather than `default`, its cases read the context after the node's own validated answer
has been merged, and `error`/`timeout` stay reserved for control flow — no case may name them:

```typescript
{
  updateNodes: [
    {
      nodeId: "review",
      changes: {
        expressions: ["review_round = review_round + 1"],
        cases: [
          {
            when: { operator: "eq", left: { contextPath: "review.verdict" }, right: "blocked" },
            output: "blocked",
          },
        ],
        connections: {
          success: "merge",
          blocked: "fix-issues",
        },
      },
    },
  ];
}
```

The review node must declare `verdict` in its response schema, and `review_round` must be a declared,
initialized numeric global before this expression increments it.

**Decide on the node that has the evidence.** When a step's own answer decides where the run goes,
move the cases onto that step and let `success` carry the remaining outcome; a single-purpose
counter or derived total becomes an `expressions` entry on the node that already runs there. Every
extra node is a hop the reader must follow and another place the decision and the evidence can drift
apart. Keep a separate `condition` or `expression` node when it reads better alone — several
producers share the decision, it reads state no single node produced, a named decision point helps
the reader of the process view, or the computation deserves its own place in the route. A node whose
only job is to route or count what the preceding node already knows is avoidable routing
scaffolding; folding it is an edit that removes the node and moves its `cases` and `connections`
onto its predecessor.

The same fields are edited file-side with `update --cases` and `update --expressions`, described
under «Via the Workflow CLI» above.

## Version Control

### Definition versions and saved history

Three values describe different things:

- `metadata.version` is the author's semantic version, such as `1.1.0`.
- `revision` from `workflow` (`get`) is the current write token. Pass it as `expectedRevision` when
  applying a guarded edit or rollback; it is not a historical snapshot number.
- `revision` in `workflow` (`history`) identifies an immutable snapshot of the complete saved definition.
  Separate saves retain separate snapshots even when their semantic versions are equal.

History compresses complete definitions and reuses identical content within a workflow. Each save
still retains its own history number, author and time; storage reuse does not discard revisions.
Reading or restoring a snapshot does not require replaying earlier changes, and JSON is returned
in a readable format.

Reading, comparing or restoring history requires editing authority: ownership or an explicit
`edit` grant, directly or through a group. Public visibility or a `use` grant alone does not expose
past private definitions. History records definition
writes, including catalog synchronization and stored-schema upgrades. When a definition has no
recorded history, its actual current content becomes the baseline before its next content write;
earlier unrecorded saves cannot be recovered. CLI file backups are separate from server history.

List the available snapshots, then read a selected snapshot or compare two returned numbers:

```typescript
mcp__moira__workflow({ action: "history", workflowId: "my-workflow" });
mcp__moira__workflow({ action: "get-revision", workflowId: "my-workflow", revision: 1 });
mcp__moira__workflow({
  action: "compare-revisions",
  workflowId: "my-workflow",
  fromRevision: 1,
  toRevision: 2,
});
```

Replace `1` and `2` with snapshot numbers returned by history. An absent snapshot is an error,
not an empty comparison. The snapshot contains the full graph, including registry, runtime policy
and process presentation, rather than only the fields visible in the browser editor.

Before restoring, read the current definition with `workflow` (`get`) and retain its write token.
After inspecting the selected content, pass that token to rollback:

```typescript
mcp__moira__workflow({
  action: "rollback",
  workflowId: "my-workflow",
  revision: 1,
  expectedRevision: currentWriteRevision,
});
```

Here `currentWriteRevision` is the `revision` from that current read, and `1` is the chosen history
number. Rollback validates and migrates the selected definition, preserves the existing workflow's
ID, owner and current sharing, and appends a new snapshot. The result returns the new write
`revision`, new `historyRevision` and `restoredFrom`. A stale token produces
`WORKFLOW_REVISION_CONFLICT` without changing the graph or history: reload and reassess the intended
restoration before retrying. Soft deletion retains history; permanent deletion removes it.
Content rollback is separate from an administrator restoring a deleted workflow.

Restoration changes the saved definition, not the state of an existing run. Runs read the current
definition; compatible paused steps can continue normally, while changed step semantics require
inspection with `execution` (`diagnose`) and an authorized `execution` (`recover`) decision. Do not replay an
old attempt, skip unfinished work or repeat an uncertain effect. See
[stale presentation diagnosis and recovery](/docs/integration/troubleshooting/#current_presentation_stale).
For browser inspection and guarded restoration, see the
[flow page](/docs/guides/flow-page/#version-history).

### Increment Version

Use semantic version changes to communicate the meaning of an authored change:

```typescript
{
  metadata: {
    version: "1.1.0"; // was 1.0.0
  }
}
```

Version semantics:

- **Major** (2.0.0): Breaking changes, restructured flow
- **Minor** (1.1.0): New features, new nodes
- **Patch** (1.0.1): Bug fixes, text corrections

### Compare Versions

To compare two different workflow definitions, rather than snapshots of one workflow, use `diff`:

```typescript
mcp__moira__workflow({
  action: "diff",
  workflowId: "my-workflow",
  compareWorkflowId: "my-workflow-old",
});
```

## Common Edits

### Fix Typo in Directive

```typescript
{
  updateNodes: [
    {
      nodeId: "task-node",
      changes: {
        directive: "Corrected directive text",
      },
    },
  ];
}
```

### Add Required Field to InputSchema

```typescript
{
  updateNodes: [
    {
      nodeId: "input-node",
      changes: {
        inputSchema: {
          type: "object",
          properties: {
            existing_field: { type: "string" },
            new_field: { type: "string" }, // added
          },
          required: ["existing_field", "new_field"], // updated
        },
      },
    },
  ];
}
```

### Insert Node in Flow

```typescript
{
  addNodes: [
    {
      type: "agent-directive",
      id: "inserted-node",
      directive: "New step",
      completionCondition: "The new step's stated result is verified",
      connections: { success: "original-target" }
    }
  ],
  updateNodes: [
    {
      nodeId: "original-source",
      changes: {
        connections: { success: "inserted-node" }
      }
    }
  ]
}
```

## Validation Errors

### Missing Connection Target

```
Error: Node 'task-1' connection target 'missing-node' not found
```

Fix: Update connection to valid node ID.

### Orphaned Node

```
Warning: Node 'orphan-node' is not reachable from start
```

Fix: Add connection from another node or remove orphaned node.

### Invalid Node Type

```
Error: Unknown node type 'custom-type'
```

Fix: Choose a built-in type from the [Nodes reference](/docs/concepts/nodes/). For a namespaced
extension type, make sure its extension is installed. A validator without authoritative live
registry data reports the type as unresolved; a live registry that does not contain it reports an
error.

## See Also

- [Creating Workflows](/docs/guides/workflow-creation/) - Building new workflows
- [MCP Tools](/docs/reference/tools/) - Tool reference
