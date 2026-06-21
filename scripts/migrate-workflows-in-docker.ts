#!/usr/bin/env node
/**
 * Workflow Migration Script for Docker
 * Loads the owner-aware workflow catalog into the database during Docker build.
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
 * IDEMPOTENT: does NOT overwrite an existing flow unless its local version is newer (semver), and
 *   FAILS on a same-version content mismatch. Use --force to overwrite all.
 * NON-DESTRUCTIVE: only touches flows it owns; never clobbers other owners' flows.
 * MISSING OWNER: when a flow's mapped owner does not exist on the target, the flow is SKIPPED and
 *   reported — it is never silently reassigned to a system owner.
 *
 * The install logic lives in @mcp-moira/shared (installCatalogEntries) so it is unit/integration
 * testable; this script is the thin Docker CLI wrapper.
 *
 * Usage:
 *   npx tsx scripts/migrate-workflows-in-docker.ts           # version-aware, fail on content mismatch
 *   npx tsx scripts/migrate-workflows-in-docker.ts --force   # overwrite all
 */

import {
  getDatabase,
  WorkflowRepository,
  UserRepository,
  getWorkflowMutationService,
  initializeWorkflowValidationCache,
  readWorkflowCatalogs,
  getWorkflowsDirs,
  installCatalogEntries,
  CatalogContentMismatchError,
} from "@mcp-moira/shared";

const forceUpdate = process.argv.includes("--force");

async function migrate(): Promise<void> {
  console.log("Loading workflow catalog into database...");
  console.log(
    forceUpdate
      ? "⚠️  Force mode: will overwrite existing workflows"
      : "📋 Idempotent mode: version-aware (fails on content mismatch)",
  );

  const db = getDatabase();
  const workflowRepo = new WorkflowRepository(db);
  const userRepo = new UserRepository(db);
  const mutationService = getWorkflowMutationService();

  const dirs = getWorkflowsDirs();
  const entries = readWorkflowCatalogs(dirs);
  console.log(
    `\nCatalog: ${entries.length} flows from ${dirs.length} director${dirs.length === 1 ? "y" : "ies"} (${dirs.join(", ")})`,
  );

  let result;
  try {
    result = await installCatalogEntries(entries, {
      workflowRepo,
      userRepo,
      mutationService,
      force: forceUpdate,
      log: (msg) => console.log(msg),
    });
  } catch (error) {
    if (error instanceof CatalogContentMismatchError) {
      console.error(
        `\n❌ FATAL: ${error.message}\n` +
          `   Either the metadata version was updated without syncing all node changes, or the\n` +
          `   file changed without bumping the version. Investigate, or use --force to override.\n`,
      );
      process.exit(1);
    }
    throw error;
  }

  console.log("\n" + "=".repeat(50));
  console.log(`✅ Installed: ${result.installed} | Updated: ${result.updated}`);
  if (result.skipped > 0) console.log(`⏭️  Skipped:  ${result.skipped} (exists/older/unchanged)`);
  if (result.skippedMissingOwner > 0)
    console.log(`⏭️  Skipped:  ${result.skippedMissingOwner} (owner missing on target)`);
  if (result.invalid > 0) console.log(`❌ Invalid:  ${result.invalid} (bad version)`);
  console.log("=".repeat(50));

  console.log("\n🔍 Running validation cache migration...");
  await initializeWorkflowValidationCache();
  console.log("✅ Validation cache migration complete");

  if (result.invalid > 0) {
    console.error("\n❌ Migration completed with invalid flows");
    process.exit(1);
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
