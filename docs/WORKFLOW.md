# Workflow Development

## Glossary

| Term                 | Definition                                               |
| -------------------- | -------------------------------------------------------- |
| Workflow             | Node graph defining a process with start, steps, and end |
| Node                 | Unit of work (directive, condition, expression, etc.)    |
| Execution            | Running instance of a workflow with its own context      |
| Process              | Synonym for execution                                    |
| Context              | Data passed between nodes during execution               |
| Directive            | Instruction text telling agent what to do                |
| Completion Condition | Success criteria defining when a step is done            |
| Input Schema         | JSON Schema validating agent responses                   |
| Template Variable    | `{{variable}}` syntax for dynamic content                |
| Connection           | Link between nodes defining flow direction               |

## Execution Management

### Starting Workflows

```typescript
// MCP tool
mcp__moira__start({ workflowId: "workflow-id" });

// With note for identification
mcp__moira__start({
  workflowId: "workflow-id",
  note: "Task: implement feature X",
});

// With parent linking
mcp__moira__start({
  workflowId: "child-workflow",
  parentExecutionId: "parent-process-id",
});
```

### Executing Steps

```typescript
// Basic step execution
mcp__moira__step({
  processId: "execution-id",
  input: { field: "value" },
});

// String input for simple responses
mcp__moira__step({
  processId: "execution-id",
  input: "completed task",
});
```

### Step Execution Errors

`executeStep()` throws `ValidationError` (HTTP 400) when:

- **Execution not found** — invalid processId
- **Workflow already completed** — calling `step()` on a finished execution. Error message includes active child workflow ID if one exists, helping agents understand the execution context.

```typescript
// Example: step() on completed workflow
// Throws: ValidationError("Workflow already completed. No active child workflows.")
// Or:     ValidationError("Workflow already completed. Active child workflow: <id>")
```

### Session Management

```typescript
// List active executions
mcp__moira__session({ action: "executions" });

// Get current step info
mcp__moira__session({
  action: "current_step",
  executionId: "execution-id",
});

// Update execution note
mcp__moira__session({
  action: "update-note",
  executionId: "execution-id",
  note: "Updated task description",
});
```

### Recovery After Interruption

If agent session is interrupted:

1. Find process ID in workspace: `cat ./moira-ws/*/process-id.txt`
2. Get current step: `mcp__moira__session({ action: "current_step", executionId: "..." })`
3. Continue from current step

## Best Practices

### Token Economy

Workflows execute on LLM context. Optimize for token efficiency:

**Directive Length:**

- Keep directives concise but complete
- Avoid redundant explanations
- Use bullet points for multiple requirements

**Input Schema:**

- Request only necessary fields
- Use enums for constrained choices
- Avoid redundant confirmation fields

**Completion Condition:**

- Single clear success criterion
- Avoid listing all requirements again

**Bad example (verbose):**

```json
{
  "directive": "You need to analyze the code. First, read all the files. Then, identify potential issues. After that, document your findings in a report. Make sure the report is comprehensive and covers all aspects.",
  "completionCondition": "You have read all files, identified all issues, and created a comprehensive report"
}
```

**Good example (concise):**

```json
{
  "directive": "Analyze code:\n1. Read files\n2. Identify issues\n3. Create report",
  "completionCondition": "Report created with identified issues"
}
```

### Directive Writing

**Neutral formulations:**

Avoid biasing agent toward specific solutions.

```
❌ "Use React for the component"
✅ "Choose appropriate approach for the component, justify choice"

❌ "Fix the bug by adding try/catch"
✅ "Find root cause and fix the error"
```

**Devil's advocate approach:**

Force consideration of alternatives:

```json
{
  "directive": "Evaluate approach:\n1. List 3 alternatives\n2. Pros/cons for each\n3. Recommend with justification",
  "inputSchema": {
    "properties": {
      "alternatives": { "type": "array", "minItems": 3 },
      "recommendation": { "type": "string" },
      "justification": { "type": "string" }
    }
  }
}
```

**Open vs closed directives:**

- Open: "Analyze and recommend" - agent decides approach
- Closed: "Run npm test and report results" - specific action

Use open for decisions, closed for execution.

### Context Preservation

**Set once, use everywhere:**

Collect reusable information in onboarding:

```json
{
  "id": "onboarding",
  "directive": "Determine project context:\n- Test command\n- Docs path\n- Has file access",
  "inputSchema": {
    "properties": {
      "test_command": { "type": "string" },
      "docs_path": { "type": "string" },
      "has_file_access": { "type": "boolean" }
    }
  }
}
```

Then use in later nodes:

```
{{#if has_file_access}}Read from {{docs_path}}{{/if}}
Run tests: {{test_command}}
```

**Variable naming:**

- Use descriptive names: `step_1_result`, not `result`
- Avoid overwriting with different meanings
- Prefix with step name for clarity

### What to Store vs Compute

**Store in workflow:**

- Process structure and flow
- Success criteria
- Validation schemas
- Reusable patterns

**Let agent determine:**

- Implementation details
- File paths (via search)
- Current state
- Runtime decisions

## Troubleshooting

### Agent Stuck in Loop

**Symptom:** Same node executes repeatedly.

**Causes:**

1. Validation always fails
2. Condition always routes back
3. Input never satisfies completion

**Solutions:**

- Check inputSchema matches what agent provides
- Verify condition logic with actual values
- Add maxRetries to prevent infinite loops

### Validation Fails

**Symptom:** "VALIDATION ERROR: Field X..." message.

**Common causes:**

1. Type mismatch (string vs number)
2. Missing required field
3. Enum value not in allowed list
4. Pattern not matching
5. Input provided to node without inputSchema

**Debug:**

```bash
# Check expected schema in workflow
moira-workflow <file> get <node-id>

# Compare with agent's input
```

**No inputSchema error:**

If you see "No inputSchema defined for this node. Input must be empty", the node doesn't expect any data. Either:

- Remove the input from your step call
- Add `inputSchema` to the node definition if data is needed

### Template Syntax Errors

**Symptom:** Validation fails with "unclosed template bracket" or "unexpected closing bracket".

**Causes:**

1. Missing closing `}}` for an opening `{{}}`
2. Extra `}}` without matching `{{`
3. Nested templates with mismatched brackets

**Fix:**

- Count `{{` and `}}` pairs in directive, completionCondition, and message fields
- Use editor with bracket matching

**Example error:**

```
Node task-1: unclosed template bracket '{{' at position 15
```

### Undeclared Variable Errors

**Symptom:** Validation error "references undeclared variable 'X'. Declare it in the workflow variableRegistry or reference a node-local value as 'node-id.name'".

**Cause:** A bare-name `{{X}}` reference resolves to neither a global declared in `variableRegistry` nor a system variable; or a `node-id.name` reference whose root segment is not a real node id.

**Notes:**

- This is a BLOCKING validation error (workflow save is rejected).
- Declare globals once in `variableRegistry`; reference node-local outputs as `node-id.name`.
- System variables (`executionId`, `workflowId`, `userId`) don't need declaration.
- Control flow keywords (`if`, `each`, `else`) are not flagged.

### Template Shows "null"

**Symptom:** `{{variable}}` renders as "null".

**Causes:**

1. Variable not set in previous nodes
2. Typo in variable name
3. Variable set to null/undefined

**Debug:**

- Check variable is in inputSchema of previous node
- Verify node that sets variable executed successfully
- Use conditional: `{{#if variable}}{{variable}}{{else}}default{{/if}}`

### Lost Context After Restart

**Symptom:** Agent can't continue workflow after session restart.

**Solution:**

1. Save process ID: `echo {{executionId}} > ./moira-ws/*/process-id.txt`
2. On restart, read ID and call `mcp__moira__session({ action: "current_step", executionId: "..." })`

### Condition Evaluates Wrong

**Symptom:** Flow takes unexpected branch.

**Debug:**

- Check operand types match (string "5" vs number 5)
- Verify contextPath points to correct variable
- Test condition with known values

**Common mistakes:**

```json
// Wrong: comparing string to number
{ "operator": "gt", "left": { "contextPath": "score" }, "right": "5" }

// Correct: both numbers
{ "operator": "gt", "left": { "contextPath": "score" }, "right": 5 }
```

### Directive Not Processing Templates

**Symptom:** `{{variable}}` appears literally in output.

**Check:**

- Templates only processed in `directive`, `completionCondition`, `message` fields
- NOT processed in `inputSchema` or `condition`
- Variable must exist in context

## Workflow Structure

### Required Fields

```json
{
  "id": "unique-workflow-id",
  "metadata": {
    "name": "Workflow Name",
    "version": "1.0.0",
    "description": "Purpose description"
  },
  "nodes": [
    /* Node array */
  ]
}
```

### Node Requirements

**All Nodes:**

- `type` - One of: start, agent-directive, condition, expression, subgraph, telegram-notification, teleport, lock, end
- `id` - Unique within workflow
- `connections` - Required (except end nodes)

## Node Specifications

### Start Node

```json
{
  "type": "start",
  "id": "start",
  "connections": { "default": "next-node" },
  "initialData": {
    /* Optional */
  }
}
```

### Agent Directive Node

```json
{
  "type": "agent-directive",
  "id": "task-id",
  "directive": "What agent should do",
  "completionCondition": "When task is complete",
  "inputSchema": {
    "type": "object",
    "properties": {
      "field": { "type": "string" }
    },
    "required": ["field"]
  },
  "maxRetries": 3,
  "connections": { "success": "next-node" }
}
```

### Condition Node

```json
{
  "type": "condition",
  "id": "check-id",
  "condition": {
    "operator": "gte",
    "left": { "contextPath": "score" },
    "right": 8
  },
  "connections": {
    "true": "success-node",
    "false": "failure-node"
  }
}
```

### Expression Node

```json
{
  "type": "expression",
  "id": "calc-id",
  "expressions": ["counter = counter + 1", "result = counter * multiplier"],
  "connections": {
    "default": "next-node",
    "error": "error-handler"
  }
}
```

**Expressions:**

- Basic arithmetic: `+`, `-`, `*`, `/`
- Parentheses: `(a + b) * c`
- Assignment: `result = a + b`
- Context paths: `step.index`, `plan.current_step`

**Security:** Custom sandboxed parser, NOT JavaScript eval.

**Error handling:** Division by zero and undefined variables route to `error` connection if defined.

### Telegram Notification Node

```json
{
  "type": "telegram-notification",
  "id": "notify-id",
  "message": "Message with {{variables}}",
  "chatId": "{{user_chat_id}}",
  "parseMode": "Markdown",
  "replyMarkup": {
    "inline_keyboard": [
      [
        { "text": "✅ Approve", "callback_data": "approve" },
        { "text": "❌ Reject", "callback_data": "reject" }
      ]
    ]
  },
  "connections": { "default": "next-node" }
}
```

`replyMarkup` is optional. When provided, sends an inline keyboard with the message. Each button has `text` (display label) and `callback_data` (payload, max 64 bytes per Telegram API).

### Subgraph Node

```json
{
  "type": "subgraph",
  "id": "subprocess-id",
  "graphId": "target-workflow-id",
  "inputMapping": {
    "parentVariable": "childVariable"
  },
  "outputMapping": {
    "childResult": "parentResult"
  },
  "connections": {
    "success": "next-node",
    "error": "error-node"
  }
}
```

### Teleport Node

Jump target reachable only via explicit teleport, not via normal connections. Behaves like agent-directive (pauses for input, validates schema) but is only reachable when agent explicitly requests a teleport jump.

```json
{
  "type": "teleport",
  "id": "teleport-replan",
  "directive": "Rewrite the development plan",
  "completionCondition": "New plan created and validated",
  "hint": "Use when current plan needs restructuring",
  "inputSchema": {
    "type": "object",
    "properties": {
      "reason": { "type": "string" }
    },
    "required": ["reason"]
  },
  "connections": { "success": "plan-node" }
}
```

| Property              | Required | Description                                        |
| --------------------- | -------- | -------------------------------------------------- |
| `hint`                | Yes      | Human-readable description of when to use teleport |
| `directive`           | Yes      | Instruction shown to agent after teleport          |
| `completionCondition` | Yes      | Success criteria for the teleport step             |
| `inputSchema`         | No       | JSON Schema for agent response validation          |
| `connections.success` | Yes      | Next node after teleport input provided            |
| `connections.error`   | No       | Error handler node                                 |

**Validation rules:**

- Teleport nodes must NOT have incoming connections from other nodes
- Teleport nodes are excluded from unreachable node warnings

**Using teleport at runtime:**

When a workflow contains teleport nodes, their hints are automatically appended to each step response under "Available Teleport Jumps". To jump to a teleport node, use the `teleportTo` parameter in `step()`:

```
step({ processId: "abc123", teleportTo: "teleport-replan" })
```

- Only teleport-type nodes can be targets
- Do NOT provide `input` when teleporting — the teleport node will present its own directive
- Execution context (all variables) is preserved across the teleport
- After providing input to the teleport node, execution continues via its `connections.success`

### Lock Node

PIN-based execution gate. Creates an execution lock, sends PIN via Telegram with Approve inline keyboard, and pauses workflow until unlocked.

```json
{
  "type": "lock",
  "id": "approval-gate",
  "reason": "Deploy to production for {{workflow_name}}",
  "connections": {
    "unlocked": "proceed-node"
  }
}
```

| Property               | Required | Description                                     |
| ---------------------- | -------- | ----------------------------------------------- |
| `reason`               | Yes      | Lock reason (supports `{{variable}}` templates) |
| `connections.unlocked` | Yes      | Next node after lock is unlocked                |

**Behavior:**

1. First visit: creates lock via LockService, sends PIN via Telegram, pauses execution
2. Subsequent visits: checks lock status or validates PIN from input
3. Routes to `unlocked` connection when lock is resolved
4. Stores `_lockId` in context variables for lock lookup on re-entry

**Unlock methods:** PIN validation via MCP step input, Telegram approve button, admin override unlock.

### End Node

```json
{
  "type": "end",
  "id": "end",
  "finalOutput": ["var1", "var2"]
}
```

## Automatic Node Types

Automatic nodes execute without agent interaction. They run server-side and immediately continue to the next node.

### Read Note Node

Reads notes matching filter criteria into context variable.

```json
{
  "type": "read-note",
  "id": "load-project-notes",
  "outputVariable": "projectNotes",
  "filter": {
    "tag": "{{projectTag}}",
    "keyPattern": "project-",
    "keySearch": "config"
  },
  "singleMode": false,
  "connections": {
    "default": "next-node",
    "error": "error-handler"
  }
}
```

| Property              | Required | Description                                      |
| --------------------- | -------- | ------------------------------------------------ |
| `outputVariable`      | Yes      | Context variable to store results                |
| `filter.tag`          | No       | Filter by exact tag                              |
| `filter.keyPattern`   | No       | Filter by key prefix                             |
| `filter.keySearch`    | No       | Search in key (contains)                         |
| `singleMode`          | No       | Return object instead of array when single match |
| `connections.default` | Yes      | Next node                                        |
| `connections.error`   | No       | Error handler node                               |

All filter parameters support `{{variable}}` template expressions.

### Write Note Node

Writes data from context to notes.

```json
{
  "type": "write-note",
  "id": "save-results",
  "key": "results-{{timestamp}}",
  "source": "analysisResults",
  "tags": ["analysis", "{{projectTag}}"],
  "connections": {
    "default": "next-node",
    "error": "error-handler"
  }
}
```

Batch mode for multiple notes:

```json
{
  "type": "write-note",
  "id": "save-batch",
  "source": "notesToSave",
  "batchMode": true,
  "connections": {
    "default": "next-node"
  }
}
```

| Property              | Required | Description                                        |
| --------------------- | -------- | -------------------------------------------------- |
| `key`                 | No\*     | Note key (required in single mode)                 |
| `source`              | Yes      | Context variable with value or batch array         |
| `tags`                | No       | Tags to assign                                     |
| `batchMode`           | No       | Process array of `{key, value, tags?}` from source |
| `connections.default` | Yes      | Next node                                          |
| `connections.error`   | No       | Error handler node                                 |

Output stored in `writeNoteResults`: `{key, version, created: boolean}`.

### Upsert Note Node

Find-or-create operation. Searches by criteria, updates if found, creates if not.

```json
{
  "type": "upsert-note",
  "id": "upsert-config",
  "search": {
    "tag": "config",
    "keyPattern": "{{projectId}}-"
  },
  "keyTemplate": "{{projectId}}-config",
  "value": "configData",
  "tags": ["config", "{{projectTag}}"],
  "outputVariable": "upsertResult",
  "connections": {
    "default": "next-node",
    "error": "error-handler"
  }
}
```

| Property              | Required | Description                      |
| --------------------- | -------- | -------------------------------- |
| `search.tag`          | No       | Search by tag                    |
| `search.keyPattern`   | No       | Search by key prefix             |
| `keyTemplate`         | Yes      | Key for new note if not found    |
| `value`               | Yes      | Context variable with note value |
| `tags`                | No       | Tags to assign                   |
| `outputVariable`      | No       | Custom variable for result       |
| `connections.default` | Yes      | Next node                        |
| `connections.error`   | No       | Error handler node               |

Output stored in `upsertNoteResult` (or `outputVariable`): `{key, version, created: boolean}`.

## Condition Operators

### Comparison

- `eq`, `neq` - Equality/inequality
- `gt`, `gte` - Greater than
- `lt`, `lte` - Less than
- `contains` - String/array contains

### Logical

```json
{
  "operator": "and",
  "conditions": [
    { "operator": "gt", "left": { "contextPath": "score" }, "right": 5 },
    { "operator": "exists", "value": { "contextPath": "user.name" } }
  ]
}
```

### Existence

```json
{ "operator": "exists", "value": {"contextPath": "variable"} }
{ "operator": "not", "condition": { /* nested condition */ } }
```

## Template Variables

### Syntax

- `{{variable}}` - Simple variable access
- `{{nested.path}}` - Object property access
- `{{array[0]}}` - Array element access (static index)
- `{{array[0].field}}` - Array element with property access
- `{{array[index]}}` - Dynamic array index (variable resolves to number)
- `{{steps[current_step].action}}` - Dynamic index with property access
- `{{data[1].items[0].value}}` - Nested array/object combinations
- `{{executionId}}` - System variable: process ID
- `{{workflowId}}` - System variable: workflow ID
- `{{userId}}` - System variable: current user ID
- `{{note:KEY}}` - Note content reference (fetches note by key for current user)

### Dynamic Array Indexes

Array indexes can be variables that resolve to numbers at runtime:

```
{{steps[current_step].action}}     - current_step=0 → steps[0].action
{{items[index].name}}              - index=2 → items[2].name
{{data[row][col]}}                 - row=1, col=3 → data[1][3]
```

Use with expression nodes for iteration:

```json
{
  "type": "expression",
  "id": "increment-step",
  "expressions": ["current_step = current_step + 1"],
  "connections": { "default": "check-remaining" }
}
```

Then in directive: `Execute step {{current_step}}: {{steps[current_step].action}}`

### Variable Naming

Variable and node ID names support multiple conventions:

- **camelCase**: `{{projectName}}`, `{{userInput}}`
- **snake_case**: `{{project_name}}`, `{{user_input}}`
- **kebab-case**: `{{my-project}}`, `{{setup-workspace}}`

Kebab-case is supported in the first segment:

```
{{my-variable}}              - Simple kebab-case variable
{{setup-workspace.path}}     - Kebab-case node ID with field access
{{#each my-items}}           - Kebab-case in iteration
```

### Conditional Templates

```
{{#if variable}}Content when truthy{{else}}Content when falsy{{/if}}
{{#if variable}}Content when truthy{{/if}}
```

Falsy values: `null`, `undefined`, `false`, `0`, `""`, empty array, empty object

Example:

```
{{#if has_file_access}}Read from file{{else}}Use memory{{/if}}
```

The variable argument of block helpers (`{{#if VAR}}`, `{{#unless VAR}}`, `{{#each VAR}}`, `{{#eq VAR ...}}`, `{{#neq VAR ...}}`) is validated identically to a bare-name reference: `VAR` must be a declared global in `variableRegistry`, a `node-id.name` output, or a system variable. An undeclared name fails graph validation (`GraphValidator.findUndefinedVariables`).

### Unless Templates

Opposite of `{{#if}}` - content shown when value is falsy:

```
{{#unless isLoggedIn}}Please log in{{/unless}}
{{#unless hasError}}Success!{{else}}Error occurred{{/unless}}
```

### Equality Comparison Templates

Compare variable with string value:

```
{{#eq variable 'value'}}Content when equal{{/eq}}
{{#eq variable 'value'}}Content when equal{{else}}Content when not equal{{/eq}}
```

Example:

```
{{#eq upload_target 'staging'}}Deploy to staging server{{/eq}}
{{#eq upload_target 'production'}}Deploy to production server{{/eq}}
```

### Not-Equal Comparison Templates

Show content when variable does NOT equal value:

```
{{#neq variable 'value'}}Content when not equal{{/neq}}
{{#neq variable 'value'}}Content when not equal{{else}}Content when equal{{/neq}}
```

Example:

```
{{#neq test_info 'skip'}}Run tests: {{test_command}}{{/neq}}
```

### Iteration Templates

Iterate over arrays:

```
{{#each items}}{{this}}, {{/each}}
{{#each users}}{{name}} ({{age}}){{/each}}
{{#each steps}}{{@index}}: {{action}}{{/each}}
```

Inside `{{#each}}`:

- `{{this}}` - current item value (for simple arrays)
- `{{this.field}}` - access field of current object (for arrays of objects)
- `{{this.nested.path}}` - access nested fields
- `{{@index}}` - current index (0-based)
- `{{fieldName}}` - direct access to object field (shorthand for `{{this.fieldName}}`)

Conditionals inside loops:

```
{{#each tasks}}{{#if done}}[x]{{else}}[ ]{{/if}} {{name}}
{{/each}}
```

### Processing Rules

- **Strings**: Direct substitution without quotes
- **Numbers/Booleans**: Convert to string
- **Objects/Arrays**: JSON serialization
- **Undefined**: "null"
- **Conditionals inside variables**: Supported. If a variable contains `{{#if}}...{{/if}}`, it will be processed after variable substitution

### Template Locations

Templates processed in:

- `directive` field of agent-directive nodes
- `completionCondition` field of agent-directive nodes
- `message` field of telegram-notification nodes

NOT processed in `inputSchema` or `condition` fields.

### Note References

Reference stored notes directly in templates using `{{note:KEY}}` syntax:

```
Use this configuration: {{note:project-config}}
Apply settings from {{note:my-settings}} to the project.
```

**Behavior:**

- Note content fetched via NoteService using execution's userId
- Missing notes produce: `[NOTE NOT FOUND: KEY]`
- Service errors produce: `[NOTE ERROR: KEY]`
- Key supports alphanumeric, underscore, hyphen: `{{note:my-config}}`, `{{note:project_settings}}`

**Dynamic note keys:**

Note keys can contain template variables for dynamic references:

```
{{note:metrics-{{projectName}}}}
{{note:config-{{environment}}}}
{{note:latest-metrics-{{ask-project.projectName}}}}
```

Inner variables resolve first, then the note is fetched. If inner variable is missing, note lookup fails with unresolved key in error.

**Processing order:**

1. Regular templates resolved first (sync) — inner variables become concrete values
2. Note references resolved (async) — keys are now complete
3. Iterate until stable (max 10 iterations)
4. Note content may contain regular templates — processed in subsequent iterations

**Example with nested templates:**

Note "greeting-template" contains: `Hello, {{userName}}!`

```json
{
  "directive": "{{note:greeting-template}} Please review the code.",
  "completionCondition": "Code reviewed"
}
```

With context `{userName: "Alice"}`, agent sees: `Hello, Alice! Please review the code.`

### Magic Variables

Special variables with automatic handling:

**execution_note** - Updates execution note when passed in step input:

```json
{
  "inputSchema": {
    "properties": {
      "execution_note": {
        "type": "string",
        "description": "Note to identify this execution"
      }
    }
  }
}
```

When agent provides `execution_note`, it updates the execution record's note field for easier tracking in execution lists.

**Note:** `execution_note` passes through inputSchema validation. You can include it in `required` array to enforce agents provide execution identification.

## JSON Schema

### Input Validation

Agent-directive nodes can specify expected input structure.

**Default Behavior (no inputSchema):**

When `inputSchema` is not defined, the node only accepts empty input (`null` or `{}`). Any non-empty input is rejected with a validation error:

```
❌ VALIDATION ERROR - Your input doesn't match the required schema

EXPECTED INPUT FORMAT:
null or {} (no inputSchema defined - node accepts empty input only)

YOUR INPUT:
{ "garbage": 123 }

ERRORS:
• No inputSchema defined. Input must be null or {}.

ACTION REQUIRED:
Send a new input object with the correct structure. Do not proceed until validation passes.
```

This prevents garbage data from accumulating in execution context.

**With inputSchema:**

```json
{
  "inputSchema": {
    "type": "object",
    "properties": {
      "score": { "type": "number", "minimum": 1, "maximum": 10 },
      "feedback": { "type": "string", "minLength": 5 },
      "items": {
        "type": "array",
        "items": { "type": "string" },
        "minItems": 1
      }
    },
    "required": ["score"],
    "additionalProperties": false
  }
}
```

### Strict Validation

The engine automatically injects `additionalProperties: false` into all object schemas with `properties` before validation. This means:

- Agent responses with extra fields not declared in `inputSchema` are **rejected**
- Only fields explicitly defined in `properties` are accepted
- Nested objects are also enforced recursively
- Existing `additionalProperties` settings in the schema are preserved

Workflow authors do not need to add `additionalProperties: false` manually — it is enforced at the handler level.

### Validation Features

- Standard JSON Schema Draft 7
- Strict additional properties enforcement (automatic)
- Field-level error messages
- Type coercion where safe
- Retry mechanism on validation failure

## Workflow Patterns

### Linear Flow

```
start → task1 → task2 → end
```

### Conditional Branching

```
start → assess → condition → [high-path | low-path] → end
```

### Validation Loop

```
start → create → validate → condition → [end | improve → create]
```

### Notification Integration

```
start → process → notify → continue → end
```

### Information Collection (Onboarding)

Collect agent capabilities or user preferences at workflow start:

```json
{
  "type": "agent-directive",
  "id": "collect-info",
  "directive": "Determine agent capabilities:\n- File system access?\n- Web fetch access?",
  "inputSchema": {
    "type": "object",
    "properties": {
      "has_file_access": { "type": "boolean" },
      "has_web_access": { "type": "boolean" }
    },
    "required": ["has_file_access", "has_web_access"]
  },
  "connections": { "success": "route-by-capabilities" }
}
```

Use collected values with conditional templates:

```
{{#if has_file_access}}Use file operations{{else}}Use MCP tools only{{/if}}
```

### Skip Pattern

Allow users to skip optional steps:

```json
{
  "type": "agent-directive",
  "id": "optional-step",
  "directive": "Perform optional analysis. User can skip if not needed.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "result": { "type": "string" },
      "skip": { "type": "string", "enum": ["да"] }
    }
  },
  "connections": { "success": "check-skip" }
}
```

Route based on skip value:

```json
{
  "type": "condition",
  "id": "check-skip",
  "condition": {
    "operator": "eq",
    "left": { "contextPath": "skip" },
    "right": "да"
  },
  "connections": { "true": "next-step", "false": "process-result" }
}
```

### Parent-Child Workflow Relationships

Link child workflow to parent for tracking and continuation:

```typescript
mcp__moira__start({
  workflowId: "child-workflow",
  parentExecutionId: "parent-process-id",
});
```

**Behavior:**

1. **Independent Completion**: Parent workflow completes when it reaches its end node, regardless of child workflow state. Child workflows are NOT blocking.

2. **Child Completion Reminder**: When child workflow completes, response includes reminder to continue parent:

   ```
   CONTINUATION REMINDER: This was a child workflow. Parent execution awaits continuation.
   Parent execution ID: <parent-id>
   Use step(processId: "<parent-id>") to continue the parent workflow.
   ```

3. **Active Child Info**: When executing steps on parent workflow, response includes info about running children:

   ```
   **Active Child Workflows** (2):
     - child-execution-id-1
     - child-execution-id-2

   Note: These child workflows are running in parallel. Monitor their status separately.
   ```

4. **Step on Completed Parent**: If parent already completed and `step()` is called, error message includes active child info:
   ```
   Workflow already completed. Active child workflow: <child-id>
   ```

**Agent Guidelines:**

- Monitor both parent and child executions when using parent-child linking
- Don't expect parent to wait for child completion — manage timing explicitly
- Use `mcp__moira__session({ action: "executions" })` to list all active executions
- Consider using condition nodes to wait for child completion if needed

### Dynamic Files Pattern

Use template variables for file paths to make workflow reusable across projects:

```json
{
  "type": "agent-directive",
  "id": "read-project-docs",
  "directive": "Read project documentation from {{project_docs_path}}",
  "connections": { "success": "next-step" }
}
```

Collect paths in onboarding:

```json
{
  "inputSchema": {
    "properties": {
      "project_docs_path": { "type": "string", "description": "Path to project docs" },
      "test_command": { "type": "string", "description": "Command to run tests" }
    }
  }
}
```

Agent determines paths by searching filesystem, using defaults, or asking user.

### Step Validation Pattern

Verify step completion before proceeding:

```
execute-step → verify-step → condition → [success: next] / [fail: retry-or-escalate]
```

```json
{
  "type": "agent-directive",
  "id": "verify-step",
  "directive": "Verify step {{current_step}} completed:\n- Expected: {{expected_output}}\n- Check actual result matches expected",
  "inputSchema": {
    "properties": {
      "step_verified": { "type": "string", "enum": ["да", "нет"] },
      "verification_evidence": { "type": "string" }
    },
    "required": ["step_verified", "verification_evidence"]
  },
  "connections": { "success": "route-verification" }
}
```

Prevents skipping incomplete steps. Evidence required for verification.

### Subagent Review Pattern

Delegate reviews to independent subagent via Task tool:

```
do-work → delegate-review → check-result → [pass: next] / [fail: fix-issues → do-work]
```

```json
{
  "type": "agent-directive",
  "id": "delegate-review",
  "directive": "Delegate review to subagent using Task tool.\n\n1) Pass ONLY: file paths, success criteria, context directory\n2) Agent prompt: YOU ARE reviewer. CHECK files. VERIFY by reading. Return BLOCKING issues only.\n3) Report findings honestly",
  "inputSchema": {
    "properties": {
      "review_file": { "type": "string" },
      "issues_found": { "type": "string", "enum": ["yes", "no"] }
    },
    "required": ["review_file", "issues_found"]
  },
  "connections": { "success": "check-review-result" }
}
```

Prevents self-review bias. Subagent provides independent assessment.

### Workspace Pattern

Organize workflow files in a dedicated workspace directory:

```
./moira-ws/{workspace-name}/
├── process-id.txt       # Execution ID for recovery
├── development-plan.md  # Plans and specifications
├── step-1/              # Step-specific results
│   └── step-results.md
└── *.backup.json        # Backup files
```

Naming format: `{short-name}-{YYYYMMDD}-{HHMM}` (e.g., `wmf-edit-20251211-2145`)

```json
{
  "type": "agent-directive",
  "id": "create-workspace",
  "directive": "Create workspace: ./moira-ws/{task-name}-{YYYYMMDD}-{HHMM}/\nSave process-id.txt with: {{executionId}}",
  "inputSchema": {
    "properties": {
      "workspace_path": {
        "type": "string",
        "pattern": "^\\./moira-ws/[a-z0-9-]+-\\d{8}-\\d{4}/$"
      }
    },
    "required": ["workspace_path"]
  }
}
```

Use `{{workspace_path}}` in subsequent directives. Add `moira-ws/` to `.gitignore`.

## File Management

### Location

- **Production catalog**: `workflows/production/flows/*.json` (the catalog base dir is
  `./workflows/production`; the loader reads its `flows/` subdirectory). The base dir is
  configurable via `WORKFLOWS_DIRS` (colon-separated) or `WORKFLOWS_DIR`.
- **Testing**: `tests/workflows/*.json`
- **Naming**: Catalog files are named by the workflow's UUID

### Validation

```bash
# Workflow automatically validated on load
# Invalid workflows marked in Web UI
# MCP tools return validation errors
```

## Data Balance Guidelines

Rules for data flow between workflow nodes and agents.

### Onboarding vs Self-Request

**Use Onboarding Pattern when:**

- Information is needed across MULTIPLE nodes (file paths, capabilities, preferences)
- Agent would need to search/ask repeatedly without it
- Data is unlikely to change during execution
- Examples: `has_file_access`, `test_command`, `project_docs_path`

**Use Self-Request when:**

- Information is needed for ONE specific node only
- Data is dynamic and changes during execution
- Agent has better context to determine the value
- Examples: current error message, specific file content, runtime state

**Anti-pattern:**

```json
{
  "directive": "Check if documentation file exists and read it",
  "inputSchema": {
    "properties": {
      "docs_path": { "type": "string" }
    }
  }
}
```

Problem: Agent searches for docs_path, provides it, then directive says "check if exists" - redundant.

**Correct approach:**

```json
// Onboarding node
{
  "id": "collect-project-info",
  "directive": "Find project documentation path. Search for README, docs/, CLAUDE.md",
  "inputSchema": {
    "properties": {
      "docs_path": { "type": "string", "description": "Path to documentation file or 'none'" }
    }
  }
}

// Later node using collected data
{
  "id": "use-documentation",
  "directive": "{{#if docs_path}}Read {{docs_path}} for context{{else}}No documentation available{{/if}}"
}
```

### Input/Output Data Size

**Minimize input when:**

- Data is already in context from previous nodes
- Agent can derive the value from available information
- Redundant confirmation of known state

**Maximize input when:**

- Structured data needed for condition nodes (scores, enums)
- Data required for templates in subsequent nodes
- Audit trail or logging requirements

**Output in directive ({{variable}}) guidelines:**

| Data Type               | Include in Directive | Reason              |
| ----------------------- | -------------------- | ------------------- |
| Small text (<500 chars) | Yes                  | Agent needs context |
| Large text (>500 chars) | Summary only         | Noise reduction     |
| Lists (<10 items)       | Yes                  | Actionable          |
| Lists (>10 items)       | Count + first 3      | Prevent overload    |
| File paths              | Yes                  | Direct use          |
| Full file content       | No                   | Read via tools      |

**Example - Good balance:**

```json
{
  "directive": "Fix {{issues_count}} issues in plan:\n{{#each issues}}{{@index}}. {{description}} (stage: {{stage}})\n{{/each}}",
  "inputSchema": {
    "properties": {
      "issues_fixed": { "type": "number" },
      "remaining_issues": { "type": "array" }
    }
  }
}
```

**Example - Bad balance (too much output):**

```json
{
  "directive": "Here is the full content of all 15 files: {{full_file_contents}}"
}
```

**Example - Bad balance (redundant input):**

```json
{
  "inputSchema": {
    "properties": {
      "understood": { "type": "string", "enum": ["yes"] },
      "confirmed": { "type": "string", "enum": ["confirmed"] }
    }
  }
}
```

### Context Accumulation

Variables persist in execution context. Each node can access all previously set variables.

**DO:**

- Set once, use many times
- Use descriptive variable names
- Clean naming: `step_1_result`, `user_preference`

**DON'T:**

- Re-collect same information
- Overwrite variables with different meaning
- Use generic names: `result`, `data`, `value`

## Common Issues

### Connection Errors

**Error**: "Node X not found"  
**Fix**: Verify connection targets exist in nodes array

### Template Errors

**Error**: Variables show as "null"  
**Fix**: Ensure variables exist in context before template use

### Validation Errors

**Error**: Agent input rejected
**Format**: Comprehensive error with 5 sections:

- Header with error indicator
- EXPECTED INPUT FORMAT (schema as readable JSON)
- YOUR INPUT (what agent sent, truncated at 500 chars)
- ERRORS (bullet list of specific issues)
- ACTION REQUIRED (instructions to retry)

**Fix**: Check input matches inputSchema requirements. The error message shows expected format and specific validation failures.

### Condition Errors

**Error**: Condition evaluation fails  
**Fix**: Ensure operand types match (string vs number)

## Development Workflow

### Creating Workflows

1. Create the JSON file under `workflows/production/flows/`
2. Define the workflow structure (id, metadata, nodes)
3. Validate with `moira-workflow <file> validate`
4. Validate in the Web UI or via MCP tools

### Testing Workflows

```bash
npm test                           # Run the full test suite
npm run test:workflow              # Run workflow-scenario tests
moira-workflow <file> validate     # Validate a single workflow file
```

### Debugging

```bash
# View execution state
cat .graph-storage/executions/<process-id>.json

# Monitor executions
ls -la .graph-storage/executions/

# Workflow validation
curl localhost:${DOCKER_PORT}/api/workflows/production/workflow-id
```
