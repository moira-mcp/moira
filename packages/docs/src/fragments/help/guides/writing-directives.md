## Directive Structure

Every agent-directive node needs:

```json
{
  "type": "agent-directive",
  "id": "unique-id",
  "directive": "What the agent should do",
  "completionCondition": "When the task is complete",
  "inputSchema": {/* expected response structure */},
  "connections": { "success": "next-node" }
}
```

## Writing Clear Directives

### Be Specific

❌ Bad:

```
"Fix the bugs"
```

✅ Good:

```
"Fix TypeScript compilation errors in src/auth/.\n\nSteps:\n1. Run tsc --noEmit\n2. Fix each error\n3. Verify compilation succeeds"
```

### Include Context

Use template variables:

```
"Implement step {{current_step_index}} of {{total_steps}}: {{current_step_name}}\n\nExpected outcome: {{expected_outcome}}"
```

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
Agents will claim completion when they believe the condition is met. Make conditions unambiguous
to prevent premature completion.
:::

## Using InputSchema Effectively

### Require Evidence

```json
{
  "inputSchema": {
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

### Collect Structured Data

```json
{
  "inputSchema": {
    "properties": {
      "test_results": {
        "type": "object",
        "properties": {
          "total": { "type": "number" },
          "passed": { "type": "number" },
          "failed": { "type": "number" }
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

Where a body of criteria is long enough to be walked item by item, open it by saying that a rule
which does not apply to the current change is met and needs nothing produced to prove it
inapplicable — otherwise it turns back into a checklist.

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
"{{#if has_tests}}Run test suite: {{test_command}}{{else}}No tests configured, skip testing{{/if}}"
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
"Refactor auth module:\n- Extract validation logic to separate function\n- Add error handling for null inputs\n- Add JSDoc comments"
```

### Missing Context

❌ Problem:

```
"Fix the error"
```

✅ Solution:

```
"Fix error in {{file_path}}:\n\nError message: {{last_error}}\nIteration: {{current_iteration}}"
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
