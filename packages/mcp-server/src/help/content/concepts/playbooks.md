---
title: Playbooks
description: Named, reusable behaviour text a workflow node references instead of carrying
---

A playbook is named, reusable behaviour text — a review standard, a tone of voice, a definition of
done. It lives in one place and a workflow node references it by name, so the same text serves
several workflows and is edited once. Editing a playbook changes how the agent behaves without
touching what the process does.

## Referencing a playbook

A node names a playbook with `{{playbook:name}}` for your own, or `{{playbook:@owner/name}}` for
another account's published one. The reference works wherever a template is processed — a directive,
a completion condition, a materialized file, the default of a registry variable — and resolves at
every step, so a running process picks up an edit at its next step. When a playbook belongs in a
directive and when in a registry default is described in
[Static Workflow Configuration](/docs/patterns/static-configuration/).

A definition naming a playbook you cannot read is refused while editing, and a run naming one is
refused before it is created. If a playbook becomes unreadable mid-run, the step continues with a
visible placeholder and the run records that it ran without that text.

## Web UI

Playbooks are managed on the Playbooks page, reachable from the sidebar:

- Browse your playbooks with title, machine name, visibility and a preview of the current text
- Create, edit and delete playbooks; the editor shows the reference a node would use
- Version history: every save is a revision; open the history to read a past revision, see it
  beside the current one or as a line-by-line difference, and restore it — restoring writes a new
  revision carrying the older text
- Publish a playbook so any signed-in user can read and reference it; only you can change it
- When a playbook is read by processes that are running, the editor says how many before you save:
  the change reaches them at their next step

On the flow page, a step that names playbooks lists them under its details with a link to each:
your own opens in the editor, another account's published one opens read-only on the Playbooks
page; a playbook you cannot read is marked as not available. On the run page, a step that ran without a
playbook is listed on the Errors tab under its own heading, apart from errors — the process
continued, but without that text.

## MCP tool

The `playbooks` tool gives an agent the same operations: list, get (optionally a past revision or
another account's published playbook), save, delete, history, compare, restore and visibility. See
the [MCP Tools Reference](/docs/reference/tools/).

## Related

- [Templates](/docs/concepts/templates/) — reference syntax and behaviour
- [Static Workflow Configuration](/docs/patterns/static-configuration/) — playbook or registry default
- [Notes](/docs/concepts/notes/) — persistent data, versioned the same way
