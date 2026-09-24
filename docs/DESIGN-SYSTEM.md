# Design System

MCP Moira Web UI design system built on shadcn/ui + Tailwind CSS v4.

## Color Tokens

All colors use OKLCH format defined in `packages/web-frontend/src/styles/globals.css`.
Theme switching is handled via CSS custom properties — **never use `dark:` prefix classes**.

| Token                                | Purpose                            |
| ------------------------------------ | ---------------------------------- |
| `--background` / `--foreground`      | Page background and default text   |
| `--card` / `--card-foreground`       | Card surfaces                      |
| `--primary` / `--primary-foreground` | Brand color (blue-purple hue 264°) |
| `--destructive`                      | Error/danger text, borders, tints  |
| `--destructive-fill`                 | Solid error/danger fills           |
| `--success`                          | Positive states                    |
| `--warning`                          | Caution states                     |
| `--info`                             | Informational badges               |
| `--muted` / `--muted-foreground`     | Secondary text and surfaces        |
| `--border`                           | Default borders                    |
| `--ring`                             | Focus rings                        |

## Typography

Font: **Inter Variable** (`--font-sans`), monospace: `--font-mono`.

| Context                         | Class                                   |
| ------------------------------- | --------------------------------------- |
| Page title                      | `text-2xl font-semibold tracking-tight` |
| Section heading                 | `text-lg font-semibold`                 |
| Card title                      | `font-medium text-sm text-foreground`   |
| Body text                       | `text-sm`                               |
| Caption                         | `text-xs text-muted-foreground`         |
| Micro text (badges, timestamps) | `text-[10px] text-muted-foreground`     |

## Spacing

8px grid. Page padding: `p-6 md:p-8`.

| Token | Value |
| ----- | ----- |
| `xs`  | 4px   |
| `sm`  | 8px   |
| `md`  | 16px  |
| `lg`  | 24px  |
| `xl`  | 32px  |
| `xxl` | 48px  |

## Component Mapping

| UI Need                   | Component            | Import                         |
| ------------------------- | -------------------- | ------------------------------ |
| Page wrapper (data pages) | `PageShell`          | `@/components/PageShell`       |
| Page title + description  | `PageHeader`         | `@/components/page-header`     |
| Filter toolbar            | `FilterBar`          | `@/components/FilterBar`       |
| Card wrapper (list/grid)  | `CardShell`          | `@/components/cards/CardShell` |
| Data list with pagination | `DataListView`       | `@/components/DataListView`    |
| Loading spinner           | `PageLoader`         | `@/components/page-loader`     |
| Inline error with retry   | `InlineError`        | `@/components/inline-error`    |
| Empty state               | `EmptyState`         | `@/components/empty-state`     |
| Confirmation dialog       | `ConfirmDialog`      | `@/components/confirm-dialog`  |
| Debounced input value     | `useDebounce`        | `@/hooks/useDebounce`          |
| List page size            | `useListPageSize`    | `@/hooks/useListPageSize`      |
| Drop stale list answers   | `useLatestRequest`   | `@/hooks/useLatestRequest`     |
| Table page size (rows)    | `useDynamicPageSize` | `@/hooks/useDynamicPageSize`   |

### DO NOT use directly:

| Instead of                                         | Use                               |
| -------------------------------------------------- | --------------------------------- |
| Raw `AlertDialog` for confirmations                | `ConfirmDialog`                   |
| Manual `setTimeout` debounce                       | `useDebounce` hook                |
| Inline `<p>Loading...</p>`                         | `PageLoader`                      |
| Ad-hoc error rendering                             | `InlineError`                     |
| Manual page wrapper `<div className="p-6 md:p-8">` | `PageShell`                       |
| Inline search + filter bar markup                  | `FilterBar`                       |
| Duplicated card hover/border CSS                   | `CardShell`                       |
| Local `formatDate`/`formatSize`                    | `@/components/cards/format-utils` |

## Component APIs

### PageShell

Standardized page layout. Handles loading and error states automatically.

```tsx
<PageShell
  title="Executions"
  description="Your workflow runs"
  loading={isLoading}
  error={errorMessage}
  onRetry={reload}
>
  {/* page content */}
</PageShell>
```

Auth pages, detail pages, and Settings have justified different layouts.

### FilterBar

Consistent filter toolbar with search + filter controls + action buttons.

```tsx
<FilterBar
  search={query}
  onSearchChange={setQuery}
  searchPlaceholder="Search..."
  searchTestId="my-search"
  filters={<Select ... />}
  actions={<Button>Create</Button>}
/>
```

When a page's filters are optional, `foldFilters={{ activeCount }}` keeps only the search in view
and puts the filters and the reset behind a "Filters" button (`filters-toggle`). The button counts
the filters in effect, and the controls stay open while any is in effect. The flow list uses it.

### CardShell

The one list item, in the list view (default) and the grid view (`compact`). An item is given as
slots and the shell owns the layout, so every list reads the same way.

```tsx
<CardShell
  compact={isGrid}
  onClick={() => navigate(item.id)}
  icon={<FileText />}
  title={item.name}
  titleAside={`v${item.version}`}
  description={item.summary}
  note={whenToPick}
  meta={
    <>
      <span>@{item.owner}</span>
      <span>{formatRelativeTime(item.updatedAt)}</span>
    </>
  }
  badges={item.failed && <Badge variant="destructive">Failed</Badge>}
  actions={[
    { icon: <Edit />, label: "Edit", onClick: handleEdit },
    { icon: <Trash />, label: "Delete", onClick: handleDelete, variant: "destructive" },
  ]}
  testId="my-card"
/>
```

| Slot          | Shows                                                                   |
| ------------- | ----------------------------------------------------------------------- |
| `icon`        | A small leading mark of what the item is                                |
| `title`       | What the reader scans for (`data-slot="card-title"`)                    |
| `titleAside`  | A quiet fact beside the title: a version, a key                         |
| `description` | What the item is, up to two lines in the list and three in the grid     |
| `note`        | One short emphasised line under the description                         |
| `meta`        | A quiet line of facts: owner, time, size, tags                          |
| `badges`      | States that need attention (invalid, shared, failed), on the title line |
| `actions`     | Icon buttons, shown on hover or focus                                   |

- **List view**: a row of up to four lines with padding, actions at the end.
- **Grid view**: the same slots stacked in a card, the meta line at the bottom.
- `title` is required and there is no free-form content: every list item is drawn from the slots.
- An item with `onClick` opens from anywhere on it with the pointer; its title is then a button, so
  the item is reachable with Tab and opens with Enter or Space. Interactive pieces inside a slot (a
  tag filter, a visibility toggle) stop their click from reaching the item.
- Each action carries its label as `aria-label` and as the delegated hint (`data-hint`).
- `LIST_ITEM_HEIGHT` (a list item) and `GRID_ROW_HEIGHT` (a row of grid cards) are the starting
  heights `useListPageSize` sizes pages by before it measures the drawn items.

### useListPageSize

The page size of a list page drawn with `DataListView` and `CardShell` items:

```tsx
const { pageSize, containerRef, onViewModeChange } = useListPageSize(() => setCurrentPage(1));

<DataListView containerRef={containerRef} onViewModeChange={onViewModeChange} … />;
```

- In the list view a page holds the list items that fit the box; in the grid view, the rows that
  fit times the columns the grid shows at this width (3, 2 or 1). At least two rows.
- It starts from `LIST_ITEM_HEIGHT` / `GRID_ROW_HEIGHT`, then measures the items a view draws first
  (`data-slotted`) and sizes by their average height, so a page holds what fits instead of leaving
  an empty band or cutting an item off. The last item's gap needs no room.
- That measurement is taken once per view. The items of a later page never change the size, so
  paging stays on the page the reader chose even when its items are taller or shorter.
- It follows the container through the list's loader (the container mounts after it) and through
  resizes, such as a banner or a quota bar loading above the list.
- When the size changes — a view switch, a resize of the box, or a view's first measurement (which
  happens on page 1 or right after a view switch) — the callback runs, so the page goes back to
  page 1 instead of skipping items.
- A size change refetches, so two requests can overlap. The page's loader drops an answer from an
  older request with `useLatestRequest` (`@/hooks/useLatestRequest`):

  ```tsx
  const beginRequest = useLatestRequest();
  const load = useCallback(async () => {
    const isCurrent = beginRequest();
    try {
      const result = await apiClient.getItems({ limit: pageSize, offset });
      if (!isCurrent()) return;
      setItems(result.items);
    } catch (err) {
      if (!isCurrent()) return;
      setError(message(err));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, pageSize, offset]);
  ```

- `useDynamicPageSize` is the measurement under it, for a paged table sized by its rows.

### useDebounce

```tsx
const debouncedSearch = useDebounce(searchQuery, 300);
```

### ConfirmDialog

```tsx
<ConfirmDialog
  open={showDialog}
  onOpenChange={setShowDialog}
  title="Delete item?"
  description="This cannot be undone."
  variant="destructive"
  onConfirm={async () => {
    await deleteItem();
  }}
/>
```

## Card Guidelines

All cards use `CardShell` and follow these patterns:

- Give the item as slots; show a badge only for a state that needs attention, not for the normal
  one (a valid flow has no "valid" badge)
- Badges in a card: `h-5 px-1.5 text-[11px]` (outline or a state colour)
- Icon size in cards: the `icon` slot draws `size-4`; inline icons in badges and meta are `size-3`
- Action buttons: `h-7 w-7` ghost icon buttons, shown on hover or focus (CardShell draws them)
- Timestamps: use `formatRelativeTime()` for recency, `formatDate()` for absolute dates
- Card data-testid: descriptive (e.g., `note-card`, `execution-card`)

## Badge Consistency

| Context          | Classes                                        |
| ---------------- | ---------------------------------------------- |
| Card badge       | `h-5 px-1.5 text-[11px]`                       |
| Execution status | `StatusBadge` (translated `common.status.*`)   |
| Error count      | `border-destructive/30 text-destructive`       |
| Success          | `border-success/30 text-success`               |
| Warning          | `bg-warning/10 text-warning border-warning/30` |

## Diagram design system

The process surfaces — the map and the technical graph on the run page (`/executions/:id`) and the
flow page (`/workflows/:id`), their contents sidebar and their right panel — are built from one
set of tokens and primitives under `packages/web-frontend/src/components/diagram/`. The map and the
graph share the card, the edge, the toolbar, the tooltip, the contents and the focus store; they
differ only in layout. Where these surfaces are composed into pages is documented in
`docs/WEB-UI.md`; this section is the vocabulary.

### Tokens

| Token                          | Values                                                                                                                                         | Source                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Card tone (`CardTone`)         | `neutral`, `active`, `waiting`, `done`, `error` → accent bar, ground gradient, rule under the title, index badge, `--card-accent` for the glow | `diagram/PortedCard.tsx` (`TONE_STYLE`)  |
| Block status → tone            | run status mapped to a `CardTone`                                                                                                              | `run/status.tsx` (`BLOCK_TONE`)          |
| Status style                   | icon, surface, chip and tint per block status                                                                                                  | `run/status.tsx` (`STATUS_STYLE`)        |
| Node type                      | badge colour and glyph per node type                                                                                                           | `run/nodeTypeStyle.tsx` (`NodeTypeTag`)  |
| Edge kind (`DiagramEdgeKind`)  | `forward`, `external`, `skip`, `hub`, `return`, `self` → stroke, width, opacity, dash, arrowhead                                               | `diagram/DiagramEdge.tsx` (`EDGE_LOOK`)  |
| Port kind (`PortInfo["kind"]`) | `forward`, `external`, `default`, `return`, `error` → pill border and text colour, handle colour                                               | `diagram/PortedCard.tsx` (`PORT_TONE`)   |
| Interactive affordance         | `clickable`, `hoverOnly`, `static` → cursor, hover treatment, focus ring                                                                       | `diagram/interactive.ts` (`INTERACTIVE`) |
| Animation                      | `card-breathe`, `card-breathe-slow`, `card-arrive`, `marker-pulse`, `edge-flash`                                                               | `styles/globals.css`                     |
| Layout preset                  | `default`, `compact`, `flow`, `vertical`, kept per browser; worded per surface (`components.diagram.presets.<map\|graph>.<id>`) where rendered | `diagram/layoutPreset.ts`                |

The affordance rule is absolute: `clickable` goes somewhere and gets a pointer cursor with a
primary hover border; `hoverOnly` only explains itself and gets the help cursor with no hover
border; `static` is text. Nothing that cannot be clicked looks like a button.

Every animation is a glow, a pulse or a flash layered over a state that colour, ring and fill
already carry, and a single `prefers-reduced-motion: reduce` block in `globals.css` turns all of
them off.

### Primitives

| Primitive                                                                                           | What it is                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Hint` / `HintBody`                                                                                 | The tooltip: popover surface, one side and delay, plain or monospace body, optional heading, three widths                                                                                                                                                          |
| `HintLayer`                                                                                         | One delegated listener mounted in `App.tsx` that draws the same tooltip for any `data-hint` element (HTML or SVG); an element that says `data-hint-at="pointer"` — a line — gets it anchored at the pointer instead of its box; the surface is pointer-transparent |
| `VariableRef` / `TemplateText` / `ExpressionText` / `ConditionText`                                 | Authored text with its `{{name}}` references, expression identifiers and condition paths as tokens that explain the variable from the registry and jump to its definition; braces are kept as authored                                                             |
| `IndexBadge`                                                                                        | A block's ordinal, toned by its status, on the card, in the contents and at the head of the block panel                                                                                                                                                            |
| `ListMarker`                                                                                        | One item of a bound list: done, in progress, pending — as an icon or as a text glyph                                                                                                                                                                               |
| `Port`                                                                                              | A pill on a card's border with a React Flow handle in it, naming one end of a transition; hover lights the link, click travels to the far end, `Enter` and `Space` do the same from the keyboard                                                                   |
| `PortedCard`                                                                                        | Title band (index badge, title, status chip or type badge, pass count) + input port column + centre (description, fact chips, children) + output port column + a bottom double port for self-loops; the card is as tall as its longer port column                  |
| `DiagramEdge` + `DiagramMarkers`                                                                    | The one line: kind × state, a halo so crossings read as over and under, and one marker set whose arrowheads keep their size at any stroke width (`markerUnits="userSpaceOnUse"`)                                                                                   |
| `PanelSection`                                                                                      | A panel group: header with a right-hand summary and a chevron, fold state kept per section, an `openToken` that unfolds it when a jump lands inside                                                                                                                |
| `PageHeader` (`diagram/PageHeader.tsx`, distinct from the list pages' `components/page-header.tsx`) | The page's text and its own actions: back, name, version or id, badges, description, fact chips. Nothing functional                                                                                                                                                |
| `DiagramToolbar` + `LayoutPresetButtons`                                                            | The page's functions: view modes, leading slot, the folded step finder, the presets, zoom/fit, the minimap switch, trailing slot. It wraps to a second row rather than cutting buttons off                                                                         |
| `ContentsSidebar` / `ContentsRow` / `ContentsLayout`                                                | The process's table of contents and the layout that places it beside either diagram                                                                                                                                                                                |
| `NodeFinder`                                                                                        | Search over the steps; a pick selects the owning block and, where the surface can, the step itself                                                                                                                                                                 |
| `useHighlightTarget`                                                                                | Scrolls a named target into view and pulses it, so every "go to X" ends with X visibly marked                                                                                                                                                                      |
| `requestReveal` (`diagram/reveal.ts`)                                                               | Brings an element that sits inside a diagram into the camera: the mounted `DiagramViewport` fits its view to the node containing it, since `scrollIntoView` cannot reach a transformed canvas                                                                      |
| `DiagramGuide` (`run/DiagramGuide.tsx`)                                                             | The compass note on how to read the open view, one per page and view, remembered per reader                                                                                                                                                                        |
| `useStoredFlag`                                                                                     | A boolean the reader toggles and the browser remembers                                                                                                                                                                                                             |
| `useRequest`                                                                                        | A request one surface makes of another (focus, highlight, unfold, arrival): a payload plus a token, minted afresh for every request so the answering effect runs again; `send(null)` withdraws it                                                                  |

Organisms compose them: the map (`run/CanvasView.tsx`), the technical graph
(`workflow/WorkflowGraph.tsx`), the contents sidebar, and the right panel's block level
(`run/BlockDetailPanel.tsx`) and node level (`run/NodePanel.tsx`). The progress picture
(`packages/workflow-engine/src/utils/execution-progress-renderer.ts`, the PNG behind `session
progress-image-token` and the notification attachment) draws the same ported cards, ports and edge
kinds as SVG without a browser: the map's layout (`process-layout.ts`), port geometry
(`process-geometry.ts`) and facts wording (`progress-facts.ts`) live in the engine's
`progress-visual` entry and the map imports them, so the picture and the map are one drawing of
one model; the picture's colours are the same tokens as literal hex per theme.

### States

The same state reads the same way on every surface.

| State                            | Card                                     | Edge         | Port                    | Panel or contents row  |
| -------------------------------- | ---------------------------------------- | ------------ | ----------------------- | ---------------------- |
| rest                             | tone by status                           | kind's look  | kind's look             | plain                  |
| hovered                          | primary ring                             | lit          | primary border and fill | accent background      |
| near (linked to what is hovered) | primary ring                             | lit          | lit                     | —                      |
| dim (something else focused)     | —                                        | faded out    | —                       | —                      |
| selected / pinned                | primary ring, all its connectors lit     | lit          | lit                     | accent background      |
| current                          | `active` tone, breathing, pulsing marker | —            | —                       | active icon            |
| arrived                          | `card-arrive` ring                       | `edge-flash` | —                       | highlight ring + pulse |
| visited                          | `done` tone                              | —            | —                       | check icon             |
| error                            | `error` tone, destructive ring           | —            | error tone              | error icon             |

### Interaction contract

- Hovering a card lights every connection it takes part in and rings the cards at their far end;
  everything else recedes so one path can be followed across the diagram.
- Hovering a port or an edge lights that one transition and shows its condition, its target and, for
  a return, its cause and exit.
  An edge's hint is anchored at the pointer and its text is the edge's accessible name (`role="img"`).
- Clicking a port or an edge travels to the far end: the camera moves there, the edge flashes and
  the card pulses on arrival.
- Clicking a block card selects the block; the panel opens at its block level and the selection goes
  into the URL.
- Clicking a contents row selects the block and moves that view's camera to it with the same arrival
  pulse, on the map and on the graph alike.
- Clicking a step — in the panel's step list, in a card's steps tooltip, in the node panel's
  connections — switches to the graph view, selects the step's block, brings the step into view with
  an arrival pulse and opens the panel's node level on it. The finder does the same on the graph; on
  the map it selects the block that owns the step.
- Clicking an item of a block's bound list opens the block panel's list section at that item and
  marks it.
- Clicking a variable token opens the variables surface with that variable highlighted.
- A fact chip is `hoverOnly`: it explains itself and does nothing on click.
- Changing a layout preset re-lays both diagrams and returns the camera to the current focus.
- The navigator (minimap) opens folded on both diagrams and is remembered once switched on, so a
  card in the diagram's corner is never under it by default.
- Ports and rows are reachable with `Tab`, and `Enter` acts as a click.

### Wording that must stay one wording

- A bound list's progress is rendered by `listProgressLabel` (the engine's `progress-facts.ts`,
  re-exported by `run/model.ts`) on the card, in the contents, in the panel, in the picture and in
  the notification footer alike: a counter the binding did not resolve reads as `—`, never as `0`
  and never as `?`.
- Durations are split once by the engine's `splitDuration` and worded by `wordDuration`: in the
  interface language through `formatDuration` (`run/duration.ts`), in English in the picture;
  clock times come from `formatClock`.
- A block's status wording comes from `blockStatusLabel` (`run/waiting.ts`), so the chip, the legend
  and the block texts agree on who is being waited for.

## Dark/Light Theme

- Colors switch via CSS custom properties in `globals.css`
- **Never** use `dark:` prefix — all theming is through CSS variables
- Test both themes when adding new components
