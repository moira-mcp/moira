/**
 * Workflow Catalog Loader
 *
 * Installs catalog flows into the database under their declared owner + visibility. Pure logic with
 * injectable dependencies so it is testable in isolation (the Docker CLI wrapper in
 * scripts/migrate-workflows-in-docker.ts supplies the real repositories/services).
 *
 * Guarantees:
 *  - Owner-aware: each flow is installed under its catalog `owner` with its `visibility`.
 *  - Missing owner: a flow whose owner does not exist on the target is SKIPPED and reported — never
 *    reassigned to a system owner.
 *  - Version-aware idempotent: an existing flow is skipped when the local version ≤ server version;
 *    a same-version content mismatch throws CatalogContentMismatchError (unless force).
 *  - Non-destructive: only the (owner, slug) flow is touched; other owners' flows are never affected.
 */

import type { CatalogEntry } from "./workflow-catalog.js";
import { compareSemver, isValidSemver, hasWorkflowContentChanged } from "../utils/version-utils.js";

/** Thrown when an existing flow has the same version but different content (and force is off). */
export class CatalogContentMismatchError extends Error {
  constructor(
    public readonly owner: string,
    public readonly slug: string,
    public readonly version: string,
  ) {
    super(
      `${owner}/${slug} has the same version ${version} but different content. ` +
        `Bump the version or load with force=true.`,
    );
    this.name = "CatalogContentMismatchError";
  }
}

/** Per-flow outcome, used for reporting and tests. */
export type EntryOutcome =
  | "installed"
  | "updated"
  | "skipped-unchanged"
  | "skipped-older"
  | "skipped-exists"
  | "skipped-missing-owner"
  | "invalid-version";

export interface CatalogLoadResult {
  installed: number;
  updated: number;
  skipped: number;
  skippedMissingOwner: number;
  invalid: number;
  /** Per-entry outcomes keyed by `${owner}/${slug}` for assertions and reporting. */
  outcomes: Array<{ owner: string; slug: string; outcome: EntryOutcome }>;
}

/** Minimal repository surface the loader needs (satisfied by WorkflowRepository). */
export interface CatalogWorkflowRepo {
  resolveSlug(slug: string, ownerUserId: string): Promise<string | null>;
  get(
    workflowId: string,
    userId: string,
  ): Promise<{ metadata?: { version?: string } } | null | undefined>;
}

/** Minimal user-existence surface the loader needs (satisfied by UserRepository.getProfile). */
export interface CatalogUserRepo {
  getProfile(userId: string): Promise<unknown | null>;
}

/** Minimal save surface the loader needs (satisfied by WorkflowMutationService). */
export interface CatalogMutationService {
  save(options: {
    graph: Record<string, unknown>;
    userId: string;
    slug: string;
    visibility: "public" | "private";
    skipAudit?: boolean;
  }): Promise<unknown>;
}

export interface CatalogLoadDeps {
  workflowRepo: CatalogWorkflowRepo;
  userRepo: CatalogUserRepo;
  mutationService: CatalogMutationService;
  force?: boolean;
  /** Optional progress sink (defaults to no-op so tests are quiet). */
  log?: (message: string) => void;
}

function emptyResult(): CatalogLoadResult {
  return { installed: 0, updated: 0, skipped: 0, skippedMissingOwner: 0, invalid: 0, outcomes: [] };
}

/**
 * Install a single catalog entry. Returns the outcome; throws CatalogContentMismatchError on a
 * same-version content mismatch (unless force). The graph saved excludes nothing extra — the entry's
 * graph body is already free of the catalog metadata (owner/visibility) by readCatalogEntry.
 */
export async function installCatalogEntry(
  entry: CatalogEntry,
  deps: CatalogLoadDeps,
): Promise<EntryOutcome> {
  const { workflowRepo, userRepo, mutationService, force = false } = deps;
  const log = deps.log ?? (() => {});
  const { slug, owner, visibility } = entry;
  const graph = entry.graph as Record<string, unknown> & { metadata?: { version?: string } };
  const localVersion = graph.metadata?.version;

  // Missing owner → skip and report; never reassign to a system owner.
  if ((await userRepo.getProfile(owner)) === null) {
    log(`  ⏭️  ${owner}/${slug} (owner missing on target — skipped)`);
    return "skipped-missing-owner";
  }

  if (localVersion && !isValidSemver(localVersion)) {
    log(`  ❌ ${owner}/${slug}: invalid semver version "${localVersion}"`);
    return "invalid-version";
  }

  const existingWorkflowId = await workflowRepo.resolveSlug(slug, owner);
  const workflowExists = !!existingWorkflowId;

  if (workflowExists && !force) {
    const existing = await workflowRepo.get(existingWorkflowId, owner);
    const serverVersion = existing?.metadata?.version;

    if (localVersion && serverVersion && isValidSemver(serverVersion)) {
      const cmp = compareSemver(localVersion, serverVersion);
      if (cmp < 0) {
        log(`  ⏭️  ${owner}/${slug} (local ${localVersion} < server ${serverVersion})`);
        return "skipped-older";
      }
      if (cmp === 0) {
        if (hasWorkflowContentChanged(existing as Record<string, unknown>, graph)) {
          throw new CatalogContentMismatchError(owner, slug, localVersion);
        }
        log(`  ⏭️  ${owner}/${slug} (v${localVersion}, unchanged)`);
        return "skipped-unchanged";
      }
      log(`  📤 ${owner}/${slug} (${serverVersion} → ${localVersion})`);
    } else {
      log(`  ⏭️  ${owner}/${slug} (exists, skipped)`);
      return "skipped-exists";
    }
  }

  // New flow → no id so the server generates one; existing → set id for update.
  const graphForSave: Record<string, unknown> = { ...graph };
  if (!workflowExists) {
    delete graphForSave.id;
  } else {
    graphForSave.id = existingWorkflowId;
  }

  await mutationService.save({
    graph: graphForSave,
    userId: owner,
    slug,
    visibility,
    skipAudit: true,
  });

  if (workflowExists) {
    log(`  🔄 ${owner}/${slug} (updated)`);
    return "updated";
  }
  log(`  ✓ ${owner}/${slug} (${visibility})`);
  return "installed";
}

/** Install every catalog entry, accumulating outcomes. Caches owner existence across entries. */
export async function installCatalogEntries(
  entries: CatalogEntry[],
  deps: CatalogLoadDeps,
): Promise<CatalogLoadResult> {
  const result = emptyResult();

  // Cache owner existence so the system owners are resolved once, not per flow.
  const ownerExists = new Map<string, boolean>();
  const cachingUserRepo: CatalogUserRepo = {
    async getProfile(userId: string) {
      let exists = ownerExists.get(userId);
      if (exists === undefined) {
        exists = (await deps.userRepo.getProfile(userId)) !== null;
        ownerExists.set(userId, exists);
      }
      // installCatalogEntry only checks getProfile() === null, so return a sentinel object/null.
      return exists ? {} : null;
    },
  };
  const entryDeps: CatalogLoadDeps = { ...deps, userRepo: cachingUserRepo };

  for (const entry of entries) {
    const outcome = await installCatalogEntry(entry, entryDeps);
    result.outcomes.push({ owner: entry.owner, slug: entry.slug, outcome });
    switch (outcome) {
      case "installed":
        result.installed++;
        break;
      case "updated":
        result.updated++;
        break;
      case "invalid-version":
        result.invalid++;
        break;
      case "skipped-missing-owner":
        result.skippedMissingOwner++;
        break;
      default:
        result.skipped++;
    }
  }

  return result;
}
