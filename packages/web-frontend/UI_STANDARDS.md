# UI Standards

Component and styling rules for `packages/web-frontend/`.

## Required Components

| Need                 | Use                                              |
| -------------------- | ------------------------------------------------ |
| Page title + actions | `PageHeader`                                     |
| Dashboard metric     | `StatCard`                                       |
| Execution status     | `StatusBadge`                                    |
| Tabular data         | `DataTable` + `DataTableColumnHeader`            |
| Search + filter bar  | `SearchFilterBar` or `DataTableToolbar`          |
| Empty list / table   | `EmptyState`                                     |
| Error with retry     | `InlineError`                                    |
| Loading skeleton     | `PageLoader`                                     |
| Destructive confirm  | `ConfirmDialog`                                  |
| Buttons              | `Button` from `@/components/ui/button`           |
| Form inputs          | `Input`, `Select`, `Textarea` from `ui/`         |
| Modals               | `AlertDialog` (destructive) / `Dialog` (general) |
| Toasts               | `sonner` via `toast()`                           |
| Icons                | `lucide-react` only                              |

## Banned Patterns

- Raw HTML elements: `<button>`, `<input>`, `<select>`, `<textarea>`, `<table>`, `<dialog>`
- Native browser APIs: `alert()`, `confirm()`, `prompt()`
- Hardcoded Tailwind palette colors: `text-gray-*`, `bg-blue-*`, `text-red-*`, `text-amber-*`, `bg-purple-*`, `text-green-*`, etc.
- Inline SVGs or icon libraries other than `lucide-react`
- Custom modal/popup implementations with absolute positioning
- `overflow-auto` without `ScrollArea`
- Raw `min-h-screen` centering divs on auth pages — use `<AuthLayout>` instead

## Auth Pages

All authentication pages use `<AuthLayout>` from `src/components/AuthLayout.tsx`:

```tsx
<AuthLayout maxWidth="max-w-sm" showLanguageSwitcher={false}>
  <Card>...</Card>
</AuthLayout>
```

Props: `maxWidth` (default `max-w-sm`), `showLanguageSwitcher` (default `true`).

Pages using AuthLayout: Login, Register, ForgotPassword, ResetPassword, VerifyEmail, ForcedPasswordReset, RegistrationSuccess, InviteAccept, OAuthConsent, OAuthAuthorize.

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
- Use `AlertDialog` for destructive actions (traps focus, requires explicit dismiss).

## Icons

- Import from `lucide-react` only.
- Default size: `h-4 w-4` (16px).
- Color: inherit via `currentColor`. Use `text-muted-foreground` for secondary icons.
- Loading spinner: `<Loader2 className="h-4 w-4 animate-spin" />`.
