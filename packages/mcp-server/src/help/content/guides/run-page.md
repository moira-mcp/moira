---
title: Reading a run
description: How to read one execution as a process on the run page, follow its route, and answer a waiting step
---

Opening an execution in the web UI (`/executions/<id>`, or `/admin/executions/<id>` for an
administrator) shows the **run page**: one run of a workflow shown as the process the workflow
declares. Everything on the page comes from the run's recorded route; nothing is inferred from
block order. A workflow without a process view (`progress`) shows the technical node graph and the
variables panel instead.

## Modes

The tabs above the picture switch how the same run is shown; the choice is in the URL as `view`.

- **Lanes** (default) — one card per block in process order. The block the run is on is pinned
  as "you are here" and marked _in progress_ or _waiting for you_; a completed block shows a tick,
  a block that ran several times shows its pass count as small muted text (×2, ×3), a block the run bypassed is struck
  through as _skipped_, and blocks not reached yet are dimmed. Thin arcs under the rail are the
  loops and thin links above it are transitions that skip a block; neither carries a label at
  rest. Each card names its loops and skips in chips (`↩ 3 Plan` returns to block 3, `↗ 6 Stop`
  skips to block 6, `↩ 3 Plan ×2` folds two loops to the same block); hover a chip or a line to
  light the line(s) and read the label and, for a single loop, what causes it and what ends it; a
  card you selected keeps its lines lit. Below the rail the
  selected block's outcome text is written out.
- **Canvas** — the process as a map filling the whole view: blocks left to right, adjacent
  forward transitions as arrows with their labels, loops as thin dashed lines below and transitions
  that skip blocks above; a block that many other blocks lead into (a replan or stop block)
  receives one thin line from each of them. Every loop, skip and exit into such a block is named
  by a chip in its source block, and so are three or more parallel transitions into the next block
  (one chip with their count instead of a pile of labels); hover the chip (or the line) to light it
  and read its label, and select a block to keep its lines lit. The map opens on the current block; scroll or drag to pan,
  pinch (or hold Ctrl and scroll) to zoom. The lanes rail pans and zooms the same way.
- **Outline** — the process as a document: every block as a numbered section with its
  description, what the run produced there, what its steps wrote, its transitions in words
  (including why a loop happens and when it ends), and its steps with the evidence each demands.
- **Route** — the run as the route it took: each card is a stretch of consecutive steps inside one
  block, a small count beside the block name says which visit to that block it is, a line marks a
  return to an earlier block, and each step shows the connection it left through, whether it waited for input, and what
  it set.

## The cursor

The slider above the picture is the **route cursor** (`at` in the URL). Dragging it, or clicking a
step in the route, shows the run as it stood at that step: the route fades after the cursor, the
other modes show the block statuses of that moment, and the variables tab shows the values written
up to it. "Show whole run" returns to the present.

## The panel

The panel's tabs form one strip that wraps on a narrow panel instead of scrolling; hovering a tab
says what it holds, a count badge on **Errors** gives the number of recorded errors, and a `!`
badge on **Variables** or **Locks** means a step is waiting for your answer or a lock is active.

- **Block** — the selected block (the current one by default): its status, description, outcome
  text, a muted facts line (steps, how many times it ran, visits), where it leads, and its steps
  as cards of one shape — the type badge in the same place on every card, then the step's name,
  the first sentence of its instruction and the fields it must return, the evidence Moira
  validates before the run continues. Clicking a step shows it on the technical node graph.
- **Variables** — the run's values as two collapsible groups of aligned rows: every declared
  variable (name, current value, a small count that opens the history of the steps that changed
  it) and every step's outputs under its step. Objects open as a tree inside the row. A declared
  variable the workflow's `runtimePolicy` allows to be edited at the current step is an input in
  its row: change it and save. A value set from outside the flow is marked _adjusted_. The
  filter narrows both groups; the expand button opens the same panel in a larger window.
- **Errors**, **Steps**, **Graph**, **Locks** — the execution's error history, every step of the
  definition on the same cards as the Block tab (block by block, the steps the run has visited
  marked completed, the current one marked), the node graph (step cards grouped by block, the
  run's block statuses as tints, the current step marked and in view when the tab opens, the fit
  and direction controls in the zoom cluster), and lock history.

## Answering a waiting step

When the run waits for a step's input and you own the execution (or are an administrator), the
variables tab shows **Answer the waiting step** with the fields that step demands, including the
declared global variables it writes. Submitting runs the answer as an ordinary engine step: the
input is validated against the step's schema exactly as an agent's answer would be, and a rejected
answer is shown with the step's message and changes nothing. An accepted answer continues the route
and is recorded on it as a runtime adjustment with your name, as is a variable edited in its
row of the variables panel.

An agent that was holding the step you answered receives `ATTEMPT_STALE` on its next `step` and
reads `session current_step` for the step the run is now on. An answer is refused while an agent is
executing the current step, on a locked or finished execution, and when the page's copy of the run
is behind the server's (reload and answer again).

## Explaining the page

**Explain this page** walks through the page in six steps — block, step, evidence, loop, route,
and the modes — highlighting the element that shows each on the live run. The step is in the URL as
`guide`, so a position can be linked to. Every mode opens with a short note saying what it is for.
