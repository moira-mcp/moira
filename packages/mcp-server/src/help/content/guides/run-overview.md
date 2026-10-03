---
title: The overview of your runs
description: How the Overview page shows recent work, finds older runs, opens details, and stops your runs
---

**Overview** in the web UI's menu (`/overview`) opens on your unfinished runs with meaningful
activity in the last seven days. Choose **All time** to find older work. Each run has its own card
showing what it waits for and how far it got. Only your own runs are shown, also to an administrator.

## Who has the move

Each card starts with the run's status:

- **Waiting for you** — the run stands on a step its workflow marks as waiting for a person's
  decision (`humanGate`), or the agent said it cannot go on without you (`session await-user`). The
  card shows what you are asked — the step's label, or «Agent asks: …» with the question — and a line
  saying whether you were notified. Answer the agent in the chat, where it waits; the overview takes no
  answers, and the status clears by itself once the agent goes on.
- **Waiting for the agent** — the agent has a directive to work on.
- **Locked** — the run stands on a lock and waits for someone to enter its PIN.
- **Completed** — the run ended without an explicit stop, including a failed run or a retired
  blocked start.
- **Stopped** — the owner permanently ended the run with a recorded reason, through the web
  control or `session stop-execution`. The card and detail show that reason; it does not mean the task was completed.

The activity order puts the latest UTC hour first. Within an hour, creation time and run identity
keep the order stable; waiting status does not override the chosen order.

## What a card shows

Every card has the same height and the same rows, whatever the run: the status and how long ago its
last step was, the canonical task name, its own flow name and, for a child run, a separate «↳ child of …»
relationship, then the declared progress. The arbitrary note is separately
available even when it matches the title. A flow with progress blocks shows its stages; a stage
that works through a list — a plan or a checklist bound to the block — shows the items around the
current one, the done ones above and the next ones below, with the rest folded into «↑ N» and «↓ N».
A flow that declares neither says so instead of guessing a percentage. The footer says when the
current directive was shown and carries flags for child runs (shown / all direct children) and refusals (steps
the engine refused; the run goes on after them). Hover or focus an element for details; the card's
title opens a spacious modal with everything else — the parent runs, the question and its choices, the
current step, the whole list and every stage, the child runs, the dates — and **Open run**.

**The last step** is the last time the run did work: a step handed in, a directive shown, or a
variable changed by the agent or by you, or the task was meaningfully renamed. An identical normalized
title, a note, a reminder, a lock or a change of parent does not
count. A group's displayed age follows the retained matching work. Idle filters instead consider
the complete tree of owned descendants, so a parent with a busy child does not look idle.

## Child runs

A run started as the child of another stands with its parent in one group on a shared backdrop,
with its own card and plan; a child with children of its own is a group inside the group. Groups from
the third level down start folded — **show N** opens them. There are no arrows: the backdrop, the
group's heading and the child's subtitle say who belongs to whom. Each run appears once. When a
filter admits a child but not its parent, the necessary parent chain stays as labelled context.
Unrelated siblings outside the filter are left out. The child flag distinguishes shown direct
children from all direct children; those counts are not the size of the entire descendant tree.

Stopped runs do not match the default active view, but a stopped ancestor can remain as context
for an active child. Stopping the parent does not stop that child.

**Grid** packs single tasks and gives a group the full width; **Lanes** puts every task on its own
horizontal strip.

## Finding what stalled

- The status switch shows what is in progress (the default), one status, the completed runs,
  stopped runs or all. Select **Stopped** or **All** to find a stopped run.
- The period control selects **Last 7 days**, **Last 30 days** or **All time**, by meaningful
  activity rather than creation date. The line below the controls explains the current selection.
- **No movement > 7 days** keeps the unfinished tasks where nothing — not even a child run — took a
  step for a week. The status does not change with age; such a task can go on from where it stopped.
- **Filters** holds other intervals without movement, a range of the last step's date, the flow, the
  order (latest step, longest without movement, newest) and «only with refusals».
  The date range is under **Custom dates (optional)** and uses your local time zone. Choosing a period clears idle
  and date bounds; choosing idle or dates selects all time. **Current work from the last 7 days** restores recent active
  work. An empty recent view offers **All time** without changing stored runs.
- The flow filter offers every flow you can read, including choices beyond the first page of
  flows. If the list cannot be loaded, **Flow filter unavailable** appears with **Try again**;
  the overview remains available while you retry loading the choices.
- The search matches the task heading you can see, its separate arbitrary note, its own flow's
  name and the run's id, without case sensitivity. An overridden authored title does not remain a hidden search match.

Everything you set stays in the page's address, so a saved link — «my runs without movement for a
week» — opens the same view. An open modal is in the address too.

## Stopping your run

When available, **Stop task** opens a confirmation for that run with a required reason. Review the
task and submit the reason to stop it permanently. An operation in progress temporarily disables
the action. A failed request keeps your reason; a conflict requires **Use the current state for a new decision** and
a fresh decision, rather than silently repeating against another revision. Administrators cannot
stop another owner's run through their wider read access. Partial stages, lists and history remain
readable, without claiming that unfinished work succeeded.

## Live updates

The page updates itself: steps, notes, parent links and status changes refresh the current trees
without a browser reload, including their search membership, order and pagination. An open modal
stays on the same run and keeps its reading position through a rename or stop, even when the run
leaves the filtered page. Full task text, note, flow and reason are available there without hover.
Changes arriving together share a refresh. One request runs at a time, and changes
received while it is pending trigger one follow-up when it finishes, so continuous activity does
not prevent slow responses from updating the page. The indicator in the page header says how: **Live** when changes
arrive as they happen, **Reconnecting…** after the connection dropped (what was missed is caught up),
or **Every 15 s** when the live connection cannot be held — for example behind a proxy that cuts
long-lived responses — and the page checks for changes instead. With several tabs open, one tab holds
the connection for all of them, and a hidden page pauses it until you come back.
