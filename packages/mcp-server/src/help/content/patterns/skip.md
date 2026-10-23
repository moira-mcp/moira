---
title: Skip Pattern
description: Allow users to skip optional steps
---

## Purpose

Allow users or agents to skip optional workflow steps when not needed. Useful for optional analysis, reviews, or configuration steps.

## Structure

```
[optional-step] → [check-skip] → skip=true  → [next-step]
                              → skip=false → [process-result]
```

## Implementation

### Optional Step Node

```json
{
  "type": "agent-directive",
  "id": "optional-analysis",
  "directive": "Perform optional deep analysis. User can skip if not needed by providing skip='yes'.",
  "completionCondition": "Optional analysis completed or explicitly skipped under the workflow's rules",
  "inputSchema": {
    "type": "object",
    "properties": {
      "analysis_result": { "type": "string" },
      "skip": { "type": "string", "enum": ["yes"] }
    },
    "oneOf": [
      { "required": ["skip"], "not": { "required": ["analysis_result"] } },
      { "required": ["analysis_result"], "not": { "required": ["skip"] } }
    ]
  },
  "connections": { "success": "check-skip" }
}
```

:::note
The `skip` field uses `enum: ["yes"]` to make it optional but explicit. If user wants to skip,
they provide `skip: "yes"`. Otherwise they provide the actual result.
:::

### Skip Check Node

```json
{
  "type": "condition",
  "id": "check-skip",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "optional-analysis.skip" },
        "right": "yes"
      },
      "output": "skipped"
    }
  ],
  "connections": {
    "skipped": "next-step",
    "default": "process-analysis"
  }
}
```

## Alternative: Boolean Flag

For simpler cases:

```json
{
  "inputSchema": {
    "properties": {
      "result": { "type": "string" },
      "skipped": { "type": "boolean" }
    },
    "required": ["skipped"]
  }
}
```

## Combining with Information Collection

Skip decisions can be made upfront:

```json
{
  "id": "collect-preferences",
  "type": "agent-directive",
  "directive": "Ask user: do you want detailed analysis?",
  "completionCondition": "Actual user preference recorded",
  "inputSchema": {
    "properties": {
      "want_detailed_analysis": { "type": "boolean" }
    },
    "required": ["want_detailed_analysis"]
  },
  "connections": { "success": "route-preferences" }
}
```

Then use condition:

```json
{
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "collect-preferences.want_detailed_analysis" },
        "right": false
      },
      "output": "skipped"
    }
  ],
  "connections": {
    "skipped": "skip-to-summary",
    "default": "detailed-analysis"
  }
}
```

## Real Example

Example of optional review of an existing definition; it does not waive mandatory review or a complete source baseline before editing:

```json
{
  "id": "review-existing-workflow",
  "type": "agent-directive",
  "completionCondition": "Applicable source review completed, or inapplicable new-workflow source review explicitly skipped",
  "connections": { "success": "route-review-result" },
  "directive": "If editing, review the existing workflow structure.\nIf creating new workflow, skip this step.",
  "inputSchema": {
    "properties": {
      "workflow_reviewed": { "type": "string" },
      "skip": { "type": "string", "enum": ["yes"] }
    }
  }
}
```

:::tip
Make skip behavior explicit in the directive. Tell the user exactly when and how to skip.
:::

## Related Patterns

- [Information Collection](/docs/patterns/information-collection/) - Collect skip preferences upfront
- [Branching](/docs/patterns/branching/) - Route to different paths based on decisions
