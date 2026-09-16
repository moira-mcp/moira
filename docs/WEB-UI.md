# Web UI Documentation

## Architecture

### Docker Setup (Dev & Production)

**Single-port access**: All services accessible via localhost:${DOCKER_PORT}
**Nginx reverse proxy**: Routes requests to appropriate internal services

- `/mcp` → mcp-server:3000 (HTTP MCP tools)
- `/api/` → web-backend:4201 (workflow API, internal)
- `/` → static frontend build (served by nginx)

```
External Access: localhost:${DOCKER_PORT}
    ↓
nginx reverse proxy
    ├── /mcp → mcp-server:3000
    ├── /api/ → web-backend:4201 (internal)
    └── / → static frontend (nginx)
```

## Component Structure

```
frontend/src/
├── App.tsx                      # Application root with routing
├── i18n.ts                      # i18n configuration (i18next + react-i18next)
├── locales/
│   ├── en.json                  # English translations (default)
│   └── ru.json                  # Russian translations
├── components/
│   ├── Layout.tsx               # Base layout (Header + Sidebar + Content grid)
│   ├── ErrorBoundary.tsx        # Error boundaries with tracking
│   ├── ProtectedRoute.tsx       # Auth-protected route wrapper
│   ├── layout/
│   │   ├── MainLayout.tsx       # Main app layout wrapper
│   │   ├── MainAppLayout.tsx    # /* routes layout with SidebarProvider
│   │   ├── AdminLayout.tsx      # /admin/* routes layout
│   │   ├── AppSidebar.tsx       # Config-driven sidebar with shadcn/ui
│   │   ├── UserMenu.tsx         # User dropdown (theme, language, logout)
│   │   └── WorkflowViewerPlaceholder.tsx  # Workflow detail page container
│   ├── execution/              # Execution display components
│   │   ├── ExecutionInspector.tsx    # Run page with DI (fetchExecution prop, editable/canAnswer flags)
│   │   └── ExecutionErrorHistory.tsx # Error log with collapsible entries, error badges
│   ├── flow/                    # Flow page: the definition as a process, edited in place
│   │   ├── editing.tsx / model.ts / modes.ts        # Edit set (apply, export diff), run-less projection, the two views
│   │   ├── RegistryPanel.tsx                        # The variable registry (panel tab)
│   │   └── EditControls.tsx                         # In-place editors (block text, transitions, owner, node text)
│   ├── run/                     # Run page: the execution as a process
│   │   ├── MapView.tsx / CanvasView.tsx                                     # The map view: header, guidance, contents sidebar; its layered diagram
│   │   ├── BlockDetailPanel.tsx / VariablesPanel.tsx / StepList.tsx        # Panel tabs
│   │   ├── BlockTimings.tsx / BlockListCard.tsx / BlockRouteFacts.tsx      # Block panel: pass timings, bound list, route facts (run page)
│   │   ├── TypicalDurations.tsx                                            # Block panel: the version's typical durations (flow page)
│   │   ├── variableRows.ts / variableTree.tsx                              # Variables grouping model; shared rows, groups, tree, leaf editor
│   │   ├── StepCard.tsx / TabBadge.tsx                                      # One step card for every list; the panel badge
│   │   ├── RunCursor.tsx / Walkthrough.tsx / Guidance.tsx / status.tsx      # Cursor, guide, notes, status vocabulary
│   │   ├── model.ts / route.ts / chips.ts / layout.ts                       # Pure view helpers; ELK layout
│   │   ├── duration.ts / waiting.ts                                         # Duration and clock formatting; who-is-waited-for wording
│   │   └── modes.ts / nodeTypeStyle.tsx
│   └── workflow/                # Workflow management
│       ├── WorkflowExplorer.tsx # Workflow list with FilterBar + DataListView + useDebounce
│       ├── WorkflowGraph.tsx    # React Flow visualization with layout controls
│       ├── WorkflowCard.tsx     # Compact single-row workflow card (icon + name left, owner center, badges right)
│       ├── WorkflowSidebar.tsx  # Persistent sidebar (workflow info / node details)
│       ├── NodeDetailSheet.tsx  # Node detail panel (legacy, used in execution views)
│       ├── WorkflowHeader.tsx   # Workflow metadata display
│       ├── WorkflowVariablesPanel.tsx # Collapsible variables sidebar
│       └── WorkflowVisualizationPage.tsx # Container component
│   ├── QuickStartCard.tsx       # Per-client QuickStart tabs with setup instructions
│   ├── notes/                   # Notes management components
│   │   ├── NoteInlineEditor.tsx # Inline expandable card editor (create/edit)
│   │   └── NoteHistoryDialog.tsx # Notes' source for the shared history dialog
│   ├── history/
│   │   └── RevisionHistoryDialog.tsx # One version-history dialog for notes, playbooks and global settings; exports DiffView
│   ├── access/
│   │   └── VisibilityToggle.tsx # One control for a resource's visibility: badge when read-only, button when it can change
│   └── playbooks/
│       └── PlaybookEditor.tsx   # Inline playbook editor with the live-runs warning
├── pages/
│   ├── Dashboard.tsx            # Home page with stat cards, Quick Start, recent ExecutionCards
│   ├── Workflows.tsx            # Workflow explorer + viewer
│   ├── FlowPage.tsx             # Flow page: the workflow definition as a process, edit mode for owners
│   ├── Executions.tsx           # Execution history (ExecutionCard list/grid)
│   ├── Playbooks.tsx            # Playbooks page (PlaybookCard list/grid, editor, shared history)
│   ├── ExecutionInspectorPage.tsx   # User execution inspector wrapper
│   ├── Settings.tsx             # User settings (single scrollable page)
│   ├── settings/               # Settings sub-components
│   │   ├── ProfileSettings.tsx  # Profile info, name editing, handle, email verification
│   │   ├── SecuritySettings.tsx # Password change with strength indicator
│   │   ├── GitHubCodespaceSettings.tsx # Website-only GitHub codespace connection
│   │   ├── OAuthSettings.tsx    # OAuth consent management
│   │   ├── SessionsSettings.tsx # Active session management
│   │   └── ApiTokensSettings.tsx # API token management (create, list, revoke)
│   ├── Admin.tsx                # Admin panel entry
│   ├── AdminDashboard.tsx       # Admin dashboard with stats + merged analytics
│   ├── AdminExecutions.tsx      # Admin executions monitoring (PageShell + DataListView)
│   ├── AdminExecutionInspectorPage.tsx # Admin execution inspector wrapper
│   ├── AdminUserDetail.tsx      # Admin user detail and security management
│   ├── AdminSettingsUnified.tsx # Unified admin settings (Definitions, Values, Maintenance, Codespaces tabs)
│   ├── AuditLog.tsx             # Admin audit log viewer (AuditLogCard grid)
│   ├── SystemSettings.tsx       # Admin system settings (embedded mode for unified view)
│   ├── AdminSettings.tsx        # Admin global settings (embedded mode for unified view)
│   ├── UserManagement.tsx       # Admin user management (PageShell + DataListView)
│   ├── DeletedWorkflows.tsx     # Admin deleted workflows (PageShell + DataListView)
│   ├── OperationalDashboard.tsx # Operational metrics: metric cards, time series charts, breakdowns, filters
│   ├── Notes.tsx                # User notes management (NoteCard list/grid)
│   ├── AdminTokens.tsx          # Admin API token management (PageShell + DataListView)
│   ├── AdminArtifacts.tsx       # Admin artifacts management (PageShell + DataListView)
│   ├── Artifacts.tsx            # User artifacts management (ArtifactCard list/grid)
│   ├── Login.tsx                # Login page
│   ├── Register.tsx             # Registration page
│   ├── RegistrationSuccess.tsx  # Post-registration email verification page
│   └── OAuthAuthorize.tsx       # OAuth authorization
├── auth/
│   ├── AuthProvider.tsx         # Better Auth UI provider
│   └── better-auth-client.ts    # Auth client config
├── hooks/
│   ├── useResource.ts           # Page-local data store with last-good retention
│   ├── useWorkflowData.ts       # Workflow API integration
│   ├── useNotes.ts              # Notes API integration
│   └── useTheme.ts              # Theme management
├── services/
│   └── api-client.ts            # HTTP client
└── utils/
    └── workflow-transformer.ts  # Per-node presentation data for the graph
```

## Design Token System

Color tokens use OKLCH format in `packages/web-frontend/src/styles/globals.css`. Neutrals have indigo tint (hue ~260°). Dark theme background lightness: 0.19 (card: 0.22, secondary: 0.30, border: 0.34).

For component patterns, color token rules, and new-page checklist: `docs/DESIGN-SYSTEM-CHECKLIST.md`.

### Token Categories

- **Core:** `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive` (each with `-foreground` variant)
- **Semantic:** `--success`, `--warning`, `--info` (each with `-foreground` variant)
- **Chart:** `--chart-1` through `--chart-5`
- **Sidebar:** Aliases to main theme variables (`--sidebar: var(--background)`)
- **Layout:** `--radius`, `--border`, `--input`, `--ring`

### Theme Switching

Light/dark via `.dark` class on `<html>`. ThemeProvider context + localStorage.

### Typography

Self-hosted Inter Variable font via `@fontsource-variable/inter`. Registered as `--font-sans` in `@theme inline`.

### UI Primitives

shadcn/ui primitives in `src/components/ui/`: alert-dialog, alert, avatar, badge, button, card, checkbox, collapsible, command, dialog, dropdown-menu, form, input, label, popover, progress, scroll-area, select, separator, sheet, sidebar, skeleton, switch, table, tabs, textarea, tooltip.

Additional: NumberTicker (Magic UI, animated counter using motion/react).

### Shared Components

Higher-level composable components in `src/components/`:

| Component             | File                                | Purpose                                                                                                                                                               |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PageHeader            | `page-header.tsx`                   | Page title, description, action slot, SidebarTrigger                                                                                                                  |
| StatCard              | `stat-card.tsx`                     | KPI card with label, value, icon, optional Tremor SparkAreaChart sparkline                                                                                            |
| StatusBadge           | `status-badge.tsx`                  | Execution status → semantic color mapping (running/waiting/completed/failed)                                                                                          |
| DataListView          | `DataListView.tsx`                  | Universal data list wrapper: ViewToggle, grid/list layout, ServerPagination, PageLoader, EmptyState                                                                   |
| DataTable             | `data-table/`                       | @tanstack/react-table wrapper with sorting, filtering, pagination                                                                                                     |
| CardShell             | `cards/CardShell.tsx`               | Universal card wrapper: dual-mode (compact/list), action buttons, `alwaysVisible` for list mode                                                                       |
| Card Components       | `cards/`                            | Reusable card components (ExecutionCard, NoteCard, ArtifactCard, etc.) built on CardShell                                                                             |
| PageShell             | `PageShell.tsx`                     | Page layout wrapper: title, description, loading (skeleton), error states, action slot                                                                                |
| FilterBar             | `FilterBar.tsx`                     | Standardized filter toolbar: search input, filters slot, actions slot, reset button                                                                                   |
| LabeledFilter         | `LabeledFilter.tsx`                 | Wrapper adding visible label above any filter control                                                                                                                 |
| SortSelect            | `SortSelect.tsx`                    | Combined sort field+direction dropdown (e.g., "Created ↓")                                                                                                            |
| SearchableSelect      | `SearchableSelect.tsx`              | Combobox with text search for dynamic option lists (absolute dropdown + cmdk)                                                                                         |
| TopWorkflowsTable     | `TopWorkflowsTable.tsx`             | Shared DataTable for admin top workflows (AdminDashboard, AdminAnalytics)                                                                                             |
| ServerPagination      | `ServerPagination.tsx`              | Server-side pagination (total-based or cursor-based), matches DataTable style                                                                                         |
| EmptyState            | `empty-state.tsx`                   | Centered icon + title + description + action CTA                                                                                                                      |
| InlineError           | `inline-error.tsx`                  | Alert destructive with optional retry                                                                                                                                 |
| PageLoader            | `page-loader.tsx`                   | Skeleton stat cards + table rows placeholder; only before a page's first data                                                                                         |
| RouteSkeleton         | `route-skeleton.tsx`                | In-layout skeleton while a lazily loaded page's code arrives                                                                                                          |
| DiagramSkeleton       | `route-skeleton.tsx`                | Quiet surface while the technical graph chunk arrives (flow and run pages)                                                                                            |
| ConfirmDialog         | `confirm-dialog.tsx`                | AlertDialog wrapper with async onConfirm, loading state, ReactNode description                                                                                        |
| RevisionHistoryDialog | `history/RevisionHistoryDialog.tsx` | Version history for anything the shared revision store versions; driven by a `RevisionHistorySource` (list, read revision, read current, restore); exports `DiffView` |
| VisibilityToggle      | `access/VisibilityToggle.tsx`       | A resource's visibility as a badge (read-only) or a button that flips it; used by the flow page and playbooks                                                         |

DataTable subcomponents: `column-header.tsx` (sortable headers), `pagination.tsx` (page nav + i18n props + aria-labels), `toolbar.tsx` (search + reset).

ServerPagination: used on pages with server-side pagination (Executions, Notes, Artifacts, AdminArtifacts, AdminExecutions, AdminTokens, DeletedWorkflows, UserManagement, AuditLog). Rendered outside the scroll container (sticky at bottom). Supports total-based mode (shows page X of Y, first/prev/next/last) and cursor-based mode (prev/next only). Uses `common.pagination` i18n keys.

`useDynamicPageSize` hook (`hooks/useDynamicPageSize.ts`): calculates optimal page size from container height. Returns `{ pageSize, containerRef }`. Attach `containerRef` to the scrollable container div. Uses ResizeObserver with 500ms debounce. All list/table pages use this hook instead of hardcoded page sizes.

`useDebounce<T>` hook (`hooks/useDebounce.ts`): generic debounce for any value. Returns debounced value after specified delay (default 300ms). Used in Executions, Notes, AuditLog, AdminArtifacts, AdminTokens for search/filter inputs.

Table page layout standard: all list pages use `h-full flex-col` layout with sticky pagination:

```tsx
<div className="h-full flex flex-col p-6 md:p-8">
  <PageHeader />
  <div className="mb-6 flex flex-wrap gap-4 items-center">/* filters + view mode toggle */</div>
  <div className="flex-1 min-h-0 overflow-auto" ref={containerRef}>
    {/* Card list/grid or EmptyState */}
  </div>
  {data.length > 0 && <ServerPagination />}
</div>
```

All pages use `PageShell` for layout (title, description, loading/error states). `FilterBar` provides search and filters. `DataListView` provides ViewToggle (list/grid), card layout, ServerPagination, PageLoader, and EmptyState. Card components use `CardShell` with dual-mode rendering (compact/list) and accept `compact` prop for grid mode. View mode persisted in localStorage via `storageKey` prop.

`DataListView<T>` API: `items`, `renderCard(item, viewMode)`, `keyExtractor`, `storageKey`, `pagination` (discriminated union: `total` | `cursor` | `none`), `containerRef`, `emptyIcon`, `emptyTitle`.

Filter layout standard: all pages use `<div className="mb-6 flex flex-wrap gap-4 items-center">` — no Card wrappers, no Labels.

All shared components accept i18n label props for translatable strings — do not hardcode English text.

Usage rules documented in `packages/web-frontend/UI_STANDARDS.md`.

## Routes

Application routes:

```
/ (protected)                      - Dashboard (home page)
/workflows (protected)             - Workflow explorer + viewer
/workflows/:id (protected)         - Flow page (FlowPage.tsx); also /workflows/:handle/:slug
/executions (protected)            - Execution history
/playbooks (protected)             - Playbooks (Playbooks.tsx)
/artifacts (protected)             - User artifacts management
/settings (protected)              - User settings (single scrollable page with all sections)
/admin (protected)                 - Admin dashboard with merged analytics
/admin/users (protected)           - User management (PageShell + DataListView + UserCard)
/admin/users/:id (protected)       - User detail and security management
/admin/executions (protected)      - Admin executions monitoring (PageShell + DataListView + ExecutionCard)
/admin/executions/:id (protected)  - Admin run page (same component as /executions/:id)
/admin/audit-log (protected)       - Audit log viewer (PageShell + AuditLogCard + total-based pagination)
/admin/settings (protected)        - Unified settings (Definitions, Values, Maintenance, Codespaces tabs)
/admin/admin-settings (protected)  - Redirects to /admin/settings
/admin/analytics (protected)       - Redirects to /admin
/admin/analytics/operational (protected) - Operational metrics dashboard (OperationalDashboard.tsx)
/admin/deleted-workflows (protected) - Deleted workflows management (PageShell + DataListView + DeletedWorkflowCard)
/admin/workflows (protected)         - All workflows browser with filters (PageShell + FilterBar + DataListView + AdminWorkflowCard)
/admin/notes (protected)           - Notes management (persistent agent memory)
/admin/tokens (protected)          - Admin API token management (PageShell + DataListView + TokenCard)
/admin/artifacts (protected)       - Admin artifacts management (PageShell + DataListView + ArtifactCard)
/admin/monitoring-test (protected) - Monitoring test page for validating monitoring pipeline
/login (public)                    - Login page
/register (public)                 - Registration page
/registration-success (public)     - Post-registration email verification instructions
/force-password-reset (protected)  - Forced password reset page
/oauth/authorize (public)          - OAuth authorization
```

Protected routes require authentication (ProtectedRoute wrapper).

Sidebar navigation:

- Home (/)
- Workflows (/workflows)
- Executions (/executions)
- Notes (/notes)
- Playbooks (/playbooks)
- Artifacts (/artifacts)
- Documentation (/docs/) - external link, opens in same tab

- Settings (/settings)
- Admin (/admin) — visible only for admin users

Active route highlighting via NavLink isActive.

### Quick Start Card

Dashboard displays per-client Quick Start card with tabbed interface:

- Tabs for 11 MCP clients: Claude Code, Copilot CLI, Cursor, Claude Desktop, VS Code, Claude Web, ChatGPT, Perplexity, Continue, Zed, Gemini CLI
- Setup instructions rendered by `setupType`: `gui` (description with `whitespace-pre-line`), `config` (JSON code block), `cli` (primary + auth + alternative commands), `deeplink` (button + auth + alternative)
- Copy button with visual feedback ("Copied!" state) on code blocks
- Client data from `@mcp-moira/shared/mcp-clients` (shared with landing page)
- Config content generated by `configGenerators`/`deeplinkGenerators` (not i18n)
- i18n keys under `pages.dashboard.quickStart.clients.{clientId}.*`

The MCP URL fed to the generators is resolved by `resolveMcpUrl()` (pure, exported) via the
`useMcpUrl()` hook, gated by deployment mode: `self-host` uses the runtime `mcpUrl` from
`useFeatures()` (the server-resolved `<protocol>://<MOIRA_HOST>/mcp`, falling back to the
build-time `process.env.MCP_URL` while the value loads); `saas` uses the build-time-baked
`process.env.MCP_URL`. So self-host shows the URL for the actual host/port the instance runs on.

Internal components: `CopyButton`, `CodeBlock`, `CollapsibleSection`, `ClientPanel`.

### Settings Page

Single scrollable page at `/settings` with all sections rendered flat (no tabs).

**Architecture:** `Settings.tsx` renders all sections sequentially with `<h2>` headings and `<Separator>` between them. Container has `data-testid="settings-flat-layout"`.

**Sections:**

- Profile (`ProfileSettings.tsx`): Name editing, email display with verification badge, handle management with AlertDialog confirmation
- Security (`SecuritySettings.tsx`): Password change form with Progress-based strength indicator
- Integrations (`GitHubCodespaceSettings.tsx`): website-only GitHub App connect/reconnect, verified account and repository grants, disconnect confirmation, disabled/configuration/revocation states, and explicit external-grant recovery for unreadable credentials or an untracked refresh successor
- Integrations (`GitHubCodespaceManagement.tsx`): Cloud codespaces card with instance readiness badge, agent-authority disclosure, create form (approved repository select, ref, active/limit hint), saved repositories kept visible with a separate `repositories_stale` warning after provider refresh failure, per-codespace cards with repository/ref, provider and machine context, state badge, desired/observed state and generation, Start/Stop/Delete actions disabled while pending, destructive delete via `ConfirmDialog` that returns focus to its trigger; never mentions chats or sessions
- Admin Settings → Codespaces (`AdminCodespaceControls.tsx`): readiness facts (configuration, resource creation, connector, reconciliation backlog, active resources/operations and transfer bytes against limits) and the global/provider kill switches with a reason field and confirmed stop/resume
- OAuth Authorizations (`OAuthSettings.tsx`): DataListView with consent cards, empty state with KeyRound icon, revoke with ConfirmDialog
- Active Sessions (`SessionsSettings.tsx`): DataListView with session cards, Current Session badge, revoke disabled for current session
- API Tokens (`ApiTokensSettings.tsx`): DataListView with token cards showing name, prefix (monospace), dates, status badge (Active/Expired/Revoked). Create dialog with name input and expiration select (30d/90d/365d/never). One-time token display dialog with copy button and warning. Revoke with ConfirmDialog (variant="destructive").

**Dynamic Settings Section (Notifications):**

- `GET /api/notifications/channels` supplies one current-user descriptor per active communication
  adapter. The descriptor provides title, origin, capabilities, mapped setting keys,
  `ready|disabled|incomplete|unavailable` state and read-only extension trusted-delivery state; it
  contains no setting values, credentials or destinations.
- Telegram and extension descriptors render through `CommunicationChannelCard`. There is no
  Telegram key-prefix or component branch.
- Each card maps its exact setting definitions into the existing `SettingsEditor` with
  `categoryLayout="plain"`; structural values remain editable JSON and encrypted values remain
  masked.
- The test button posts no body to `/api/notifications/channels/:channelId/test`. The server uses
  stored settings for the authenticated user and the common communication service.
- Saving a mapped setting refreshes descriptor state from the server. Definitions not mapped to a
  communication channel render under a separate Settings section.
- Channel fields and test controls have accessible names; capability and state labels remain visible
  without hover.

**Section Order:** Profile → Security → Notifications (when channels exist) → Settings (when
unmapped dynamic definitions exist) → Integrations → OAuth Authorizations → Active Sessions → API
Tokens. Each section has a stable `data-testid="settings-section-{name}"`.

**SettingsEditor `collapsible` prop:**

- `collapsible={true}` (default): Collapsible groups with ChevronDown toggle — used by AdminSettings
- `collapsible={false}`: Flat Card rendering without Collapsible wrapper — used by Settings page

**Implementation:** Settings.tsx → ProfileSettings.tsx, SecuritySettings.tsx, GitHubCodespaceSettings.tsx, OAuthSettings.tsx, SessionsSettings.tsx

- Loads user profile via GET /api/user/profile
- Fetches dynamic settings definitions via GET /api/settings/definitions
- Fetches current-user communication descriptors via GET /api/notifications/channels
- Fetches masked current values via GET /api/settings
- Saves one edited dynamic value through bulk PUT /api/settings and applies the returned saved/refused result
- Tests one channel through POST /api/notifications/channels/:channelId/test with no request body
- Updates profile via PATCH /api/user/profile
- Changes password via POST /api/user/change-password
- Resends verification via POST /api/user/resend-verification
- OAuth consents via GET/DELETE /api/user/oauth-consents
- Sessions via GET/DELETE /api/user/sessions
- Handle change via PATCH /api/user/handle
- GitHub codespace connection via GET /api/integrations/github, browser navigation to GET /api/integrations/github/start, and DELETE /api/integrations/github
- External GitHub grant recovery via DELETE /api/integrations/github/external-revocation after the user revokes the grant in GitHub; this covers unreadable credentials and an untracked refresh successor
- Automatic ten-minute repository-grant refresh on Settings load plus an explicit Refresh button backed by `POST /api/integrations/github/refresh`; a provider failure keeps the saved repositories visible with a stale warning

**Password Strength Indicator (Progress component):**

- Too Short: < 6 chars (15%)
- Fair: 6-9 chars (33%)
- Good: 10-14 chars (66%)
- Strong: 15+ chars (100%)

### Executions Page

Execution history at `/executions` with filtering, sorting, and pagination.

**Filter Controls:**

- Search input: Filter by note (300ms debounce)
- Status dropdown: All statuses, Active (running), Locked, Completed, Failed, Waiting
- Workflow dropdown: Filter by specific workflow (dynamically loaded)
- Sort by: Created date or Updated date
- Sort order: Newest first or Oldest first

**Table Columns:**

- Execution ID (truncated to 8 chars)
- Workflow (displays workflow name from API; falls back to truncated UUID if workflow deleted)
- Status (color-coded) with error count badge
- Created date
- Updated date

**Error Display:**

- ErrorCountBadge shows the refusal count next to status (only if > 0; degradation entries are not counted by the server)
- Badge uses destructive variant with AlertTriangle icon

**Pagination:**

- 20 items per page
- Previous/Next buttons with disabled states
- Page indicator (X / Y)
- Results count display

**Implementation:** Executions.tsx

- Loads executions via GET /api/executions with query params
- Loads workflows via GET /api/workflows for filter dropdown
- Debounced search resets pagination to page 1
- Filter changes reset pagination to page 1
- Click row navigates to ExecutionInspector

**LockedExecutionsWidget:**

Yellow alert banner displayed above the execution list when locked executions exist. Shows count ("N locked execution(s)") with individual items listing workflow name and lock duration. Items collapse to 3 by default with expand/collapse toggle. User page shows own locked executions; admin page shows all locked executions with user email. Component: `LockedExecutionsWidget.tsx`, props: `admin` (boolean), `refreshKey` (number).

### Flow page (FlowPage component)

`/workflows/:id` and `/workflows/:handle/:slug` show one workflow definition as the process it
declares (`pages/FlowPage.tsx`).

**Data:** the workflow detail (`apiClient.getWorkflow`, whose `fileInfo.revision` is the
definition revision the page saves against) and the saved definition's derived process
(`apiClient.getWorkflowProcess`), both held in `useResource` stores (the detail through
`useWorkflowDetail`, the process keyed by workflow id and refreshed when the revision changes): a
refetch keeps the current value on screen with a "Refreshing…" indicator (`flow-pending`, in the
header row or the no-process bar), the page loader appears only before the first data of a
workflow (a move to another workflow through breadcrumbs or a subgraph link is a first load and
shows nothing of the previous one), and a failed refetch keeps the content and reports once
through a toast. While the page holds unsaved edits it re-derives the process in
the browser with the engine's `deriveProcess` (the `@mcp-moira/workflow-engine/process` subpath),
so the diagnostics it shows are the ones the server's validation would raise. The map renders a
run-less projection (`components/flow/model.ts`: every block pending, no route, no cursor, no run
title) through the run page's `MapView`; the page's context (`EditingProvider` with
`definition`) makes the shared status chips and icons, the run's no-content sentences and the run
notes disappear, and the map reads its guidance from `pages.flowPage.modeGuide`. Derivation
diagnostics are also shown on the offending block or step (`DiagnosticBadge`), and the registry
panel edits a whole declaration as JSON Schema besides its type, description and default.

**URL state:** `view` (`map | graph`, default map, registry `components/flow/modes.ts`; any other
value resolves to `map`; `graph` is the only view of a workflow without `progress`), `block`,
`guide` (walkthrough step), `edit` (`1` turns on edit mode; ignored for non-owners).

**Layout:** the toolbar (back, name and version, edit toggle with its hint for owners, the owner
actions: copy for public flows, visibility, share, delete); a header row with the view tabs and
"Explain this page"; the edit panel while editing (the edit count, which is the export diff's
entry count so a value typed back to what is stored is not an edit; discard, which clears every
recorded edit; save; the loaded revision; the export diff as flow-file path / before / after;
the server's refusal message); the process diagnostics inline; the view filling the main area; a
panel beside it (under it on a phone) with the **Block** tab (`BlockDetailPanel`, a step click
opens the graph view on that node) and the
**Variables** tab (`RegistryPanel`: the registry on the shared variable rows — name, type badge
and default in the row, description and the whole declaration as JSON Schema in the opened row;
in edit mode the type select, default input, description and schema editors sit in the same
places, a row's control removes the entry and a form below declares one). The panel is hidden
while the graph view is shown, because the graph brings its own node sidebar. The graph view
mounts `WorkflowGraph` (its `focusRequest` prop brings a chosen node into view, `selectedBlockId`
rings the block selected on the map, no minimap) with its controls beside `WorkflowSidebar`. Both
views stay mounted once shown and are only hidden by the tab, so the map keeps its selection and
the graph its viewport across a switch; the graph's lazy chunk is requested on page mount.

**Editing** (`components/flow/editing.tsx`): the edit set covers block label and summary,
connection labels with a loop's cause and exit, node ownership, node text (directive, completion
condition, message, expressions) and registry entries; `applyEdits` yields the edited definition,
`exportDiff` the changed flow-file entries. Editors (`components/flow/EditControls.tsx`), all in
the block panel: `BlockNameEditor` / `BlockSummaryEditor` on the block header, `TransitionEditor`
on each transition, `OwnerSelect` and `NodeTextEditor` on each step card; `RegistryPanel`
(variables tab; a default and a whole declaration are parsed as JSON before they
are applied). The save calls
`apiClient.updateWorkflow(id, edited, fileInfo.revision)` (`PUT /api/workflows/:id`); a 409 shows
the conflict text and a 400 the server's message, both keeping the edits; a success clears them and
reloads the detail and then the process for the new revision, the previous picture staying mounted
through both. The walkthrough (`Walkthrough`, generic over the page's views) explains block,
step, evidence, loop, editing and the views.

### Run page (ExecutionInspector component)

The execution page shows one run as the process its workflow declares. One component serves the
user and admin routes through dependency injection.

**Routes:**

- User view: `/executions/:id`
- Admin view: `/admin/executions/:id`

**Component Interface:**

```typescript
interface ExecutionInspectorProps {
  executionId: string;
  fetchExecution: (id: string) => Promise<ExecutionData>;
  editable?: boolean; // context editing (per-path saves)
  canAnswer?: boolean; // answering the waiting step; defaults to editable
  backRoute: string;
  showOwnerInfo?: boolean;
}
```

**Dependency Injection:**

- User view: `fetchExecution` → `apiClient.getExecution`, `editable` → true (context saved via
  `apiClient.updateExecutionContextPath` with the detail's `metadataRevisions.context`)
- Admin view: `fetchExecution` → `apiClient.getAdminExecution`, `editable` omitted (read-only
  context), `canAnswer` → true, `showOwnerInfo` → true

**Data:** the execution detail, the workflow definition (step text and input schemas for the
block panel, editable variable list for the Variables panel) and the run projection from
`apiClient.getExecutionProgress(id, at?)`. Every run fact — block statuses, pass counts, the
route, the variables — comes from the projection; the page derives none of it. When a route cursor
is set the page keeps the whole-run projection (for the scrubber) and fetches the projection at
the cursor for the views.

**URL state:** `view` (`map | graph`, default map, registry `components/run/modes.ts`; any other
value resolves to `map`), `block` (selected block), `at` (route cursor, a visit sequence number),
`guide` (walkthrough step). Unknown values fall back to defaults; navigation compares against the
live URL so a duplicate change pushes no history entry.

**Layout:**

- Compact toolbar (single line): back button, execution ID (copy), workflow name, status badge,
  current node (focuses the node graph), owner info (admin), lock button (user view, running
  executions), refresh (spins, `data-pending="true"`, while an
  execution or progress request is in flight), error badge. A refresh that fails keeps the run on
  screen and reports through a toast; a progress refetch that fails keeps the projection already on
  screen (the "unavailable" banner is a first-load state only). The Locks tab holds its history in a
  `useResource` store: opening it again refreshes behind the list (`locks-panel` with
  `data-pending`), the spinner (`locks-loading`) shows only before the first list.
- With a process view: a header row with the view tabs (**Map** and **Graph**), the route cursor
  (when a route is recorded), the status legend (`StatusLegend`, worded for the run's
  `waitingFor`) and the "Explain this page" button; the view fills the remaining width and
  height. Both views stay mounted once shown and are only hidden by the tab, so a switch keeps the
  map's selection and the graph's viewport; the graph's lazy chunk is requested on page mount. The
  toolbar's current-node button and a step's "focus" click switch to the graph view and focus the
  node. Without a process view (a workflow without `progress`): the technical node graph fills
  the main area.
- Panel (beside the run on `lg` and wider, stacked under it below, capped at 38 vh on a phone) with
  tabs: **Block** (default when a process view exists), **Variables**, **Errors**,
  **Steps** and **Locks**.

**Views** (`components/run/`):

- `MapView` — one component for both pages: a compact header (the run's `taskTitle`, the rendered
  `title` only when it differs from the task title, the goal and the fact chips; nothing on a
  definition), a one-line guidance disclosure (`guidance-map`, closed by default, its state
  remembered per page in `localStorage` under `moira.map.guide:<page key>`), the layered diagram
  (`CanvasDiagram` from `CanvasView.tsx`, no minimap) and the contents sidebar (`map-contents`):
  every block in process order with its status icon, pass count (`×n`), bound-list `done/total`,
  the typical run duration whenever the version's statistics carry one for the block — on the
  flow page and on a run (`data-contents-typical`) — plus the node finder
  (`map-node-finder`, which answers "which block is this step in" and selects that block). The
  sidebar sits left of the diagram from `lg` and stacks under it on a phone (`useIsMobile`),
  where the diagram keeps a fixed readable height. The map holds no block narrative: the page's
  panel carries it.
- `runBlocks(progress, statistics?)` (`run/model.ts`) joins the process blocks with the run's
  projection — each block's `timing`, its bound `list` and, when the version's statistics are
  given, its `stats` — and `RunProgress` is the projection with an optional `statistics`; a rendered
  summary that equals the block's description or its name (an untemplated `content.summary`, or
  one that renders to the label) is dropped so the views show it once, under the title.
- `CanvasDiagram` (`CanvasView.tsx`) — React Flow over an ELK layered layout (`layout.ts`, `elkjs`
  loaded on first use):
  forward edges between blocks adjacent in process order as elbows with label pills (several
  transitions between one pair take their own line and label row, `PARALLEL_STEP`; from
  `PARALLEL_CHIP_MIN` transitions the pills give way to one "forward" chip in the source block,
  `parallelForwardsOf` in `chips.ts`, that names the target and the count and lights the bundle
  on hover; the gap between ranks is at least `MIN_RANK_SEP` and grows to the widest label pill
  drawn at rest plus clearance, `rankSeparation`, with the pill capped at `LABEL_MAX_WIDTH` by the
  layout metric and the renderer alike, so no pill runs under the next card), forward edges
  that skip a block above and cycles as dashed lanes below, both thin and muted with no pill at
  rest; a transition into a hub block (many
  sources) is a muted bundled edge (`kind: "hub"`, one per source and hub, routed through the
  inter-rank gaps and a channel per hub into one port on the hub's left edge, `hubPort`). Every
  cycle, skip and hub exit is a chip in its source block (`chips.ts`: `canvasChipsOf` =
  `returnsOf` + `skipsOf` + `hubExitsOf`; transitions of one kind into one target fold into one
  chip carrying every label and every connector key, and `TransitionChipView` in `focus.tsx`
  renders `↩ n name` (`×k` when it folds k transitions) / `↗ n name` with the labels, and a single
  return's cause and exit, as the tooltip), and `TransitionFocusProvider` lights the edge
  (`data-focused`) and renders its pill (`data-edge-label`) on hover or for the selected block
  (`selectedBlockId`), which keeps all of its connectors lit while nothing is hovered. A card's
  footer is one facts line that never wraps — the step count, `×n`, the block's total time, the
  open pass's own time and the bound list's `done/total` (`BlockFacts`; a block without
  measurements shows nothing rather than a zero) — with the chips wrapped beneath it inside the
  card; the block height estimate (`estimateBlockHeight`) reserves the rows `chipRowCount`
  counts (a long-named chip takes a row of its own, short ones share). Mounts through
  `DiagramViewport` and opens at the fitted zoom (never below three quarters) on the first block
  with the block row in the upper third, or centred on the current block on a run; its
  fit-to-view control (`onFit`) fits the whole process at a readable zoom when it fits the
  viewport and otherwise returns to that first-block overview at the readable floor.

**Diagram substrate** (`components/diagram/`): `DiagramViewport` wraps `ReactFlowProvider` +
`ReactFlow` with the one interaction policy every diagram shares (`interaction.ts`,
`diagramInteractionProps(kind)`, `DiagramKind` = `canvas | graph`: a plain wheel pans freely,
`zoomOnScroll` off, pinch zooms, drag pans, nodes fixed, page scroll prevented under the pointer,
an opening fit clamped to a readable zoom per kind — canvas three quarters to full size, graph
down to its floor), one zoom/fit control cluster whose fit action a diagram may own through
`onFit` (the stock fit button is then replaced by the diagram's), and an `onReady` callback that
fires after an explicit fit so a diagram can place its opening viewport; `placement.ts`
(`useOpeningPlacement`) places once on ready and again only when the followed block changes,
never on a plain refetch. The map's diagram and the technical `WorkflowGraph` both mount through
it. Block cards carry no shadow (border, fill and ring carry state); floating surfaces keep
theirs. Scroll containers of the process pages use the `scrollbar-thin` utility
(`styles/globals.css`), a thin theme-coloured scrollbar in both themes.

The panel's tab strip (`run-panel-tabs`) is the shadcn tabs' `line` variant with `flex-wrap`:
content-sized triggers with a `title` from `pages.runPage.tabHints.*`, wrapping to a second row on
a narrow panel instead of scrolling; counters and warnings are `TabBadge` (`components/run/TabBadge.tsx`:
a count or a `!`, `role="status"` with an accessible label; `errors-count-badge`,
`variables-waiting-badge`, `locks-active-badge`).

**Step cards:** every list of steps — the block panel's `StepList` on a run, its editable step
list on the flow page, and the technical graph's cards — renders `StepCard`
(`components/run/StepCard.tsx`): a card on one grid with an
optional position column, a type badge of one width and height (`NodeTypeTag` with `fixed`,
`data-step-badge`), and a body whose title (`data-step-title`) and first line start at the same
point in every card; evidence chips and connection chips (`stepConnections` in `model.ts`:
internal → the sibling step, external → the owning block's name, `data-edge-kind`) wrap inside the
body; slots take the flow page's owner select, diagnostics and node text editor and the run page's
"current" marker. Pass counts are secondary text everywhere (`PassCount` in `status.tsx`: `×n` in
muted small type on the map card's facts line, the map's contents list and the block panel's facts
line `block-detail-facts`); the status chip carries none.

**Waiting wording** (`components/run/waiting.ts`): a block is `waiting` whenever the run pauses on
one of its nodes, and the projection's `waitingFor` says who is waited for. `waitingSuffix`
maps `user` to the `waiting` key and anything else to `waitingAgent`; `waitingLabel` and
`blockStatusLabel` word the state, so the status chip, the legend and the block texts read
"waiting for you" only for a person's gate (a `lock` node's PIN) and "agent on the step" otherwise.
Durations (`components/run/duration.ts`): `formatDuration` renders `12 s`, `1 min 20 s`,
`2 h 05 min` and "—" for `null` (never "0 s"); `formatClock` renders an epoch stamp as wall-clock
time in the interface locale, "—" when absent.

**Panels:** `BlockDetailPanel` (status chip worded for `waitingFor`, description, run content, a
facts line with the step count, pass count and visits, transitions in words with a cycle's cause
and exit, steps as cards with the evidence fields each schema demands — declared `globalInputs`
merged from the variable registry — and a click that focuses the node graph). On the run page it
adds `BlockTimings` (`block-timings`: one row per pass with its duration, the live pass
measured to `projectedAt`, the block's total and, when the statistics carry a sampled entry for
the block, the typical pass;
"—" for a pass without timestamps), `BlockListCard` (`block-list`: the bound list's `done/total`,
its items with their durations or a counters-only note, the current item) and
`BlockRouteFacts` (`block-route-facts`: the block's visits in route order with the exit each took,
the names it changed, the actor of an adjustment and the re-entries; a visit click sets the
cursor, the cursor's visit is marked, later visits are dimmed). On the flow page it adds
`TypicalDurations` (`typical-durations`: the version's median pass, median run time in the block
and median pass count from `apiClient.getWorkflowStatistics`, `GET
/api/workflows/:id/statistics?version=`; "loading typical durations…" while the first fetch is
pending, "typical durations unavailable" with the message as the title when it failed —
`statisticsPending`/`statisticsError` from the page's `useResource` — and "no runs yet" while the
version has no sample).
`VariablesPanel` (the one variables surface, see
below, with the **answer form** for the waiting step: fields from the step's input schema with
enum selects, booleans, numbers, JSON textareas, submit gated on required fields, the server's
refusal shown inline); `ExecutionErrorHistory`; `StepProgression`. The lazily loaded
`WorkflowGraph` is the page's graph view: a stable init callback, a focus request that fits the
view to a node, `selectedBlockId` ringing the block selected on the map, and no minimap.

**Answering the waiting step:** `apiClient.answerExecutionStep(id, input, expectedRevision)` calls
`POST /api/executions/:id/answer`; the page reloads the execution and the projection afterwards
whether the answer was accepted or refused, because a rejected answer is still an engine step that
advances the revision.

**Walkthrough** (`Walkthrough.tsx`): six anchored steps (process, agent, evidence, loop, route,
explore), each with a selector per view and a fallback view, the current block and panel tab it
needs; the highlight is a ring on the target element. **Guidance** callouts introduce the panels
(on a phone they fold to their title); the map's guidance is the one-line disclosure described
above.

**Lock Dialog:**

Two-phase dialog (input → result). Input phase: reason text field (required), Lock/Cancel buttons. Result phase: shows lockId and the PIN for sharing with MCP agents — this is the only place the PIN is shown, as it is stored hashed and not retrievable afterward. Submit enabled when reason is non-empty and not in loading state. Enter key submits.

**Variables tab:** `VariablesPanel` (`components/run/VariablesPanel.tsx`) is the run page's one
variables surface; it is always present and is the default tab when the run has no process view.
Rows come from the pure grouping model `variableRows` (`components/run/variableRows.ts`): the
declared variables (every registry name plus any undeclared top-level context key) in name order
with the registry description, the server's editability (`editableVariableNames`, the policy at
the current node), and — when the run has a process view — the projection's history and
adjusted mark; the value shown is the projection's while a cursor is set (a note says so) and the
context's otherwise, and an edit always targets the context. A node's outputs form a group under
its node id; a global the node wrote is one declared row and is hidden from the node's group; a
scope holding only such globals is no group. The panel shows, in order: the answer form when the
run waits and the page may answer; a tree-aware filter (name / value / both) with the fullscreen
button; the **Global variables** group and the **Node outputs** group, both collapsible
(`variables-group-<id>`, `data-open`) with a secondary count; the adjustment count as secondary
text. A row (`VariableRow` in `variableTree.tsx`: one grid for name, value and trailing controls)
shows a leaf as an input in edit mode with dirty-gated save and cancel and a modal for long text,
or as read-only text; objects and arrays open as a tree of rows with alphabetically sorted keys,
editable per path. The secondary history count opens the list of changes (seq, writing node,
value, adjusted) under the row. Saves go through `apiClient.updateExecutionContextPath` with the
execution's step revision and context revision, then the execution and projection reload;
read-only when `editable` is not set (the admin view). Test ids: `context-filter-input`,
`context-filter-field-*`, `context-var-<path>`, `context-node-toggle-<path>`,
`context-var-input|save|cancel|expand|modal-textarea-<path>`, `variable-history-<name>`,
`data-history-of`, `variables-cursor-note`, `context-fullscreen-button`.

**Errors tab:** ExecutionErrorHistory component showing execution errors with timestamps, collapsible entries, error type badges. A journal entry of kind `degradation` is not an error: it says the step ran without a playbook it names. Such entries are listed in their own card ("Ran without referenced text", `execution-degradations`, one row per entry with the node and time) above the error card, counted by a separate amber tab badge (`degradations-count-badge`), and left out of the red error count.

**Steps tab:** `StepProgression` lists the definition's nodes on the Block tab's `StepCard`s (`StepCardList`), ordered by the process blocks' node order and then the rest, each marked done when the shown route (up to the cursor) visited it (`data-step-done`) or current; clicking a card focuses the node in the graph.

**Locks tab:** Lock history cards showing all lock records (active/unlocked). Each card displays reason, node ID, status badge, timestamps (created/unlocked). Badge with count indicator on tab when locks exist. "Unlock" on active locks: admin override in the admin view, the owner's own unlock (no PIN) in the user view. The PIN is shown only once in the Lock Dialog result phase at creation time; lock history cards do not display it.

**Variables fullscreen:** the fullscreen button in the panel's filter bar opens a wide Dialog
(`w-[90vw] sm:max-w-5xl`) hosting the same `VariablesPanel` with the same props (no guidance, no
second fullscreen button); read-only when `editable` is not set.

**ExecutionErrorHistory Component:**

- Displays execution errors with timestamps and details
- Collapsible entries with error type badges (validation, handler, system); `degradation` entries render in the separate card instead
- Relative time display ("5m ago", "2h ago")
- Full timestamp and node ID on expand
- Input data display with whitespace-pre-wrap
- Empty state: "No errors recorded"

**Implementation:**

- `components/execution/ExecutionInspector.tsx` - the page (toolbar, panel, dialogs, graph wrapper)
- `components/run/` - modes, panels, cursor, walkthrough, pure view helpers and layout
- `pages/ExecutionInspectorPage.tsx` - user view wrapper
- `pages/AdminExecutionInspectorPage.tsx` - admin view wrapper
- `components/execution/ExecutionErrorHistory.tsx` - error history display

**Error Node Highlighting:**

WorkflowGraph receives `errorNodeIds` prop computed from execution errors; a step card whose
node is in it carries a destructive ring (`ring-destructive`) around the card.

### Artifacts Page

User artifact management at `/artifacts`.

**Features:**

- List view with artifact name, size, created date, expiry date, public URL
- Copy URL button for sharing
- Preview button opening artifact in sandboxed iframe
- Edit button for updating artifact content
- Delete button with confirmation dialog
- Create dialog (name + HTML textarea)
- Quota indicator showing storage usage

**Table Columns:**

- Name
- Size (formatted: B/KB/MB)
- Created (formatted date)
- Expires (formatted date)
- Actions (Copy URL, Preview, Edit, Open, Delete)

**Preview Implementation:**

- Sandbox iframe with `allow-same-origin` restriction
- Points to public URL (${STATIC_ARTIFACTS_DOMAIN})
- Prevents XSS from affecting main app

**Edit Dialog:**

- Name field disabled (cannot change artifact name)
- Content textarea with loading state
- Fetches current content from public URL
- Validates HTML content (must contain `<html>` tag)

**Quota Indicator:**

- Progress bar showing storage usage percentage
- Text display: used/limit bytes and artifact count

**Implementation:** Artifacts.tsx

- Lists artifacts via GET /api/artifacts
- Creates artifact via POST /api/artifacts
- Updates artifact via PUT /api/artifacts/:uuid
- Deletes artifact via DELETE /api/artifacts/:uuid
- Gets stats via GET /api/artifacts/stats

### Admin User Detail Page

Admin user management at `/admin/users/:id` with security controls.

**User Information:**

- User profile (email, name, status, created date)
- Admin role badge
- Email verification status
- Block status and reason

**Security Actions Panel:**

- Force Password Reset button (sets passwordResetRequired flag, revokes all sessions)
- Revoke All OAuth Tokens button (deletes all user's OAuth tokens)
- Security Activity stats (active sessions count, OAuth tokens count)
- Password Reset Required badge (shown when flag is true)
- Password Reset status panel (shows requester and timestamp)

**Confirmation Dialogs:**

- Force password reset requires confirmation
- Revoke tokens requires confirmation
- Destructive actions styled with red variant

**Button States:**

- Force Password Reset disabled when passwordResetRequired = true
- Revoke OAuth Tokens disabled when oauthTokensCount = 0
- Self-targeting prevented (admin cannot target themselves)

**Implementation:** AdminUserDetail.tsx

- Loads user via GET /api/admin/users/:id
- Loads security activity via GET /api/admin/users/:id/security-activity
- Forces password reset via POST /api/admin/users/:id/force-password-reset
- Revokes tokens via DELETE /api/admin/users/:id/oauth-tokens
- All actions create audit log entries

**Artifact Quota Section:**

- Storage and file count usage with progress bars
- Edit form for per-user quota overrides (quotaMb, maxFiles)
- Save and reset to defaults functionality
- Displays "Using global default" when no custom quota set

**Quota API:**

- Loads quota via GET /api/admin/users/:id/artifact-quota
- Updates quota via PUT /api/admin/users/:id/artifact-quota

### Admin Artifacts Page

Admin artifact management at `/admin/artifacts`.

**Stats Cards:**

- Total artifacts count
- Total storage size
- Users with artifacts
- Expired count
- Deleted count

**Filters:**

- User search (email/id)
- Include expired checkbox
- Include deleted checkbox
- Clear filters button

**Table Columns:**

- User (email with link to user detail)
- Artifact name
- Size (formatted)
- Created date
- Expires date
- Status badge (active/expired/deleted)
- Actions (open, delete)

**Actions:**

- Open in new tab button
- Delete with confirmation dialog

**Pagination:**

- Limit selector (10/20/50)
- Previous/next navigation
- Total results count

**Implementation:** AdminArtifacts.tsx

- Lists artifacts via GET /api/admin/artifacts
- Gets stats via GET /api/admin/artifacts/stats
- Deletes artifact via DELETE /api/admin/artifacts/:uuid

### Workflow Sharing

Share private workflows with specific users via invite links.

**ShareDialog Component:**

Modal for managing workflow sharing, accessible from workflow detail page via Share button (owner only).

Features:

- Generate invite link with copy-to-clipboard
- List active and used invites with revoke option
- View users with shared access

Implementation: `components/workflow/ShareDialog.tsx`

- Creates invite via POST /api/workflows/:id/invites
- Lists invites via GET /api/workflows/:id/invites
- Revokes invite via DELETE /api/workflows/:id/invites/:inviteId
- Lists access via GET /api/workflows/:id/access
- Revokes access via DELETE /api/workflows/:id/access/:userId

**InviteAccept Page:**

Landing page at `/invites/:token` for accepting workflow invites.

Features:

- Displays workflow name, owner, invite status
- Accept/Decline buttons
- Error handling for invalid/expired tokens
- Success redirect to workflow detail

Implementation: `pages/InviteAccept.tsx`

- Gets invite info via GET /api/invites/:token
- Accepts invite via POST /api/invites/:token/accept

**Shared Access Indicators:**

WorkflowCard and FlowPage show "Shared" badge when `accessType === "shared"`:

- Purple badge with Users icon
- Indicates workflow was shared via invite link

**Ownership Check:**

`FlowPage` uses `fileInfo.accessType === "owner"` to determine ownership. Delete, visibility and edit mode are only shown for owned workflows.

### Workflow Card Layout

WorkflowCard displays workflows in a compact single-row format:

```
┌──────────────────────────────────────────────────────────────────┐
│ [icon] Name v1.0.0          @owner         [✓] [🌐] [🗑]        │
└──────────────────────────────────────────────────────────────────┘
```

**Layout Sections:**

- Left: GitBranch icon + workflow name (truncated) + version badge
- Center: Owner handle (@username) - hidden on mobile
- Right: Validation badge (icon) + Visibility badge + Delete button (on hover)

**Responsive Behavior:**

- Owner handle: `hidden sm:block`
- Badge text: `hidden md:inline` (icons always visible)
- Delete button: `opacity-0 group-hover:opacity-100`

**Tooltip:** Description appears on hover (300ms delay) via Radix UI Tooltip

### Playbooks Page

Playbooks at `/playbooks`: named, reusable behaviour text a workflow node references by name.

- `PageShell` + `FilterBar` (search) + `DataListView` of `PlaybookCard` (CardShell, list/grid; the
  card shows title, machine name, visibility badge, preview and `size · vN · updated`)
- Persistent "new playbook" card and inline `PlaybookEditor` for create and edit: name (machine
  name, read-only once created), title, description, content, `VisibilityToggle`, and the
  reference a node would use (`{{playbook:name}}`)
- Live-runs warning (`playbook-live-runs-warning`): the editor asks
  `GET /api/playbooks/:name/usage` and, before the change is saved, says how many running processes
  read this playbook; `complete: false` adds that more may be affected
- History via the shared `RevisionHistoryDialog` (`history-playbook-<name>`), restore as a new
  revision; delete via `ConfirmDialog`
- Test ids: `create-playbook-button`, `new-playbook-card`, `playbook-card-<name>`,
  `edit|history|delete-playbook-<name>`, `playbook-visibility-<name>`, `playbook-*-input`,
  `save-playbook-button`

Flow page node details (`WorkflowSidebar`, and `NodeDetailSheet` where it is used) list the
playbooks a node names (`NodePlaybookReferences`, collected with the shared reference module so an
escaped reference is not offered) with a link to `/playbooks?name=…&owner=…`; a playbook the viewer
cannot read is marked "not available" (`playbook-reference-unavailable-<name>`). The Playbooks page
reads those parameters: your own playbook opens in the editor above the list
(`linked-playbook-editor`, independent of which page of the list is loaded), another account's
published one is shown read-only above the list (`linked-playbook`), and an unreadable one is
reported (`linked-playbook-missing`). Closing the slot, or starting to edit another playbook
from the list, clears the `name`/`owner` parameters and returns the page to the plain list.

### Admin Notes Page

Notes management at `/admin/notes` for persistent agent memory.

**Features:**

- Notes list with search and tag filtering
- Create, edit, view, delete notes
- Markdown preview in editor
- Version history with restore capability
- User quota display (used/limit)

**List View:**

- Search by note key or content
- Tag filter dropdown (all tags from existing notes)
- Table columns: Key, Tags, Size, Updated, Created, Actions
- Pagination with configurable page size

**Persistent New Note Card:**

- Dashed-border card with FilePlus icon always visible above notes list
- Click expands to inline editor in create mode
- Hidden while any inline editor is active

**Inline Editor (NoteInlineEditor):**

- Replaces NoteCard in-place when editing
- Create mode: renders above the list with key input field
- Edit mode: replaces card in DataListView, key shown as read-only
- Content textarea with markdown preview toggle
- Tag editor with autocomplete from existing tags
- Size indicator with progress bar (100KB limit)
- Save via button or Ctrl+Enter, cancel via button or Escape
- Key validation: alphanumeric, underscore, hyphen, max 100 chars
- Version switcher dropdown in header (edit mode only):
  - Shows all versions from history API with "Current" badge on latest
  - Selecting historical version loads content in read-only mode (amber styling)
  - Restore button replaces Save for older versions (AlertDialog confirmation)
  - Compare button opens the shared history dialog

**Version History:**

`NoteHistoryDialog` only supplies a `RevisionHistorySource` (history, one version, current value,
restore) to the shared `RevisionHistoryDialog`; the dialog itself is the same one playbooks and
global settings use.

- Split-pane dialog: version list (left), content panel (right); stacks on a narrow screen
- Right panel tabs: Content (the selected version), Side by side (selected beside current) and
  Diff (line-by-line via the shared `DiffView`)
- Restore is confirmed inline in the panel header, not in a second modal (hidden for current version)
- Relative timestamps (e.g., "2h ago"), size badges, "current" badge on latest

**Quota Indicator:**

- Shows used/limit bytes in header
- Progress bar visualization
- Warning state when approaching limit

**Implementation:** AdminNotesPage.tsx

- Lists notes via GET /api/notes
- Creates note via POST /api/notes
- Updates note via PUT /api/notes/:key
- Deletes note via DELETE /api/notes/:key
- Gets versions via GET /api/notes/:key/versions
- Restores version via POST /api/notes/:key/restore

### System Settings Page

Setting definitions management. Accessible via the "Definitions" tab in unified admin settings (`/admin/settings`).

Supports `embedded` prop for rendering without header inside `AdminSettingsUnified.tsx`.

**Features:**

- CRUD operations for setting definitions (schema)
- Definitions declared by installed extension manifests are visible as protected, read-only definitions and are changed only through the extension bundle
- Protected definitions cannot be deleted (marked with lock icon)
- Export schema to JSON file
- Import schema from JSON file with preview
- DB maintenance operations

**Protected Definitions:**

Critical settings are protected from deletion:

- `telegram.bot_token`, `telegram.chat_id`, `telegram.enabled`
- `mcp.systemReminder`

Protected definitions show lock icon, no delete button available.

**Export/Import Schema:**

- Export creates `moira-schema-YYYY-MM-DD.json`
- Export creates audit log entry (`admin:settings:export_schema`)
- Import shows preview with change types (New, Changed, Type Changed, Unchanged)
- Type changes require explicit confirmation

**Implementation:** SystemSettings.tsx

- Definitions via GET/POST/PUT/DELETE /api/admin/settings/definitions
- Export via GET /api/admin/settings/definitions/export
- All operations create audit log entries

### Admin Settings Page

Global setting values management. Accessible via the "Values" tab in unified admin settings (`/admin/settings`).

Supports `embedded` prop for rendering without header inside `AdminSettingsUnified.tsx`.

**Categories:**

- MCP prompts (system prompt and system reminder, including agent/model overrides)
- Messages & Validation (error messages, validation help)

**Features:**

- Settings grouped by category with sorting
- SettingsEditor component with type-based inputs
- Input types: string (single line), text (multiline textarea), number, boolean (checkbox), encrypted (password), json
- Per-setting save button with loading state
- Character count display for text areas
- Error state with retry functionality
- Value history: the shared `RevisionHistoryDialog` over the setting's revisions (`/api/admin/global-settings/:key/history`, `/revision/:n`, `/restore`); restoring writes a new revision
- MCP prompts: master-detail layout with System Prompt and System Reminder entries in the left panel and a full-height editor on the right (McpPromptsEditor → PromptDetailEditor)
- MCP prompts: per-prompt inline version history with diff highlighting panel, version dropdown, and Apply button for rollback
- MCP tool descriptions are static application contract data and are not exposed as global settings.
- Export: download all setting values as JSON file
- Import: upload JSON file with preview of changes before applying

**Export/Import Values:**

- Export creates `moira-settings-YYYY-MM-DD.json`
- Export creates audit log entry (`admin:global_settings:export`)
- Format:
  ```json
  {
    "version": "1.0",
    "exportedAt": "2025-01-01T00:00:00.000Z",
    "values": { "key": "value", ... }
  }
  ```
- Import shows preview modal with change types:
  - Overwrite: existing setting with different value
  - Add: key without definition (skipped)
  - Unchanged: same value as current
- Only overwrite changes are applied
- Each imported value creates audit log entry

**Implementation:** AdminSettings.tsx with SettingsEditor component

- Loads settings via GET /api/admin/global-settings
- Updates settings via PUT /api/admin/global-settings/:key
- Export via GET /api/admin/global-settings/export
- Categories sorted by predefined order (mcp, system, messages)
- Settings within category sorted by sortOrder
- History via GET /api/admin/audit-log with filters

## API Endpoints

### Backend Routes (internal port 4201, accessed via nginx proxy on DOCKER_PORT)

```typescript
GET    /api/health                     // Backend status (requires auth)
GET    /api/status                     // System status (requires auth)
GET    /api/workflows                  // List all workflows with visibility
GET    /api/workflows/:id              // Get workflow detail (fileInfo.revision = definition revision)
PUT    /api/workflows/:id              // Replace an owned definition against expectedRevision
GET    /api/workflows/:id/raw          // Get raw workflow JSON
POST   /api/workflows/:id/validate     // Validate workflow
```

### Response Formats

```typescript
// Workflow list response
interface WorkflowListResponse {
  workflows: WorkflowFileInfo[];
  totalWorkflows: number;
  validWorkflows: number;
  invalidWorkflows: number;
  lastScan: number;
}

// Workflow file information
interface WorkflowFileInfo {
  id: string;
  ownerName: string;
  visibility: "public" | "private";
  filePath: string;
  metadata: WorkflowGraph["metadata"];
  validation: WorkflowValidationStatus;
  lastModified: number;
  fileSize: number;
}

// Workflow detail response
interface WorkflowDetailResponse {
  workflow: WorkflowGraph;
  validation: WorkflowValidationStatus;
  fileInfo: WorkflowFileInfo;
}
```

## Development Commands

```bash
npm run docker:restart  # Build and start Docker
npm run docker:stop     # Stop container

# Access all services via single port
# Web UI: http://localhost:${DOCKER_PORT}/
# MCP Endpoint: http://localhost:${DOCKER_PORT}/mcp
# Backend API: http://localhost:${DOCKER_PORT}/api/
```

**All development happens through Docker containers.**

### Docker Container Management

docker-compose down # Stop all services
docker-compose logs -f # View logs

````

## Component Interfaces

### Layout System

```typescript
// Main layout component
interface LayoutProps {
  children: React.ReactNode;
  sidebar?: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  className?: string;
}

// Application header
interface AppHeaderProps {
  backendConnected?: boolean;
  onRefresh?: () => void;
  selectedWorkflow?: string | null;
}
````

### Workflow Management

```typescript
// Workflow explorer component (uses FilterBar + DataListView + PageShell)
interface WorkflowExplorerProps {
  selectedWorkflowId?: string;
  onWorkflowSelect: (workflow: WorkflowFileInfo) => void;
}
```

### Workflow Explorer Toolbar

WorkflowExplorer uses `FilterBar` with inline Select controls:

```
┌─────────────────────────────────────────────────────────────┐
│ [🔍 Search workflows...    ] Status[▼] Visibility[▼]       │
│                               Sort[▼]  Direction[▼]        │
│ 42 workflows                                     [⊞] [≡]   │
└─────────────────────────────────────────────────────────────┘
```

- Filter changes reset pagination to page 1
- Sort options: Date/Name, Newest/Oldest
- i18n support for all labels (en/ru)
- Same layout pattern as Executions page

### Beta Agreement System

**Components:**

- `BetaAgreementModal` - First-login agreement modal
- `BetaWarningBanner` - Persistent warning banner
- `useBetaAgreement` - Hook managing agreement state

**Hook Interface:**

```typescript
interface UseBetaAgreementReturn {
  showModal: boolean;
  showBanner: boolean;
  hasAccepted: boolean;
  acceptAgreement: () => void;
  declineAgreement: () => void;
  dismissBanner: () => void;
}
```

**Modal Props:**

```typescript
interface BetaAgreementModalProps {
  isOpen: boolean;
  onAccept: () => void;
  onDecline: () => void;
}
```

**Banner Props:**

```typescript
interface BetaWarningBannerProps {
  onDismiss: () => void;
}
```

**Storage:**

- `moira-beta-agreement-accepted` - Agreement acceptance state
- `moira-beta-banner-dismissed` - Banner dismiss state

**Behavior:**

- Modal appears on first authenticated page load
- Accept saves to localStorage and shows banner
- Decline triggers logout and redirects to landing
- Banner dismissible but persists across sessions until dismissed
- Gated by `betaNotices`: the modal and banner never appear when the feature is
  off (self-host).

### Feature-Mode Gating

`FeaturesProvider` / `useFeatures()` (`hooks/useFeatures.tsx`) load
`GET /api/features` once at startup and expose `{deploymentMode, features, mcpUrl, isEnabled}`.
Mounted above `AuthProvider`. Default while loading / on error: all flags off
(self-host baseline — SaaS UI never flashes before the server confirms it).

Deployment-specific UI is selected by named capabilities:

| Flag                    | UI gated                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `legalConsents`         | Registration terms + residency consent checkboxes (`AuthProvider`)                                           |
| `betaNotices`           | `BetaAgreementModal` + `BetaWarningBanner` (`useBetaAgreement`)                                              |
| `userManagement`        | Users list and user detail                                                                                   |
| `multiUserAdmin`        | Executions, Workflows, Artifacts, Reported Artifacts, Deleted Workflows, logout-all, and related quick links |
| `adminAnalytics`        | Installation-wide dashboard totals, recent activity, analytics panels, and their requests                    |
| `adminOperations`       | Operational dashboard                                                                                        |
| `operationsDevelopment` | Monitoring Test page                                                                                         |

Capability gating is defense-in-depth:

- Navigation level: `AppSidebar` filters routes through the generic
  `NavRoute.capability` field configured by `AdminLayout`.
- Route level: `ProtectedRoute requireCapability` redirects direct navigation to
  `/admin` when the named capability is off; `App.tsx` assigns the same capability
  to each protected route.
- Request level: the backend resolves the same capability names before disabled
  administrator handlers can read cross-user data or perform effects. UI filtering
  is not the security boundary.

The default self-host administrator retains Dashboard, Users, Audit Log, API Tokens,
Settings Manager, database/health status, and managed-workflow reconciliation. It does
not receive the broad multi-user pages, Deleted Workflows, analytics, Operational, or
Monitoring Test surfaces. SaaS enables the complete comparison through the same resolver.

### React Flow Integration

```typescript
// Workflow visualization component
interface WorkflowViewerProps {
  debugSelectedWorkflow?: string | null;
  layoutOptions?: LayoutOptions;
  onNodeSelect?: (nodeId: string | null) => void;
  onWorkflowLoad?: (workflow: any) => void;
  className?: string;
}
```

## The technical node graph (`WorkflowGraph`)

The graph is the process view's detailed layer, not a separate rendering:

- **Model** (`components/run/graphModel.ts`): `graphModel(workflow, blocks)` builds one `GraphStep`
  per workflow node (the same `StepInfo` and `stepConnections` the block panel uses, owned by the
  block the derivation names) and one `GraphLink` per connection, classified `forward` (inside a
  block), `external` (into a later block) or `return` (a derived cycle transition's edge, or into
  an earlier block). `definitionBlocks(workflow)` derives run-less blocks in the browser when a
  caller passes none; both pages pass their own `blocks` so a run's groups carry status.
- **Layout** (`components/workflow/graphLayout.ts`): `layoutGraph(model, direction, measuredHeights?)`
  lays each block's steps out with ELK layered (model order, in-block forward edges only) and stacks
  the block groups in process order — top to bottom, or left to right for Horizontal — with the
  steps no block owns in one flat set after the groups. Card heights are estimated
  (`estimateStepHeight`, which turns the evidence and the chips a card carries — its connections
  plus, generously, every edge arriving at it — into rows) for the first pass; `GraphMeasuredHeights` (mounted inside the viewport,
  reading React Flow's store) reports the measured heights, and a second pass with them runs when
  any differs from its estimate, so cards never overlap. A block's box grows by a corridor under
  its cards (to their right in a row) holding one lane per routed edge, and by an entry side wide
  enough for the approach columns of the edges arriving at it.
- **Routing** (`routeLinks`, pure): a forward link inside a block is drawn straight (smooth step).
  Everything else is a `GraphRoute` (stub, lane waypoints, side): a return inside a block leaves its
  source, runs along the block's bottom corridor and enters its target from before it; a link into
  a later block runs in the gap after its source's block; a return to an earlier block runs in the
  gap, climbs the margin before the groups and comes in through the target block's corridor. Every
  corridor is sized before the groups are placed for the lanes it must hold (`laneCounts`,
  `corridorSize`): `GRAPH_MARGIN` and `GROUP_GAP` are floors, the margin grows with the returns and
  a block's entry side holds the approach columns of its arrivals. Lanes sharing a corridor are offset by
  `LANE_STEP` (`MARGIN_LANE_STEP` in the margin, which holds one lane per return) and centred in
  the room reserved for them. `GraphEdgeView` draws a routed
  edge as a rounded polyline (`routedPoints`, `roundedPath`); its label is shown while it is lit,
  on the first lane run.
- **Rendering** (`components/workflow/graphNodes.tsx`): every node type is registered to
  `StepNodeView` (the shared `StepCard` with hidden handles; the per-type registration keeps React
  Flow's `react-flow__node-<type>` classes), `block-group` to `BlockGroupView` (the shared status
  surface, `data-graph-group`, `data-block-id`), and one `graph` edge type. Groups sit at z-index
  −1 and cards at 2; edges carry 0, which React Flow adds to their nodes' level, so the edge layer
  shares the cards' level and paints first — above the groups, below the cards. A line is drawn at
  rest only where it runs straight from card to card, and it keeps its label pill. Every edge that
  needs a corridor — a return, a link into another block, a link ELK laid backwards — is not drawn
  at rest: it is named in both cards, by the connection chip in its source and by an arrival chip
  (`data-arrival`, dashed, with the source's block when it is another block) in its target, and it
  is drawn with its label while either chip, either card or the edge itself is hovered, everything
  else dimming meanwhile. A drawn line carries a halo in the page colour, so a crossing reads as
  one line passing over another, and every arrowhead keeps one size (`markerUnits="userSpaceOnUse"`)
  whatever the line's width. Every edge that is drawn leaves and arrives at its own handle, and an
  arrival turns up to its card in an approach column of its own: a column of cards holds
  `APPROACH_COLUMNS` of them, each card's arrivals take different ones and the cards of a column
  start at different ones, so lines merge only where a card receives more arrivals than there are
  columns, and even then they still arrive at their own handles. Clicking an arrival chip brings the card at the other end into view.
  Hovering a card lights every connection it takes part in and rings the cards at their far end.
- **Viewport**: the graph mounts through `DiagramViewport` (`kind="graph"`). The opening placement
  uses `useOpeningPlacement`: a `focusRequest` (node id + token) or a run's `currentNodeId` fits
  the view to that node; a definition opens readable on its first block at `GRAPH_OPENING_ZOOM`.
  The placement key includes the layout generation, so it is applied again after the measured
  second pass. A direction change refits to the whole graph. The layout controls (Fit View,
  Vertical, Horizontal; `data-testid="graph-layout-controls"`) are `ControlButton`s inside the
  zoom cluster (`DiagramViewport`'s `controlButtons` slot), so the cluster is one column and covers
  no card; the minimap (`showMinimap`, on by default) renders after an idle callback and not on a
  phone (`useIsMobile`), where it would cover the graph; the run page and the flow page pass
  `showMinimap={false}`, so their graph views draw none, as the map's diagram draws none. The block
  selected on the map (`selectedBlockId`) is the ringed group (`data-selected` on `BlockGroupView`)
  on both pages.

### Node Selection System

- **Persistent Sidebar**: `WorkflowSidebar` component (side-by-side with graph). Shows workflow info when no node selected, node details on selection. Used in the flow page's graph view.
- **Legacy Sheet**: `NodeDetailSheet` (Sheet overlay). Used in execution views (`ExecutionInspector`, `WorkflowVisualizationPage`) where `onNodeSelect` is not provided.
- **Connections of the selected node**: both surfaces name the incoming and outgoing nodes by
  display name or node id (`nodeName` in `WorkflowGraph`), and list each outgoing connection as
  `output → target` with the summary of the routing case that selects that output
  (`OutgoingConnectionChips` in `components/workflow/OutgoingConnections.tsx`, `data-output`), so
  several outputs into one target stay distinguishable.
- **WorkflowGraph** accepts optional `onNodeSelect` callback. When provided, Sheet is disabled and node clicks route to external sidebar.

## Error Handling

### ErrorBoundary Integration

```typescript
// Error boundary with error handling
interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  showDetails?: boolean;
}

// HOC for component error wrapping
withErrorBoundary<P>(Component: React.ComponentType<P>, errorFallback?: ReactNode)

// Async error handling hook
useAsyncErrorBoundary(): (error: Error) => void
```

## State Management

### Page-local data store (`useResource`)

```typescript
useResource<T>(key: string | null, fetcher: (key: string) => Promise<T>, describeError?): {
  data: T | undefined;      // last successful value; kept while a refetch is pending
  dataKey: string | null;   // the key `data` belongs to
  pending: boolean;         // a fetch is in flight (first load or refetch)
  error: string | null;     // last failure, cleared by the next success; `data` is kept
  refresh: () => Promise<void>;
}
```

Fetches when `key` changes and on `refresh()`; a response from an older request that resolves
after a newer one is dropped; a `null` key clears the value. A page shows its full-page loader only
while `data` is undefined and `pending` is true; every later fetch renders the previous value with
a local pending indicator. The fetcher is read through a ref, so it may close over page state.

### Workflow Data Hook

```typescript
// Primary data hook
useWorkflowApp(): {
  selectedWorkflow: string | null;
  selectWorkflow: (id: string) => void;
}

// Workflow detail (built on useResource)
useWorkflowDetail(id?: string): {
  workflow: WorkflowDetailResponse | null;
  loading: boolean;   // first load of this id only
  pending: boolean;   // any fetch in flight
  current: boolean;   // the held workflow is the requested id
  error: string | null;
  refreshWorkflow: () => Promise<void>;
}

// Workflow list data
useWorkflowList(): {
  workflows: WorkflowListResponse | null;
  loading: boolean;
  error: string | null;
  refreshWorkflows: () => Promise<void>;
}
```

## Styling System

### Theme Integration

- **Tailwind CSS v4**: Utility-first CSS framework with @theme configuration
- **shadcn/ui**: Component library with Radix UI primitives
- **Semantic tokens**: bg-card, text-foreground, bg-muted, border-border for automatic dark mode
- **Theme switching**: ThemeProvider with system/light/dark modes, localStorage persistence

```typescript
// Theme provider hook
import { useTheme } from "./hooks/useTheme";

const { theme, setTheme, actualTheme } = useTheme();
// theme: 'system' | 'light' | 'dark'
// actualTheme: 'light' | 'dark' (resolved system preference)
```

**Theme-aware styling rules:**

Use semantic tokens for all colors:

- Background: `bg-background` (not bg-gray-50, bg-white)
- Cards: `bg-card` with `border-border`
- Text: `text-foreground`, `text-muted-foreground`
- Primary: `bg-primary`, `text-primary-foreground`

Avoid hardcoded colors:

```tsx
// WRONG - breaks dark theme
<div className="bg-gray-100 text-gray-600">
<div className="bg-white border-gray-200">

// CORRECT - adapts to theme
<div className="bg-background text-muted-foreground">
<div className="bg-card border-border">
```

### CSS Architecture

```css
/* globals.css structure */
@import "tailwindcss";
@import "@daveyplate/better-auth-ui/css";

@layer base {
  /* Better Auth UI variables */
}

@theme {
  /* Tailwind v4 semantic tokens */
  --color-background: hsl(0 0% 100%);
  --color-foreground: hsl(240 10% 3.9%);
  --color-card: hsl(0 0% 100%);
  --color-muted: hsl(240 4.8% 95.9%);
}

.dark {
  /* Dark mode overrides */
  --background: hsl(240 10% 3.9%);
  --foreground: hsl(0 0% 98%);
}
```

### Component Styling

- **shadcn/ui components**: Button, Card, Badge, Alert, Collapsible, Avatar, Separator, Sheet, Sidebar, Skeleton, Tooltip
- **Ant Design legacy**: Select, Drawer, Descriptions for complex state management
- **Icon library**: lucide-react for consistent iconography
- **Dialogs**: Use AlertDialog/toast (sonner) instead of native `alert()`/`confirm()`

### Accessibility

- **Skip navigation**: Link in `MainAppLayout.tsx` (sr-only, visible on focus), targets `#main-content`
- **aria-labels**: Required on all icon-only buttons (e.g., delete, clear, close)
- **aria-live regions**: `assertive` on error displays (AuthErrorDisplay, ErrorBoundary), `polite` on loading states
- **Keyboard navigation**: All interactive elements reachable via Tab/Enter/Space/Escape
- **Code splitting**: Heavy pages use `React.lazy()`; the Suspense boundary sits inside
  `MainAppLayout` and `AdminLayout` around the outlet with `RouteSkeleton` as the fallback, so the
  sidebar stays while a page's code arrives (an in-app navigation is a router transition and keeps
  the current page until the next one can render; the skeleton shows on a direct load). The outer
  boundary in `App.tsx` uses the same fallback.

### Responsive Design

- **Sidebar collapse**: Controlled via SidebarProvider, collapsible="icon" mode with tooltips
- **Sidebar persistence**: State saved to cookie (sidebar_state), restored on page load
- **Keyboard shortcut**: Cmd/Ctrl+B toggles sidebar
- **Mobile support**: Responsive layout with sidebar toggle, use-mobile hook
- **Smooth transitions**: Tailwind transition utilities

## Internationalization (i18n)

### Configuration

```typescript
// src/i18n.ts - Centralized language configuration
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

// Language config - single source of truth
export interface LanguageConfig {
  code: string;
  flag: string; // Emoji flag for UI display
}

export const LANGUAGES: LanguageConfig[] = [
  { code: "en", flag: "🇬🇧" },
  { code: "ru", flag: "🇷🇺" },
];

export const SUPPORTED_LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, ru: { translation: ru } },
    supportedLngs: SUPPORTED_LANGUAGE_CODES,
    fallbackLng: ["en"],
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  });
```

### Adding New Language

1. Create `locales/{code}.json` with translations
2. Import in `i18n.ts`
3. Add to `LANGUAGES` array: `{ code: '{code}', flag: '{emoji}' }`
4. Add to `resources` in i18n.init()

### File Structure

```
src/
├── i18n.ts              # i18n configuration
└── locales/
    ├── en.json          # English translations (default)
    └── ru.json          # Russian translations
```

### Translation Namespaces

```json
// locales/en.json structure
{
  "auth": {
    "SIGN_IN": "Sign In",
    "SIGN_UP": "Sign Up",
    "SIGN_IN_DESCRIPTION": "..."
  },
  "layout": {
    "nav": { "home", "workflows", "executions", "artifacts", "settings", "admin", "docs" },
    "adminNav": { "dashboard", "users", "auditLog", "systemSettings", "deletedWorkflows", "backToApp" },
    "userMenu": { "user", "theme", "language", "settings", "logout" },
    "sidebar": { "collapse", "expand", "show" },
    "languages": { "en", "ru" }
  },
  "pages": {
    "dashboard": {
      "title", "loading", "error", "retry",
      "stats": { "totalWorkflows", "executions", "settings", "clickToView", "clickToConfigure" },
      "quickStart": { "title", "description", "configLabel", "copy", "copied", "learnMore", "documentation" },
      "recentWorkflows": { "title", "empty" },
      "recentExecutions": { "title", "empty", "execution", "workflow" },
      "time": { "justNow", "minutesAgo", "hoursAgo", "daysAgo", "running" }
    },
    "workflows": {
      "explorer": { "title", "workflows", "loading", "failedToLoad", "retry", "noWorkflows", "noMatch", "statistics", "valid", "invalid", "of" },
      "time": { "today", "yesterday", "daysAgo" }
    },
    "workflowDetail": { "backToWorkflows", "deleteWorkflow", "confirmDelete", "useAsTemplate", "copying" },
    "executions": {
      "title", "subtitle", "loading", "retry", "noExecutions", "noResults",
      "filters": { "searchPlaceholder", "status", "allStatuses", "workflow", "allWorkflows", "sortByCreated", "sortByUpdated", "newest", "oldest" },
      "table": { "executionId", "workflow", "status", "created", "updated" },
      "pagination": { "showing", "page", "previous", "next" }
    },
    "executionInspector": {
      "loading", "notFound", "backToExecutions", "execution", "workflow", "selected", "current", "clearSelection",
      "context": { "save", "saveFailed", "filterPlaceholder", "filterField", "empty", "noMatches", "globalSection", "nodeLocalSection", "emptyValue", "editLong" }
    },
    "settings": {
      "title", "loading", "required", "enable", "saveChanges", "saving", "cancel", "noSettings", "saveSuccess", "saveFailed", "fixErrors",
      "validation": { "mustBeOneOf", "minLength", "maxLength" },
      "telegram": { "testNotification", "sending", "testDescription", "configureBotFirst", "testSuccess", "testFailed" },
      "github": { "title", "description", "states", "outcomes", "errors", "connect", "reconnect", "install", "disconnect", "confirmExternalRevocationAction" }
    },
    "artifacts": {
      "title", "subtitle", "loading", "retry", "noArtifacts",
      "table": { "name", "size", "created", "expires", "actions" },
      "actions": { "create", "copyUrl", "preview", "edit", "openInNewTab", "delete", "copied" },
      "editor": { "titleCreate", "titleEdit", "descriptionCreate", "descriptionEdit", "name", "namePlaceholder", "content", "contentPlaceholder", "contentHint", "nameAndContentRequired", "mustContainHtml", "contentRequired", "loadingContent", "loadError" },
      "delete": { "title", "description" },
      "quota": { "storage", "artifacts" },
      "pagination": { "showing", "page", "previous", "next" }
    }
  },
  "admin": {
    "dashboard": { "title", "failedToLoad", "stats", "systemHealth", "recentActivity", "quickLinks" },
    "executions": { "title", "subtitle", "filters", "table", "status", "pagination" },
    "executionInspector": { "loading", "backToExecutions", "execution", "workflow", "context" },
    "userDetail": { "loading", "backToUsers", "status", "stats", "actions", "blocked", "userInfo", "sessions", "emailHistory" },
    "auditLog": { "title", "subtitle", "loading", "filters", "table", "pagination", "detail", "system" },
    "systemSettings": { "title", "createNew", "definitions", "dbMaintenance", "actions", "form", "types", "validation" },
    "userManagement": { "title", "search", "table", "status", "role", "actions", "pagination", "confirmDelete", "noSearchResults" },
    "deletedWorkflows": { "title", "search", "filters", "table", "actions", "pagination", "confirmRestore", "confirmPermanentDelete", "noDeletedWorkflows", "noMatchingWorkflows" }
  },
  "components": {
    "workflowCard": { "valid", "invalid", "unknown", "public", "private", "delete", "deleteWorkflow" },
    "searchFilters": { "searchPlaceholder", "status", "all", "valid", "invalid", "warning", "visibility", "public", "private" },
    "betaWarningBanner": { "title", "message", "dismiss" },
    "betaAgreementModal": { "title", "description", "aboutSystem", "aboutSystemText", "importantInfo", "dataInfo", "functionalityInfo", "termsInfo", "recommendations", "rec1", "rec2", "rec3", "acceptTerms", "term1", "term2", "term3", "thankYou", "decline", "acceptAndContinue" },
    "errorBoundary": { "title", "subtitle", "errorId", "error", "technicalDetails", "tryAgain", "reloadPage", "copyErrorDetails", "errorCopied", "helpTitle", "helpRefresh", "helpBackend", "helpReport" }
  }
}
```

### Component Usage

```typescript
import { useTranslation } from 'react-i18next';

const Component = () => {
  const { t, ready } = useTranslation();

  if (!ready) return <div>Loading...</div>;

  // Single string
  const title = t('auth.SIGN_IN');

  // Nested object for library integration
  const authLocalization = t('auth', { returnObjects: true });
};
```

### Language Detection

- Priority: URL parameter (`?lang=`) → localStorage → browser navigator
- Persistence: localStorage key `i18nextLng`
- Default: English (`en`)

**URL Parameter**: `?lang=ru` or `?lang=en` in query string overrides other detection methods. Used for landing page → app navigation to maintain language choice.

### Language Switcher

```typescript
// UserMenu language toggle
const { t, i18n } = useTranslation();

const cycleLanguage = () => {
  const newLang = i18n.language === "en" ? "ru" : "en";
  i18n.changeLanguage(newLang);
};

// Display current language
const getCurrentLanguageLabel = () => {
  const lang = i18n.language?.substring(0, 2) || "en";
  return t(`layout.languages.${lang}`);
};
```

**Location**: UserMenu dropdown (Globe icon)
**Behavior**: Click toggles between English and Russian
**Persistence**: Automatic via i18next localStorage

## Statistics Dashboard

### Compact Format

```typescript
// Statistics calculation
interface StatisticsCounts {
  valid: number;
  invalid: number;
  total: number;
}

// Display format: "Statistics • 3 valid" with color indicators
```

## Search and Filtering

### Multi-field Search

```typescript
// Search across workflow properties
- workflow.metadata.name
- workflow.metadata.description
- workflow.id
- workflow.metadata.tags[]
```

### Validation Filtering

```typescript
type ValidationFilter = "all" | "valid" | "invalid" | "warning";
```

## Backend Configuration

### Express Server Setup

```typescript
// Server startup
const server = new MoiraApiServer();
server.start(); // Internal port 4201, accessed via nginx proxy

// CORS origins configured dynamically via getBaseUrl() + EXTRA_TRUSTED_ORIGINS env var

// Security headers
helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
    },
  },
});
```

## Frontend Entry Points

### Application Bootstrap

```typescript
// index.tsx
import { ErrorBoundary } from './components/ErrorBoundary';
import App from './App';

root.render(
  <ErrorBoundary showDetails={process.env.NODE_ENV === 'development'}>
    <App />
  </ErrorBoundary>
);
```

### Main Application

```typescript
// App.tsx
const App: React.FC = () => {
  const { selectedFolder, selectedWorkflow, selectWorkflow } = useWorkflowApp();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [backendConnected, setBackendConnected] = useState(false);

  return (
    <Layout
      header={<AppHeader backendConnected={backendConnected} />}
      footer={<AppFooter />}
      sidebar={<WorkflowExplorer onWorkflowSelect={handleWorkflowSelect} />}
      sidebarOpen={sidebarOpen}
    >
      <WorkflowViewerPlaceholder
        debugSelectedFolder={selectedFolder}
        debugSelectedWorkflow={selectedWorkflow}
      />
    </Layout>
  );
};
```

## API Client Configuration

### HTTP Client Setup

```typescript
// services/api-client.ts
export class MoiraApiClient {
  private client: AxiosInstance;

  constructor(baseURL: string = "") {
    this.client = axios.create({
      baseURL,
      timeout: 30000,
      headers: { "Content-Type": "application/json" },
    });
  }

  async healthCheck(): Promise<HealthCheckResponse>;
  async getWorkflows(request?: WorkflowListRequest): Promise<WorkflowListResponse>;
  async getWorkflow(id: string, request?: WorkflowDetailRequest): Promise<WorkflowDetailResponse>;
  async getRawWorkflow(id: string): Promise<RawWorkflowResponse>;
  async validateWorkflow(
    id: string,
    request?: WorkflowValidationRequest,
  ): Promise<WorkflowValidationResponse>;
  async copyWorkflow(id: string): Promise<{ workflowId: string; message: string }>;
  async getGitHubCodespaceConnection(): Promise<CodespaceConnectionView>;
  async disconnectGitHubCodespace(): Promise<CodespaceConnectionView>;
  async confirmGitHubExternalRevocation(): Promise<CodespaceConnectionView>;
}

// Default instance using same-origin (nginx proxies /api/ to backend)
export const apiClient = new MoiraApiClient("");
```

## The workflow transformer

`utils/workflow-transformer.ts` turns a definition into per-node presentation data (validation
status, catalog styling from `DEFAULT_NODE_STYLES`, extension names) that the technical graph
merges into its step nodes; it is the only consumer of that palette. There is no separate node
renderer, node registry or dagre layout module: every page draws the graph described above.

## Configuration Files

### TypeScript Configuration

```json
// frontend/tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@shared/types": ["../types/src"]
    }
  }
}
```

### Webpack Build

```javascript
// packages/web-frontend/webpack.config.cjs
// Production build only - no dev server
// Frontend is built as static files and served by nginx in Docker
// API requests use same-origin (empty base URL), proxied by nginx to backend
```

## Animations

### Page Transitions

Page-level wrapper animations are **not used** on `AnimatedPage` (a `h-full` wrapper ensuring the CSS height chain for React Flow). Instead, content entrance animations are handled by `FadeIn` component.

### Content Entrance Animation

`FadeIn` component (`components/fade-in.tsx`) wraps page content that appears after loading. Uses `tw-animate-css` (same animation system as shadcn Dialog, Popover, Tooltip):

- CSS classes: `animate-in fade-in slide-in-from-bottom-3 duration-300 fill-mode-both`
- Fade from transparent + slide up 12px over 300ms
- Applied to: Dashboard, Settings, AdminDashboard, AdminAnalytics, AdminSettings, AdminUserDetail, UserManagement, DeletedWorkflows, OperationalDashboard
- **Not applied to the flow page's graph view** — React Flow requires immediate full opacity to measure container dimensions

Usage: replace outermost `<div>` with `<FadeIn className="...">` in page content return (after loading guard).

### Hover Effects

Interactive cards use `transition-all duration-200 hover:shadow-md hover:-translate-y-0.5`:

- `WorkflowCard` — both grid and list views
- `StatCard` — only when `onClick` is provided (conditional)

### Empty State Entrance

`EmptyState` component uses `motion/react` with `LazyMotion` for bundle splitting:

- `opacity: 0 → 1`, `y: 8 → 0`, duration 250ms

### Duration Guidelines

| Type                      | Duration | Method             |
| ------------------------- | -------- | ------------------ |
| Content entrance (FadeIn) | 300ms    | tw-animate-css     |
| Hover effects             | 200ms    | CSS transition-all |
| Empty state entrance      | 250ms    | motion/react       |
| Modal/dialog              | 200ms    | shadcn built-in    |

All animations stay under 300ms for interactions, 150ms for micro-interactions.

### Visual Regression Tests

`tests/e2e/visual-regression.spec.ts` captures 18 baseline screenshots (9 pages × 2 themes). Update baselines after intentional UI changes: `npx testfold e2e -- visual-regression.spec.ts --update-snapshots`.

## File Structure Reference

```
frontend/
├── src/
│   ├── App.tsx                  # Application root with layout integration
│   ├── index.tsx                # Entry point with ErrorBoundary
│   ├── components/              # React components
│   │   ├── ui/                  # shadcn/ui components (Button, Card, Badge, etc.)
│   │   ├── auth/                # Authentication components (Login, Register, ProtectedRoute)
│   │   ├── layout/              # Layout components (AppHeader, AppFooter, WorkflowViewerPlaceholder)
│   │   ├── workflow/            # Workflow components (WorkflowExplorer, WorkflowCard)
│   ├── contexts/                # ThemeProvider for dark mode
│   ├── hooks/                   # useWorkflowData, useLayoutState, use-mobile
│   ├── services/                # api-client.ts HTTP communication
│   ├── utils/                   # workflow-transformer.ts
│   ├── lib/                     # utils.ts for cn() className utility
│   └── styles/                  # globals.css (Tailwind v4 + semantic tokens)
├── components.json              # shadcn/ui configuration
├── package.json                 # Frontend dependencies and scripts
├── tsconfig.json                # TypeScript configuration
├── postcss.config.js            # PostCSS with Tailwind plugin
└── webpack.config.cjs           # Production build config
```

## How to Extend

### Adding a New Data List Page

1. Create page component using `PageShell` for loading/error/title:

```tsx
import { PageShell } from "../components/PageShell";
import { DataListView } from "../components/DataListView";
import { FilterBar } from "../components/FilterBar";

export const MyPage: React.FC = () => {
  if (loading) return <PageShell title="My Page" loading />;
  if (error) return <PageShell title="My Page" error={error} onRetry={reload} />;

  return (
    <PageShell title="My Page">
      <FilterBar search={search} onSearchChange={setSearch} />
      <DataListView
        items={items}
        renderCard={(item, viewMode) => <MyCard item={item} compact={viewMode === "grid"} />}
        keyExtractor={(item) => item.id}
        pagination={{
          mode: "total",
          currentPage,
          totalPages,
          totalItems,
          pageSize,
          onPageChange: setPage,
        }}
      />
    </PageShell>
  );
};
```

### Adding a New Card Component

Cards live in `components/cards/`. Each card has a `compact` prop for grid vs list layout:

```tsx
import { CardShell } from "./CardShell";

interface MyCardProps {
  data: MyData;
  compact?: boolean;
  onClick?: () => void;
}

export const MyCard: React.FC<MyCardProps> = ({ data, compact, onClick }) => (
  <CardShell compact={compact} onClick={onClick}>
    {compact ? (
      // Vertical layout for grid view
      <div className="space-y-1">...</div>
    ) : (
      // Horizontal layout for list view
      <div className="flex items-center gap-3">...</div>
    )}
  </CardShell>
);
```

### Adding Filters to FilterBar

Use `LabeledFilter` for visible labels, `SearchableSelect` for dynamic lists, plain `Select` for fixed lists:

```tsx
<FilterBar
  search={search}
  onSearchChange={setSearch}
  onReset={handleReset}
  filters={
    <>
      <LabeledFilter label={t("common.filters.status")}>
        <Select value={status} onValueChange={setStatus}>
          ...
        </Select>
      </LabeledFilter>
      <LabeledFilter label={t("common.filters.user")}>
        <SearchableSelect
          value={userId}
          onValueChange={setUserId}
          options={[
            { value: "all", label: "All" },
            ...users.map((u) => ({ value: u.id, label: u.email })),
          ]}
          searchPlaceholder={t("common.filters.search")}
        />
      </LabeledFilter>
      <SortSelect
        value={makeSortValue(sortBy, sortOrder)}
        onChange={(v) => {
          const { field, direction } = parseSortValue(v);
          setSortBy(field);
          setSortOrder(direction);
        }}
        options={[{ value: "createdAt-desc", label: "Created ↓" }]}
      />
    </>
  }
/>
```

### Server-Side Pagination Pattern

Backend returns `{ data: { items: [...], total, limit, offset } }`. Frontend uses `DataListView` with `mode: "total"` pagination. Use `useDynamicPageSize()` for responsive page sizes.
