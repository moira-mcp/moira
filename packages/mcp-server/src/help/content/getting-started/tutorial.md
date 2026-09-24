---
title: "Tutorial: your first flows"
description: Three tiny learning flows — plain steps, one choice, several paths — that show how Moira runs a flow
---

You do not need to build any of these flows, and you will not need to build flows for real work
either: your agent picks a ready flow or creates one for your task. These three examples are small
on purpose, so you can see what a flow is and what Moira does while your agent runs one. Each has
no variables and no loops, and asks for one short answer per step.

**Before you start:** connect Moira to your AI client ([Quick Start](/docs/getting-started/quickstart/))
and think of any small task — renaming a file, answering a question, writing a note.

**To look at a flow:** open **Workflows** in the web app. The recommended section at the top lists
the three examples; each opens on the **Steps** view — the instructions the agent receives, as
numbered cards joined by arrows. **Map** and **Graph** show the same flow as a process and as the
full technical graph.

The recommended section, the other panels for newcomers on the home page and the hints on the flow
and run pages can each be hidden for good. A hidden panel stays hidden on every device you sign in from; bring it back in **Settings →
Preferences → Hints for beginners**.

## Level 1 — Simple steps

`moira/example-simple-steps` is a straight line: four steps, no choices. It shows the core of
Moira: the agent gets exactly one step, does it, returns a short answer, and only then gets the
next one.

Say to your agent:

> Use Moira to run Example 1: Simple Steps for this task: …

The steps the agent receives, in order:

1. Read the user's request and restate the task in one sentence. If something important is unclear, ask the user before you go on.
2. Do the task. Keep to what the user asked for and do not add extra work.
3. Compare the result with the request. Fix anything that does not match before you go on.
4. Tell the user in a few sentences what you did and how you checked it.

Every step also carries a completion condition — for the first one, "The task is restated in one sentence and nothing important is unclear." — and asks
for one field back. If the agent answers without it, Moira refuses the answer and the agent stays
on the same step. It cannot skip ahead.

## Level 2 — One choice

`moira/example-one-choice` adds a fork. The agent's answer to one question decides which way the
flow goes.

> Use Moira to run Example 2: One Choice for this task: …

1. Do the task the user asked for.
2. Check the result against the request. Answer yes if it fully matches, or no if something is missing.
   - **yes — it matches** → Tell the user in a few sentences what you did.
   - **no — something is missing** → Tell the user what is missing and why, and suggest what to do next. Do not start the task again in this flow.

The answer is one field with two allowed values, `yes` and `no`; Moira reads it and takes the
matching way. There is no loop: a "no" does not send the agent round again, it ends the flow with an
honest note about what is missing.

## Level 3 — Several paths

`moira/example-several-paths` branches three ways on one answer.

> Use Moira to run Example 3: Several Paths for this request: …

1. Read the user's request and decide what it is: a question, a bug to fix, or a new idea.
   - **a question** → Answer the question briefly and say where the answer comes from.
   - **a bug** → Reproduce the bug, fix it, and show the user that it no longer happens.
   - **an idea** → Write a short plan for the idea, at most five steps, and ask the user whether to go ahead.

Each path is short and ends on its own. On the **Steps** view the fork is drawn as three arrows,
each labelled with the answer that takes it.

## What you have seen

- A flow is a sequence of instructions the agent receives one at a time.
- Each step has a completion condition and asks for evidence — here, one short field.
- A fork is decided by the agent's answer, not guessed.
- Moira checks every answer before the flow moves on.

Real flows use the same pieces, only more of them: reviews, repair loops, files, notes. Your agent
handles that structure; you describe the task.

## Next

- [Which ready flow to use](/docs/getting-started/ready-flows/) — Quick Task, Robust Task and Todo
  List for everyday tasks.
- To get a flow of your own, say to your agent: "Create a Moira flow for …". It builds one through
  the Workflow Management Flow, and you can open it on the Steps view like the examples.
- [Concepts](/docs/concepts/workflows/) — how flows are built, when you want to read or shape one
  yourself.

Each example also exists in Russian: `moira/example-simple-steps-ru`, `moira/example-one-choice-ru`
and `moira/example-several-paths-ru`.
