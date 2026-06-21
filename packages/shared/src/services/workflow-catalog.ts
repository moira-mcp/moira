/**
 * Workflow Catalog Reader
 *
 * Reads the on-disk production workflow catalog. Each flow file carries its own `owner` and
 * `visibility` (catalog metadata, not part of the executable graph), so a flow can be mapped to a
 * specific owning user rather than implicitly being system-owned. The deploy/migration loader
 * (Step 13) consumes this to install each flow under the correct owner.
 *
 * Catalog identity is (owner, slug): the same slug can exist under different owners, so the catalog
 * must never collapse entries by slug alone. Files are named by their stable UUID to avoid filename
 * collisions across owners.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";

/** Stable identifiers of the two system owners. Everything else is a real user. */
export const SYSTEM_OWNER_IDS = ["system-admin", "system-moira"] as const;
export type SystemOwnerId = (typeof SYSTEM_OWNER_IDS)[number];

export type WorkflowVisibility = "public" | "private";

export interface CatalogEntry {
  /** Stable UUID of the flow on the source system (also the catalog file name). */
  id: string;
  /** Human-readable slug; unique only per owner. */
  slug: string;
  /** Owner the flow must be installed under (system id or a real user id). */
  owner: string;
  /** Visibility the flow is installed with. */
  visibility: WorkflowVisibility;
  /** True when the owner is one of the system owners (system-admin / system-moira). */
  isSystemOwner: boolean;
  /** The executable graph body (without the catalog metadata keys). */
  graph: Record<string, unknown>;
  /** Absolute path of the source file. */
  filePath: string;
}

/** Default catalog directory, relative to the process working directory. */
export function getCatalogDir(baseDir?: string): string {
  return path.resolve(baseDir ?? "./workflows/production", "flows");
}

export function isSystemOwner(owner: string): boolean {
  return (SYSTEM_OWNER_IDS as readonly string[]).includes(owner);
}

/**
 * Read one catalog file into a CatalogEntry. Throws on missing/invalid catalog metadata so a
 * malformed catalog fails loudly rather than silently installing under the wrong owner.
 */
export function readCatalogEntry(filePath: string): CatalogEntry {
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;

  const owner = raw.owner;
  const visibility = raw.visibility;
  const slug = raw.slug ?? path.basename(filePath, ".json");

  if (typeof owner !== "string" || owner.length === 0) {
    throw new Error(`Catalog file ${filePath} is missing a non-empty 'owner' field`);
  }
  if (visibility !== "public" && visibility !== "private") {
    throw new Error(
      `Catalog file ${filePath} has invalid 'visibility' (expected "public" | "private")`,
    );
  }
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error(`Catalog file ${filePath} is missing a non-empty 'slug' field`);
  }

  // The graph body excludes the catalog-only metadata keys.
  const { owner: _owner, visibility: _visibility, ...graph } = raw;

  return {
    id: typeof raw.id === "string" ? raw.id : path.basename(filePath, ".json"),
    slug,
    owner,
    visibility,
    isSystemOwner: isSystemOwner(owner),
    graph,
    filePath,
  };
}

/**
 * Enumerate the full production catalog. Returns one CatalogEntry per flow file, preserving per-owner
 * duplicates of the same slug. Returns an empty array if the catalog directory does not exist.
 */
export function readWorkflowCatalog(baseDir?: string): CatalogEntry[] {
  const dir = getCatalogDir(baseDir);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readCatalogEntry(path.join(dir, f)));
}

/**
 * Read and MERGE several catalog base directories into one entry list, de-duplicating by the
 * (owner, slug) identity. Directories are applied IN ORDER and a LATER directory OVERRIDES an
 * earlier one on a collision — so a private folder listed last can extend or shadow the bundled
 * public catalog. Per-owner duplicate slugs (different owner or different slug) all survive the
 * merge; only an exact (owner, slug) match is overridden. Missing/empty directories are skipped.
 *
 * Passing a single directory is equivalent to readWorkflowCatalog(dir) (modulo the unconditional
 * dedup, which is a no-op for a single well-formed directory), so the default single-dir path is
 * preserved.
 */
export function readWorkflowCatalogs(baseDirs: string[]): CatalogEntry[] {
  const merged = new Map<string, CatalogEntry>();
  for (const baseDir of baseDirs) {
    for (const entry of readWorkflowCatalog(baseDir)) {
      // Later directory wins: a Map.set with the same key overrides the earlier entry.
      merged.set(ownerSlugKey(entry.owner, entry.slug), entry);
    }
  }
  return [...merged.values()];
}

/** Compose the (owner, slug) catalog key. Owners/slugs cannot contain "|", so it is unambiguous. */
export function ownerSlugKey(owner: string, slug: string): string {
  return `${owner}|${slug}`;
}

/**
 * Find a single catalog entry by slug, optionally narrowed by visibility and/or owner. Since a slug
 * can exist under multiple owners, this throws if the slug is still ambiguous (more than one match)
 * so callers must disambiguate. Returns undefined when there is no match.
 */
export function findCatalogEntryBySlug(
  slug: string,
  visibility?: WorkflowVisibility,
  baseDir?: string,
  owner?: string,
): CatalogEntry | undefined {
  const matches = readWorkflowCatalog(baseDir).filter(
    (e) =>
      e.slug === slug &&
      (visibility === undefined || e.visibility === visibility) &&
      (owner === undefined || e.owner === owner),
  );
  if (matches.length > 1) {
    const owners = matches.map((m) => `${m.owner}/${m.visibility}`).join(", ");
    throw new Error(
      `Ambiguous catalog slug '${slug}' matches multiple entries (${owners}); narrow by visibility/owner.`,
    );
  }
  return matches[0];
}

/**
 * The system owner that holds a flow of a given visibility in the bundled catalog: public flows are
 * owned by system-moira, private flows by system-admin. (Mirrors the previous public/private folder
 * convention.) Used to resolve a system flow unambiguously by (visibility-derived owner, slug).
 */
export function systemOwnerForVisibility(visibility: WorkflowVisibility): SystemOwnerId {
  return visibility === "public" ? "system-moira" : "system-admin";
}

/** Resolve a SYSTEM-owned catalog flow by slug + visibility, disambiguating by the system owner. */
export function findSystemCatalogEntry(
  slug: string,
  visibility: WorkflowVisibility,
  baseDir?: string,
): CatalogEntry | undefined {
  return findCatalogEntryBySlug(slug, visibility, baseDir, systemOwnerForVisibility(visibility));
}

/** Build a Map keyed by ownerSlugKey so (owner, slug) duplicates never collide. */
export function catalogByOwnerSlug(entries: CatalogEntry[]): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  for (const e of entries) {
    map.set(ownerSlugKey(e.owner, e.slug), e);
  }
  return map;
}
