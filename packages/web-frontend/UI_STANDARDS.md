# UI Standards

Component and styling rules for `packages/web-frontend/`.

## Required Components

| Need                          | Use                                                          |
| ----------------------------- | ------------------------------------------------------------ |
| Page title + actions          | `PageHeader`                                                 |
| Process title + facts/actions | `diagram/PageHeader` over `PageHeaderContent`                |
| Retained data region          | `DataRegion`                                                 |
| Card list + server pagination | `DataListView` + `CardShell`                                 |
| User settings task navigation | `ui/Tabs`                                                    |
| Admin settings navigation     | `settings/SettingsNav`                                       |
| Dashboard metric              | `StatCard`                                                   |
| Execution status              | `StatusBadge`                                                |
| Tabular data                  | `DataTable` + `DataTableColumnHeader`                        |
| Search + filter bar           | `FilterBar` + `LabeledFilter`; `DataTableToolbar` for tables |
| Empty list / table            | `EmptyState`                                                 |
| Error with retry              | `InlineError`                                                |
| Initial region load           | `Skeleton` / `PageLoader` within that region                 |
| Destructive confirm           | `ConfirmDialog`                                              |
| Buttons                       | `Button` from `@/components/ui/button`                       |
| Form inputs                   | `Input`, `Select`, `Textarea` from `ui/`                     |
| Modals                        | `ConfirmDialog` (confirmation) / `Dialog` (general)          |
| Toasts                        | `sonner` via `toast()`                                       |
| Icons                         | `lucide-react` only                                          |

## Banned Patterns

- Raw HTML elements: `<button>`, `<input>`, `<select>`, `<textarea>`, `<table>`, `<dialog>`
- Native browser APIs: `alert()`, `confirm()`, `prompt()`
- Hardcoded Tailwind palette colors: `text-gray-*`, `bg-blue-*`, `text-red-*`, `text-amber-*`, `bg-purple-*`, `text-green-*`, etc.
- Inline SVGs or icon libraries other than `lucide-react`
- Custom modal/popup implementations with absolute positioning
- `overflow-auto` without `ScrollArea`
- Raw `min-h-screen` centering divs on auth pages — use `<AuthLayout>` instead

## Loading and partial updates

Follow `docs/DESIGN-SYSTEM.md` → **Loading and partial updates**. A local request has a local
pending indicator, error and retry. Keep the frame, header, tabs, filters and independent panels
mounted, preserving focus, scroll and unsaved values. A successful empty result is loaded data.
Show an initial skeleton only before the affected region has a usable result; refresh keeps the
last usable result with its actual scope. Account/resource changes must not show another
identity's private data. Compose `useResource` and existing UI primitives; a request inside a
loaded tab must not replace the whole tab or page with `PageShell.loading`.

Use explicit `hasResult` in `DataRegion` and `DataListView`; pass it to `PageShell` when its whole
body owns a retained result. Keep accepted items, total, page, size and query in one snapshot,
separate from the requested filter controls. `resultScope` and pagination describe accepted data,
including an empty response. `DataListView` retains its toolbar and provides local `onRetry` and
optional `onRefresh`; an empty page beyond the available range keeps previous-page navigation.
This contract applies throughout the interface, including settings, detail panels and operational
cards, rather than only administrator analytics.

Compose the existing header wrappers: the standard header owns screen-tour discovery, while the
compact process header preserves back navigation, facts, badges, actions and declared guide IDs.
`PageHeaderContent` has no Router dependency. `SettingsNav` owns presentation only: callers pass
links, selection and optional guide identity, and perform query/hash history changes and scrolling.
User Settings uses `Tabs` for tasks and Development subviews. Retain inactive panels with
`forceMount` and `hidden`, preserving drafts without focusable hidden controls. Section hashes and
guide preparation select the owning view before revealing the target; panel activation refreshes
its source locally.

Drafts belong to fields, accepted facts to the resource. Adopt fresh source values for untouched
fields, preserve other dirty fields, and supersede older reads after a confirmed mutation with
the existing resource/request guard. `ConfirmDialog.onConfirm` awaits and rejects failures; show
the refusal inside its `children` slot so it remains accessible with the modal open. Keep typed
input available for retry instead of closing the confirmation before the operation finishes.

Use the existing layout Suspense boundary for route code and local boundaries for form/editor,
Markdown preview and history code. Pending presentation preserves the draft and independent
controls. Private access uncertainty uses the existing private holding/admission boundary:
withhold private contents while preserving same-owner drafts, and reset them on confirmed
account/backend replacement. Public auth forms remain outside private ownership keys. See
`docs/WEB-UI.md` → **Routes** and `docs/AUTHENTICATION.md`; do not introduce another session context.

Use `useListPageSize` for card-list capacity. Concealed or partly unmeasured items must not settle
the row height; wait for valid geometry after disclosure and keep later-page heights from changing
the accepted view measurement. Preserve the existing private holding boundary while measuring.

## Auth Pages

All authentication pages use `<AuthLayout>` from `src/components/AuthLayout.tsx`:

```tsx
<AuthLayout maxWidth="max-w-sm" showLanguageSwitcher={false}>
  <Card>...</Card>
</AuthLayout>
```

Props: `maxWidth` (default `max-w-sm`), `showLanguageSwitcher` (default `true`).

Pages using AuthLayout: Login, Register, ForgotPassword, ResetPassword, VerifyEmail, ForcedPasswordReset, RegistrationSuccess, InviteAccept, OAuthConsent, OAuthAuthorize.

Render the shared `auth/LazyAuthView` for an actual form branch. Global `AuthProvider` supplies
error state/interception and Toaster; `AuthForm` owns Better Auth UI configuration and continuation
callbacks. Keep both inside the existing Router/features composition, with one auth client.

Use the existing session notifier and `revokeObservedSession` for automatic cleanup of the
originally observed session. Async results and timers must belong to the current mounted operation;
a late refusal or cleanup must not redirect or sign out a replacement account. An owned form's
successful credential renewal must still complete its normal continuation.

## DataTable Props

| Prop             | Type                 | Default | Purpose                                          |
| ---------------- | -------------------- | ------- | ------------------------------------------------ |
| `columns`        | `ColumnDef<T>[]`     | —       | Column definitions                               |
| `data`           | `T[]`                | —       | Row data                                         |
| `getRowTestId`   | `(row: T) => string` | —       | Per-row `data-testid` attribute                  |
| `onRowClick`     | `(row: T) => void`   | —       | Row click handler (adds cursor-pointer)          |
| `showPagination` | `boolean`            | `true`  | Show built-in pagination (false for server-side) |
| `showToolbar`    | `boolean`            | `true`  | Show built-in toolbar (false for custom toolbar) |

For server-side paginated pages, set `showPagination={false}` and `showToolbar={false}`.

## Color Tokens

All colors must use semantic tokens defined in `globals.css`.

Tremor charts and `StatCard` sparklines use the shared `CHART_COLORS` semantic palette.
`globals.css` owns finite vendor utility generation and live foreground/border/background aliases;
do not introduce raw palette overrides or dependency-wide scanning. A tooltip's semantic color
name resolves through its CSS variable, rather than becoming a literal CSS color.

Comparison charts preserve each series's returned bounds: missing clipped history is `null`,
received zero stays zero, and a known gap in covered history stays zero. A series limitation notice
does not turn unknown points into numerical tooltip values or restrict full-period totals.

| Token class             | Purpose                |
| ----------------------- | ---------------------- |
| `bg-background`         | Page background        |
| `text-foreground`       | Primary text           |
| `bg-card`               | Card surfaces          |
| `text-muted-foreground` | Secondary/caption text |
| `bg-primary`            | Brand accent           |
| `bg-destructive`        | Errors, delete actions |
| `bg-success`            | Success states         |
| `bg-warning`            | Warning states         |
| `bg-info`               | Informational states   |
| `border-border`         | Default borders        |
| `border-input`          | Input field borders    |
| `ring-ring`             | Focus rings            |

## Accessibility

- Every form field must have a `Label` component.
- Interactive elements must be keyboard-navigable.
- Buttons with only icons must have `aria-label`.
- Color is never the sole indicator of state — pair with text or icons.
- Use `ConfirmDialog` for destructive confirmations; its underlying AlertDialog traps focus.

## Icons

- Import from `lucide-react` only.
- Default size: `h-4 w-4` (16px).
- Color: inherit via `currentColor`. Use `text-muted-foreground` for secondary icons.
- Loading spinner: `<Loader2 className="h-4 w-4 animate-spin" />`.
