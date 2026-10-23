---
title: Information Collection Pattern
description: Gather agent capabilities or user preferences at workflow start
---

## Purpose

Collect information about agent environment, user preferences, or project configuration before workflow proceeds. This enables conditional behavior in later steps.

## Structure

```
[start] → [collect-info] → [route-by-info] → [branch-a | branch-b]
```

## Implementation

### Collector Node

```json
{
  "type": "agent-directive",
  "id": "collect-info",
  "directive": "Determine agent capabilities:\n- File system access?\n- Web fetch access?\n- Test framework?",
  "completionCondition": "Relevant capabilities checked in the current environment; unavailable access reported honestly",
  "inputSchema": {
    "type": "object",
    "properties": {
      "has_file_access": { "type": "boolean" },
      "has_web_access": { "type": "boolean" },
      "test_framework": { "type": "string" }
    },
    "required": ["has_file_access", "has_web_access"]
  },
  "connections": { "success": "route-by-capabilities" }
}
```

### Routing Node

```json
{
  "type": "condition",
  "id": "route-by-capabilities",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "collect-info.has_file_access" },
        "right": true
      },
      "output": "has-file-access"
    }
  ],
  "connections": {
    "has-file-access": "file-based-flow",
    "default": "memory-based-flow"
  }
}
```

## Using Collected Values

Values are node-local. These are node/configuration fragments; their connection targets must exist in the containing workflow. Use the producer ID in later templates:

```json
{
  "directive": "{{#if collect-info.has_file_access}}Discover an authorized output path and save the result there{{else}}Return the result in the workflow answer{{/if}}"
}
```

## Real Example

Configuration fragment for a project collector (add its connections and completion condition when making a node):

```json
{
  "type": "agent-directive",
  "id": "get-initial-requirements",
  "completionCondition": "Relevant project rules and validation entries identified from actual sources",
  "connections": { "success": "next-step" },
  "directive": "Read applicable project instructions and identify the validation entry relevant to the requested change. Record discovered paths and report unavailable commands rather than guessing.",
  "inputSchema": {
    "properties": {
      "test_command": { "type": "string" },
      "has_tests": { "type": "string", "enum": ["yes", "no"] },
      "build_command": { "type": "string" },
      "checklist_path": { "type": "string" },
      "has_checklist": { "type": "string", "enum": ["yes", "no"] },
      "has_browser_ui": { "type": "string", "enum": ["yes", "no"] }
    },
    "required": ["has_tests", "has_checklist"],
    "if": { "properties": { "has_tests": { "const": "yes" } }, "required": ["has_tests"] },
    "then": {
      "required": ["test_command"],
      "properties": { "test_command": { "type": "string", "minLength": 1 } }
    }
  }
}
```

:::tip
Collect information when its consumer needs it. Resolve available project facts yourself; ask only for decisions or access that cannot be established from authorized context. A capability flag does not grant permission to use that capability.
:::

## Related Patterns

- [Skip Pattern](/docs/patterns/skip/) - Use collected flags to skip steps
- [Dynamic Files](/docs/patterns/dynamic-files/) - Use collected paths in templates
- [Branching](/docs/patterns/branching/) - Route based on collected values
