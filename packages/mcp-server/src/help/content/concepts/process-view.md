---
title: Process view
description: How to read a workflow as a process of blocks and how to read a run of it
---

Moira shows every workflow that declares `progress` as a **process view**: a short chain of
blocks a newcomer can read without knowing the graph underneath. The same view shows a **run**
of that workflow: which blocks are done, which one is active, which were repeated or skipped, and
the route the run actually took. This topic explains the vocabulary and how each picture is
produced.

## Vocabulary

- **Block.** One stage of the process as a person would name it — "Draft the plan",
  "Independent plan review", "Execute plan steps". A workflow's `progress.nodes` array lists its
  blocks in process order; each has a label and a one-sentence description (`content.summary`).
- **Step.** One authored node of the workflow graph: a directive the agent executes, a condition
  or expression that routes, a start or an end. Every step belongs to exactly one block through
  its `progressNodeId`, routing steps included, so nothing the run does falls outside the
  picture.
- **Evidence.** What a step must return to finish — its input schema. A block's outcome text
  (`content.outcome`) is a template over the variables its steps write, so the run shows what a
  block concluded, not only that it ran.
- **Transition.** An edge that leaves a block for another block. Each carries a short label
  from `connectionLabels` on the authored step, such as "plan approved" or "review found
  defects", so the arrow explains itself.
- **Loop.** A transition back to an earlier block, or to the same block. Its label also states
  the cause of the repetition and what ends it (`cycle.cause`, `cycle.exit`); the view marks
  the arrow as a return.
- **Hub.** A block that several other blocks lead into (a replan or a stop). It is placed after
  the blocks that feed it, so the process reads left to right, and every view draws one bundled
  connector from each source into it, named by a chip in the source.
- **Run.** One execution of the workflow. The engine records its **route**: every step it ran,
  the connection it left through, the variables it changed, and where it waited.

## The flow page: the process without a run

The process is derived from the workflow definition alone: blocks from `progress.nodes`,
membership from `progressNodeId`, transitions and loops from the labelled edges. Nothing about it
is drawn separately, so the picture cannot drift from the graph. Validation refuses a workflow
whose process would be unreadable: a step without a block (`unowned-node`), a block without a
description (`empty-description`) or without steps (`empty-block`), a boundary edge without a
label (`unlabeled-edge`), a return without its cause and exit (`unexplained-cycle`), an outcome
template on a block that owns no writer of its variable (`outcome-unowned`) or on two blocks
(`outcome-duplicate`), a block with no transition to or from another block
(`unconnected-block`; the block owning the start node is exempt, and a self-return alone connects
nothing). `moira-workflow <file> derive` prints the derived process with any of
these diagnostics, and `set-block`, `add-block`, `edit-block`, `set-label` and `clear-label`
author it one change at a time.

The web UI shows this derivation on the **flow page** (`/workflows/<id>`, see the _Reading and
editing a flow_ guide): outline, canvas, lanes and a split of blocks against their steps, plus the
technical node graph. The owner can edit the definition there — blocks, transition labels and
loops, step ownership and text, the variable registry — with the diagnostics above shown inline
while typing and a save that is refused for an invalid definition or a stale revision.

## The run page: the process with a route

A run is projected onto the process from its recorded route, never guessed from block order:

- **active** — the block of the last step the run reached; **waiting** when that step is
  paused for a person's or the agent's input;
- **done** — a visited block whose working steps completed once; **repeated ×n** — the same
  after n passes through its working steps (a review that ran twice shows ×2);
- **skipped** — a block the run bypassed, or entered without doing its work (only its routing
  steps ran);
- **pending** — not reached yet.

An unvisited block is never shown as done. The route itself is available as an ordered list
with loop markers, every variable carries its value history, and a value set from outside the
flow (a runtime adjustment) is shown as such with who made it. A route cursor shows the run as it
stood at any earlier visit, and the execution's owner can answer the step the run waits for from
the page; the answer is validated like an agent's and recorded as an adjustment (see the
_Reading a run_ guide). A run recorded before routes existed shows only its current block and
says that no route was recorded.

## Making a workflow readable

Name blocks for what a person would call the stage, keep descriptions to one sentence, label
every boundary edge with the decision it represents, and explain every return with its cause and
exit. Prefer three to fifteen blocks; put routing steps in the block whose decision they route.
The Workflow Management Flow requires all of this when it creates or edits a workflow, and
`session({ action: "progress" })` or `GET /api/executions/:id/progress` returns the run view.
