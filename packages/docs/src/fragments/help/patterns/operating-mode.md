A workflow that a caller may want to run unattended declares an operating mode: `interactive`, where
every approval gate stays, or `autonomous`, where the workflow routes around waits for a human and
delivers a final report instead. The mode is one declared global and a condition before each gate —
not a second version of the workflow, and not a flag inside every node.

## Declaring the mode

Declare exactly one registry global with a two-value enum:

```json
{
  "variableRegistry": {
    "operating_mode": {
      "type": "string",
      "enum": ["autonomous", "interactive"],
      "description": "How this run treats the user before the final result: autonomous skips the plan approval and the acceptance question, interactive keeps them"
    }
  }
}
```

## Resolving it once

The first node that already talks to the user resolves the mode in the same turn, listing it in
`inputSchema.globalInputs`. A separate turn whose only output is that value adds a step without new
judgment. The directive tells the agent to reuse a mode the user already stated, to infer an
unambiguous one — including a run started as a child of an already autonomous process — and
otherwise to ask once while naming the consequence. The mode holds for the whole run and is never
asked again.

## Routing around a gate

A `condition` on the global precedes each approval gate and sends the autonomous branch to the node
the gate reaches on approval. The gate keeps its directive, schema, and interactive routes, including
its rejection loop:

```json
{
  "id": "route-operating-mode-plan-approval",
  "type": "condition",
  "condition": {
    "operator": "eq",
    "left": { "contextPath": "operating_mode" },
    "right": "autonomous"
  },
  "connections": {
    "true": "check-steps-remaining",
    "false": "present-plan"
  }
}
```

Retarget every incoming edge of the gated node to its condition. A single back edge left pointing at
the gate — from a repair loop, for example — will still stop an autonomous run at the approval.

## What autonomy removes and what it never removes

Autonomous mode removes only waits for a human: approvals, acceptances, feedback prompts, and
decisions the agent can derive from evidence it already has.

It never removes independent agent reviews, validation, replan or recovery routes. It never removes
an authority gate either: publication, destructive operations, and external mutations stay
user-authorized, and in autonomous mode such a node resolves to the safe answer without asking rather
than being routed away. The user still receives a final report in both modes, so an autonomous branch
needs a report responsibility where the interactive branch both reports and asks.

:::caution
An `inputSchema` cannot branch on a context variable, so mode handling is route-based. Do not add
statuses, counters, `*_skipped` flags, duplicate mode aliases, or a mode question inside each
gate.
:::

## Related

- [Branching](/docs/patterns/branching/) - the condition mechanics used for the routes
- [Escalation](/docs/patterns/escalation/) - what still reaches the user when a run cannot proceed
- [Process Revision](/docs/patterns/process-revision/) - a revision re-enters the same gates in both modes
- [Anti-Patterns](/docs/patterns/anti-patterns/) - the flags and aliases a mode must not introduce
