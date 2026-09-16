---
title: Reading a run
description: How to read one execution as a process on the run page, follow its route, and answer a waiting step
---

Opening an execution in the web UI (`/executions/<id>`, or `/admin/executions/<id>` for an
administrator) shows the **run page**: one run of a workflow shown as the process the workflow
declares. Everything on the page comes from the run's recorded route; nothing is inferred from
block order. A workflow without a process view (`progress`) shows the technical node graph and the
variables panel instead.

## Views

The two tabs above the picture show the same run in two ways; the choice is in the URL as `view`.

- **Map** (default) — the process as a diagram with its table of contents. A compact band above
  the diagram names the run: its task, the title it rendered for itself when that differs, its
  goal and the projection's facts as chips. The diagram draws the blocks left to right in process
  order: the main sequence of the process on one row, each side branch on a row of its own
  above or below it, and a block many others lead into or that is reached only by loops beneath
  them; adjacent forward transitions as arrows with their labels, loops as thin dashed lines
  below and transitions that skip blocks above; a block that many other blocks lead into (a
  replan or stop block) receives one thin line from each of them. Every loop, skip and exit into
  such a block is named by a chip in its source block, and so are three or more parallel
  transitions into the next block (one chip with their count); hover the chip (or the line) to
  light it and read its label, and select a block to keep its lines lit. The block the run is on
  is marked _in progress_, _agent on the step_ or _waiting for you_; a completed block shows a
  tick, a block that ran several times shows its pass count (×2, ×3), a block the run bypassed is
  struck through as _skipped_, and blocks not reached yet are dimmed. Under the name and the
  description a card shows its step count, the time spent in it so far and, when it is bound to a
  list, `done/total`. The map opens on the current block; scroll or drag to pan, pinch (or hold
  Ctrl and scroll) to zoom; the fit control shows the whole process at a readable size or, when
  the process is wider than the view, its beginning. The contents on the left list every block
  with its status, pass count, `done/total` and, when the owner's other completed runs of this
  version give one, how long the block typically takes; click one to select it, or type a step's id or
  text into the finder above to find the block that owns it. The one-line note above the diagram
  opens into an explanation of the view and remembers whether you left it open.
- **Graph** — the technical node graph: every workflow node as a step card grouped by block in
  process order, the run's block statuses as tints, the current step marked, and every long or
  returning connection named by chips in both cards instead of drawn. The block selected on the
  map keeps its frame highlighted here; the fit and direction controls are in the zoom cluster.
  Clicking a card opens its details: definition, evidence, and its connections as `output →
target` with the case that selects each output.

Switching tabs keeps the page as it is: the map keeps its selected block, the graph the position
you left it at, and nothing reloads.

## The cursor

The slider above the picture is the **route cursor** (`at` in the URL). Dragging it, or clicking a
step in the route, shows the run as it stood at that step: the map and the panel show the block
statuses of that moment, and the variables tab shows the values written up to it. "Show whole run" returns to the present.

## The panel

The panel's tabs form one strip that wraps on a narrow panel instead of scrolling; hovering a tab
says what it holds, a count badge on **Errors** gives the number of recorded errors (a second,
amber count says how many steps ran without a playbook they name), and a `!` badge on
**Variables** or **Locks** means you can answer the paused step from the page or a lock is active.

- **Block** — the selected block (the current one by default): its status, description, outcome
  text, a muted facts line (steps, how many times it ran, visits), then **Time** — every pass
  through the block with when it started, when it ended and how long it took, the pass in
  progress ticking, the total, and beside them how long a pass and a whole run through this block
  typically take across the run owner's completed runs of this workflow version; a pass recorded before
  timestamps existed shows "—", never "0 s". A block bound to a list shows the list as a
  **checklist** — `done of total`, each item with its state and time, the current one marked (a
  binding that only counts shows the counters). **Where it leads** words the transitions,
  including why a loop happens and when it ends; **What happened here** is the block's route
  facts — each visit with the connection it left through, what it changed and who set it; then
  its steps as cards of one shape — the type badge in the same place on every card, then the
  step's name, the first sentence of its instruction and the fields it must return, the evidence
  Moira validates before the run continues. Clicking a step shows it on the graph view.
- **Variables** — the run's values as two collapsible groups of aligned rows: every declared
  variable (name, current value, a small count that opens the history of the steps that changed
  it) and every step's outputs under its step. Objects open as a tree inside the row. A declared
  variable the workflow's `runtimePolicy` allows to be edited at the current step is an input in
  its row: change it and save. A value set from outside the flow is marked _adjusted_. The
  filter narrows both groups; the expand button opens the same panel in a larger window.
- **Errors**, **Steps**, **Locks** — the execution's error history (and, above it, the steps
  that ran without a playbook they name — the process continued with a placeholder in place of
  that text, so this is not an error, but it is named with the step), every step of the definition
  on the same cards as the Block tab (block by block, the steps the run has visited marked
  completed, the current one marked), and lock history.

## Who is waited for

A paused run says who it waits for. _Waiting for you_ appears only when a person must act — a
PIN gate (a `lock` step). While an agent is on a step, the card, the legend and the panel say
_agent on the step_; the run is not waiting for you, even though you may answer the step from the
variables tab in the agent's place.

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
and the views — highlighting the element that shows each on the live run. The step is in the URL as
`guide`, so a position can be linked to. The map's one-line note opens into what the view is for.
