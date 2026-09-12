---
title: Reading and editing a flow
description: How to read one workflow as a process on the flow page, drill from blocks into steps, and edit the definition in place
---

Opening a workflow in the web UI (`/workflows/<id>` or `/workflows/<handle>/<slug>`) shows the
**flow page**: the workflow's definition read as the process it declares, with no run in it.
Everything on the page is derived from the definition — blocks from `progress.nodes`, membership
from `progressNodeId`, transitions and loops from the labelled connections — so the picture
cannot drift from the graph. A workflow without a process view (`progress`) shows the technical
node graph and its node details instead.

## Modes

The tabs above the picture switch how the same definition is shown; the choice is in the URL as
`view`.

- **Outline** (default) — the process as a document: every block as a numbered section with its
  description, its transitions in words (including why a loop happens and when it ends), and its
  steps with the evidence each demands.
- **Canvas** — the process as a map filling the whole view: blocks left to right, forward
  transitions as arrows with their labels, loops as dashed lines below; a block that many other
  blocks lead into receives one thin line from each of them, and the source names it in a small
  chip. Scroll or drag to pan, pinch (or hold Ctrl and scroll) to zoom.
- **Lanes** — one card per block in process order with the loops drawn as arcs under the rail and
  transitions that skip a block as thin links above it; the rail pans and zooms like the map.
  Nothing is "current": the definition has no run.
- **Split** — blocks against their implementation: pick a block on the left to see, on the right,
  the steps that implement it in the order they run, with their connections. Chips lead to the
  block a connection leaves for; the finder above answers "which block is this step in".
- **Graph** — the technical node graph with its layout controls and a sidebar that shows a
  selected node's definition. Clicking a step in the block panel opens the graph on that node.

## The panel

- **Block** — the selected block (the first one by default): its description, where it leads,
  and its steps. Each step names the fields it must return — the evidence Moira validates before a
  run continues.
- **Variables** — the variable registry: every global the workflow declares, with its type,
  description and default.

## Editing the definition

The owner of a workflow can turn on **Edit flow** (`edit=1` in the URL). Edit mode changes the
definition itself and never a run:

- a block's name and description, in place (Outline and Split);
- a transition's label and, for a return, its loop cause and exit (the pencil next to it);
- which block a step belongs to, and a step's directive, completion condition, message or
  expressions (Split);
- the variable registry — declarations, types, descriptions and defaults (Variables tab).

The views re-derive as you type. A change that would make the process unreadable — a step in a
block that leaves an edge without a label, an empty block — appears at once as a diagnostic with
the same code the server's validation uses, and the save stays disabled until it is fixed.
**Export** lists exactly the flow-file entries the edits would change, as JSON path, value before
and value after.

**Save** sends the whole definition to the server against the revision the page loaded. The
server validates it as `manage edit` does and refuses an invalid definition (nothing is saved).
Every stored write of a definition — from this page, from `manage`, from a bundled-catalog sync —
advances its **revision**; if someone else changed the workflow since the page loaded, the save is
refused with a conflict and your edits stay on the page: reload and apply them again. A run reads
the stored definition at every step, so a run that is already in progress follows the saved
edits from its next step on; edit a workflow with paused runs deliberately.

Shared and bundled workflows are shown without edit mode; copy a bundled flow ("Use as template")
to get an editable one.

## Explaining the page

**Explain this page** walks through the page in six steps — block, step, evidence, loop, editing,
and the modes — highlighting the element that shows each. The step is in the URL as `guide`, so a
position can be linked to. Every mode opens with a short note saying what it is for.
