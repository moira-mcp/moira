#!/usr/bin/env node
/**
 * Workflow Migration Script for Docker
 * Loads the owner-aware workflow catalog into the database during container startup.
 *
 * Catalog: <baseDir>/flows/<uuid>.json — each file carries its own `owner` and `visibility` (catalog
 * metadata). The flow is installed under its mapped owner with that visibility. Catalog identity is
 * (owner, slug): the same slug may exist under different owners.
 *
 * The base directories come from `getWorkflowsDirs()` (env `WORKFLOWS_DIRS`, colon-separated; falls
 * back to `WORKFLOWS_DIR`, then to `./workflows/production`). Multiple directories are merged and
 * de-duplicated by (owner, slug) with a later directory overriding an earlier one — so a production
 * build can combine a public bundled folder with a private operator folder. Unset → single default.
 *
 * THREE-WAY: compares the last bundled baseline, current database state, and incoming catalog.
 * User-only changes survive; upstream-only changes apply; two-sided changes become durable
 * reconciliation errors. SaaS fails; self-host remains operable for WMF recovery.
 * MISSING OWNER: when a flow's mapped owner does not exist on the target, the flow is SKIPPED and
 *   reported — it is never silently reassigned to a system owner.
 *
 * The install logic lives in @mcp-moira/shared (installCatalogEntries) so it is unit/integration
 * testable; this script is the thin Docker CLI wrapper.
 *
 * Usage:
 *   npx tsx scripts/migrate-workflows-in-docker.ts
 *   npx tsx scripts/migrate-workflows-in-docker.ts --force
 *   npx tsx scripts/migrate-workflows-in-docker.ts --resolve owner/slug:current --revision <sha256> --rationale "..."
 */

import {
  getDatabase,
  getSqliteInstance,
  UserRepository,
  getWorkflowMutationService,
  initializeWorkflowValidationCache,
  readWorkflowCatalogs,
  getWorkflowsDirs,
  installCatalogEntries,
  CatalogReconciliationError,
  CatalogPreflightError,
  resolveWorkflowReconciliation,
  isSaas,
  formatWorkflowReconciliationNotice,
  publishWorkflowReconciliationBundle,
  WorkflowReconciliationRepository,
  getDbPath,
} from "@mcp-moira/shared";
import fs from "node:fs";
import path from "node:path";

const forceUpdate = process.argv.includes("--force");
const resolveIndex = process.argv.indexOf("--resolve");
const revisionIndex = process.argv.indexOf("--revision");
const rationaleIndex = process.argv.indexOf("--rationale");

function buildIdentity(): string {
  for (const candidate of ["/app/BUILD_INFO", path.resolve("BUILD_INFO")]) {
    if (!fs.existsSync(candidate)) continue;
    const commit = /^commit:\s*(.+)$/m.exec(fs.readFileSync(candidate, "utf8"))?.[1]?.trim();
    if (commit) return commit;
  }
  return "development-local";
}

async function migrate(): Promise<void> {
  console.log("Loading workflow catalog into database...");
  console.log(
    forceUpdate
      ? "⚠️  Force mode: will overwrite existing workflows"
      : "📋 Three-way mode: preserves user-only changes and records conflicts",
  );

  const db = getDatabase();
  const userRepo = new UserRepository(db);
  const mutationService = getWorkflowMutationService();
  const sqlite = getSqliteInstance();

  if (resolveIndex !== -1) {
    const raw = process.argv[resolveIndex + 1];
    const split = raw?.lastIndexOf(":") ?? -1;
    if (!raw || split <= 0) {
      throw new Error("--resolve requires owner/slug:current|incoming|previous");
    }
    const reference = raw.slice(0, split);
    const selection = raw.slice(split + 1);
    if (selection !== "current" && selection !== "incoming" && selection !== "previous") {
      throw new Error("--resolve selection must be current, incoming, or previous");
    }
    const revision = revisionIndex === -1 ? undefined : process.argv[revisionIndex + 1];
    const rationale = rationaleIndex === -1 ? undefined : process.argv[rationaleIndex + 1];
    if (!revision || !rationale) {
      throw new Error("--resolve requires --revision <sha256> and --rationale <text>");
    }
    await resolveWorkflowReconciliation(
      reference,
      selection,
      { sqlite, mutationService },
      undefined,
      { expectedRevision: revision, rationale, source: "cli" },
    );
    console.log(`Resolved bundled workflow reconciliation for ${reference} using ${selection}`);
    return;
  }

  const dirs = getWorkflowsDirs();
  const entries = readWorkflowCatalogs(dirs);
  console.log(
    `\nCatalog: ${entries.length} flows from ${dirs.length} director${dirs.length === 1 ? "y" : "ies"} (${dirs.join(", ")})`,
  );

  let result;
  try {
    result = await installCatalogEntries(entries, {
      userRepo,
      mutationService,
      sqlite,
      force: forceUpdate,
      fatalConflicts: isSaas(),
      log: (msg) => console.log(msg),
    });
  } catch (error) {
    if (error instanceof CatalogPreflightError) {
      console.error(`\n❌ FATAL: ${error.message}`);
      for (const outcome of error.result.outcomes.filter((item) =>
        item.outcome.startsWith("invalid"),
      )) {
        console.error(`   ${outcome.owner}/${outcome.slug}: ${outcome.outcome}`);
      }
      process.exit(1);
    }
    if (error instanceof CatalogReconciliationError) {
      if (!isSaas()) {
        publishWorkflowReconciliationBundle(
          path.join(path.dirname(path.resolve(getDbPath())), ".moira-reconciliation"),
          buildIdentity(),
          entries,
          new WorkflowReconciliationRepository(sqlite).listConflicts(),
        );
      }
      const notice = formatWorkflowReconciliationNotice(sqlite);
      console.error(
        `\n❌ FATAL: ${error.message}\n` +
          `   Inspect the previous/current/incoming candidates and resolve the semantic merge.\n` +
          `   --force discards local changes and must only be used deliberately.\n` +
          (notice ? `\n${notice}\n` : ""),
      );
      process.exit(1);
    }
    throw error;
  }

  console.log("\n" + "=".repeat(50));
  console.log(`✅ Installed: ${result.installed} | Updated: ${result.updated}`);
  if (result.removed > 0) console.log(`🗑️  Removed:   ${result.removed}`);
  if (result.adopted > 0) console.log(`✅ Adopted:   ${result.adopted}`);
  if (result.preserved > 0) console.log(`🛡️  Preserved: ${result.preserved} user changes`);
  if (result.conflicts > 0)
    console.error(
      `❌ Reconciliation required: ${result.conflicts} (self-host remains operable but degraded)`,
    );
  if (result.conflicts > 0) {
    if (!isSaas()) {
      publishWorkflowReconciliationBundle(
        path.join(path.dirname(path.resolve(getDbPath())), ".moira-reconciliation"),
        buildIdentity(),
        entries,
        new WorkflowReconciliationRepository(sqlite).listConflicts(),
      );
    }
    console.error(formatWorkflowReconciliationNotice(sqlite));
  }
  if (result.skipped > 0) console.log(`⏭️  Skipped:  ${result.skipped} (exists/older/unchanged)`);
  if (result.skippedMissingOwner > 0)
    console.log(`⏭️  Skipped:  ${result.skippedMissingOwner} (owner missing on target)`);
  console.log("=".repeat(50));

  console.log("\n🔍 Running validation cache migration...");
  await initializeWorkflowValidationCache();
  console.log("✅ Validation cache migration complete");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
