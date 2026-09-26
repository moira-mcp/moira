/**
 * Bundled playbook catalog: playbooks that ship with Moira, installed and upgraded by version.
 *
 * A playbook file lives next to the flow catalog, in `<workflows dir>/playbooks/<id>.json`, and
 * carries its owner, machine name, human name, description, visibility, version and content. Its
 * identity is (owner, slug), the same identity a workflow node's reference resolves by.
 *
 * Installation follows the bundled flows' three-way rule with the shared reconciler: the last
 * upstream state (the baseline), the stored playbook and the incoming file are compared, so an
 * upstream change applies, a local edit survives, and a change on both sides is never overwritten.
 * Unlike a flow, a playbook conflict does not block startup: a playbook is prose a node quotes, not
 * the route a run executes, so the local text is kept, the baseline stays where it is, and the
 * conflict is reported on every start until the two sides converge.
 *
 * Versions follow the flows' rules: a file carries a semantic version, a catalog older than the one
 * last installed here is skipped rather than rolled back, and new content under an unchanged version
 * is kept out and reported. A playbook dropped from the catalog is left in place, unlike a dropped
 * flow: flows and copies of flows may still name it, and removing it would make them unsavable and
 * unstartable for everyone.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { managedPlaybookBaseline, user } from "../database/schema.js";
import type * as schema from "../database/schema.js";
import {
  MAX_PLAYBOOK_SIZE,
  PlaybookRepository,
  type PlaybookVisibility,
} from "../database/repositories/playbook-repository.js";
import {
  managedStateEquals,
  reconcileManagedResource,
  type ManagedResourceState,
  type ReconciliationClassification,
  type ReconciliationDecision,
} from "./managed-resource-reconciler.js";
import { PLAYBOOK_SLUG_PATTERN } from "./playbook-service.js";
import { ownerSlugKey } from "./workflow-catalog.js";
import { compareSemver, isValidSemver } from "../utils/version-utils.js";

/** What a bundled playbook is, apart from its identity: everything the reconciliation compares. */
export interface ManagedPlaybookContent {
  name: string;
  description: string | null;
  visibility: PlaybookVisibility;
  content: string;
}

export interface PlaybookCatalogEntry extends ManagedPlaybookContent {
  owner: string;
  slug: string;
  version: string;
  filePath: string;
}

function catalogDir(baseDir: string): string {
  return path.resolve(baseDir, "playbooks");
}

/** Read one playbook file. A malformed file fails loudly rather than installing something else. */
export function readPlaybookCatalogEntry(filePath: string): PlaybookCatalogEntry {
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new Error(`Playbook catalog file ${filePath} ${what}`);
  };
  const text = (key: string): string => {
    const value = raw[key];
    return typeof value === "string" && value.length > 0
      ? value
      : fail(`is missing a non-empty '${key}' field`);
  };

  const owner = text("owner");
  const slug = text("slug");
  const version = text("version");
  const name = text("name");
  const content = text("content");
  // The playbook service's own rule, so a bundled playbook is always referenceable and savable.
  if (!PLAYBOOK_SLUG_PATTERN.test(slug)) fail(`has an invalid 'slug' '${slug}'`);
  if (!isValidSemver(version)) fail(`has an invalid 'version' '${version}' (expected semver)`);
  if (raw.visibility !== "public" && raw.visibility !== "private") {
    fail(`has invalid 'visibility' (expected "public" | "private")`);
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    fail("has a non-string 'description'");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_PLAYBOOK_SIZE) {
    fail(`holds more than ${MAX_PLAYBOOK_SIZE} bytes of content`);
  }

  return {
    owner,
    slug,
    version,
    name,
    description: (raw.description as string | undefined) ?? null,
    visibility: raw.visibility as PlaybookVisibility,
    content,
    filePath,
  };
}

/**
 * Every bundled playbook across the catalog directories. A later directory overrides an earlier
 * one on the same (owner, slug), as for flows; a missing directory contributes nothing.
 */
export function readPlaybookCatalogs(baseDirs: string[]): PlaybookCatalogEntry[] {
  const merged = new Map<string, PlaybookCatalogEntry>();
  for (const baseDir of baseDirs) {
    const dir = catalogDir(baseDir);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()) {
      const entry = readPlaybookCatalogEntry(path.join(dir, file));
      merged.set(ownerSlugKey(entry.owner, entry.slug), entry);
    }
  }
  return [...merged.values()];
}

export interface PlaybookInstallOutcome {
  owner: string;
  slug: string;
  classification: ReconciliationClassification | "skipped-missing-owner" | "skipped-older";
}

export interface PlaybookCatalogInstallResult {
  outcomes: PlaybookInstallOutcome[];
  /** Playbooks kept at their local text because both sides changed; reported, never overwritten. */
  conflicts: Array<{ owner: string; slug: string }>;
}

function contentOf(entry: ManagedPlaybookContent): ManagedPlaybookContent {
  return {
    name: entry.name,
    description: entry.description,
    visibility: entry.visibility,
    content: entry.content,
  };
}

/**
 * Install or upgrade the bundled playbooks.
 *
 * Each playbook is decided on its own from its baseline, its stored state and the file. Only an
 * `incoming` selection writes the playbook, as a new revision, so the history shows every
 * upgrade; the baseline advances exactly when the reconciler says so.
 */
export async function installPlaybookCatalog(
  entries: PlaybookCatalogEntry[],
  db: BetterSQLite3Database<typeof schema>,
  log: (message: string) => void = () => {},
): Promise<PlaybookCatalogInstallResult> {
  const playbooks = new PlaybookRepository(db);
  const result: PlaybookCatalogInstallResult = { outcomes: [], conflicts: [] };

  for (const entry of entries) {
    const [owner] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, entry.owner))
      .limit(1);
    if (!owner) {
      log(`⏭️  Playbook ${entry.owner}/${entry.slug}: owner missing on this instance, skipped`);
      result.outcomes.push({
        owner: entry.owner,
        slug: entry.slug,
        classification: "skipped-missing-owner",
      });
      continue;
    }

    const [baselineRow] = await db
      .select()
      .from(managedPlaybookBaseline)
      .where(
        and(
          eq(managedPlaybookBaseline.ownerId, entry.owner),
          eq(managedPlaybookBaseline.slug, entry.slug),
        ),
      )
      .limit(1);
    const previous = baselineRow
      ? (JSON.parse(baselineRow.state) as ManagedResourceState<ManagedPlaybookContent>)
      : null;

    const stored = await playbooks.get(entry.owner, entry.slug);
    const current: ManagedResourceState<ManagedPlaybookContent> = stored
      ? { lifecycle: "present", content: contentOf(stored) }
      : { lifecycle: "absent" };
    const incoming: ManagedResourceState<ManagedPlaybookContent> = {
      lifecycle: "present",
      content: contentOf(entry),
    };

    // The flows' version rules: a catalog older than the one last installed here never rolls a
    // playbook back, and new content under an unchanged version is a packaging mistake, kept out
    // and reported like a conflict rather than installed.
    const previousVersion = baselineRow?.sourceVersion ?? null;
    if (previousVersion && compareSemver(entry.version, previousVersion) < 0) {
      log(
        `⏭️  Playbook ${entry.owner}/${entry.slug}: catalog version ${entry.version} is older than the installed ${previousVersion}, skipped`,
      );
      result.outcomes.push({
        owner: entry.owner,
        slug: entry.slug,
        classification: "skipped-older",
      });
      continue;
    }
    const sameVersionChanged =
      previous !== null &&
      previousVersion === entry.version &&
      !managedStateEquals(previous, incoming);
    const decision: ReconciliationDecision<ManagedPlaybookContent> = sameVersionChanged
      ? {
          classification: "conflict",
          previous,
          current,
          incoming,
          selected: null,
          advanceBaseline: false,
          unresolved: true,
        }
      : reconcileManagedResource(previous, current, incoming);

    if (decision.selected === "incoming") {
      await playbooks.save({
        ownerId: entry.owner,
        slug: entry.slug,
        name: entry.name,
        description: entry.description,
        visibility: entry.visibility,
        content: entry.content,
        authorId: entry.owner,
      });
    }
    if (decision.advanceBaseline) {
      const now = new Date();
      await db
        .insert(managedPlaybookBaseline)
        .values({
          ownerId: entry.owner,
          slug: entry.slug,
          state: JSON.stringify(incoming),
          sourceVersion: entry.version,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [managedPlaybookBaseline.ownerId, managedPlaybookBaseline.slug],
          set: { state: JSON.stringify(incoming), sourceVersion: entry.version, updatedAt: now },
        });
    }
    if (decision.unresolved) {
      result.conflicts.push({ owner: entry.owner, slug: entry.slug });
      const reason = sameVersionChanged
        ? `the catalog changed its content without raising its version ${entry.version}`
        : decision.classification === "baseline-missing"
          ? "a playbook with this name already exists here and differs from the bundled one"
          : `it was changed both here and upstream (${entry.version})`;
      log(
        `⚠️  Playbook ${entry.owner}/${entry.slug}: ${reason}; the stored text is kept and this is reported on every start until the two match.`,
      );
    }
    result.outcomes.push({
      owner: entry.owner,
      slug: entry.slug,
      classification: decision.classification,
    });
  }

  return result;
}
