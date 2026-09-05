---
title: Completeness Self-Review
description: Verify every requirement against the real artifact before delivery
---

A workflow that produces a deliverable from explicit requirements should verify the finished artifact before delivery. The workflow that owns the domain also owns this review: it reads the frozen requirements, inspects the real implementation, writes a durable report, and returns the report path and counts in one schema-validated response.

## Rules

1. **Use the frozen requirements as the source of truth.** Do not substitute the current plan or the agent's memory.
2. **Inspect the real artifact.** For each requirement, cite concrete code, files, test output, or another reproducible observation.
3. **Write one durable report.** Record one ordered entry per requirement and classify it `COVERED` only when evidence proves it; otherwise use `GAP`.
4. **Return the complete summary atomically.** The same action returns `coverage_report_path`, `total_requirements`, and `requirements_gaps_count`. JSON Schema validates their shape; another agent or graph recount does not repeat the domain judgment.
5. **Route gaps back to implementation.** Zero gaps proceeds to delivery. A nonzero count enters the workflow's fix or replan branch.

Todo List is a generic sequential checklist and has an empty terminal result. Do not use it as a transport for coverage classifications, outcomes, or counters.

## Variable registry

Declare coverage values without defaults so an execution that has not completed the review cannot fabricate a zero-gap result:

```json
{
  "coverage_report_path": {
    "type": "string",
    "minLength": 1,
    "maxLength": 1000
  },
  "total_requirements": {
    "type": "integer",
    "minimum": 1,
    "maximum": 100
  },
  "requirements_gaps_count": {
    "type": "integer",
    "minimum": 0,
    "maximum": 100
  }
}
```

## Coverage action

The producing `agent-directive` writes a versioned report such as `requirements-coverage-report-v{attempt}.md` and returns all three globals together:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {},
  "required": ["coverage_report_path", "total_requirements", "requirements_gaps_count"],
  "globalInputs": ["coverage_report_path", "total_requirements", "requirements_gaps_count"]
}
```

The report may use domain terms such as `COVERED` and `GAP`; those classifications remain inside the owning workflow. JSON Schema proves only the returned types and bounds. The agent remains responsible for reading every requirement and making an evidence-based classification.

Record the completed pass immediately after this response, before any gap decision or agent-visible pause. This gives later abort and replan paths an unambiguous distinction between “coverage never ran” and “a complete prior report exists.”

## Gap check

```json
{
  "type": "condition",
  "id": "check-requirements-gaps",
  "condition": {
    "operator": "eq",
    "left": { "contextPath": "requirements_gaps_count" },
    "right": 0
  },
  "connections": {
    "true": "deliver",
    "false": "fix-gaps"
  }
}
```

:::caution
A zero default is not evidence that review ran. Keep review outputs absent until the coverage
action returns a complete schema-valid response.
:::

## Related

- [Validation Loop](/docs/patterns/validation-loop/) - Re-validation mechanics
- [Replan Pattern](/docs/patterns/replan/) - Extending the plan when coverage finds gaps
- [Todo List](/docs/reference/workflows/todo-list/) - Generic sequential checklist semantics
