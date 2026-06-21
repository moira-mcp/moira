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
│   ├── nodes/                   # React Flow node components
│   │   └── CompactNode.tsx      # Unified compact node (~120x40px) for all types
│   ├── execution/              # Execution display components
│   │   ├── ExecutionInspector.tsx    # Unified inspector with DI (fetchExecution prop, editable flag)
│   │   └── ExecutionErrorHistory.tsx # Error log with collapsible entries, error badges
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
│   └── notes/                   # Notes management components
│       ├── NoteInlineEditor.tsx # Inline expandable card editor (create/edit)
│       └── NoteHistoryDialog.tsx # Version history modal with diff view
├── pages/
│   ├── Dashboard.tsx            # Home page with stat cards, Quick Start, recent ExecutionCards
│   ├── Workflows.tsx            # Workflow explorer + viewer
│   ├── Executions.tsx           # Execution history (ExecutionCard list/grid)
│   ├── ExecutionInspectorPage.tsx   # User execution inspector wrapper
│   ├── Settings.tsx             # User settings (single scrollable page)
│   ├── settings/               # Settings sub-components
│   │   ├── ProfileSettings.tsx  # Profile info, name editing, handle, email verification
│   │   ├── SecuritySettings.tsx # Password change with strength indicator
│   │   ├── OAuthSettings.tsx    # OAuth consent management
│   │   ├── SessionsSettings.tsx # Active session management
│   │   └── ApiTokensSettings.tsx # API token management (create, list, revoke)
│   ├── Admin.tsx                # Admin panel entry
│   ├── AdminDashboard.tsx       # Admin dashboard with stats + merged analytics
│   ├── AdminExecutions.tsx      # Admin executions monitoring (PageShell + DataListView)
│   ├── AdminExecutionInspectorPage.tsx # Admin execution inspector wrapper
│   ├── AdminUserDetail.tsx      # Admin user detail and security management
│   ├── AdminSettingsUnified.tsx # Unified admin settings (Definitions, Values, Maintenance tabs)
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
│   ├── useWorkflowData.ts       # Workflow API integration
│   ├── useNotes.ts              # Notes API integration
│   └── useTheme.ts              # Theme management
├── services/
│   └── api-client.ts            # HTTP client
└── utils/
    ├── node-factory.ts          # React Flow node registry
    └── layout-algorithm.ts      # Dagre layout
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

| Component         | File                    | Purpose                                                                                             |
| ----------------- | ----------------------- | --------------------------------------------------------------------------------------------------- |
| PageHeader        | `page-header.tsx`       | Page title, description, action slot, SidebarTrigger                                                |
| StatCard          | `stat-card.tsx`         | KPI card with label, value, icon, optional Tremor SparkAreaChart sparkline                          |
| StatusBadge       | `status-badge.tsx`      | Execution status → semantic color mapping (running/waiting/completed/failed)                        |
| DataListView      | `DataListView.tsx`      | Universal data list wrapper: ViewToggle, grid/list layout, ServerPagination, PageLoader, EmptyState |
| DataTable         | `data-table/`           | @tanstack/react-table wrapper with sorting, filtering, pagination                                   |
| CardShell         | `cards/CardShell.tsx`   | Universal card wrapper: dual-mode (compact/list), action buttons, `alwaysVisible` for list mode     |
| Card Components   | `cards/`                | Reusable card components (ExecutionCard, NoteCard, ArtifactCard, etc.) built on CardShell           |
| PageShell         | `PageShell.tsx`         | Page layout wrapper: title, description, loading (skeleton), error states, action slot              |
| FilterBar         | `FilterBar.tsx`         | Standardized filter toolbar: search input, filters slot, actions slot, reset button                 |
| LabeledFilter     | `LabeledFilter.tsx`     | Wrapper adding visible label above any filter control                                               |
| SortSelect        | `SortSelect.tsx`        | Combined sort field+direction dropdown (e.g., "Created ↓")                                          |
| SearchableSelect  | `SearchableSelect.tsx`  | Combobox with text search for dynamic option lists (absolute dropdown + cmdk)                       |
| TopWorkflowsTable | `TopWorkflowsTable.tsx` | Shared DataTable for admin top workflows (AdminDashboard, AdminAnalytics)                           |
| ServerPagination  | `ServerPagination.tsx`  | Server-side pagination (total-based or cursor-based), matches DataTable style                       |
| EmptyState        | `empty-state.tsx`       | Centered icon + title + description + action CTA                                                    |
| InlineError       | `inline-error.tsx`      | Alert destructive with optional retry                                                               |
| PageLoader        | `page-loader.tsx`       | Skeleton stat cards + table rows placeholder                                                        |
| ConfirmDialog     | `confirm-dialog.tsx`    | AlertDialog wrapper with async onConfirm, loading state, ReactNode description                      |

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
/executions (protected)            - Execution history
/artifacts (protected)             - User artifacts management
/settings (protected)              - User settings (single scrollable page with all sections)
/admin (protected)                 - Admin dashboard with merged analytics
/admin/users (protected)           - User management (PageShell + DataListView + UserCard)
/admin/users/:id (protected)       - User detail and security management
/admin/executions (protected)      - Admin executions monitoring (PageShell + DataListView + ExecutionCard)
/admin/executions/:id (protected)  - Admin execution inspector
/admin/audit-log (protected)       - Audit log viewer (PageShell + AuditLogCard + total-based pagination)
/admin/settings (protected)        - Unified settings (Definitions, Values, Maintenance tabs)
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

Sidebar navigation (6 items):

- Home (/)
- Workflows (/workflows)
- Executions (/executions)
- Notes (/notes)
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
- OAuth Authorizations (`OAuthSettings.tsx`): DataListView with consent cards, empty state with KeyRound icon, revoke with ConfirmDialog
- Active Sessions (`SessionsSettings.tsx`): DataListView with session cards, Current Session badge, revoke disabled for current session
- API Tokens (`ApiTokensSettings.tsx`): DataListView with token cards showing name, prefix (monospace), dates, status badge (Active/Expired/Revoked). Create dialog with name input and expiration select (30d/90d/365d/never). One-time token display dialog with copy button and warning. Revoke with ConfirmDialog (variant="destructive").

**Dynamic Sections (Notifications):**

- Categories loaded from `settingDefinition` table (category: "notifications")
- Telegram settings rendered inline without category subgroups
- Uses SettingsEditor with `collapsible={false}` for flat Card rendering
- Test notification button shown when telegram settings detected

**Section Order:** Profile → Security → Notifications (dynamic) → OAuth Authorizations → Active Sessions → API Tokens. Each section has `data-testid="settings-section-{name}"`.

**SettingsEditor `collapsible` prop:**

- `collapsible={true}` (default): Collapsible groups with ChevronDown toggle — used by AdminSettings
- `collapsible={false}`: Flat Card rendering without Collapsible wrapper — used by Settings page

**Implementation:** Settings.tsx → ProfileSettings.tsx, SecuritySettings.tsx, OAuthSettings.tsx, SessionsSettings.tsx

- Loads user profile via GET /api/user/profile
- Fetches dynamic settings definitions via GET /api/settings/definitions
- Updates profile via PATCH /api/user/profile
- Changes password via POST /api/user/change-password
- Resends verification via POST /api/user/resend-verification
- OAuth consents via GET/DELETE /api/user/oauth-consents
- Sessions via GET/DELETE /api/user/sessions
- Handle change via PATCH /api/user/handle

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

- ErrorCountBadge shows error count next to status (only if errors > 0)
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

### ExecutionInspector Component

Unified execution detail component used by both user and admin views via dependency injection.

**Routes:**

- User view: `/executions/:id`
- Admin view: `/admin/executions/:id`

**Component Interface:**

```typescript
interface ExecutionInspectorProps {
  executionId: string;
  fetchExecution: (id: string) => Promise<ExecutionData>;
  editable?: boolean;
  backRoute: string;
  showOwnerInfo?: boolean;
}
```

**Dependency Injection:**

- User view: `fetchExecution` → `apiClient.getExecution`, `editable` → true (context saved via `apiClient.updateExecutionContextPath`)
- Admin view: `fetchExecution` → `apiClient.getAdminExecution`, `editable` omitted (read-only), `showOwnerInfo` → true

**Layout:**

- Compact toolbar (single line): back button, execution ID (copy), workflow name, status badge, current node (clickable), action buttons
- Left panel (50%): Workflow graph visualization with lazy loading via React.lazy + Suspense
- Right panel (50%): Tabbed panel with Context, Errors, and Steps tabs

**Toolbar Elements:**

- Back button with tooltip
- Execution ID (8 chars, click to copy with visual feedback)
- Workflow name with Tooltip for full ID
- Status badge with icon (includes "🔒 Locked" badge when execution is locked)
- Current node button (focuses graph on node via fitView)
- Owner info (admin view only, truncated with Tooltip)
- Lock button (user view only, visible when execution is "running" — opens lock dialog)
- Fullscreen button (opens expanded context modal)
- Refresh button

**Lock Dialog:**

Two-phase dialog (input → result). Input phase: reason text field (required), Lock/Cancel buttons. Result phase: shows lockId and the PIN for sharing with MCP agents — this is the only place the PIN is shown, as it is stored hashed and not retrievable afterward. Submit enabled when reason is non-empty and not in loading state. Enter key submits.

**Tabbed Right Panel:**

Three tabs via shadcn `Tabs` component (four in admin view):

- **Context** (default): `ContextVariableEditor` — a compact variable tree grouped into exactly two sections with count badges, alphabetically ordered: "Global variables" (declared in the workflow `variableRegistry`, readable by bare name) and "Node outputs" (per-node-id local scopes, referenced as `node-id.name`). Under the explicit output-scope model every context value is one of these two, so there is no undeclared/"appeared during execution" group. A global that a node wrote also lives in that node's local scope; it is shown once under Global and hidden from the node's tree (so a promoted global is never duplicated). A node-local scope whose only contents are globals the node wrote (e.g. the start node's seeded scope) renders empty after de-duplication and is omitted. A text filter (key / value / both) is tree-aware: a nested match is shown together with its ancestor path. The description (resolved from the `variableRegistry`, shown for globals) appears as a tooltip on the name. Object/array values render as an expandable tree with alphabetically sorted keys; leaf values are editable at any nesting level. Leaf fields are always in edit mode; Save/Cancel are present but enabled only after a change (dirty state); empty values render at normal height with a placeholder. Long/multiline strings show an expand button that opens a modal multi-line editor. Editing is per-path: only the value at the edited path is sent via `apiClient.updateExecutionContextPath`, then the view reloads authoritative server state. Editable when the `editable` prop is true; read-only in admin view. Fullscreen button opens a Dialog modal hosting the same editor.
- **Errors**: ExecutionErrorHistory component showing execution errors with timestamps, collapsible entries, error type badges.
- **Steps**: StepProgression component showing workflow nodes with completed/current/pending states. Clickable nodes focus the workflow graph.
- **Locks**: Lock history cards showing all lock records (active/unlocked). Each card displays reason, node ID, status badge, timestamps (created/unlocked). Badge with count indicator on tab when locks exist.
  - **Admin view**: "Unlock" button on active locks for admin override.
  - **User view (owner)**: "Unlock" button for owner's own locks (no PIN required in web UI). The PIN is shown only once in the Lock Dialog result phase at creation time; lock history cards do not display it.

**Context Fullscreen Modal:**

- Opens via Maximize2 button in Context tab
- Wide modal: `w-[90vw] max-w-5xl min-w-[800px]`
- Hosts the same `ContextVariableEditor` (per-path save inside the tree)
- Read-only mode when `editable` is not set (admin view)

**ExecutionErrorHistory Component:**

- Displays execution errors with timestamps and details
- Collapsible entries with error type badges (validation, handler, system)
- Relative time display ("5m ago", "2h ago")
- Full timestamp and node ID on expand
- Input data display with whitespace-pre-wrap
- Empty state: "No errors recorded"

**Implementation:**

- `components/execution/ExecutionInspector.tsx` - unified component
- `pages/ExecutionInspectorPage.tsx` - user view wrapper
- `pages/AdminExecutionInspectorPage.tsx` - admin view wrapper
- `components/execution/ExecutionErrorHistory.tsx` - error history display

**Error Node Highlighting:**

WorkflowGraph receives `errorNodeIds` prop computed from execution errors. CompactNode displays error styling:

- Red border (`border-red-500`)
- Red ring highlight (`ring-red-500`)
- Red background tint (`bg-red-500/20`)
- AlertCircle icon

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

WorkflowCard and WorkflowDetail show "Shared" badge when `accessType === "shared"`:

- Purple badge with Users icon
- Indicates workflow was shared via invite link

**Ownership Check:**

`WorkflowDetail` uses `fileInfo.accessType === "owner"` to determine ownership. Delete and visibility buttons are only shown for owned workflows.

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
  - Compare button opens NoteHistoryDialog for diff view

**Version History (NoteHistoryDialog):**

- Split-pane dialog: version list (left), content/diff panel (right)
- Tabbed right panel: Content view (raw text) and Diff view (line-by-line diff via `diff` library)
- Color-coded diff: green for additions, red for removals
- Compares selected version against current (latest) version
- Restore button with AlertDialog confirmation (hidden for current version)
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

- MCP Tool Descriptions (tool descriptions for MCP clients)
- System Configuration (system prompt, system reminder)
- Messages & Validation (error messages, validation help)

**Features:**

- Settings grouped by category with sorting
- SettingsEditor component with type-based inputs
- Input types: string (single line), text (multiline textarea), number, boolean (checkbox), encrypted (password), json
- Per-setting save button with loading state
- Character count display for text areas
- Error state with retry functionality
- History panel: view audit log of all setting changes with rollback capability
- MCP prompts: master-detail layout with left nav panel (System Prompts + Tool Descriptions groups) and right full-height editor (McpPromptsEditor → PromptDetailEditor)
- MCP prompts: per-prompt inline version history with diff highlighting panel, version dropdown, and Apply button for rollback
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
GET    /api/workflows/:id              // Get workflow detail
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

SaaS-specific UI is hidden in self-host based on the flags:

| Flag             | UI gated                                                                            |
| ---------------- | ----------------------------------------------------------------------------------- |
| `legalConsents`  | Registration terms + residency consent checkboxes (`AuthProvider`)                  |
| `betaNotices`    | `BetaAgreementModal` + `BetaWarningBanner` (`useBetaAgreement`)                     |
| `multiUserAdmin` | Admin sidebar items Users / Executions / Workflows / Artifacts / Reported Artifacts |

Multi-user admin gating is defense-in-depth:

- Nav level: `AppSidebar` filters `NavRoute.multiUserAdmin` items (`AdminLayout`).
- Route level: `ProtectedRoute requireMultiUserAdmin` redirects direct
  navigation to `/admin` when the feature is off (`App.tsx` wraps the
  multi-user admin routes).

Retained in self-host admin: Dashboard, Settings Manager, Audit Log, API Tokens,
Deleted Workflows, Monitoring Test, Operational.

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

## React Flow Features

### Available Components

- **Background**: Grid pattern with configurable gap and color
- **Controls**: Zoom controls and fit view functionality
- **MiniMap**: Node overview with custom node colors
- **Node Types**: Unified CompactNode component (~120x40px) for all node types with color-coded borders and smart edge routing

### Layout Controls

```typescript
// Layout algorithm options
interface LayoutOptions {
  direction: "TB" | "BT" | "LR" | "RL";
  spacing: number;
  algorithm: "dagre" | "manual" | "force";
}
```

### Canvas Control Buttons

WorkflowGraph provides layout control buttons at bottom-left:

- **Fit View**: Centers and fits all nodes in viewport
- **Vertical**: Applies top-to-bottom (TB) dagre layout
- **Horizontal**: Applies left-to-right (LR) dagre layout

```typescript
// WorkflowGraph control buttons
<Button onClick={handleFitView}>Fit View</Button>
<Button onClick={() => changeLayout({ direction: "TB" })}>Vertical</Button>
<Button onClick={() => changeLayout({ direction: "LR" })}>Horizontal</Button>
```

Implementation uses ReactFlowProvider wrapper pattern with useReactFlow() hook for fitView API access.

### Node Selection System

- **Persistent Sidebar**: `WorkflowSidebar` component (side-by-side with graph). Shows workflow info when no node selected, node details on selection. Used in `WorkflowDetail` page.
- **Legacy Sheet**: `NodeDetailSheet` (Sheet overlay). Used in execution views (`ExecutionInspector`, `WorkflowVisualizationPage`) where `onNodeSelect` is not provided.
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

### Workflow Data Hook

```typescript
// Primary data hook
useWorkflowApp(): {
  selectedWorkflow: string | null;
  selectWorkflow: (id: string) => void;
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
- **Code splitting**: Heavy pages use `React.lazy()` with Suspense fallback in `App.tsx`

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
      "context": { "title", "saving", "fullscreen", "close", "editor", "editingNote" }
    },
    "settings": {
      "title", "loading", "required", "enable", "saveChanges", "saving", "cancel", "noSettings", "saveSuccess", "saveFailed", "fixErrors",
      "validation": { "mustBeOneOf", "minLength", "maxLength" },
      "telegram": { "testNotification", "sending", "testDescription", "configureBotFirst", "testSuccess", "testFailed" }
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
}

// Default instance using same-origin (nginx proxies /api/ to backend)
export const apiClient = new MoiraApiClient("");
```

## React Flow Integration

### Node Factory System

```typescript
// WorkflowGraph.tsx - All node types use CompactNode
const nodeTypes = {
  start: CompactNode,
  "agent-directive": CompactNode,
  agentDirective: CompactNode,
  condition: CompactNode,
  "telegram-notification": CompactNode,
  telegram: CompactNode,
  subgraph: CompactNode,
  expression: CompactNode,
  end: CompactNode,
  "read-note": CompactNode, // Notes system - cyan styling
  "write-note": CompactNode, // Notes system - teal styling
  "upsert-note": CompactNode, // Notes system - sky styling
  fallback: CompactNode, // Unknown types - stone/gray styling, warning status
};

// Node styling by type (defined in react-flow-types.ts DEFAULT_NODE_STYLES)
// Note nodes: read-note (cyan), write-note (teal), upsert-note (sky)
// Fallback: stone/gray for unknown node types, displays with HelpCircle icon

// Edge types - SmartStepEdge uses A* pathfinding
const edgeTypes = {
  smart: SmartStepEdge, // @tisoap/react-flow-smart-edge
};
```

### Layout Engine

```typescript
// utils/layout-algorithm.ts
export class LayoutEngine {
  static applyDagreLayout(
    nodes: MoiraReactFlowNode[],
    edges: MoiraReactFlowEdge[],
    options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
  ): { nodes: MoiraReactFlowNode[]; edges: MoiraReactFlowEdge[] };

  static calculateViewport(nodes: MoiraReactFlowNode[], width: number, height: number);
}
```

### Performance Optimizations

WorkflowGraph uses several optimization techniques for smooth operation on complex workflows:

**CompactNode Memoization:**

```typescript
// CompactNode.tsx - React.memo with custom comparison
function arePropsEqual(prevProps: CompactNodeProps, nextProps: CompactNodeProps): boolean {
  return (
    prevProps.selected === nextProps.selected &&
    prevProps.data.nodeId === nextProps.data.nodeId &&
    prevProps.data.nodeType === nextProps.data.nodeType &&
    prevProps.data.label === nextProps.data.label &&
    prevProps.data.validationStatus === nextProps.data.validationStatus &&
    prevProps.data.isCurrent === nextProps.data.isCurrent &&
    prevProps.data.isError === nextProps.data.isError &&
    prevProps.data.layoutDirection === nextProps.data.layoutDirection
  );
}
const CompactNode = React.memo(CompactNodeInner, arePropsEqual);
```

**Layout Throttle:**

```typescript
// WorkflowGraph.tsx - 100ms throttle on layout changes
const layoutThrottleRef = useRef<NodeJS.Timeout | null>(null);
const LAYOUT_THROTTLE_MS = 100;

const changeLayout = useCallback(
  (options: LayoutOptions) => {
    if (layoutThrottleRef.current) return; // Skip if pending
    layoutThrottleRef.current = setTimeout(() => {
      layoutThrottleRef.current = null;
    }, LAYOUT_THROTTLE_MS);
    // ... layout calculation
  },
  [nodes, edges],
);
```

**Delayed MiniMap Render:**

```typescript
// WorkflowGraph.tsx - requestIdleCallback for MiniMap
useEffect(() => {
  if (showMinimap && !showMiniMapDelayed) {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(() => setShowMiniMapDelayed(true), { timeout: 500 });
    } else {
      setTimeout(() => setShowMiniMapDelayed(true), 200);
    }
  }
}, [showMinimap, showMiniMapDelayed]);
```

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

## Workflow Visualization

### React Flow Setup

```typescript
// Professional React Flow configuration
<ReactFlow
  nodes={nodes}
  edges={edges}
  nodeTypes={nodeTypes}
  connectionMode={ConnectionMode.Strict}
  minZoom={0.1}
  maxZoom={2}
  deleteKeyCode={null}
  multiSelectionKeyCode={null}
>
  <Background gap={20} size={1} color="#E5E7EB" />
  <Controls position="top-right" showZoom={true} showFitView={true} />
  <MiniMap position="bottom-right" nodeStrokeWidth={2} />
</ReactFlow>
```

### Layout Controls

```typescript
// Layout control buttons
const fitView = useCallback(() => {
  const optimalViewport = LayoutEngine.calculateViewport(nodes, 800, 600);
  setViewport(optimalViewport);
}, [nodes]);

const changeLayout = useCallback(
  async (newLayoutOptions: LayoutOptions) => {
    const layoutResult = LayoutEngine.applyDagreLayout(nodes, edges, newLayoutOptions);
    setNodes(layoutResult.nodes);
    setEdges(layoutResult.edges as Edge[]);
  },
  [nodes, edges],
);
```

## Animations

### Page Transitions

Page-level wrapper animations are **not used** on `AnimatedPage` (a `h-full` wrapper ensuring the CSS height chain for React Flow). Instead, content entrance animations are handled by `FadeIn` component.

### Content Entrance Animation

`FadeIn` component (`components/fade-in.tsx`) wraps page content that appears after loading. Uses `tw-animate-css` (same animation system as shadcn Dialog, Popover, Tooltip):

- CSS classes: `animate-in fade-in slide-in-from-bottom-3 duration-300 fill-mode-both`
- Fade from transparent + slide up 12px over 300ms
- Applied to: Dashboard, Settings, AdminDashboard, AdminAnalytics, AdminSettings, AdminUserDetail, UserManagement, DeletedWorkflows, OperationalDashboard
- **Not applied to WorkflowDetail** — React Flow requires immediate full opacity to measure container dimensions

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
│   │   └── nodes/               # ReactFlow node components (CompactNode - unified for all types)
│   ├── contexts/                # ThemeProvider for dark mode
│   ├── hooks/                   # useWorkflowData, useLayoutState, use-mobile
│   ├── services/                # api-client.ts HTTP communication
│   ├── utils/                   # node-factory.ts, layout-algorithm.ts
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
