---
title: Validation Loop Pattern
description: Verify results and retry on failure
---

## Purpose

Ensure quality by verifying results and retrying if they don't meet criteria. Prevents low-quality outputs from proceeding.

## Structure

```
[action] → [check] → success → [next]
              ↓
           failure → [fix] → [increment-iteration] → [action]
```

## Implementation

### Action Node

```json
{
  "type": "agent-directive",
  "id": "do-work",
  "directive": "Complete the task against its actual acceptance criteria. Report unresolved findings honestly.",
  "completionCondition": "Task completed with quality standards met",
  "inputSchema": {
    "type": "object",
    "properties": {
      "result": { "type": "string" },
      "quality_check_passed": { "type": "string", "enum": ["yes", "no"] }
    },
    "required": ["result", "quality_check_passed"]
  },
  "connections": { "success": "check-quality" }
}
```

### Check Node

```json
{
  "type": "condition",
  "id": "check-quality",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "do-work.quality_check_passed" },
        "right": "yes"
      },
      "output": "passed"
    }
  ],
  "connections": {
    "passed": "next-step",
    "default": "fix-issues"
  }
}
```

### Fix Node

```json
{
  "type": "agent-directive",
  "id": "fix-issues",
  "directive": "Repair the confirmed findings in {{do-work.result}} at their source; preserve valid work and return to verification.",
  "completionCondition": "Confirmed defects repaired, with relevant checks performed or their blocker reported",
  "connections": { "success": "increment-iteration" }
}
```

### Iteration Counter

Use a counter only for a real retry budget or evidence-directory consumer. This example assumes a numeric `current_iteration` registry entry with description and `default: 0`. Otherwise omit the counter and connect repair directly to verification:

```json
{
  "type": "expression",
  "id": "increment-iteration",
  "expressions": ["current_iteration = current_iteration + 1"],
  "connections": { "default": "check-max-iterations" }
}
```

:::caution
A counter without an enforced policy only counts repetitions. Retry after a diagnosed cause or changed work; stop at a real blocker or an applicable retry budget.
:::

## With Max Iterations

Add check before retry:

```json
{
  "type": "condition",
  "id": "check-max-iterations",
  "cases": [
    {
      "when": {
        "operator": "lt",
        "left": { "contextPath": "current_iteration" },
        "right": 5
      },
      "output": "under-limit"
    }
  ],
  "connections": {
    "under-limit": "do-work",
    "default": "escalate-to-user"
  }
}
```

## Bounded Re-Validation Loop

A re-validation loop revisits the same node. Explain which artifact changed and which findings must be rechecked. Include a numeric bound only when the domain or caller imposes one.

### Counter is an Expression Node

When a counter has a real consumer, increment it in an expression node and declare it in `variableRegistry` with a numeric default. This registry fragment illustrates a chosen retry policy, not universal limits.

```json
{
  "variableRegistry": {
    "validation_round": {
      "type": "number",
      "description": "Re-validation pass counter",
      "default": 0
    },
    "max_validation_rounds": {
      "type": "number",
      "description": "Re-validation bound",
      "default": 5
    }
  }
}
```

```json
{
  "type": "expression",
  "id": "increment-validation-round",
  "expressions": ["validation_round = validation_round + 1"],
  "connections": { "default": "re-validate" }
}
```

### Loop-Entry Cue

The loop-entry directive renders the round counter and states that the repetition is expected:

```json
{
  "type": "agent-directive",
  "id": "re-validate",
  "directive": "Re-validation pass {{validation_round}} of {{max_validation_rounds}}. Inspect the changed artifact against the criteria. Report unresolved findings, an unchanged failure or a real blocker honestly; do not blindly replay an uncertain external action.",
  "completionCondition": "Work re-checked against criteria",
  "inputSchema": {
    "type": "object",
    "properties": {
      "all_resolved": { "type": "string", "enum": ["yes", "no"] }
    },
    "required": ["all_resolved"]
  },
  "connections": { "success": "check-resolved" }
}
```

:::caution
The wording is illustrative. Re-entering review after repair is expected; unchanged work, a real blocker or unsafe external replay must still be reported honestly. A loop cue never authorizes blind retry.
:::

## Numeric Quality Check

For a property a machine can decide, route on the machine's own answer — a count of reproducible
findings, an exit status, a coverage gap:

```json
{
  "inputSchema": {
    "properties": {
      "issues_count": { "type": "number", "minimum": 0 }
    },
    "required": ["issues_count"]
  }
}
```

```json
{
  "when": {
    "operator": "eq",
    "left": { "contextPath": "validate-result.issues_count" },
    "right": 0
  },
  "output": "clean"
}
```

Do not route on a quality score. A number a reviewer assigns to coherence, depth or architecture
does not distinguish two states of the result — seven against eight says nothing a reader could
verify — and the threshold is met by adjusting the number. Where the property is qualitative, the
gate is the reviewer's reasoned verdict and the count of findings that verdict produced. See
[Fixed Semantic Quality Score](/docs/patterns/anti-patterns/).

## Real Example

This example assumes declared step metadata and existing target nodes in the containing workflow:

```json
{
  "id": "verify-step-implementation",
  "type": "agent-directive",
  "completionCondition": "Actual step result assessed against its expected output and gaps reported",
  "connections": { "success": "route-verification" },
  "directive": "Verify step {{current_step_name}} implementation:\n- Expected: {{expected_output}}\n- Check actual matches expected",
  "inputSchema": {
    "properties": {
      "step_verified": { "type": "string", "enum": ["yes", "no"] },
      "verification_evidence": { "type": "string" }
    },
    "required": ["step_verified", "verification_evidence"]
  }
}
```

## Agent Behavior at Validation Gates

When a workflow includes validation gates (nodes that ask user for approval), the agent must follow strict rules:

### Validation Gate Directive Pattern

A gate directive says what its answer records and where each answer leads, so the agent can see that
answering honestly is the only way the run proceeds correctly:

```
`plan_approved` records the user's own answer. Anything other than an unqualified yes is a no, and the
feedback belongs in `user_feedback` — the flow routes a no to the responsibility that owns the
repair, so a correction made here instead is a change nobody reviewed.
```

### Why This Matters

A gate exists to move a decision to whoever owns it. An agent that reads the answer as "minor
corrections I can apply myself" delivers work the flow never routed through its repair and review
path, and an `approval = "yes"` recorded over feedback loses the feedback entirely. Naming the
consequence — where a no goes, what a yes closes — is what makes the honest answer the useful one.

### Example Validation Gate

```json
{
  "type": "agent-directive",
  "id": "approve-plan",
  "directive": "Present the plan and ask whether it is approved.\n\nPlan: {{prepare-plan.summary}}\n\n`plan_approved` records the user's own answer: anything other than an unqualified yes is a no, with the exact words in `user_feedback`. A no routes to the responsibility that owns the revision, so a correction made here instead is a change nobody reviewed.",
  "completionCondition": "User confirmed or rejected plan",
  "inputSchema": {
    "type": "object",
    "properties": {
      "plan_approved": { "type": "string", "enum": ["yes", "no"] },
      "user_feedback": { "type": "string" }
    },
    "required": ["plan_approved"],
    "if": { "properties": { "plan_approved": { "const": "no" } }, "required": ["plan_approved"] },
    "then": {
      "required": ["user_feedback"],
      "properties": { "user_feedback": { "type": "string", "minLength": 1 } }
    }
  },
  "connections": { "success": "route-plan-approval" }
}
```

## Related Patterns

- [Step Verification](/docs/patterns/step-verification/) - Verify specific steps
- [Escalation](/docs/patterns/escalation/) - Handle repeated failures
