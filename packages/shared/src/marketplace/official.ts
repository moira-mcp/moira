/**
 * Official ownership + the curated base-flow seed set.
 *
 * "Official" is a derived signal, not a schema column: a flow is official iff its
 * owner is one of the system accounts ({@link OFFICIAL_OWNER_IDS}). Bundled flows are
 * installed under `system-moira` (public) / `system-admin` (private), so they carry no
 * separate "verified"/"core" marker — the owner is the source of truth.
 *
 * {@link OFFICIAL_BASE_FLOW_SLUGS} is the curated everyday set seeded into every user's
 * library on signup (and back-filled for existing users). It is intentionally small —
 * the common base, NOT the whole bundled catalog — and lists only `system-moira`
 * (public) slugs that exist in the on-disk catalog.
 */

/**
 * The system/official account ids. A flow owned by one of these is "official".
 * `system-moira` (handle `moira`) owns the bundled PUBLIC flows; `system-admin`
 * (handle `admin`) owns the bundled PRIVATE flows.
 */
export const OFFICIAL_OWNER_IDS = ["system-moira", "system-admin"] as const;
export type OfficialOwnerId = (typeof OFFICIAL_OWNER_IDS)[number];

const OFFICIAL_OWNER_ID_SET: ReadonlySet<string> = new Set(OFFICIAL_OWNER_IDS);

/** Whether a user id is one of the official system accounts. */
export function isOfficialOwner(userId: string | null | undefined): boolean {
  return userId != null && OFFICIAL_OWNER_ID_SET.has(userId);
}

/**
 * The curated everyday base flows seeded into a new user's library. Each slug is a
 * `system-moira` (public) catalog flow. Keep this list small and stable — it is the
 * common starting set, not the full catalog.
 */
export const OFFICIAL_BASE_FLOW_SLUGS: readonly string[] = [
  "quick-task",
  "robust-task",
  "workflow-management-flow",
  "verified-research",
  "user-onboarding",
  "software-development-flow",
] as const;

/**
 * Marketplace category for each known official (`system-moira`) catalog slug.
 *
 * The on-disk catalog flows carry no category, so the official-publish routine assigns
 * one at publish time. Each value MUST be one of the closed
 * {@link MARKETPLACE_CATEGORIES} ids (development/research/content/data/design/testing/
 * marketing/productivity/other). A slug not listed here resolves to `other` via
 * {@link officialFlowCategory}. Keep this in sync with `workflows/production/flows/*`.
 */
export const OFFICIAL_FLOW_CATEGORIES: Readonly<Record<string, string>> = {
  // development — build/ship/manage work
  "quick-task": "development",
  "robust-task": "development",
  "software-development-flow": "development",
  "software-development-flow-lite": "development",
  "workflow-management-flow": "development",
  "task-breakdown-flow": "development",
  // research
  "verified-research": "research",
  "iterative-research": "research",
  "universal-research-workflow": "research",
  research: "research",
  // content
  "content-creation": "content",
  // data & analysis
  "data-analysis": "data",
  // design & UX
  "ux-design": "design",
  "architecture-design-flow": "design",
  // testing & QA
  "test-generation": "testing",
  "test-planning": "testing",
  "test-suite-audit": "testing",
  "bug-hunting-workflow": "testing",
  // marketing
  "marketing-campaign": "marketing",
  // productivity — assistants, planning, task management, onboarding
  "user-onboarding": "productivity",
  "todo-list": "productivity",
  "prd-creation": "productivity",
  "smart-purchase-assistant": "productivity",
  "startup-idea-validation": "productivity",
  "infinite-task-loop": "productivity",
  "simple-plan-execution": "productivity",
  // other — demos, generators, setup utilities
  "artifacts-demo-dashboard-builder": "other",
  "artifacts-demo-report-publisher": "other",
  "notes-demo-metrics-collector": "other",
  "notes-demo-metrics-reporter": "other",
  "workflow-presentation-generator": "other",
  "telegram-setup": "other",
};

/**
 * The marketplace category for an official catalog slug. Returns the mapped category
 * from {@link OFFICIAL_FLOW_CATEGORIES}, or `"other"` for an unmapped slug.
 */
export function officialFlowCategory(slug: string): string {
  return OFFICIAL_FLOW_CATEGORIES[slug] ?? "other";
}
