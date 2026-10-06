# Design System Checklist

Component patterns, color token rules, and checklists for maintaining visual consistency.

## Color Tokens

All colors use OKLCH format. Never use hardcoded Tailwind color classes (e.g., `bg-gray-100`, `text-blue-500`).

### Semantic Tokens

| Token                                         | Purpose                                    | Usage                                             |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `background`                                  | Page background                            | `bg-background`                                   |
| `foreground`                                  | Primary text                               | `text-foreground`                                 |
| `card` / `card-foreground`                    | Card surfaces                              | `bg-card text-card-foreground`                    |
| `popover` / `popover-foreground`              | Dropdown/popover surfaces                  | `bg-popover text-popover-foreground`              |
| `primary` / `primary-foreground`              | Brand actions, primary buttons             | `bg-primary text-primary-foreground`              |
| `secondary` / `secondary-foreground`          | Secondary buttons, subtle surfaces         | `bg-secondary text-secondary-foreground`          |
| `muted` / `muted-foreground`                  | Disabled text, subtle backgrounds          | `bg-muted text-muted-foreground`                  |
| `accent` / `accent-foreground`                | Hover states, highlights                   | `bg-accent text-accent-foreground`                |
| `destructive`                                 | Error text, borders, rings, tints          | `text-destructive`, `border-destructive/30`       |
| `destructive-fill` / `destructive-foreground` | Solid delete/error fills (buttons, badges) | `bg-destructive-fill text-destructive-foreground` |
| `success` / `success-foreground`              | Success states                             | `text-success`                                    |
| `warning` / `warning-foreground`              | Warning states                             | `text-warning`                                    |
| `info` / `info-foreground`                    | Info states                                | `text-info`                                       |
| `your-move`                                   | The move is the person's (waiting for you) | `text-your-move`, `bg-your-move/10`               |
| `border`                                      | Borders                                    | `border-border`                                   |
| `input`                                       | Form input borders                         | `border-input`                                    |
| `ring`                                        | Focus rings                                | `ring-ring`                                       |

### Dark Theme OKLCH Targets

Background lightness: 0.19 (range 0.18-0.20).
Card lightness: 0.22 (background + ~0.03).
Secondary/muted/accent lightness: 0.30.
Border/input lightness: 0.34.
Hue: 260 (indigo family). Chroma: 0.012-0.015.

## Approved Component Patterns

### Buttons

Use `Button` from `@/components/ui/button`. Variants:

- `default` — primary actions (submit, save, create)
- `destructive` — delete, remove, revoke
- `outline` — secondary actions with border
- `secondary` — less prominent actions
- `ghost` — toolbar/icon buttons
- `link` — inline text links

Sizes: `default` (h-9), `sm` (h-8), `lg` (h-10), `icon` (9x9), `icon-sm` (8x8).

### Cards

Use `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` from `@/components/ui/card`.

Cards use `rounded-xl` border radius and `shadow` by default.

### Forms

- Input: `Input` from `@/components/ui/input`
- Select: `Select` from `@/components/ui/select`
- Checkbox: `Checkbox` from `@/components/ui/checkbox`
- Switch: `Switch` from `@/components/ui/switch`
- Labels: `Label` from `@/components/ui/label`
- TextArea: `Textarea` from `@/components/ui/textarea`

### Data Display

- Tables: `DataTable` component with `@tanstack/react-table`
- Badges: `Badge` from `@/components/ui/badge`
- Skeletons: `Skeleton` from `@/components/ui/skeleton`

### Feedback

- Dialogs: `Dialog` from `@/components/ui/dialog`
- Destructive confirmations: `ConfirmDialog` from `@/components/confirm-dialog`; await the operation and reject failure, with its accessible error inside the dialog
- Toasts: `toast()` from `sonner`
- Progress: `Progress` from `@/components/ui/progress`

### Navigation

- Tabs: `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` from `@/components/ui/tabs`
- Dropdown: `DropdownMenu` from `@/components/ui/dropdown-menu`
- Sidebar: `AppSidebar` with `SidebarProvider`
- User Settings: `Tabs` with retained hidden panels, caller-owned hashes and guide preparation
- Administrator Settings: `SettingsNav` with caller-owned links, query changes and optional guide identity

## New Page Checklist

When creating a new data listing page:

1. **Page wrapper**: Use `PageShell` for the stable title/actions; pass explicit `hasResult` when its body owns a retained result, or compose smaller `DataRegion` boundaries
2. **Filters**: Use `FilterBar` with search, filters slot, actions slot, reset
3. **Data list**: Use `DataListView<T>` with required `hasResult`, renderCard, accepted-result pagination, ViewToggle and local loading/error/retry/refresh
4. **Cards**: Create a card component that fills `CardShell`'s slots (title, description, meta, badges, actions; `compact` for grid mode)
5. **Formatters**: Use shared `formatDate`, `formatRelativeTime`, `formatSize` from `@/components/cards/format-utils`
6. **Debounce**: Use `useDebounce` hook for search inputs (300ms)
7. **Page size**: Use `useListPageSize` for a `DataListView` of cards (pass its `onViewModeChange` and reset to page 1 in its callback), `useDynamicPageSize` for a table; never a hardcoded page size; drop stale answers with `useLatestRequest` directly or through `useResource`

General rules for all pages:

1. **Colors**: Use only semantic tokens from `globals.css`. No hardcoded Tailwind colors.
2. **Components**: Use shadcn/ui primitives. Do not create custom button/input/card components.
3. **Layout**: Use `PageShell` for standard data pages; preserve the justified settings/detail/process layouts and their header wrappers. Use `Card` for content sections and `Separator` between major sections.
4. **Spacing**: Follow existing page patterns — `p-6 md:p-8` page padding, `gap-4` between sections.
5. **Typography**: Use `text-foreground` for primary text, `text-muted-foreground` for secondary.
6. **Border radius**: Use theme `--radius` via Tailwind classes (`rounded-md`, `rounded-lg`, `rounded-xl`).
7. **Dark mode**: All colors auto-adapt via semantic tokens. No `dark:` prefix needed for standard tokens.
8. **i18n**: All user-visible text via `t('key')` from `useTranslation()`. Add keys to both `en.json` and `ru.json`.
9. **Dialogs**: Use `ConfirmDialog` for destructive confirmations. Never use native `alert()` or `confirm()`.
10. **Loading states**: Load only the affected region. Use a skeleton before that region's first result; keep loaded data, including an empty result, with a local pending indicator on refresh. Preserve the frame, header, tabs, filters, focus, scroll and unsaved input. Use `PageShell.loading` only when the whole screen has no usable data. See the Design System's **Loading and partial updates** contract.
11. **Empty states**: Use `EmptyState` component with icon, title, description, and CTA.
12. **Error states**: Use `InlineError` with retry in the affected region. A failed refresh keeps its last usable data and all independent panels; it does not replace the whole loaded page. Retained data must show its actual scope, and account/resource changes must not expose another identity's private result.
13. **Responsive**: Test mobile viewport. Use responsive Tailwind classes (`sm:`, `md:`, `lg:`).
14. **Accessibility**: All interactive elements must be keyboard-navigable. Icon-only buttons require `aria-label`.

Keep requested controls separate from the accepted response's items, query, count, page and size.
An accepted empty response is a result; show its actual zero count and retain out-of-range
previous-page navigation. Local retry must not discard independent panels or drafts. Confirmed
mutations supersede older reads; fresh accepted fields update untouched inputs without overwriting
other edits. These checks apply to all data surfaces, including user settings and operational pages.

For settings rows, retain full translated labels, descriptions and help. Metadata and actions
wrap inside the card on narrow screens; long storage keys must not widen it. A pending save
must preserve a newer draft, and its completion clears only the value it submitted.

## Anti-Patterns

- ❌ `bg-gray-100`, `text-blue-500` — use semantic tokens
- ❌ `style={{ color: '#333' }}` — use Tailwind classes with tokens
- ❌ Native `confirm()` / `alert()` — use `ConfirmDialog`
- ❌ Custom button styling with `<div onClick>` — use `Button` component
- ❌ `target="_blank"` on internal doc links — use same-tab navigation
- ❌ Raw `<table>` — use `DataListView` with card components
- ❌ `dark:` prefix classes — use CSS custom properties
- ❌ Manual `setTimeout` debounce — use `useDebounce` hook
- ❌ Inline `<p>Loading...</p>` — use the affected `DataRegion`, with an initial skeleton only before its first result
- ❌ Ad-hoc error rendering — use `InlineError`
- ❌ Manual page wrapper `<div className="p-6">` — use `PageShell`
- ❌ Inline search + filter bar markup — use `FilterBar`
- ❌ Duplicated card hover/border CSS — use `CardShell`
- ❌ Local `formatDate`/`formatSize` — use `@/components/cards/format-utils`
