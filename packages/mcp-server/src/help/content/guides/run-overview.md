---
title: The overview of your runs
description: How the Overview page shows every run you have in progress, what waits for you, what stalled, and how it stays current
---

**Overview** in the web UI's menu (`/overview`) shows every run of yours that has not finished, one
card per run, so you can see at a glance what each one waits for and how far it got. Only your own
runs are shown, also to an administrator.

## Who has the move

Each card starts with the run's status:

- **Waiting for you** — the run stands on a step its workflow marks as waiting for a person's
  decision (`humanGate`), or the agent said it cannot go on without you (`session await-user`). The
  card shows what you are asked — the step's label, or «Agent asks: …» with the question — and a line
  saying whether you were notified. Answer the agent in the chat, where it waits; the overview takes no
  answers, and the status clears by itself once the agent goes on.
- **Waiting for the agent** — the agent has a directive to work on.
- **Locked** — the run stands on a lock and waits for someone to enter its PIN.
- **Completed** — the flow reached its end or was cancelled.

Runs waiting for you always come first, whatever the order you chose.

## What a card shows

Every card has the same height and the same rows, whatever the run: the status and how long ago its
last step was, the task's title, the flow's name (or, for a child run, «↳ child of …» naming its
parent), then the progress the flow declares. A flow with progress blocks shows its stages; a stage
that works through a list — a plan or a checklist bound to the block — shows the items around the
current one, the done ones above and the next ones below, with the rest folded into «↑ N» and «↓ N».
A flow that declares neither says so instead of guessing a percentage. The footer says when the
current directive was shown and carries flags for child runs (in progress / all) and refusals (steps
the engine refused; the run goes on after them). Hover or focus an element for details; the card's
title opens a side panel with everything else — the parent runs, the question and its choices, the
current step, the whole list and every stage, the child runs, the dates — and **Open run**.

**The last step** is the last time the run did work: a step handed in, a directive shown, or a
variable changed by the agent or by you. A note, a reminder, a lock or a change of parent does not
count. For a run with child runs the card counts the latest step of the whole tree, so a parent
waiting on a busy child does not look idle.

## Child runs

A run started as the child of another stands with its parent in one group on a shared backdrop,
with its own card and plan; a child with children of its own is a group inside the group. Groups from
the third level down start folded — **show N** opens them. There are no arrows: the backdrop, the
group's heading and the child's subtitle say who belongs to whom. Each run appears once. When a
filter admits a child but not its parent, the child stands on its own and names the parent; when a
filter admits only one run of a group, the others stay in the group, dimmed.

**Grid** packs single tasks and gives a group the full width; **Lanes** puts every task on its own
horizontal strip.

## Finding what stalled

- The status switch shows what is in progress (the default), one status, the completed runs or all.
- **No movement > 7 days** keeps the unfinished tasks where nothing — not even a child run — took a
  step for a week. The status does not change with age; such a task can go on from where it stopped.
- **Filters** holds other intervals without movement, a range of the last step's date, the flow, the
  order (latest step, longest without movement, newest) and «only with refusals».
- The search matches a run's note (which is also its task title when the agent gave one), its flow's
  name and the run's id.

Everything you set stays in the page's address, so a saved link — «my runs without movement for a
week» — opens the same view. An open panel is in the address too.

## Live updates

The page updates itself: a step handed in, a new run, a wait that starts or ends shows without a
reload, and an open panel stays open. The indicator at the start of the toolbar says how: **Live** when changes
arrive as they happen, **Reconnecting…** after the connection dropped (what was missed is caught up),
or **Every 15 s** when the live connection cannot be held — for example behind a proxy that cuts
long-lived responses — and the page checks for changes instead. With several tabs open, one tab holds
the connection for all of them, and a hidden page pauses it until you come back.
