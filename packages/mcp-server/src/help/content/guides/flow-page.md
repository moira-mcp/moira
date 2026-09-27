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
and **What is this?**. The presets re-lay the open diagram and bring the camera back to the block you were
reading; each view words them for what it moves — on the map _Rows_, _Compact_, _Balanced_
(branches on both sides of the main line) and _Top to bottom_, on the graph _Stacked groups_,
_Compact_, _Groups in a row_ and _Steps top to bottom_ — and both views follow the one you chose.
The compass opens a note on how to read the view that is open and remembers whether you left it
open. The steps view's toolbar carries the same switch, **Variables as words** and **What is
this?**, and zoom and fit when the flow is drawn.

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

Edit mode also changes the process's structure:

- **Rename or delete a step.** Use the step card's menu (…) in the block panel.
  - A new id is lower-case letters, digits and hyphens, starting with a letter or digit; a dot or an
    upper-case letter is refused in the dialog.
  - The rename preview lists every place the rename rewrites: the connections that lead to the
    step, its values in templates, routing paths and expressions. It also lists texts that only
    mention the id and stay as they are: in steps, in the process's title, goal and facts, in block
    names and summaries, in variable descriptions, in the flow's name and description, and in the
    system reminder agents see at every step.
  - A teleport step warns that agents jump to it by its id.
  - Deleting asks where each connection that led to the step should lead instead. By default it
    continues to where the deleted step led. A step's main output can be redirected but not
    removed, and the start step cannot be deleted.
  - The dialog lists the references to the step's values that will be left without a source, and
    the check then reports them on the steps that read them.
- **Change a step's connections.** Use the step card: lead an output to another step (grouped by
  block), add an output, or remove one other than the main output. Removing an output that a case
  names is allowed; the check then reports the case on that step.
- **Add a step.** Use "Add step" under a block's steps. Choose any node type from the catalog
  (every type but the start), give its id and the fields the type requires. Texts are typed as
  text and lists of lines as lines. A structure — a condition's cases, a subgraph's mappings,
  files to write, an extension's configuration — is written as JSON, starting from its empty
  shape, and the check of the draft tells you whether it fits the type. The step joins the block
  unconnected; connect it from its own card and from the step before it.
- **Add or delete a block.** Use the contents list: "Add block" takes an id, a name, a description
  and the block it follows, and a block's delete control works only while the block owns no step.

The **Graph** view is the same editor drawn as the node graph. In edit mode:

- **Right-click a step** to rename it, insert a step after it (on its main output) or delete it.
- **Right-click a connection** — its line or its output port — to insert a step on it, lead it to
  another step, or remove it. The main output can't be removed.
- **A step inserted on a connection that runs forward from one block into another** can join
  either block. With the source's block, the boundary label moves to the new step's output. With
  the block the connection leads into, the label stays on the connection. A connection that returns
  to an earlier block always puts the new step in the source's block, whose output then carries the
  label and the return's explanation.
- **Right-click the empty canvas inside a block's group** to add a step to that block.
- **Drag an output by the dot at its right end onto another card** to lead that output there
  (clicking the port itself still travels along it). Drag from a card's **+ output** port to create
  a new output: you name it, and it leads to the card you dropped on. Drop anywhere on the card.
- **Drop a dragged output on the empty canvas** to create a step there that the output leads to.
  The step joins the block you dropped it in, or its source's block.

Each of these is one edit, like the same change made in the block panel. The graph keeps the step
you changed in view, and the layout stays automatic, so cards can't be moved by hand.

A workflow without a process view (no `progress`) is edited in the Graph view too. Its owner can
turn on **Edit flow**; everything above works except the block operations, and a new step belongs
to no block.

A change to the structure re-derives the whole process, so a problem can appear on a transition you
did not touch — for example a return created by leading a step back to an earlier block, which
needs its cause and exit before the save. If you rename or delete a step that one of your paused
runs is waiting on, the edit bar names the run before you save: after the save that run no longer
finds its step, so move it on with `session recover`.

Every edit goes into the page's edit log. **Undo** takes back the last one — typing into one field
counts as one edit — and **Discard edits** drops them all. The views re-derive as you type.

The draft is checked in two layers. The process rules run in the browser on every change: a step
in a block that leaves an edge without a label, a return without its cause and exit, or an empty
block appears at once, with the same code the server's validation uses. A moment after you stop
typing, the server checks the whole draft the way it checks a save — a reference to a value no
step or variable provides, for example, or a playbook you cannot use. Each problem is shown where
it belongs:

- on the step's card in the block panel, with its connection chip or transition marked when the
  problem is about one connection;
- on the step's card on the graph, where a problem connection's output port and line turn red;
- in the node panel's validation section;
- in the list under the edit bar, where a problem's place brings its step into view.

The edit bar says what stands between you and saving: no changes yet, process problems to fix,
checking the draft, problems found by the server, or checked and ready to save. **Save** opens only
for a changed draft that the server has checked, exactly as shown, without errors. **Export** lists
exactly the flow-file entries the edits would change. A changed value is shown as its JSON path
with the value before and after. A structural change has a line of its own: `+ node` and `- node`,
`+ block` and `- block`, and `node old → new` for a rename, with the references it rewrote.

**Save** sends the whole definition to the server against the revision the page loaded, and the
server validates it once more, as `manage edit` does — including playbook references you cannot
resolve — so the page and `manage edit` accept and refuse the same definitions. If it still refuses
— something changed after the check, such as a playbook the draft names being deleted — nothing is
saved, the draft stays, and the refusal is shown on the definition the same way. Every stored write
of a definition — from this page, from `manage`, from a bundled-catalog sync — advances its
**revision**. If someone else changed the workflow since the page loaded, the save is refused with a
conflict and your edits stay on the page: reload and apply them again. A run reads the stored
definition at every step, so a run that is already in progress follows the saved edits from its next
step on; edit a workflow with paused runs deliberately.

Shared and bundled workflows are shown without edit mode; copy a bundled flow ("Use as template")
to get an editable one.

## Explaining the page

**What is this?** opens a tour of the page in eight steps — that your agent, not you, picks or
builds flows; the steps view; block, step, evidence, loop, editing; and the views — each card
sitting beside the element that shows it, in whichever view is open, with the rest of the page
dimmed: the page header, a numbered instruction card on the steps view (on the map and the graph,
the **Steps** tab), a contents row, a step in the block panel (the section it sits in unfolds), the
evidence a step must return, a return port, the edit toggle and the toolbar. A step whose element
the open view does not draw moves to the view that does, and a highlighted card inside the diagram
is brought into the camera. The steps about the map are skipped, with a note, on a flow that has
no process view, and the loop step on a flow without a loop. The editing step depends on who reads: the flow's owner is shown the
edit toggle, on a wide screen only; anyone else learns, on the page header, that only the owner
edits and that "Use as Template" makes an editable copy. The right arrow or Enter goes on, the
left arrow goes back and Escape closes. On a phone the card is a sheet along the top or the bottom
of the screen, whichever leaves the element in sight. The tour and its step are in the URL
(`guide=flow&step=…`), so a position can be linked to. The compass in the toolbar opens the note
about the open view.
