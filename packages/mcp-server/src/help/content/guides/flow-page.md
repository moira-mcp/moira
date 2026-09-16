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

## Views

The two tabs above the picture show the same definition in two ways; the choice is in the URL as
`view`.

- **Map** (default) — the process as a diagram with its table of contents: blocks left to right,
  adjacent forward transitions as arrows with their labels, loops as thin dashed lines below and
  transitions that skip blocks above; a block that many other blocks lead into receives one thin
  line from each of them. Every loop, skip and exit into such a block is named by a chip in its
  source block, and so are three or more parallel transitions into the next block (one chip with
  their count); hover the chip (or the line) to light it and read its label, and select a block
  to keep its lines lit. Nothing is "current": the definition has no run. The picture opens on
  the first block; scroll or drag to pan, pinch (or hold Ctrl and scroll) to zoom; the fit
  control shows the whole process at a readable size or, when it is wider than the view, its
  beginning. The contents on the left list every block with, once you have completed runs of this
  version, how long it typically takes; the finder above them answers "which block is this step
  in" and selects that block.
- **Graph** — every workflow node as a step card, grouped by block in process order, with its
  connection chips. A line is drawn where it runs straight from card to card. A loop, a link into
  another block and anything else that would cross the picture is named instead of drawn: the
  source card's connection chip says where it goes, and the target card gains an arrival chip
  saying where it comes from and from which block. Hovering either chip, or either card, draws
  that line with its label and dims the rest; clicking an arrival chip brings the card at the
  other end into view. The block selected on the map keeps its frame highlighted here. In the
  zoom cluster the fit control shows the whole graph and Vertical and Horizontal change the
  direction. The sidebar shows a selected node's definition and its connections as `output →
target` with the case that selects each output; clicking a step in the block panel opens the
  graph on that node.

Switching tabs keeps the page as it is: the map keeps its selected block, the graph the position
you left it at, and nothing reloads.

## The panel

- **Block** — the selected block (the first one by default): its description, how long a pass
  and a whole run through it typically take across your completed runs of this version ("no runs
  yet" before there are any, "typical durations unavailable" when they could not be fetched),
  where it leads, and its steps as cards of one shape (the type badge
  in the same place, then the name, the first sentence and the fields it must return — the
  evidence Moira validates before a run continues). On the node graph, a selected step that
  names playbooks lists them under its details with a link to each; one you cannot read is marked
  as not available.
- **Variables** — the variable registry as rows: every global the workflow declares with its
  type and default; open a row for its description and the whole declaration as JSON Schema.
  While editing, the type, default, description and schema are edited in the row.

## Editing the definition

The owner of a workflow can turn on **Edit flow** (`edit=1` in the URL). Edit mode changes the
definition itself and never a run:

- a block's name and description, in place in the block panel;
- a transition's label and, for a return, its loop cause and exit (the pencil next to it);
- which block a step belongs to, and a step's directive, completion condition, message or
  expressions (on the step's card in the block panel);
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
and the views — highlighting the element that shows each. The step is in the URL as `guide`, so a
position can be linked to. The map's one-line note opens into what the view is for.
