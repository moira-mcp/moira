---
title: Reading and editing a flow
description: How to read one workflow as a process on the flow page, drill from blocks into steps, and edit the definition in place
---

Opening a workflow in the web UI (`/workflows/<id>` or `/workflows/<handle>/<slug>`) shows the
**flow page**: the workflow's definition read as the process it declares, with no run in it.
Everything on the page is derived from the definition — blocks from `progress.nodes`, membership
from `progressNodeId`, transitions and loops from the labelled connections — so the picture
cannot drift from the graph. A workflow without a process view (`progress`) has no map: it opens
on the technical node graph with its node details, and the steps view is one click away.

You do not need this page to use Moira: your agent picks a ready flow or builds one for your task
through the Workflow Management Flow. The page is for looking inside a flow when you want to.

## Views

The three tabs above the picture show the same definition in three ways; the choice is in the URL
as `view`.

- **Steps** — the simplest picture: what the agent is told, top to bottom. Every instruction is a
  numbered card with the text the agent receives; arrows join them in the order they come; where
  the agent's answer (or a check Moira makes on its own) chooses the way on, the arrows fork and
  carry the answer's label; a connection back to an earlier step is a dashed arrow on the side
  marked "back to step N"; each end is a finish marker. Steps Moira takes by itself — a condition,
  an expression, files written for the agent, a note, a lock, a notification — are small dashed
  cards. There are no node types, ids, schemas or ports, and the page's panel is hidden. **Variables
  as words** (on by default and remembered; `inline=0` or `inline=1` in the URL) reads every
  `{{name}}` as the variable's name in plain words — `{{current_task}}` as "current task" — with
  its description on hover, so the flow reads as a list of instructions; turned off, the
  references show as `{{…}}` tokens. With it on, template conditions and loops read as words too:
  `{{#if x}}` as "(if x)", `{{#unless x}}` as "(unless x)", `{{#eq x 'v'}}` as "(if x is 'v')",
  `{{#neq x 'v'}}` as "(if x is not 'v')", `{{#each x}}` as "(for each x)", `{{else}}` as
  "(otherwise)", `{{this}}` as "(the item)" and `{{@index}}` as "(its number)". A card
  longer than seven lines shows the rest on hover. The learning examples open on this view; nodes
  reached only by a jump (teleport) are not part of it.

  A small flow (up to 12 cards: the learning examples, Todo List) is drawn this way. A larger flow
  — Quick Task, Robust Task, the Software Development Flow — reads as a list instead: the same
  cards top to bottom at normal size with the whole text, each ending with its way on ("Next:"
  and the step, each labelled choice linked to the step it leads to, or "back to step N"). A link
  scrolls to its step, moves the focus there and marks it for a moment, and a link to a step
  (`#step-<id>` after the address) opens the list at it. Checks and Moira's own steps are compact
  rows; a link to one also says where it stands ("Moira checks a condition, before step 12"), with
  its order ("(#2)") where two would read alike.

- **Map** (default for other flows with a process view) — the process as a diagram with its table of contents: blocks left to right,
  the main sequence on one row, each side branch on a row of its own above or below it, a block
  many others lead into or that only loops reach beneath them. Each block is one card: a title band
  with the block's number badge and its name, then its description and its step count, with a
  column of input ports on the left and output ports on the right. A port names the transition and
  the block at the other end; a transition that sends the work back is a dashed return port marked
  ↻, every transition a block makes to itself shares the double port under the card, and a long
  link runs through the nearest free lane between rows. Hover a port or a line to light that one
  transition and read its condition or, for a return, its cause and exit; hover a card to light
  every connection it takes part in; click a port or a line to travel to the other end; select a
  block to keep its lines lit. The steps chip opens a tooltip listing the block's steps — click one
  to open it on the graph. Nothing is "current": the definition has no run. The picture opens on
  the first block; scroll or drag to pan, pinch (or hold Ctrl and scroll) to zoom; the fit control
  shows the whole process. The contents on the left lists every block with, once you have completed
  runs of this version, how long it typically takes; click one to select it and move the camera
  there.
- **Graph** — every workflow node as a step card, grouped by block in process order. A step card
  has the same title band, side ports and fact chips as a block card on the map; its chips carry
  the directive, the fields it must return and its expressions — hover one to read the full text.
  Every connection is drawn as a line between side ports, loops and links into other blocks
  included; an output port is named by the case that selects it, `success` and `default` are the
  outputs taken when no case holds, and `error` and `timeout` are control outputs. Hovering,
  clicking and selecting work exactly as on the map. The block selected on the map keeps its group
  ringed here, and the contents beside the graph moves the camera to a block's group. Clicking a
  card opens the panel's node level: the directive, the completion condition, the returned fields,
  the expressions, the cases, the connections as `output → target` with the case that selects each
  output, the validation, the playbooks and a catalog-drawn node's configuration, with a breadcrumb
  back to the block and a "Show on the graph" action; clicking a step in the block panel opens the
  graph on that node the same way.

The map and the graph share one toolbar above the diagram: the **Steps / Map / Graph** switch,
the contents fold button, the step finder (it answers "which block is this step in" and, on the graph, opens that
step), the layout presets, zoom and fit, the navigator switch, the compass, the refresh indicator
and **Explain this page**. The presets re-lay the open diagram and bring the camera back to the block you were
reading; each view words them for what it moves — on the map _Rows_, _Compact_, _Balanced_
(branches on both sides of the main line) and _Top to bottom_, on the graph _Stacked groups_,
_Compact_, _Groups in a row_ and _Steps top to bottom_ — and both views follow the one you chose.
The compass opens a note on how to read the view that is open and remembers whether you left it
open. The steps view's toolbar carries the same switch, **Variables as words** and **Explain this
page**, and zoom and fit when the flow is drawn.

Switching tabs keeps the page as it is: the map keeps its selected block, the graph the position
you left it at, and nothing reloads.

## The panel

- **Block** — the selected block (the first one by default): its description, how long a pass
  and a whole run through it typically take across your completed runs of this version ("no runs
  yet" before there are any, "typical durations unavailable" when they could not be fetched),
  where it leads, and its steps as cards of one shape (the type badge
  in the same place, then the name, the first sentence and the fields it must return — the
  evidence Moira validates before a run continues). A selected step opens the panel's node level;
  a step that names playbooks lists them there with a link to each, and one you cannot read is
  marked as not available.
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

**Explain this page** walks through the page in eight steps — that your agent, not you, picks or
builds flows; the steps view; block, step, evidence, loop, editing; and the views — highlighting
the element that shows each, in whichever view is open: the page header, a numbered instruction
card on the steps view (on the map and the graph, the **Steps** tab), a contents row, a step in the block panel (the section it sits in unfolds), the evidence a step must return, a
return port, the edit toggle (the header for a reader who cannot edit) and the toolbar. A step whose
element the open view does not draw moves to the view that does. A highlighted card inside the diagram is brought into the camera. The step is in the URL as `guide`,
so a position can be linked to. The compass in the toolbar opens the note about the open view.
