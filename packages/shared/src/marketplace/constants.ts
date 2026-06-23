/**
 * Marketplace constants
 *
 * The marketplace uses a FIXED category set for browse/filter (stable URLs,
 * predictable navigation) plus free-form tags for open-ended discovery. Adding a
 * category is a deliberate schema-level change here; tags need no code change.
 */

/**
 * A single browse category. `id` is the stable value stored on a listing and
 * used in URLs/filters; `label` is the human-facing display name.
 */
export interface MarketplaceCategory {
  readonly id: string;
  readonly label: string;
}

/**
 * The fixed, ordered category set. Order is the display order in the gallery.
 * `other` is the catch-all and must remain last.
 */
export const MARKETPLACE_CATEGORIES: readonly MarketplaceCategory[] = [
  { id: "development", label: "Development" },
  { id: "research", label: "Research" },
  { id: "content", label: "Content" },
  { id: "data", label: "Data & Analysis" },
  { id: "design", label: "Design & UX" },
  { id: "testing", label: "Testing & QA" },
  { id: "marketing", label: "Marketing" },
  { id: "productivity", label: "Productivity" },
  { id: "other", label: "Other" },
] as const;

/** Valid category ids, derived from {@link MARKETPLACE_CATEGORIES}. */
export const MARKETPLACE_CATEGORY_IDS: readonly string[] = MARKETPLACE_CATEGORIES.map((c) => c.id);

/** The catch-all category id used when none is specified or a value is invalid. */
export const DEFAULT_MARKETPLACE_CATEGORY = "other";

const CATEGORY_ID_SET: ReadonlySet<string> = new Set(MARKETPLACE_CATEGORY_IDS);

/** Whether `id` is one of the fixed marketplace categories. */
export function isValidMarketplaceCategory(id: string): boolean {
  return CATEGORY_ID_SET.has(id);
}

/**
 * Normalize an arbitrary input to a valid category id. Unknown/empty values
 * fall back to {@link DEFAULT_MARKETPLACE_CATEGORY} so a listing always has a
 * valid category.
 */
export function normalizeMarketplaceCategory(id: string | null | undefined): string {
  if (id && CATEGORY_ID_SET.has(id)) return id;
  return DEFAULT_MARKETPLACE_CATEGORY;
}
