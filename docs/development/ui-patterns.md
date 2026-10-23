# UI patterns

This is the contributor contract for `packages/web-frontend/`. Start with the existing components
and hooks; [Web UI architecture](web-ui.md) explains routing, private admission and screen ownership.
Component props and exact token values remain in their source files.

## Choose the existing composition

| Need                           | Owner                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Standard data page             | `PageShell`, `PageHeader` and `FilterBar`                                      |
| Independently refreshed result | `DataRegion` with explicit `hasResult`                                         |
| List/grid of resources         | `DataListView` and a slotted `CardShell`                                       |
| Tabular data                   | `data-table/` and `ServerPagination` for server paging                         |
| Process header and controls    | `diagram/PageHeader`, `DiagramToolbar`, shared `PageHeaderContent`             |
| Forms and navigation           | `components/ui/` primitives, `LabeledFilter`, `SortSelect`, `SearchableSelect` |
| Destructive decision           | `ConfirmDialog`                                                                |
| Resource history               | `history/RevisionHistoryDialog` and its `RevisionHistorySource`                |
| User/admin settings navigation | `Tabs` / presentation-only `SettingsNav`                                       |
| Empty, initial, failed result  | `EmptyState`, local skeleton/`PageLoader`, `InlineError`                       |

Use the shared button/input/select/textarea/table/dialog primitives rather than raw controls or
custom popups. Tables are valid for genuinely tabular tasks; resource cards use `CardShell`.
Auth pages compose `AuthLayout` and the shared lazy form. Keep the justified process/detail/settings
layouts rather than forcing every screen into a list template.

`CardShell` owns list/grid geometry through icon, title, titleAside, description, note, meta, badge
and action slots. A clickable card has a keyboard-operable title; nested controls stop navigation.
Action labels supply accessible names and delegated hints. Use shared date/size/relative-time
formatters; add a badge for a meaningful state, not a normal “valid” decoration.

## Retained results and drafts

Loading belongs to the smallest affected region. Preserve the frame, header, tabs, filters,
independent panels, focus, scroll and unsaved inputs. A successful empty response is a loaded
result. Use an initial skeleton only before that region has a usable result; refreshing retains
its accepted result with local pending/error/retry feedback and `aria-busy`.

Compose `useResource`, `DataRegion` and the existing latest-request guard. Keep accepted items,
total, page, size and query in one snapshot, separate from requested controls. Captions, period
labels and pagination describe that accepted snapshot until its successor arrives. An empty
out-of-range page keeps first/previous navigation. A failed card refresh cannot erase other cards.
`PageShell.hasResult` is explicit when the whole body owns retained data; a local read must not
replace a loaded tab with `PageShell.loading`.

Confirmed mutations supersede older reads. Adopt fresh accepted values for untouched fields and
preserve independently dirty fields. A successful save clears only the value actually submitted;
a newer edit remains dirty. A resource/account change cannot expose another identity's old data.
Use the existing private holding boundary during uncertain authority; do not reveal private
content to make a layout calculation or preserve a visual snapshot.

Settings panels use `forceMount` plus `hidden` to retain drafts without focusable inactive controls.
The caller owns URL changes and selection; a hash or guide target activates the containing view
before scrolling. Full translated labels, descriptions, help, badges and actions wrap on narrow
screens; long storage keys must not widen the card.

`ConfirmDialog.onConfirm` awaits the operation and rejects failure. Render the refusal inside its
content slot so it remains accessible with the modal open, and retain the user's input for retry.
Use its decision identity, duplicate-submit guard and focus-return support. Native `confirm`,
`alert` and `prompt` are not substitutes. Shared execution-stop controls retain their separate
current revision, ownership and reconciliation contract.

## Measurement and local feedback

Use `useListPageSize` with `DataListView` and its `onViewModeChange`; reset to the first page when
capacity changes. The hook accepts only finite positive geometry for every measured item, retries
after a hidden container is disclosed, and settles item height once per view. Later-page items do
not redefine the accepted row height. `useDynamicPageSize` is the lower-level table measurement
primitive. Neither requires exposing a private hidden region.

Use `useDebounce` for search and the existing request guard directly or through `useResource` for
overlapping reads. Older success/error/finally callbacks cannot replace the current query or clear
its pending indicator. Keep server pagination outside the scrolling list, or use its existing
embedded card footer where appropriate.

## Tokens, wording and accessibility

`src/styles/globals.css` owns OKLCH theme tokens, Inter/monospace fonts and reduced-motion rules.
Use semantic background/foreground/card/popover/primary/muted/border/input/ring classes rather
than raw Tailwind palettes, separate first-party `dark:` colors or copied numeric theme values.
`destructive` is readable text/border/tint; solid danger surfaces use `destructive-fill` with
`destructive-foreground`. `success`, `warning`, `info` and `your-move` express their named states.
Color never carries the only state indication.

Charts and sparklines share `CHART_COLORS`. Finite Tremor utility generation and live theme aliases
belong to the existing CSS integration, not global palette overrides or dependency-wide scanning.
A clipped or unobserved time-series point is `null`; observed zero and an absent event within
covered history remain zero. A limitation notice does not alter full-period totals or invent
numeric tooltip values.

All visible wording uses the existing i18n owner and matching EN/RU keys. Guide copy has no
fallback text. Preserve authored template braces and let existing `TemplateText`, `VariableRef`,
`ExpressionText` and `ConditionText` explain references instead of flattening them to JSON.
Use `lucide-react`, semantic inherited colors, visible form labels and named icon-only controls.
Check keyboard navigation, focus return, touch/narrow layouts and both themes.

## Modal and hint layers

Compose `Dialog`, `AlertDialog`, `Sheet` and portaled controls through `ModalLayerScope`.
Backdrop, content and popup layers remain ordered, including nested modals and retained exit
animations. Do not solve layering with unrelated absolute positioning or page-specific z-index
numbers.

`TooltipContent` and diagram `Hint` share the popover surface. One `HintLayer` in `App.tsx` serves
`data-hint` targets; pointer-anchored edge hints use `data-hint-at="pointer"` and do not intercept
the pointer. Delegated hints read the target's nearest modal popup layer. Give screen readers
`aria-label`/appropriate semantics; process surfaces do not introduce native HTML/SVG title bubbles.

## Process diagrams

`components/diagram/` owns ported cards, ports, edges, markers, toolbars, contents and panels;
`run/status.tsx`, `run/nodeTypeStyle.tsx` and `diagram/interactive.ts` own their status/type/affordance
vocabulary. A clickable object navigates and looks clickable; hover-only facts explain without
acting, and static text has no false button treatment.

Map and technical graph share focus and drawing primitives. Hovering a card lights its connections
and neighbors; hovering an edge/port identifies the transition and its cause/exit where applicable.
Clicking a connection navigates to the far end with reveal/arrival feedback. Selecting a block
updates the panel and URL; selecting a step opens its owning block and technical node view.
Contents rows, finder results, bound-list items and variable references use the same reveal/highlight
primitives. A request has a fresh token so repeating it can reveal the same target again.

Use `requestReveal` for transformed diagram content and `useHighlightTarget` for ordinary targets.
The existing viewport owns camera fit; changing a layout preset returns it to the current focus.
The remembered minimap starts folded. Ports and contents rows support Tab and Enter/Space.
Animations add emphasis to states already carried by text, fill and rings, and stop under reduced
motion.

The engine's `progress-visual` entry shares layout, port geometry and fact wording with image
rendering. Reuse `listProgressLabel`, duration helpers and `blockStatusLabel`: an unresolved bound
list counter reads `—`, never invented zero. Do not implement a browser-only interpretation of
run status, waiting responsibility or progress routes.

## Adding or changing a surface

1. Identify the existing page/resource owner and appropriate composition above. Put local loading,
   failures and mutations in that owner; reuse its resource/admission guards.
2. Compose the existing header, filters, result region and list/table or justified detail layout.
   Preserve accepted scope, drafts, retry, pagination and focus; do not add parallel controls.
3. Add both translations, accessible labels and the route/guide decision described in
   [Web UI architecture](web-ui.md#guides). Keep topic-level user instructions at the existing
   portable help owner.
4. Exercise the actual changed behavior through the root npm entrypoints and existing frontend
   helpers, then inspect affected browser states. Include pending/empty/error/retry, rapid scope
   changes and failed confirmation when relevant; visual changes need direct inspection rather
   than a component or heading count. See [testing](../../tests/TESTING-GUIDE.md).
