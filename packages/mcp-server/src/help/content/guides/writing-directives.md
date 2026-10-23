---
title: Writing Directives
description: Best practices for writing clear and effective workflow directives
---

## Directive Structure

An `agent-directive` node needs an ID, directive, completion condition and success connection.
Add `inputSchema` when the agent must return data:

```json
{
  "type": "agent-directive",
  "id": "unique-id",
  "directive": "What the agent should do",
  "completionCondition": "When the task is complete",
  "inputSchema": {
    "type": "object",
    "properties": { "result": { "type": "string" } },
    "required": ["result"]
  },
  "connections": { "success": "next-node" }
}
```

Without `inputSchema`, complete the step with an empty object; arbitrary fields are refused.

## Writing Clear Directives

### Be Specific

❌ Bad:

```
"Fix the bugs"
```

✅ Good:

```
"Resolve the reported TypeScript errors in src/auth/ without changing the intended authentication behavior. Report the project typecheck command, its actual result, and any unresolved errors."
```

### Include Context

Use template variables:

```
"Implement step {{plan.current_step_index}} of {{plan.total_steps}}: {{plan.current_step_name}}\n\nExpected outcome: {{plan.expected_outcome}}"
```

Here `plan` is an earlier node whose validated output contains those fields. Read local outputs as
`node-id.field`; a bare name is available only when declared in `variableRegistry`. Do not invent
values for missing context. Report the missing prerequisite or take an explicit recovery route.

### Specify Output Requirements

```
"Run tests and report results.\n\nRequired output format:\n- Total tests\n- Passed count\n- Failed count\n- List of failed test names"
```

## Completion Conditions

### What Makes a Good Condition

- **Measurable**: Can be verified objectively
- **Specific**: Clear pass/fail criteria
- **Complete**: All requirements covered

### Examples

❌ Vague:

```
"Task is done"
```

✅ Specific:

```
"All tests pass (npm test shows 0 failures)"
```

✅ Multi-criteria:

```
"Implementation complete:\n- Feature works as specified\n- Tests added and passing\n- No TypeScript errors"
```

:::caution
An unambiguous condition helps an agent or reviewer judge completion; it does not prove the work
was done. Require evidence appropriate to the result, and provide a truthful failure or blocked
route when the criterion cannot be met. A schema validates the submitted shape, not the truth of
its claims. A directive also cannot grant missing access or user approval.
:::

## Using InputSchema Effectively

### Require Evidence

```json
{
  "inputSchema": {
    "type": "object",
    "properties": {
      "task_completed": { "type": "string", "enum": ["yes", "no"] },
      "evidence": {
        "type": "string",
        "description": "Concrete proof: command output, test results, etc."
      }
    },
    "required": ["task_completed", "evidence"]
  }
}
```

### Force Explicit Choices

```json
{
  "inputSchema": {
    "type": "object",
    "properties": {
      "quality_check": {
        "type": "string",
        "enum": ["pass", "fail"],
        "description": "Did implementation meet quality standards?"
      }
    },
    "required": ["quality_check"]
  }
}
```

### Route on the Answer

An enum answer usually decides where the run goes next. Put the `cases` on the same node, so the
step that has the evidence is the step that decides. If the workflow has an authorized budget of
three reviews, declare its counter in the workflow:

```json
{
  "variableRegistry": {
    "review_round": {
      "type": "integer",
      "description": "Number of validated review answers counted against the review budget",
      "minimum": 0,
      "default": 0
    }
  }
}
```

Then use this node fragment, with every connection target defined in the graph:

```json
{
  "id": "review",
  "type": "agent-directive",
  "directive": "Review the change against the acceptance criteria.",
  "completionCondition": "Verdict recorded with the findings that support it",
  "inputSchema": {
    "type": "object",
    "properties": {
      "verdict": { "type": "string", "enum": ["pass", "repair", "blocked"] },
      "findings": { "type": "string", "minLength": 1 }
    },
    "required": ["verdict", "findings"]
  },
  "expressions": ["review_round = review_round + 1"],
  "cases": [
    {
      "when": { "operator": "eq", "left": { "contextPath": "review.verdict" }, "right": "pass" },
      "output": "passed"
    },
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "review.verdict" },
        "right": "blocked"
      },
      "output": "blocked"
    },
    {
      "when": { "operator": "gte", "left": { "contextPath": "review_round" }, "right": 3 },
      "output": "exhausted"
    }
  ],
  "connections": {
    "success": "fix-issues",
    "passed": "merge",
    "blocked": "escalate",
    "exhausted": "escalate",
    "error": "handle-error"
  }
}
```

`review.verdict` and `review.findings` are node-local outputs. Only `review_round` is a declared
global. The expressions run after the answer is validated and before the cases, so a case can read
what they computed. Cases are tried in order: a passing review goes to `merge`, including on the
last allowed round; blocked work escalates; a repair verdict at the budget limit escalates. Otherwise
the `success` fallback goes to `fix-issues`. A counter bounds attempts; it does not establish quality.
`error` and `timeout` are reserved for control flow: no case may name them, and they need none.

Use `inputSchema.globalInputs` only when an answer must update a declared global; node-local output
needs no global write. `directive` and `completionCondition` are templated, while `inputSchema`
is presented as a schema: do not expect `{{...}}` strings inside it to be expanded.

### Collect Structured Data

```json
{
  "inputSchema": {
    "type": "object",
    "properties": {
      "test_results": {
        "type": "object",
        "properties": {
          "total": { "type": "integer", "minimum": 0 },
          "passed": { "type": "integer", "minimum": 0 },
          "failed": { "type": "integer", "minimum": 0 }
        },
        "required": ["total", "passed", "failed"]
      }
    },
    "required": ["test_results"]
  }
}
```

## Rules Are Outcomes, and Each Carries Its Reason

Where a directive states a rule — what a plan must be, what a review may block on, what evidence
counts — state the outcome the result must satisfy, and say why the opposite is bad.

An outcome can be judged against a case its author never imagined; a procedure can only be replayed,
so it is right exactly where the author's picture holds and quietly wrong everywhere else. The
reason is what lets an executor apply a rule to an unforeseen case instead of guessing, and what
lets a reviewer argue with the rule on the merits rather than on whether it was obeyed.

State each criterion's scope. Do not manufacture artifacts for unrelated criteria, but explain an
exclusion when it affects acceptance. Uncertainty about whether a rule applies is not proof that
it is satisfied.

❌ Procedure:

```
"STEP 1: read the plan. STEP 2: check every item has a verification. STEP 3: report the count."
```

✅ Outcome with its reason:

```
"Every unit names the evidence that would accept it, in observable terms.\n\nWhy: acceptance criteria written as adjectives — robust, clean, complete — cannot be met or refused, so they end up decided by whoever is more insistent."
```

:::caution
Raising the voice is not a substitute: MANDATORY, NEVER and CRITICAL add no state of the world in
which the rule holds or fails. See [Directive as a Drill Order](/docs/patterns/anti-patterns/).
:::

## Directive Patterns

### Sequenced Work

Give the order only where the order is a real dependency, and say what makes it one:

```
"Migrate the schema before switching the reader, because the reader rejects rows the old schema still produces.\n\nReport the state after each of the two, with the command you used."
```

### Conditional Instructions

```
"{{#if inspection.has_tests}}Run the relevant suite: {{inspection.test_command}}{{else}}Report that no suite is configured and verify the result by the available appropriate method.{{/if}}"
```

### Verification Requirements

```
"Verify implementation:\n\n- [ ] Feature works as specified\n- [ ] Edge cases handled\n- [ ] Error messages clear\n\nProvide evidence for each checkbox."
```

## Common Mistakes

### Too Much Freedom

❌ Problem:

```
"Make the code better"
```

✅ Solution:

```
"Refactor auth validation so callers use one existing validation boundary, accepted inputs keep their behavior, and invalid inputs produce the documented refusal. Choose the implementation after inspecting current callers and report the evidence for those properties."
```

### Missing Context

❌ Problem:

```
"Fix the error"
```

✅ Solution:

```
"Investigate the failure in {{diagnosis.file_path}}:\n\nObserved error: {{diagnosis.last_error}}\nConfirm the cause before changing code, and report whether the selected check now distinguishes the corrected behavior."
```

### Avoidable Routing Scaffolding

A `condition` or `expression` node whose only job is to route or count what the preceding directive
already knows is avoidable routing scaffolding: it adds a hop the reader must follow and a second
place the decision can drift from its evidence. Fold it into the directive as `cases` or an
`expressions` entry — and keep a standalone node where the decision is genuinely shared, reads state
no single node produced, or earns a named place in the route.

❌ Problem:

```
[validate] → [route-validation] → [fix] / [next]
```

✅ Solution:

```
[validate, cases on issues_count] → [fix] / [next]
```

### No Success Criteria

❌ Problem:

```
"completionCondition": "Done"
```

✅ Solution:

```
"completionCondition": "npm test passes with 0 failures, npm run build completes without errors"
```

:::tip
Read your directives from the agent's perspective. Would you know exactly what to do and when
you're done?
:::

## See Also

- [Input Schema](/docs/reference/input-schema/) - Structuring expected responses
- [Templates](/docs/concepts/templates/) - Using variables in directives
