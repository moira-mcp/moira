---
title: Dynamic Files Pattern
description: Template-based file paths for workflow reusability
---

## Purpose

Use template variables for file paths to make workflows reusable across different projects. Paths are collected at runtime and used throughout execution.

## Structure

```
[collect-paths] → [use-paths-in-directives] → [output-to-path]
```

## Implementation

### Path Collection

```json
{
  "type": "agent-directive",
  "id": "collect-project-paths",
  "directive": "Determine project structure:\n- Docs location?\n- Output location?\n- Test files location?",
  "completionCondition": "Relevant existing paths and authorized output location identified",
  "inputSchema": {
    "type": "object",
    "properties": {
      "docs_path": {
        "type": "string",
        "description": "Path to project documentation"
      },
      "output_path": {
        "type": "string",
        "description": "Path for workflow outputs"
      },
      "test_path": { "type": "string", "description": "Path to test files" }
    },
    "required": ["docs_path", "output_path"]
  },
  "connections": { "success": "read-documentation" }
}
```

### Using Paths in Directives

```json
{
  "type": "agent-directive",
  "id": "read-documentation",
  "directive": "Read project documentation from {{collect-project-paths.docs_path}}.\nAnalyze structure and content.",
  "completionCondition": "Relevant documentation read completely and analysis produced",
  "connections": { "success": "write-output" }
}
```

### Output to Dynamic Path

```json
{
  "type": "agent-directive",
  "id": "write-output",
  "directive": "Write results to {{collect-project-paths.output_path}}/analysis-results.md",
  "completionCondition": "Result written to the authorized path and checked",
  "connections": { "success": "next-step" }
}
```

## Path Discovery Strategies

Agent can determine paths by:

1. **Searching filesystem**: Look for common patterns (`docs/`, `README.md`)
2. **Using defaults**: Fallback to standard locations
3. **Asking user**: When path cannot be determined

```json
{
  "directive": "Find project documentation:\n1. Search for docs/ directory\n2. Check for README.md\n3. Look in standard locations\n4. Ask user if not found"
}
```

## Conditional Path Usage

Combine with conditional templates:

```json
{
  "directive": "{{#if get-initial-requirements.testing_guide_path}}Read testing guide from {{get-initial-requirements.testing_guide_path}}{{else}}Determine validation from the actual project configuration{{/if}}"
}
```

:::tip
Collect paths needed by the current responsibility. Treat them as data: check ownership, allowed location and actual existence before reading or writing. Templates do not validate filesystem access.
:::

## Real Example

Collector configuration fragment; add the agent directive, type, completion condition and connections in the containing workflow:

```json
{
  "id": "get-initial-requirements",
  "inputSchema": {
    "properties": {
      "checklist_path": {
        "type": "string",
        "description": "Path to project checklist or empty if none"
      },
      "agent_onboarding_path": {
        "type": "string",
        "description": "Path to agent onboarding document or empty if none"
      },
      "docs_standards_path": {
        "type": "string",
        "description": "Path to documentation standards or empty if none"
      },
      "testing_guide_path": {
        "type": "string",
        "description": "Path to testing guide or empty if none"
      }
    }
  }
}
```

Used later:

```json
{
  "directive": "{{#if get-initial-requirements.checklist_path}}Review project checklist: {{get-initial-requirements.checklist_path}}{{/if}}"
}
```

## Path Validation

An inputSchema pattern checks only string format. This example restricts names to ASCII and excludes spaces; adapt it to the project. It does not prevent traversal or enforce an authorized filesystem boundary:

```json
{
  "properties": {
    "file_path": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9/_.-]+$"
    }
  }
}
```

## Related Patterns

- [Information Collection](/docs/patterns/information-collection/) - Collect paths as part of onboarding
- [Skip Pattern](/docs/patterns/skip/) - Skip steps when paths not available
