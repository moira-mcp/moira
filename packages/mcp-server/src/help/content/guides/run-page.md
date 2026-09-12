---
title: Reading a run
description: How to read one execution as a process on the run page, follow its route, and answer a waiting step
---

Opening an execution in the web UI (`/executions/<id>`, or `/admin/executions/<id>` for an
administrator) shows the **run page**: one run of a workflow shown as the process the workflow
declares. Everything on the page comes from the run's recorded route; nothing is inferred from
block order. A workflow without a process view (`progress`) shows the technical node graph and the
context tabs instead.

## Modes

The tabs above the picture switch how the same run is shown; the choice is in the URL as `view`.

- **Lanes** (default) — one card per block in process order. The block the run is on is pinned
  as "you are here" and marked _in progress_ or _waiting for you_; a completed block shows a tick,
  a block that ran several times shows its pass count (×2, ×3), a block the run bypassed is struck
  through as _skipped_, and blocks not reached yet are dimmed. Return arcs under the rail are the
  loops, labelled with what causes them; thin links above the rail are transitions that skip a
  block. Below the rail the selected block's outcome text is written out.
- **Canvas** — the process as a map filling the whole view: blocks left to right, forward
  transitions as arrows with their labels, loops as dashed lines below; a block that many other
  blocks lead into (a replan or stop block) receives one thin line from each of them, and the
  source names it in a small chip. The map opens on the current block; scroll or drag to pan, pinch
  (or hold Ctrl and scroll) to zoom. The lanes rail pans and zooms the same way.
- **Outline** — the process as a document: every block as a numbered section with its
  description, what the run produced there, what its steps wrote, its transitions in words
  (including why a loop happens and when it ends), and its steps with the evidence each demands.
- **Route** — the run as the route it took: each card is a stretch of consecutive steps inside one
  block, a badge counts the times the run returned to a block, a line marks a return to an earlier
  block, and each step shows the connection it left through, whether it waited for input, and what
  it set.

## The cursor

The slider above the picture is the **route cursor** (`at` in the URL). Dragging it, or clicking a
step in the route, shows the run as it stood at that step: the route fades after the cursor, the
other modes show the block statuses of that moment, and the variables tab shows the values written
up to it. "Show whole run" returns to the present.

## The panel

- **Block** — the selected block (the current one by default): its status, description, outcome
  text, where it leads, and its steps. Each step names the fields it must return — the evidence
  Moira validates before the run continues. Clicking a step shows it on the technical node graph.
- **Variables** — every declared variable and every step output with its current value and a
  history of the steps that changed it. A value set from outside the flow is marked _adjusted_.
- **Context** — the context editor: a declared variable the workflow's `runtimePolicy` allows to
  be edited at the current step can be changed here (the variables tab offers a shortcut to it).
- **Errors**, **Steps**, **Graph**, **Locks** — the execution's error history, the technical step
  list, the node graph, and lock history.

## Answering a waiting step

When the run waits for a step's input and you own the execution (or are an administrator), the
variables tab shows **Answer the waiting step** with the fields that step demands, including the
declared global variables it writes. Submitting runs the answer as an ordinary engine step: the
input is validated against the step's schema exactly as an agent's answer would be, and a rejected
answer is shown with the step's message and changes nothing. An accepted answer continues the route
and is recorded on it as a runtime adjustment with your name, as is a variable edited in the
context tab.

An agent that was holding the step you answered receives `ATTEMPT_STALE` on its next `step` and
reads `session current_step` for the step the run is now on. An answer is refused while an agent is
executing the current step, on a locked or finished execution, and when the page's copy of the run
is behind the server's (reload and answer again).

## Explaining the page

**Explain this page** walks through the page in six steps — block, step, evidence, loop, route,
and the modes — highlighting the element that shows each on the live run. The step is in the URL as
`guide`, so a position can be linked to. Every mode opens with a short note saying what it is for.
