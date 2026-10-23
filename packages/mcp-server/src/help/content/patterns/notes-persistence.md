---
title: Notes Persistence Pattern
description: Store and retrieve data across workflow steps and executions
---

## Purpose

Persist a canonical value that needs an address beyond one execution. Notes provide key-value storage with versioning and tagging. The engine already persists execution variables; ordinary interruption does not require copying them into notes.

## When to Use

| Use Case                    | Example                                                  |
| --------------------------- | -------------------------------------------------------- |
| **Session recovery**        | Store intermediate results for resume after interruption |
| **Cross-step data sharing** | Pass complex data between agent-directive nodes          |
| **User preferences**        | Remember choices, settings, configuration                |
| **Analysis results**        | Store research findings, comparisons, recommendations    |
| **Execution history**       | Track decisions made during workflow execution           |

:::caution
Don't use notes for temporary calculations (use context variables), data only needed in the next
step (use inputSchema), data that exceeds the active note policy, or binary data. Use an owned workspace for general files; artifacts publish HTML.
:::

## Structure

```
[collect-data] → [write-note] → [other-steps] → [read-note] → [use-data]
```

## Implementation

### Write Note Node

Store output from an agent-directive node:

```json
{
  "id": "save-analysis",
  "type": "write-note",
  "key": "purchase-{{executionId}}-01-analysis",
  "source": "{{analyze-step.analysis}}",
  "tags": ["purchase-{{executionId}}", "analysis"],
  "connections": {
    "default": "next-step",
    "error": "handle-error"
  }
}
```

**Key pattern:** `{domain}-{{executionId}}-{sequence}-{description}`

| Part          | Purpose             | Example                  |
| ------------- | ------------------- | ------------------------ |
| `domain`      | Workflow area       | `purchase`, `research`   |
| `scope`       | Execution isolation | `{{executionId}}`        |
| `sequence`    | Ordering            | `01`, `02`, `03`         |
| `description` | Content hint        | `user-needs`, `analysis` |

### Batch Write Mode

Write multiple notes from an array:

```json
{
  "id": "save-batch",
  "type": "write-note",
  "source": "collect-items.items",
  "batchMode": true,
  "connections": { "default": "next" }
}
```

Batch `source` is a context path, without template braces. Here `collect-items` returns `items`. Other node examples assume the named producers and connection targets exist in the containing workflow. Source array format:

```json
[
  { "key": "item-001", "value": "content 1", "tags": ["batch"] },
  { "key": "item-002", "value": "content 2", "tags": ["batch"] }
]
```

### Read Note Node

Load notes into node-local data, referenced later as `load-data.previousData`:

```json
{
  "id": "load-data",
  "type": "read-note",
  "outputVariable": "previousData",
  "filter": {
    "keyPattern": "purchase-{{executionId}}"
  },
  "connections": { "default": "use-data" }
}
```

**Single mode** returns an object only when exactly one note is in the returned page; zero or multiple results remain arrays. The handler reads one bounded list page, so it does not enforce uniqueness across all notes. Read this example through `load-preferences.userPrefs`:

```json
{
  "id": "load-preferences",
  "type": "read-note",
  "outputVariable": "userPrefs",
  "filter": { "tag": "preferences" },
  "singleMode": true,
  "connections": { "default": "apply-prefs" }
}
```

### Upsert Note Node

Update the first returned search match, or create a new note if none was returned. Use a sufficiently narrow search; this is not a uniqueness check:

```json
{
  "id": "update-preferences",
  "type": "upsert-note",
  "search": {
    "tag": "user-prefs",
    "keyPattern": "prefs-{{userId}}"
  },
  "keyTemplate": "prefs-{{userId}}-new",
  "value": "{{collect-preferences.preferences}}",
  "tags": ["user-prefs"],
  "outputVariable": "saveResult",
  "connections": { "default": "confirm" }
}
```

## Template Injection

Access notes directly in directives:

```json
{
  "id": "research-step",
  "type": "agent-directive",
  "directive": "Research based on user needs.\n\n**User needs:**\n{{note:purchase-{{executionId}}-01-user-needs}}\n\nDetermine main categories.",
  "completionCondition": "Research completed",
  "connections": { "success": "next-step" }
}
```

**Syntax:** `{{note:key-name}}`

The note content is injected into the directive before the agent receives it.

## MCP Tool Usage

Within agent-directive nodes, use the `notes` MCP tool:

```typescript
// Save a note
notes({
  action: "save",
  key: "user-preferences",
  value: JSON.stringify({ theme: "dark", lang: "en" }),
  tags: ["preferences"],
});

// Get a note
notes({
  action: "get",
  key: "user-preferences",
});

// List notes by tag
notes({
  action: "list",
  tag: "preferences",
});

// Check quota
notes({
  action: "stats",
});
```

## Canonical durable value

Choose one canonical detailed value. A filesystem package and a note containing the same report create competing sources. A write-note is appropriate when the note itself is the durable value:

```json
{
  "id": "write-note-01",
  "type": "write-note",
  "key": "purchase-{{executionId}}-01-user-needs",
  "source": "{{analyze-user-needs.needs}}",
  "tags": ["analysis-{{executionId}}", "research"],
  "connections": { "default": "research-product-category" }
}
```

## Best Practices

### Tag Strategy

- Use execution-specific tag: `purchase-{{executionId}}`
- Use category tag: `research`, `research-flow`
- Enables efficient filtering and cleanup

### Error Handling

```json
{
  "id": "write-critical",
  "type": "write-note",
  "key": "critical-data-{{executionId}}",
  "source": "{{produce-results.result}}",
  "connections": {
    "default": "continue",
    "error": "handle-write-error"
  }
}
```

### Data Serialization

- Objects and arrays auto-serialize to JSON
- Primitive values stored as strings
- For large objects, use an owned workspace; use artifacts when publishing HTML

## Anti-patterns

### Not Using Execution Isolation

```jsonc
// Wrong - shared across executions
{ "key": "user-analysis" }

// Right - isolated per execution
{ "key": "user-analysis-{{executionId}}" }
```

### Overusing Notes for Simple Data

Don't store loop counters or temporary values in notes. Use expression nodes or context variables instead.

### Storing Large Binary Data

Notes are for structured text data. Use [Artifacts](/docs/patterns/artifacts-publishing/) for HTML publication and an owned workspace for binary or general large files.

## Related Patterns

- [Artifacts Publishing](/docs/patterns/artifacts-publishing/) - For HTML content with public URLs
- [Workspace](/docs/patterns/workspace/) - For organized file structures
