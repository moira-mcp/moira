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
| `--destructive`                      | Error/danger actions               |
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
| Dynamic page sizing       | `useDynamicPageSize` | `@/hooks/useDynamicPageSize`   |

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

### CardShell

Universal card wrapper supporting list (default) and grid (`compact`) modes.

```tsx
<CardShell
  compact={isGrid}
  onClick={() => navigate(item.id)}
  actions={[
    { icon: <Edit />, label: "Edit", onClick: handleEdit },
    { icon: <Trash />, label: "Delete", onClick: handleDelete, variant: "destructive" },
  ]}
  testId="my-card"
>
  {/* card content */}
</CardShell>
```

- **Compact mode**: vertical flex layout, actions float top-right
- **List mode**: horizontal row (h-10), actions appended at end

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

- Badge height: `h-4` consistently (not h-5)
- Icon size in cards: `w-4 h-4` for primary icons, `w-3 h-3` for inline metadata icons
- Action buttons: `h-6 w-6` ghost icon buttons, hidden until hover
- Timestamps: use `formatRelativeTime()` for recency, `formatDate()` for absolute dates
- Card data-testid: descriptive (e.g., `note-card`, `execution-card`)

## Badge Consistency

| Context             | Classes                                        |
| ------------------- | ---------------------------------------------- |
| Standard badge      | `text-[10px] px-1 py-0 h-4`                    |
| Status/action badge | `text-[10px] px-1.5 py-0 h-4`                  |
| Error count         | `border-destructive/30 text-destructive`       |
| Success             | `border-success/30 text-success`               |
| Warning             | `bg-warning/10 text-warning border-warning/30` |

## Dark/Light Theme

- Colors switch via CSS custom properties in `globals.css`
- **Never** use `dark:` prefix — all theming is through CSS variables
- Test both themes when adding new components
