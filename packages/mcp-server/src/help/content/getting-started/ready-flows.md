---
title: Which ready flow to use
description: Quick Task, Robust Task and Todo List for everyday tasks, and when to ask your agent for a new flow instead
---

For most tasks you do not choose a flow at all: describe the task to your agent and it picks one.
This page is for when you want to know what it picks between, or to name a flow yourself. Three
universal flows cover clear tasks without special logic; each of them is started by saying so to
your agent, for example "Use Moira Quick Task for this: …".

## Quick Task

`moira/quick-task` plans the work, gets the plan reviewed and approved, carries it out step by step
with evidence, has the result reviewed independently, and asks you to accept it.

**Pick it when** the task is clear and bounded, is not a change to a code repository, and fits a
plan of up to ten steps: a document, a piece of research, a set of edits you want checked. It
needs an agent that can write files.

[Quick Task reference](/docs/reference/workflows/quick-task/)

## Robust Task

`moira/robust-task` is the same idea built for long or critical work. It keeps everything in a
durable workspace so a run survives interruptions, sends review findings back to the step that
caused them, replans when new facts change the task, and reports a partial result honestly
instead of calling it done.

**Pick it when** the task is large or important, or likely to run into problems along the way.

[Robust Task reference](/docs/reference/workflows/robust-task/)

## Todo List

`moira/todo-list` works through a checklist one item at a time — the one you give it, or one it
writes once from your goal — asking for a short proof that each item is done, and lets the list be
corrected mid-run. It has no plan review and no final review.

**Pick it when** the steps are clear and just need doing in order.

[Todo List reference](/docs/reference/workflows/todo-list/)

## Something else

- **A change to a code repository** — `moira/software-development-flow` plans, implements, tests,
  documents and reviews it. See the [Software Development Flow reference](/docs/reference/workflows/software-development-flow/).
- **Research, content, analysis and more** — the [ready workflows catalog](/docs/reference/workflows/)
  lists every bundled flow; your agent reads the current list with `list()` before it picks.
- **Nothing fits** — ask your agent: "Create a Moira flow for …". It builds one through the
  Workflow Management Flow, as simple or as complex as the task needs, and you can use it at once.
