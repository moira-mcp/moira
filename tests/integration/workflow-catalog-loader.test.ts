/**
 * Workflow Catalog Loader Integration Tests (Step 13)
 *
 * Drives installCatalogEntries against the real database + repositories with a fixture catalog,
 * verifying the deploy/migration loader contract:
 *  - installs each flow under its mapped owner + visibility (owner-mapping);
 *  - idempotent: a re-run installs nothing new (skipped-unchanged);
 *  - missing owner → skipped and reported, never reassigned to a system owner;
 *  - version-aware: newer local version updates; older is skipped; same-version content mismatch throws;
 *  - non-destructive: a flow owned by user A is not affected when loading user B's flow.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";
import { manageReconciliation } from "../../packages/mcp-server/src/tools/manage-reconciliation.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import express from "express";
import request from "supertest";
import { healthRoutes } from "../../packages/web-backend/src/routes/health.js";
import {
  getDatabase,
  user,
  WorkflowRepository,
  UserRepository,
  getWorkflowMutationService,
  installCatalogEntries,
  installCatalogEntry,
  readWorkflowCatalog,
  readWorkflowCatalogs,
  getWorkflowsDirs,
  getSqliteInstance,
  getWorkflowReconciliationStatus,
  getWorkflowReconciliationStatusSummary,
  resolveWorkflowReconciliation,
  createWorkflowReconciliationStagedArtifact,
  applyWorkflowReconciliationStagedArtifact,
  managedWorkflowStateDigest,
  WorkflowReconciliationRepository,
  workflowReconciliationStagedArtifactDigest,
  type CatalogEntry,
} from "@mcp-moira/shared";

const OWNER_A = "catalog-loader-owner-a";
const OWNER_B = "catalog-loader-owner-b";
const MISSING_OWNER = "catalog-loader-ghost-owner";

function entry(
  owner: string,
  slug: string,
  version: string,
  visibility: "public" | "private" = "public",
  extraNodeDirective = "Do the work",
  previousSlugs?: string[],
): CatalogEntry {
  return {
    id: `${owner}-${slug}`,
    slug,
    previousSlugs,
    owner,
    visibility,
    isSystemOwner: false,
    filePath: `memory://${owner}/${slug}.json`,
    graph: {
      metadata: { name: slug, version, description: "fixture" },
      nodes: [
        { id: "start", type: "start", connections: { default: "step" } },
        {
          id: "step",
          type: "agent-directive",
          directive: extraNodeDirective,
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    },
  };
}

function inspectedResolution(owner: string, slug: string) {
  const conflict = new WorkflowReconciliationRepository(getSqliteInstance()).findConflict(
    owner,
    slug,
  );
  if (!conflict) throw new Error(`Missing reconciliation conflict for ${owner}/${slug}`);
  return { revision: conflict.revision, rationale: "Test decision from inspected candidates." };
}

describe("Workflow Catalog Loader Integration", () => {
  let deps: {
    workflowRepo: WorkflowRepository;
    userRepo: UserRepository;
    mutationService: ReturnType<typeof getWorkflowMutationService>;
  };

  beforeAll(async () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    for (const id of [OWNER_A, OWNER_B]) {
      try {
        await db.insert(user).values({
          id,
          email: `${id}@test.com`,
          name: id,
          handle: id,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        });
      } catch {
        // already exists
      }
    }
    deps = {
      workflowRepo: new WorkflowRepository(db),
      userRepo: new UserRepository(db),
      mutationService: getWorkflowMutationService(),
    };
  });

  beforeEach(() => {
    const sqlite = getSqliteInstance();
    sqlite
      .prepare("DELETE FROM workflowReconciliationConflict WHERE ownerId IN (?, ?)")
      .run(OWNER_A, OWNER_B);
    sqlite
      .prepare("DELETE FROM managedWorkflowBaseline WHERE ownerId IN (?, ?)")
      .run(OWNER_A, OWNER_B);
    sqlite
      .prepare("DELETE FROM workflowReconciliationResolution WHERE ownerId IN (?, ?)")
      .run(OWNER_A, OWNER_B);
    sqlite.prepare("DELETE FROM workflow WHERE userId IN (?, ?)").run(OWNER_A, OWNER_B);
  });

  test("installs each flow under its mapped owner and visibility", async () => {
    const slugA = `loader-map-a-${Date.now()}`;
    const slugB = `loader-map-b-${Date.now()}`;
    const result = await installCatalogEntries(
      [entry(OWNER_A, slugA, "1.0.0", "public"), entry(OWNER_B, slugB, "1.0.0", "private")],
      deps,
    );

    expect(result.installed).toBe(2);
    expect(result.skipped).toBe(0);

    // Each flow resolvable ONLY under its own owner.
    expect(await deps.workflowRepo.resolveSlug(slugA, OWNER_A)).toBeTruthy();
    expect(await deps.workflowRepo.resolveSlug(slugA, OWNER_B)).toBeNull();
    expect(await deps.workflowRepo.resolveSlug(slugB, OWNER_B)).toBeTruthy();
    expect(await deps.workflowRepo.resolveSlug(slugB, OWNER_A)).toBeNull();
  });

  test("is idempotent: re-running installs nothing new", async () => {
    const slug = `loader-idem-${Date.now()}`;
    const entries = [entry(OWNER_A, slug, "1.0.0")];

    const first = await installCatalogEntries(entries, deps);
    expect(first.installed).toBe(1);

    const second = await installCatalogEntries(entries, deps);
    expect(second.installed).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.outcomes[0].outcome).toBe("skipped-unchanged");
  });

  test("treats legacy root catalog metadata in a persisted graph as unchanged", async () => {
    const slug = `loader-legacy-metadata-${Date.now()}`;
    const catalogEntry = entry(OWNER_A, slug, "1.0.0");

    await deps.mutationService.save({
      graph: {
        ...catalogEntry.graph,
        slug,
        owner: OWNER_A,
        visibility: "public",
      },
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    const result = await installCatalogEntries([catalogEntry], deps);
    expect(result.installed).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.adopted).toBe(1);
    expect(result.outcomes[0].outcome).toBe("adopted");
  });

  test("skips and reports a flow whose owner does not exist, never reassigning to a system owner", async () => {
    const slug = `loader-missing-owner-${Date.now()}`;
    const result = await installCatalogEntries([entry(MISSING_OWNER, slug, "1.0.0")], deps);

    expect(result.skippedMissingOwner).toBe(1);
    expect(result.installed).toBe(0);
    expect(result.outcomes[0].outcome).toBe("skipped-missing-owner");

    // Not installed under the missing owner, and NOT reassigned to a system owner.
    expect(await deps.workflowRepo.resolveSlug(slug, MISSING_OWNER)).toBeNull();
    expect(await deps.workflowRepo.resolveSlug(slug, "system-admin")).toBeNull();
    expect(await deps.workflowRepo.resolveSlug(slug, "system-moira")).toBeNull();
  });

  test("updates an existing flow when the local version is newer", async () => {
    const slug = `loader-version-${Date.now()}`;
    await installCatalogEntries([entry(OWNER_A, slug, "1.0.0")], deps);

    const result = await installCatalogEntries([entry(OWNER_A, slug, "1.1.0")], deps);
    expect(result.updated).toBe(1);
    expect(result.outcomes[0].outcome).toBe("updated");

    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const updated = await deps.workflowRepo.get(id!, OWNER_A);
    expect(updated?.metadata?.version).toBe("1.1.0");
  });

  test("preserves a user-only visibility change and applies upstream visibility", async () => {
    const stamp = Date.now();
    const userSlug = `loader-user-visibility-${stamp}`;
    const upstreamSlug = `loader-upstream-visibility-${stamp}`;
    await installCatalogEntries(
      [
        entry(OWNER_A, userSlug, "1.0.0", "public"),
        entry(OWNER_A, upstreamSlug, "1.0.0", "public"),
      ],
      deps,
    );

    getSqliteInstance()
      .prepare("UPDATE workflow SET visibility = 'private' WHERE userId = ? AND slug = ?")
      .run(OWNER_A, userSlug);
    const result = await installCatalogEntries(
      [
        entry(OWNER_A, userSlug, "1.0.0", "public"),
        entry(OWNER_A, upstreamSlug, "2.0.0", "private"),
      ],
      deps,
    );

    expect(result.outcomes.find((item) => item.slug === userSlug)).toMatchObject({
      outcome: "preserved-user-change",
      classification: "user-only",
    });
    expect(result.outcomes.find((item) => item.slug === upstreamSlug)).toMatchObject({
      outcome: "updated",
      classification: "upstream-only",
    });
    const rows = getSqliteInstance()
      .prepare("SELECT slug, visibility FROM workflow WHERE userId = ? AND slug IN (?, ?)")
      .all(OWNER_A, userSlug, upstreamSlug) as Array<{ slug: string; visibility: string }>;
    expect(Object.fromEntries(rows.map((row) => [row.slug, row.visibility]))).toEqual({
      [userSlug]: "private",
      [upstreamSlug]: "private",
    });
  });

  test("skips an older local version", async () => {
    const slug = `loader-older-${Date.now()}`;
    await installCatalogEntries([entry(OWNER_A, slug, "2.0.0")], deps);

    const result = await installCatalogEntries([entry(OWNER_A, slug, "1.0.0")], deps);
    expect(result.skipped).toBe(1);
    expect(result.outcomes[0].outcome).toBe("skipped-older");

    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const stored = await deps.workflowRepo.get(id!, OWNER_A);
    expect(stored?.metadata?.version).toBe("2.0.0");
  });

  test("records a same-version upstream content mismatch without mutating the workflow", async () => {
    const slug = `loader-mismatch-${Date.now()}`;
    await installCatalogEntries(
      [entry(OWNER_A, slug, "1.0.0", "public", "Original directive")],
      deps,
    );

    const result = await installCatalogEntries(
      [entry(OWNER_A, slug, "1.0.0", "public", "CHANGED directive")],
      deps,
    );
    expect(result.conflicts).toBe(1);
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const stored = await deps.workflowRepo.get(id!, OWNER_A);
    expect(stored?.nodes[1]).toMatchObject({ directive: "Original directive" });
    expect(getWorkflowReconciliationStatus(getSqliteInstance()).status).toBe("error");
  });

  test("non-destructive: loading one owner's flow does not affect another owner's same-slug flow", async () => {
    const slug = `loader-shared-slug-${Date.now()}`;
    const entryA = entry(OWNER_A, slug, "1.0.0", "public", "A's flow");
    const entryB = entry(OWNER_B, slug, "1.0.0", "private", "B's flow");
    await installCatalogEntries([entryA, entryB], deps);

    // Both exist independently under their own owners.
    const idA = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const idB = await deps.workflowRepo.resolveSlug(slug, OWNER_B);
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);

    // Re-loading A unchanged leaves B untouched.
    const rerun = await installCatalogEntries([entryA, entryB], deps);
    expect(rerun.outcomes[0].outcome).toBe("skipped-unchanged");
    expect(await deps.workflowRepo.resolveSlug(slug, OWNER_B)).toBe(idB);
  });

  test("single-entry compatibility API does not interpret omitted baselines as removals", async () => {
    const stamp = Date.now();
    const first = entry(OWNER_A, `loader-single-first-${stamp}`, "1.0.0");
    const second = entry(OWNER_A, `loader-single-second-${stamp}`, "1.0.0");
    await installCatalogEntries([first, second], deps);

    expect(await installCatalogEntry(first, deps)).toBe("skipped-unchanged");
    expect(await deps.workflowRepo.resolveSlug(second.slug, OWNER_A)).toBeTruthy();
  });

  test("does not restore a user-deleted flow when upstream also changed", async () => {
    const slug = `loader-softdeleted-${Date.now()}`;

    // Install, then soft-delete it — simulating a prod row that was previously soft-deleted while
    // its (owner, slug) slot stays occupied by the unique index.
    await installCatalogEntries([entry(OWNER_A, slug, "1.0.0")], deps);
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    expect(id).toBeTruthy();
    await deps.workflowRepo.softDelete(id!, OWNER_A);
    expect(await deps.workflowRepo.resolveSlug(slug, OWNER_A)).toBeNull(); // hidden, but slot taken

    const result = await installCatalogEntries([entry(OWNER_A, slug, "1.1.0")], deps);
    expect(result.conflicts).toBe(1);
    expect(await deps.workflowRepo.resolveSlug(slug, OWNER_A)).toBeNull();
  });

  test("preserves a user soft-delete when the bundled version is unchanged", async () => {
    const slug = `loader-softdeleted-same-${Date.now()}`;

    await installCatalogEntries([entry(OWNER_A, slug, "1.0.0")], deps);
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    await deps.workflowRepo.softDelete(id!, OWNER_A);
    expect(await deps.workflowRepo.resolveSlug(slug, OWNER_A)).toBeNull();

    const result = await installCatalogEntries([entry(OWNER_A, slug, "1.0.0")], deps);
    expect(result.preserved).toBe(1);
    expect(await deps.workflowRepo.resolveSlug(slug, OWNER_A)).toBeNull();
  });

  test("preserves first-adoption divergence and records all three candidate states", async () => {
    const slug = `loader-first-divergence-${Date.now()}`;
    const incoming = entry(OWNER_A, slug, "2.0.0", "public", "incoming");
    await deps.mutationService.save({
      graph: entry(OWNER_A, slug, "1.0.0", "public", "user").graph,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });

    const result = await installCatalogEntries([incoming], deps);
    expect(result.outcomes[0]).toMatchObject({
      outcome: "conflict",
      classification: "baseline-missing",
    });
    const [conflict] = getWorkflowReconciliationStatus(getSqliteInstance()).conflicts;
    expect(conflict.previous).toBeNull();
    expect(conflict.current.lifecycle).toBe("present");
    expect(conflict.incoming.lifecycle).toBe("present");
  });

  test("does not apply an early safe update when a later identity conflicts", async () => {
    const stamp = Date.now();
    const safeSlug = `loader-preflight-safe-${stamp}`;
    const conflictSlug = `loader-preflight-conflict-${stamp}`;
    const initial = [
      entry(OWNER_A, safeSlug, "1.0.0", "public", "safe-v1"),
      entry(OWNER_A, conflictSlug, "1.0.0", "public", "conflict-v1"),
    ];
    await installCatalogEntries(initial, deps);
    const conflictId = await deps.workflowRepo.resolveSlug(conflictSlug, OWNER_A);
    const userGraph = await deps.workflowRepo.get(conflictId!, OWNER_A);
    (userGraph!.nodes[1] as { directive: string }).directive = "user-change";
    await deps.mutationService.save({
      graph: userGraph!,
      userId: OWNER_A,
      slug: conflictSlug,
      visibility: "public",
      skipAudit: true,
    });

    const result = await installCatalogEntries(
      [
        entry(OWNER_A, safeSlug, "2.0.0", "public", "safe-v2"),
        entry(OWNER_A, conflictSlug, "2.0.0", "public", "upstream-change"),
      ],
      deps,
    );
    expect(result.conflicts).toBe(1);
    const safeId = await deps.workflowRepo.resolveSlug(safeSlug, OWNER_A);
    expect((await deps.workflowRepo.get(safeId!, OWNER_A))?.metadata.version).toBe("1.0.0");
    const baselineVersions = getSqliteInstance()
      .prepare("SELECT sourceVersion FROM managedWorkflowBaseline WHERE ownerId = ? ORDER BY slug")
      .all(OWNER_A) as Array<{ sourceVersion: string }>;
    expect(baselineVersions.map((row) => row.sourceVersion)).toEqual(["1.0.0", "1.0.0"]);
  });

  test("does not apply a safe update when another incoming entry has an invalid version", async () => {
    const stamp = Date.now();
    const safeSlug = `loader-invalid-safe-${stamp}`;
    const invalidSlug = `loader-invalid-version-${stamp}`;
    await installCatalogEntries([entry(OWNER_A, safeSlug, "1.0.0")], deps);

    await expect(
      installCatalogEntries(
        [entry(OWNER_A, safeSlug, "2.0.0"), entry(OWNER_A, invalidSlug, "not-semver")],
        deps,
      ),
    ).rejects.toThrow("invalid entry");
    const safeId = await deps.workflowRepo.resolveSlug(safeSlug, OWNER_A);
    expect((await deps.workflowRepo.get(safeId!, OWNER_A))?.metadata.version).toBe("1.0.0");
    expect(await deps.workflowRepo.resolveSlug(invalidSlug, OWNER_A)).toBeNull();
  });

  test("does not apply a safe update when another incoming graph is malformed", async () => {
    const stamp = Date.now();
    const safeSlug = `loader-malformed-safe-${stamp}`;
    const malformedSlug = `loader-malformed-graph-${stamp}`;
    await installCatalogEntries([entry(OWNER_A, safeSlug, "1.0.0")], deps);
    const malformed = entry(OWNER_A, malformedSlug, "1.0.0");
    malformed.graph = {
      metadata: { name: malformedSlug, version: "1.0.0", description: "invalid" },
      nodes: [],
    };

    await expect(
      installCatalogEntries([entry(OWNER_A, safeSlug, "2.0.0"), malformed], deps),
    ).rejects.toThrow("invalid entry");
    const safeId = await deps.workflowRepo.resolveSlug(safeSlug, OWNER_A);
    expect((await deps.workflowRepo.get(safeId!, OWNER_A))?.metadata.version).toBe("1.0.0");
    expect(await deps.workflowRepo.resolveSlug(malformedSlug, OWNER_A)).toBeNull();
  });

  test("rejects invalid slugs and oversized graphs before any catalog write", async () => {
    const stamp = Date.now();
    const safeSlug = `loader-bounds-safe-${stamp}`;
    await installCatalogEntries([entry(OWNER_A, safeSlug, "1.0.0")], deps);

    const invalidSlugEntry = entry(OWNER_A, `loader_invalid_${stamp}`, "1.0.0");
    const oversized = entry(OWNER_A, `loader-oversized-${stamp}`, "1.0.0");
    oversized.graph.metadata.description = "x".repeat(5 * 1024 * 1024);

    await expect(
      installCatalogEntries([entry(OWNER_A, safeSlug, "2.0.0"), invalidSlugEntry, oversized], deps),
    ).rejects.toThrow("2 invalid entries");
    const safeId = await deps.workflowRepo.resolveSlug(safeSlug, OWNER_A);
    expect((await deps.workflowRepo.get(safeId!, OWNER_A))?.metadata.version).toBe("1.0.0");
    expect(await deps.workflowRepo.resolveSlug(invalidSlugEntry.slug, OWNER_A)).toBeNull();
    expect(await deps.workflowRepo.resolveSlug(oversized.slug, OWNER_A)).toBeNull();
  });

  test("rejects duplicate current/legacy catalog identities before writing", async () => {
    const stamp = Date.now();
    const oldSlug = `loader-duplicate-old-${stamp}`;
    const newSlug = `loader-duplicate-new-${stamp}`;
    await expect(
      installCatalogEntries(
        [
          entry(OWNER_A, oldSlug, "1.0.0"),
          entry(OWNER_A, newSlug, "2.0.0", "public", "new", [oldSlug]),
        ],
        deps,
      ),
    ).rejects.toThrow("Duplicate catalog legacy identity");
    expect(await deps.workflowRepo.resolveSlug(oldSlug, OWNER_A)).toBeNull();
    expect(await deps.workflowRepo.resolveSlug(newSlug, OWNER_A)).toBeNull();
  });

  test("applies an upstream removal as a tombstone and remains idempotent", async () => {
    const slug = `loader-removal-${Date.now()}`;
    await installCatalogEntries([entry(OWNER_A, slug, "1.0.0")], deps);
    expect((await installCatalogEntries([], deps)).removed).toBe(1);
    expect(await deps.workflowRepo.resolveSlug(slug, OWNER_A)).toBeNull();
    const baseline = getSqliteInstance()
      .prepare("SELECT state FROM managedWorkflowBaseline WHERE ownerId = ? AND slug = ?")
      .get(OWNER_A, slug) as { state: string };
    expect(JSON.parse(baseline.state).lifecycle).toBe("deleted");
    expect((await installCatalogEntries([], deps)).outcomes[0].outcome).toBe("skipped-unchanged");

    const reintroduced = entry(OWNER_A, slug, "2.0.0", "public", "returned");
    const reintroduction = await installCatalogEntries([reintroduced], deps);
    expect(reintroduction.updated).toBe(1);
    const restoredId = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    expect((await deps.workflowRepo.get(restoredId!, OWNER_A))?.metadata.version).toBe("2.0.0");
  });

  test("preserves a user hard-delete while the incoming catalog is unchanged", async () => {
    const slug = `loader-hard-delete-${Date.now()}`;
    const bundled = entry(OWNER_A, slug, "1.0.0");
    await installCatalogEntries([bundled], deps);
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    await deps.workflowRepo.delete(id!, OWNER_A);

    const result = await installCatalogEntries([bundled], deps);
    expect(result.preserved).toBe(1);
    expect(await deps.workflowRepo.resolveSlugIncludingDeleted(slug, OWNER_A)).toBeNull();
  });

  test("records upstream removal plus a user graph change as a conflict", async () => {
    const slug = `loader-removal-conflict-${Date.now()}`;
    await installCatalogEntries([entry(OWNER_A, slug, "1.0.0", "public", "base")], deps);
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const graph = await deps.workflowRepo.get(id!, OWNER_A);
    (graph!.nodes[1] as { directive: string }).directive = "user-change";
    await deps.mutationService.save({
      graph: graph!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });

    const result = await installCatalogEntries([], deps);
    expect(result.conflicts).toBe(1);
    expect(await deps.workflowRepo.resolveSlug(slug, OWNER_A)).toBe(id);
    const [conflict] = getWorkflowReconciliationStatus(getSqliteInstance()).conflicts;
    expect(conflict.incoming.lifecycle).toBe("deleted");

    const resolution = await runWithMCPContext({ userId: "system-admin" }, () =>
      manageReconciliation({
        action: "resolve",
        reference: `${OWNER_A}/${slug}`,
        selection: "incoming",
        ...inspectedResolution(OWNER_A, slug),
      }),
    );
    expect(resolution).not.toHaveProperty("isError");
    expect(getWorkflowReconciliationStatus(getSqliteInstance()).status).toBe("ok");
    expect(await deps.workflowRepo.resolveSlug(slug, OWNER_A)).toBeNull();
    const resolvedBaseline = getSqliteInstance()
      .prepare("SELECT state FROM managedWorkflowBaseline WHERE ownerId = ? AND slug = ?")
      .get(OWNER_A, slug) as { state: string };
    expect(JSON.parse(resolvedBaseline.state)).toMatchObject({ lifecycle: "deleted" });
    const audit = getSqliteInstance()
      .prepare(
        "SELECT action, metadata FROM auditLog WHERE resource = 'workflow-reconciliation' AND resourceId = ? ORDER BY createdAt DESC LIMIT 1",
      )
      .get(`${OWNER_A}/${slug}`) as { action: string; metadata: string };
    expect(audit.action).toBe("workflow:reconciliation_resolve");
    expect(JSON.parse(audit.metadata)).toEqual({ selection: "incoming", merged: false });
    expect((await installCatalogEntries([], deps)).outcomes[0]).toMatchObject({
      slug,
      outcome: "skipped-unchanged",
    });
  });

  test("rolls back workflow and baseline writes when a later apply operation fails", async () => {
    const stamp = Date.now();
    const firstSlug = `loader-atomic-first-${stamp}`;
    const secondSlug = `loader-atomic-second-${stamp}`;
    await installCatalogEntries(
      [
        entry(OWNER_A, firstSlug, "1.0.0", "public", "first-v1"),
        entry(OWNER_A, secondSlug, "1.0.0", "public", "second-v1"),
      ],
      deps,
    );
    const sqlite = getSqliteInstance();
    sqlite.exec(
      `CREATE TRIGGER fail_catalog_second_baseline_update BEFORE UPDATE ON managedWorkflowBaseline
       WHEN NEW.ownerId = '${OWNER_A}' AND NEW.slug = '${secondSlug}'
       BEGIN SELECT RAISE(ABORT, 'injected apply failure'); END`,
    );
    try {
      await expect(
        installCatalogEntries(
          [
            entry(OWNER_A, firstSlug, "2.0.0", "public", "first-v2"),
            entry(OWNER_A, secondSlug, "2.0.0", "public", "second-v2"),
          ],
          deps,
        ),
      ).rejects.toThrow("injected apply failure");
    } finally {
      sqlite.exec("DROP TRIGGER fail_catalog_second_baseline_update");
    }
    for (const slug of [firstSlug, secondSlug]) {
      const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
      expect((await deps.workflowRepo.get(id!, OWNER_A))?.metadata.version).toBe("1.0.0");
      const baseline = sqlite
        .prepare("SELECT sourceVersion FROM managedWorkflowBaseline WHERE ownerId = ? AND slug = ?")
        .get(OWNER_A, slug) as { sourceVersion: string };
      expect(baseline.sourceVersion).toBe("1.0.0");
    }
  });

  test("rejects a catalog plan when a workflow changes after its preflight snapshot", async () => {
    const stamp = Date.now();
    const firstSlug = `loader-stale-plan-first-${stamp}`;
    const secondSlug = `loader-stale-plan-second-${stamp}`;
    await installCatalogEntries(
      [
        entry(OWNER_A, firstSlug, "1.0.0", "public", "first-v1"),
        entry(OWNER_A, secondSlug, "1.0.0", "public", "second-v1"),
      ],
      deps,
    );
    const firstId = await deps.workflowRepo.resolveSlug(firstSlug, OWNER_A);
    const mutationService = {
      validate: async (graph: Parameters<typeof deps.mutationService.validate>[0]) => {
        const metadata = graph.metadata as { name?: string } | undefined;
        if (metadata?.name === secondSlug) {
          const live = await deps.workflowRepo.get(firstId!, OWNER_A);
          (live!.nodes[1] as { directive: string }).directive = "late-user-change";
          getSqliteInstance()
            .prepare("UPDATE workflow SET graph = ? WHERE id = ? AND userId = ?")
            .run(JSON.stringify(live), firstId, OWNER_A);
        }
        return deps.mutationService.validate(graph);
      },
    };

    await expect(
      installCatalogEntries(
        [
          entry(OWNER_A, firstSlug, "2.0.0", "public", "first-v2"),
          entry(OWNER_A, secondSlug, "2.0.0", "public", "second-v2"),
        ],
        { ...deps, mutationService },
      ),
    ).rejects.toThrow(`MANAGED_WORKFLOW_RECONCILIATION_STALE: ${OWNER_A}/${firstSlug}`);

    const firstStored = await deps.workflowRepo.get(firstId!, OWNER_A);
    expect((firstStored!.nodes[1] as { directive: string }).directive).toBe("late-user-change");
    const secondId = await deps.workflowRepo.resolveSlug(secondSlug, OWNER_A);
    expect((await deps.workflowRepo.get(secondId!, OWNER_A))?.metadata.version).toBe("1.0.0");
    const baselines = getSqliteInstance()
      .prepare(
        "SELECT slug, sourceVersion FROM managedWorkflowBaseline WHERE ownerId = ? AND slug IN (?, ?) ORDER BY slug",
      )
      .all(OWNER_A, firstSlug, secondSlug) as Array<{ slug: string; sourceVersion: string }>;
    expect(baselines).toEqual([
      { slug: firstSlug, sourceVersion: "1.0.0" },
      { slug: secondSlug, sourceVersion: "1.0.0" },
    ]);
  });

  test("fails preflight on a malformed persisted baseline without changing the workflow", async () => {
    const slug = `loader-malformed-baseline-${Date.now()}`;
    await installCatalogEntries([entry(OWNER_A, slug, "1.0.0")], deps);
    getSqliteInstance()
      .prepare("UPDATE managedWorkflowBaseline SET state = ? WHERE ownerId = ? AND slug = ?")
      .run("not-json", OWNER_A, slug);

    await expect(installCatalogEntries([entry(OWNER_A, slug, "2.0.0")], deps)).rejects.toThrow(
      `Malformed managed workflow baseline ${OWNER_A}/${slug}`,
    );
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    expect((await deps.workflowRepo.get(id!, OWNER_A))?.metadata.version).toBe("1.0.0");
  });

  test("fails closed with identity when durable conflict evidence is malformed", async () => {
    const slug = `loader-malformed-conflict-${Date.now()}`;
    const base = entry(OWNER_A, slug, "1.0.0", "public", "base");
    await installCatalogEntries([base], deps);
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const graph = await deps.workflowRepo.get(id!, OWNER_A);
    (graph!.nodes[1] as { directive: string }).directive = "user-change";
    await deps.mutationService.save({
      graph: graph!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    await installCatalogEntries([entry(OWNER_A, slug, "2.0.0", "public", "upstream-change")], deps);
    getSqliteInstance()
      .prepare(
        "UPDATE workflowReconciliationConflict SET currentState = ? WHERE ownerId = ? AND slug = ?",
      )
      .run("not-json", OWNER_A, slug);

    expect(() => getWorkflowReconciliationStatus(getSqliteInstance())).toThrow(
      `Malformed workflow reconciliation current candidate ${OWNER_A}/${slug}`,
    );
    const summary = getWorkflowReconciliationStatusSummary(getSqliteInstance());
    expect(summary).toMatchObject({
      status: "error",
      conflicts: [{ owner: OWNER_A, slug, classification: "conflict" }],
    });
    expect(summary.conflicts[0]).not.toHaveProperty("current");
  });

  test("explicit merged-current recovery clears error and preserves the merge on repeat", async () => {
    const slug = `loader-recovery-${Date.now()}`;
    const v1 = entry(OWNER_A, slug, "1.0.0", "public", "base");
    const v2 = entry(OWNER_A, slug, "2.0.0", "public", "upstream");
    await installCatalogEntries([v1], deps);
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const graph = await deps.workflowRepo.get(id!, OWNER_A);
    (graph!.nodes[1] as { directive: string }).directive = "user-change";
    await deps.mutationService.save({
      graph: graph!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    expect((await installCatalogEntries([v2], deps)).conflicts).toBe(1);
    const statusResponse = await runWithMCPContext({ userId: "system-admin" }, () =>
      manageReconciliation({ action: "status" }),
    );
    const statusPayload = JSON.parse(statusResponse.content[0].text);
    expect(statusPayload).toMatchObject({
      status: "error",
      code: "MANAGED_WORKFLOW_RECONCILIATION_REQUIRED",
    });
    expect(statusPayload.conflicts[0]).toMatchObject({
      owner: OWNER_A,
      slug,
      classification: "conflict",
    });
    expect(statusPayload.conflicts[0].candidateRefs).toEqual({
      previous: expect.stringContaining("#previous"),
      current: expect.stringContaining("#current"),
      incoming: expect.stringContaining("#incoming"),
    });
    expect(statusPayload.conflicts[0].instruction).toContain("Workflow Management Flow (WMF)");
    expect(statusPayload.conflicts[0]).toMatchObject({
      previous: {
        lifecycle: "present",
        content: {
          graph: {
            nodes: expect.arrayContaining([expect.objectContaining({ directive: "base" })]),
          },
        },
      },
      current: {
        lifecycle: "present",
        content: {
          graph: {
            nodes: expect.arrayContaining([expect.objectContaining({ directive: "user-change" })]),
          },
        },
      },
      incoming: {
        lifecycle: "present",
        content: {
          graph: {
            nodes: expect.arrayContaining([expect.objectContaining({ directive: "upstream" })]),
          },
        },
      },
    });
    const healthApp = express();
    healthApp.use("/health", healthRoutes);
    const healthResponse = await request(healthApp).get("/health");
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.body.data).toMatchObject({
      status: "degraded",
      reconciliation: {
        status: "error",
        code: statusPayload.code,
      },
    });
    expect(healthResponse.body.data.reconciliation.conflicts[0]).toMatchObject({
      owner: OWNER_A,
      slug,
      candidateRefs: statusPayload.conflicts[0].candidateRefs,
    });
    expect(healthResponse.body.data.reconciliation.conflicts[0]).not.toHaveProperty("current");

    const ordinaryStatusResponse = await runWithMCPContext({ userId: OWNER_A }, () =>
      manageReconciliation({ action: "status" }),
    );
    const ordinaryStatus = JSON.parse(ordinaryStatusResponse.content[0].text);
    expect(ordinaryStatus.conflicts[0].candidateRefs).toEqual(
      statusPayload.conflicts[0].candidateRefs,
    );
    expect(ordinaryStatus.conflicts[0]).not.toHaveProperty("current");

    const candidateResponse = await runWithMCPContext({ userId: "system-admin" }, () =>
      manageReconciliation({
        action: "get",
        reference: statusPayload.conflicts[0].candidateRefs.current,
      }),
    );
    expect(JSON.parse(candidateResponse.content[0].text)).toMatchObject({
      reference: statusPayload.conflicts[0].candidateRefs.current,
      state: { lifecycle: "present" },
    });
    for (const [candidate, directive] of [
      ["previous", "base"],
      ["current", "user-change"],
      ["incoming", "upstream"],
    ] as const) {
      const candidateResult = await runWithMCPContext({ userId: "system-admin" }, () =>
        manageReconciliation({
          action: "get",
          reference: statusPayload.conflicts[0].candidateRefs[candidate],
        }),
      );
      expect(JSON.parse(candidateResult.content[0].text)).toMatchObject({
        state: {
          content: {
            graph: { nodes: expect.arrayContaining([expect.objectContaining({ directive })]) },
          },
        },
      });
    }

    const deniedResolution = await runWithMCPContext({ userId: OWNER_A }, () =>
      manageReconciliation({
        action: "resolve",
        reference: `${OWNER_A}/${slug}`,
        selection: "current",
        ...inspectedResolution(OWNER_A, slug),
      }),
    );
    expect(deniedResolution).toMatchObject({ isError: true });
    expect(getWorkflowReconciliationStatus(getSqliteInstance()).status).toBe("error");

    const invalidMergedResolution = await runWithMCPContext({ userId: "system-admin" }, () =>
      manageReconciliation({
        action: "resolve",
        reference: `${OWNER_A}/${slug}`,
        selection: "current",
        ...inspectedResolution(OWNER_A, slug),
        mergedGraph: {
          metadata: { name: slug, version: "2.0.0", description: "invalid merge" },
          nodes: [],
        },
        visibility: "public",
      }),
    );
    expect(invalidMergedResolution).toMatchObject({ isError: true });
    expect(getWorkflowReconciliationStatus(getSqliteInstance()).status).toBe("error");
    expect(
      getSqliteInstance()
        .prepare(
          "SELECT COUNT(*) AS count FROM auditLog WHERE resource = 'workflow-reconciliation' AND resourceId = ?",
        )
        .get(`${OWNER_A}/${slug}`),
    ).toEqual({ count: 0 });

    const mergedGraph = structuredClone(statusPayload.conflicts[0].current.content.graph);
    mergedGraph.nodes[1].directive = "merged user + upstream";

    const resolutionResponse = await runWithMCPContext({ userId: "system-admin" }, () =>
      manageReconciliation({
        action: "resolve",
        reference: `${OWNER_A}/${slug}`,
        selection: "current",
        ...inspectedResolution(OWNER_A, slug),
        mergedGraph,
        visibility: "public",
      }),
    );
    expect(resolutionResponse).not.toHaveProperty("isError");
    expect(getWorkflowReconciliationStatus(getSqliteInstance()).status).toBe("ok");
    const resolutionAudit = getSqliteInstance()
      .prepare(
        "SELECT userId, action, source, metadata FROM auditLog WHERE resource = 'workflow-reconciliation' AND resourceId = ? ORDER BY createdAt DESC LIMIT 1",
      )
      .get(`${OWNER_A}/${slug}`) as {
      userId: string;
      action: string;
      source: string;
      metadata: string;
    };
    expect(resolutionAudit).toMatchObject({
      userId: "system-admin",
      action: "workflow:reconciliation_resolve",
      source: "mcp",
    });
    expect(JSON.parse(resolutionAudit.metadata)).toEqual({ selection: "current", merged: true });
    const resolutionContext = getSqliteInstance()
      .prepare(
        "SELECT selection, merged, rationale, residualDelta FROM workflowReconciliationResolution WHERE ownerId = ? AND slug = ?",
      )
      .get(OWNER_A, slug) as {
      selection: string;
      merged: number;
      rationale: string;
      residualDelta: string;
    };
    expect(resolutionContext).toMatchObject({
      selection: "current",
      merged: 1,
      rationale: "Test decision from inspected candidates.",
    });
    expect(JSON.parse(resolutionContext.residualDelta)).toContain(
      "$.content.graph.nodes[1].directive",
    );
    const repeated = await installCatalogEntries([v2], deps);
    expect(repeated.preserved).toBe(1);
    const stored = await deps.workflowRepo.get(id!, OWNER_A);
    expect((stored!.nodes[1] as { directive: string }).directive).toBe("merged user + upstream");
    expect(
      (await installCatalogEntries([entry(OWNER_A, slug, "3.0.0", "public", "upstream-v3")], deps))
        .conflicts,
    ).toBe(1);
    const nextConflict = getWorkflowReconciliationStatus(getSqliteInstance()).conflicts[0];
    const nextPrevious = nextConflict.previous as {
      content: { graph: { nodes: Array<{ directive?: string }> } };
    };
    expect(nextPrevious.content.graph.nodes[1].directive).toBe("upstream");
    expect(
      (nextConflict.current.content.graph.nodes as Array<{ directive?: string }>)[1].directive,
    ).toBe("merged user + upstream");
    expect(
      (nextConflict.incoming.content.graph.nodes as Array<{ directive?: string }>)[1].directive,
    ).toBe("upstream-v3");
  });

  test("rejects every stale resolution path without overwriting a later user edit", async () => {
    const variants = [
      { name: "keep-current", selection: "current" as const, merged: false },
      { name: "incoming", selection: "incoming" as const, merged: false },
      { name: "previous", selection: "previous" as const, merged: false },
      { name: "merged-current", selection: "current" as const, merged: true },
    ];

    for (const variant of variants) {
      const slug = `loader-stale-${variant.name}-${Date.now()}`;
      const v1 = entry(OWNER_A, slug, "1.0.0", "public", "base");
      const v2 = entry(OWNER_A, slug, "2.0.0", "public", "upstream");
      expect(await installCatalogEntry(v1, deps)).toBe("installed");
      const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
      const firstUserGraph = await deps.workflowRepo.get(id!, OWNER_A);
      (firstUserGraph!.nodes[1] as { directive: string }).directive = "captured-user-change";
      await deps.mutationService.save({
        graph: firstUserGraph!,
        userId: OWNER_A,
        slug,
        visibility: "public",
        skipAudit: true,
      });
      expect(await installCatalogEntry(v2, deps)).toBe("conflict");

      const laterGraph = await deps.workflowRepo.get(id!, OWNER_A);
      (laterGraph!.nodes[1] as { directive: string }).directive = "later-user-change";
      await deps.mutationService.save({
        graph: laterGraph!,
        userId: OWNER_A,
        slug,
        visibility: "private",
        skipAudit: true,
      });

      const resolution = await runWithMCPContext({ userId: "system-admin" }, () =>
        manageReconciliation({
          action: "resolve",
          reference: `${OWNER_A}/${slug}`,
          selection: variant.selection,
          ...inspectedResolution(OWNER_A, slug),
          ...(variant.merged
            ? {
                mergedGraph: entry(OWNER_A, slug, "2.0.0", "private", "stale-merge").graph,
                visibility: "private" as const,
              }
            : {}),
        }),
      );
      expect(resolution).toMatchObject({ isError: true });
      expect(JSON.parse(resolution.content[0].text)).toMatchObject({
        status: "error",
        code: "MANAGED_WORKFLOW_RECONCILIATION_STALE",
        owner: OWNER_A,
        slug,
      });
      const stored = await deps.workflowRepo.get(id!, OWNER_A);
      expect((stored!.nodes[1] as { directive: string }).directive).toBe("later-user-change");
      const row = getSqliteInstance()
        .prepare("SELECT visibility FROM workflow WHERE id = ?")
        .get(id) as { visibility: string };
      expect(row.visibility).toBe("private");
      const conflict = getWorkflowReconciliationStatus(getSqliteInstance()).conflicts.find(
        (item) => item.owner === OWNER_A && item.slug === slug,
      );
      expect(conflict?.current).toMatchObject({
        lifecycle: "present",
        content: {
          graph: {
            nodes: expect.arrayContaining([
              expect.objectContaining({ directive: "captured-user-change" }),
            ]),
          },
        },
      });
      const baseline = getSqliteInstance()
        .prepare("SELECT sourceVersion FROM managedWorkflowBaseline WHERE ownerId = ? AND slug = ?")
        .get(OWNER_A, slug) as { sourceVersion: string };
      expect(baseline.sourceVersion).toBe("1.0.0");
      expect(
        getSqliteInstance()
          .prepare(
            "SELECT COUNT(*) AS count FROM auditLog WHERE resource = 'workflow-reconciliation' AND resourceId = ?",
          )
          .get(`${OWNER_A}/${slug}`),
      ).toEqual({ count: 0 });
    }
  });

  test("rejects stale resolution after the user deletes the captured workflow", async () => {
    const slug = `loader-stale-delete-${Date.now()}`;
    const v1 = entry(OWNER_A, slug, "1.0.0", "public", "base");
    const v2 = entry(OWNER_A, slug, "2.0.0", "public", "upstream");
    expect(await installCatalogEntry(v1, deps)).toBe("installed");
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const graph = await deps.workflowRepo.get(id!, OWNER_A);
    (graph!.nodes[1] as { directive: string }).directive = "captured-user-change";
    await deps.mutationService.save({
      graph: graph!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    expect(await installCatalogEntry(v2, deps)).toBe("conflict");
    await deps.workflowRepo.softDelete(id!, OWNER_A);

    const resolution = await runWithMCPContext({ userId: "system-admin" }, () =>
      manageReconciliation({
        action: "resolve",
        reference: `${OWNER_A}/${slug}`,
        selection: "incoming",
        ...inspectedResolution(OWNER_A, slug),
      }),
    );

    expect(resolution).toMatchObject({ isError: true });
    expect(JSON.parse(resolution.content[0].text).code).toBe(
      "MANAGED_WORKFLOW_RECONCILIATION_STALE",
    );
    expect(await deps.workflowRepo.resolveSlug(slug, OWNER_A)).toBeNull();
    expect(await deps.workflowRepo.resolveSlugIncludingDeleted(slug, OWNER_A)).toBe(id);
    expect(getWorkflowReconciliationStatus(getSqliteInstance()).status).toBe("error");
    const baseline = getSqliteInstance()
      .prepare("SELECT sourceVersion FROM managedWorkflowBaseline WHERE ownerId = ? AND slug = ?")
      .get(OWNER_A, slug) as { sourceVersion: string };
    expect(baseline.sourceVersion).toBe("1.0.0");
  });

  test("rejects resolution when a previously absent rename alias appears after capture", async () => {
    const stamp = Date.now();
    const oldSlug = `loader-stale-alias-old-${stamp}`;
    const newSlug = `loader-stale-alias-new-${stamp}`;
    const original = entry(OWNER_A, oldSlug, "1.0.0", "public", "base");
    expect(await installCatalogEntry(original, deps)).toBe("installed");
    const originalId = await deps.workflowRepo.resolveSlug(oldSlug, OWNER_A);
    await deps.workflowRepo.delete(originalId!, OWNER_A);

    const incoming = entry(OWNER_A, newSlug, "2.0.0", "public", "upstream-change", [oldSlug]);
    expect(await installCatalogEntry(incoming, deps)).toBe("conflict");

    await deps.mutationService.save({
      graph: entry(OWNER_A, oldSlug, "9.0.0", "private", "late-alias").graph,
      userId: OWNER_A,
      slug: oldSlug,
      visibility: "private",
      skipAudit: true,
    });
    const resolution = await runWithMCPContext({ userId: "system-admin" }, () =>
      manageReconciliation({
        action: "resolve",
        reference: `${OWNER_A}/${newSlug}`,
        selection: "incoming",
        ...inspectedResolution(OWNER_A, newSlug),
      }),
    );

    expect(resolution).toMatchObject({ isError: true });
    expect(JSON.parse(resolution.content[0].text).code).toBe(
      "MANAGED_WORKFLOW_RECONCILIATION_STALE",
    );
    expect(await deps.workflowRepo.resolveSlug(newSlug, OWNER_A)).toBeNull();
    expect(await deps.workflowRepo.resolveSlug(oldSlug, OWNER_A)).toBeTruthy();
    expect(getWorkflowReconciliationStatusSummary(getSqliteInstance()).status).toBe("error");
  });

  test("rejects an older competing resolution after another administrator clears the conflict", async () => {
    const slug = `loader-stale-competing-resolution-${Date.now()}`;
    const v1 = entry(OWNER_A, slug, "1.0.0", "public", "base");
    const v2 = entry(OWNER_A, slug, "2.0.0", "public", "upstream");
    expect(await installCatalogEntry(v1, deps)).toBe("installed");
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const graph = await deps.workflowRepo.get(id!, OWNER_A);
    (graph!.nodes[1] as { directive: string }).directive = "user-change";
    await deps.mutationService.save({
      graph: graph!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    expect(await installCatalogEntry(v2, deps)).toBe("conflict");

    let releaseValidation!: () => void;
    let reportValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      reportValidationStarted = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const delayedResolution = resolveWorkflowReconciliation(
      `${OWNER_A}/${slug}`,
      "incoming",
      {
        sqlite: getSqliteInstance(),
        mutationService: {
          validate: async (candidate) => {
            reportValidationStarted();
            await validationGate;
            return deps.mutationService.validate(candidate);
          },
        },
      },
      undefined,
      {
        actorId: "system-admin",
        source: "test",
        expectedRevision: inspectedResolution(OWNER_A, slug).revision,
        rationale: "Test decision from inspected candidates.",
      },
    );
    void delayedResolution.catch(() => reportValidationStarted());
    await validationStarted;

    await resolveWorkflowReconciliation(
      `${OWNER_A}/${slug}`,
      "current",
      { sqlite: getSqliteInstance(), mutationService: deps.mutationService },
      undefined,
      {
        actorId: "system-admin",
        source: "test",
        expectedRevision: inspectedResolution(OWNER_A, slug).revision,
        rationale: "Test decision from inspected candidates.",
      },
    );
    releaseValidation();

    await expect(delayedResolution).rejects.toThrow(
      `MANAGED_WORKFLOW_RECONCILIATION_STALE: ${OWNER_A}/${slug}`,
    );
    expect(getWorkflowReconciliationStatusSummary(getSqliteInstance()).status).toBe("ok");
    const stored = await deps.workflowRepo.get(id!, OWNER_A);
    expect((stored!.nodes[1] as { directive: string }).directive).toBe("user-change");
    const baseline = getSqliteInstance()
      .prepare("SELECT sourceVersion FROM managedWorkflowBaseline WHERE ownerId = ? AND slug = ?")
      .get(OWNER_A, slug) as { sourceVersion: string };
    expect(baseline.sourceVersion).toBe("2.0.0");
    expect(
      getSqliteInstance()
        .prepare(
          "SELECT COUNT(*) AS count FROM auditLog WHERE resource = 'workflow-reconciliation' AND resourceId = ?",
        )
        .get(`${OWNER_A}/${slug}`),
    ).toEqual({ count: 1 });
  });

  test("rejects resolution when catalog evidence is replaced during validation", async () => {
    const slug = `loader-stale-replaced-conflict-${Date.now()}`;
    const v1 = entry(OWNER_A, slug, "1.0.0", "public", "base");
    const v2 = entry(OWNER_A, slug, "2.0.0", "public", "upstream-v2");
    expect(await installCatalogEntry(v1, deps)).toBe("installed");
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const graph = await deps.workflowRepo.get(id!, OWNER_A);
    (graph!.nodes[1] as { directive: string }).directive = "user-change";
    await deps.mutationService.save({
      graph: graph!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    expect(await installCatalogEntry(v2, deps)).toBe("conflict");

    const replacement = entry(OWNER_A, slug, "3.0.0", "public", "upstream-v3");
    let releaseValidation!: () => void;
    let reportValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      reportValidationStarted = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const delayedResolution = resolveWorkflowReconciliation(
      `${OWNER_A}/${slug}`,
      "incoming",
      {
        sqlite: getSqliteInstance(),
        mutationService: {
          validate: async (candidate) => {
            reportValidationStarted();
            await validationGate;
            return deps.mutationService.validate(candidate);
          },
        },
      },
      undefined,
      {
        source: "test",
        expectedRevision: inspectedResolution(OWNER_A, slug).revision,
        rationale: "Test decision from inspected candidates.",
      },
    );
    void delayedResolution.catch(() => reportValidationStarted());
    const staleResolution = expect(delayedResolution).rejects.toThrow(
      `MANAGED_WORKFLOW_RECONCILIATION_STALE: ${OWNER_A}/${slug}`,
    );
    await validationStarted;

    expect(await installCatalogEntry(replacement, deps)).toBe("conflict");
    releaseValidation();
    await staleResolution;

    const conflict = getWorkflowReconciliationStatus(getSqliteInstance()).conflicts.find(
      (item) => item.owner === OWNER_A && item.slug === slug,
    );
    expect(conflict?.instruction).toContain("Workflow Management Flow (WMF)");
    expect(conflict?.incoming).toMatchObject({
      content: {
        graph: {
          metadata: { version: "3.0.0" },
          nodes: expect.arrayContaining([expect.objectContaining({ directive: "upstream-v3" })]),
        },
      },
    });
    const stored = await deps.workflowRepo.get(id!, OWNER_A);
    expect((stored!.nodes[1] as { directive: string }).directive).toBe("user-change");
    const baseline = getSqliteInstance()
      .prepare("SELECT sourceVersion FROM managedWorkflowBaseline WHERE ownerId = ? AND slug = ?")
      .get(OWNER_A, slug) as { sourceVersion: string };
    expect(baseline.sourceVersion).toBe("1.0.0");
    expect(
      getSqliteInstance()
        .prepare(
          "SELECT COUNT(*) AS count FROM auditLog WHERE resource = 'workflow-reconciliation' AND resourceId = ?",
        )
        .get(`${OWNER_A}/${slug}`),
    ).toEqual({ count: 0 });
  });

  test("rejects an older catalog plan after resolution advances its captured baseline", async () => {
    const slug = `loader-stale-catalog-baseline-${Date.now()}`;
    const v1 = entry(OWNER_A, slug, "1.0.0", "public", "base");
    const v2 = entry(OWNER_A, slug, "2.0.0", "public", "upstream-v2");
    expect(await installCatalogEntry(v1, deps)).toBe("installed");
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const graph = await deps.workflowRepo.get(id!, OWNER_A);
    (graph!.nodes[1] as { directive: string }).directive = "user-change";
    await deps.mutationService.save({
      graph: graph!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    expect(await installCatalogEntry(v2, deps)).toBe("conflict");

    let releaseValidation!: () => void;
    let reportValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      reportValidationStarted = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const delayedCatalog = installCatalogEntry(v2, {
      ...deps,
      mutationService: {
        validate: async (candidate) => {
          reportValidationStarted();
          await validationGate;
          return deps.mutationService.validate(candidate);
        },
      },
    });
    const staleCatalog = expect(delayedCatalog).rejects.toThrow(
      `MANAGED_WORKFLOW_RECONCILIATION_STALE: ${OWNER_A}/${slug}`,
    );
    await validationStarted;

    await resolveWorkflowReconciliation(
      `${OWNER_A}/${slug}`,
      "current",
      { sqlite: getSqliteInstance(), mutationService: deps.mutationService },
      undefined,
      {
        actorId: "system-admin",
        source: "test",
        expectedRevision: inspectedResolution(OWNER_A, slug).revision,
        rationale: "Test decision from inspected candidates.",
      },
    );
    releaseValidation();
    await staleCatalog;

    expect(getWorkflowReconciliationStatusSummary(getSqliteInstance()).status).toBe("ok");
    const stored = await deps.workflowRepo.get(id!, OWNER_A);
    expect((stored!.nodes[1] as { directive: string }).directive).toBe("user-change");
    const baseline = getSqliteInstance()
      .prepare("SELECT sourceVersion FROM managedWorkflowBaseline WHERE ownerId = ? AND slug = ?")
      .get(OWNER_A, slug) as { sourceVersion: string };
    expect(baseline.sourceVersion).toBe("2.0.0");
    expect(
      getSqliteInstance()
        .prepare(
          "SELECT COUNT(*) AS count FROM auditLog WHERE resource = 'workflow-reconciliation' AND resourceId = ?",
        )
        .get(`${OWNER_A}/${slug}`),
    ).toEqual({ count: 1 });
  });

  test("rejects an older first-adoption plan after another catalog creates its baseline", async () => {
    const slug = `loader-stale-created-baseline-${Date.now()}`;
    const bundled = entry(OWNER_A, slug, "1.0.0", "public", "existing");
    await deps.mutationService.save({
      graph: bundled.graph,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);

    let releaseValidation!: () => void;
    let reportValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      reportValidationStarted = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const delayedCatalog = installCatalogEntry(bundled, {
      ...deps,
      mutationService: {
        validate: async (candidate) => {
          reportValidationStarted();
          await validationGate;
          return deps.mutationService.validate(candidate);
        },
      },
    });
    const staleCatalog = expect(delayedCatalog).rejects.toThrow(
      `MANAGED_WORKFLOW_RECONCILIATION_STALE: ${OWNER_A}/${slug}`,
    );
    await validationStarted;

    expect(await installCatalogEntry(bundled, deps)).toBe("adopted");
    releaseValidation();
    await staleCatalog;

    expect(await deps.workflowRepo.resolveSlug(slug, OWNER_A)).toBe(id);
    const baseline = getSqliteInstance()
      .prepare("SELECT sourceVersion FROM managedWorkflowBaseline WHERE ownerId = ? AND slug = ?")
      .get(OWNER_A, slug) as { sourceVersion: string };
    expect(baseline.sourceVersion).toBe("1.0.0");
    expect(getWorkflowReconciliationStatusSummary(getSqliteInstance()).status).toBe("ok");
  });

  test("rejects an older rename plan after resolution migrates its captured baseline identity", async () => {
    const stamp = Date.now();
    const oldSlug = `loader-stale-baseline-old-${stamp}`;
    const newSlug = `loader-stale-baseline-new-${stamp}`;
    const v1 = entry(OWNER_A, oldSlug, "1.0.0", "public", "base");
    const v2 = entry(OWNER_A, newSlug, "2.0.0", "public", "upstream-v2", [oldSlug]);
    expect(await installCatalogEntry(v1, deps)).toBe("installed");
    const id = await deps.workflowRepo.resolveSlug(oldSlug, OWNER_A);
    const graph = await deps.workflowRepo.get(id!, OWNER_A);
    (graph!.nodes[1] as { directive: string }).directive = "user-change";
    await deps.mutationService.save({
      graph: graph!,
      userId: OWNER_A,
      slug: oldSlug,
      visibility: "public",
      skipAudit: true,
    });
    expect(await installCatalogEntry(v2, deps)).toBe("conflict");

    let releaseValidation!: () => void;
    let reportValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      reportValidationStarted = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const delayedCatalog = installCatalogEntry(v2, {
      ...deps,
      mutationService: {
        validate: async (candidate) => {
          reportValidationStarted();
          await validationGate;
          return deps.mutationService.validate(candidate);
        },
      },
    });
    const staleCatalog = expect(delayedCatalog).rejects.toThrow(
      `MANAGED_WORKFLOW_RECONCILIATION_STALE: ${OWNER_A}/${newSlug}`,
    );
    await validationStarted;

    await resolveWorkflowReconciliation(
      `${OWNER_A}/${newSlug}`,
      "current",
      { sqlite: getSqliteInstance(), mutationService: deps.mutationService },
      undefined,
      {
        actorId: "system-admin",
        source: "test",
        expectedRevision: inspectedResolution(OWNER_A, newSlug).revision,
        rationale: "Test decision from inspected candidates.",
      },
    );
    releaseValidation();
    await staleCatalog;

    expect(await deps.workflowRepo.resolveSlug(oldSlug, OWNER_A)).toBeNull();
    expect(await deps.workflowRepo.resolveSlug(newSlug, OWNER_A)).toBe(id);
    const baselines = getSqliteInstance()
      .prepare(
        "SELECT slug, sourceVersion FROM managedWorkflowBaseline WHERE ownerId = ? AND slug IN (?, ?)",
      )
      .all(OWNER_A, oldSlug, newSlug) as Array<{ slug: string; sourceVersion: string }>;
    expect(baselines).toEqual([{ slug: newSlug, sourceVersion: "2.0.0" }]);
    expect(getWorkflowReconciliationStatusSummary(getSqliteInstance()).status).toBe("ok");
  });

  test("Cloud CLI exits non-zero on a copied conflicting database and leaves the source untouched", async () => {
    const slug = `loader-cloud-fatal-${Date.now()}`;
    const v1 = entry(OWNER_A, slug, "1.0.0", "public", "base");
    await installCatalogEntries([v1], deps);
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const graph = await deps.workflowRepo.get(id!, OWNER_A);
    (graph!.nodes[1] as { directive: string }).directive = "user-change";
    await deps.mutationService.save({
      graph: graph!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-cloud-fatal-"));
    const copyPath = path.join(temp, "copy.db");
    const flowsDir = path.join(temp, "catalog", "flows");
    fs.mkdirSync(flowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowsDir, "incoming.json"),
      JSON.stringify({
        ...entry(OWNER_A, slug, "2.0.0", "public", "upstream-change").graph,
        owner: OWNER_A,
        slug,
        visibility: "public",
      }),
    );
    try {
      await getSqliteInstance().backup(copyPath);
      const cliArgs = ["node_modules/tsx/dist/cli.mjs", "scripts/migrate-workflows-in-docker.ts"];
      const baseEnv = {
        ...process.env,
        DB_PATH: copyPath,
        WORKFLOWS_DIR: path.join(temp, "catalog"),
      };
      const selfHostCli = spawnSync(process.execPath, cliArgs, {
        cwd: process.cwd(),
        env: { ...baseEnv, DEPLOYMENT_MODE: "self-host" },
        encoding: "utf8",
      });
      const selfHostOutput = `${selfHostCli.stdout}\n${selfHostCli.stderr}`;
      expect(selfHostCli.status).toBe(0);
      expect(selfHostOutput).toContain("MANAGED_WORKFLOW_RECONCILIATION_REQUIRED");
      expect(selfHostOutput).toContain("#previous");
      expect(selfHostOutput).toContain("#current");
      expect(selfHostOutput).toContain("#incoming");
      expect(selfHostOutput).toContain("Workflow Management Flow (WMF)");

      const cli = spawnSync(process.execPath, cliArgs, {
        cwd: process.cwd(),
        env: { ...baseEnv, DEPLOYMENT_MODE: "saas" },
        encoding: "utf8",
      });
      expect(cli.status).not.toBe(0);
      expect(`${cli.stdout}\n${cli.stderr}`).toContain("Bundled workflow reconciliation");
      expect(getWorkflowReconciliationStatus(getSqliteInstance()).status).toBe("ok");
      const copy = new Database(copyPath, { readonly: true });
      try {
        const retained = copy
          .prepare(
            "SELECT classification, previousState, currentState, incomingState FROM workflowReconciliationConflict WHERE ownerId = ? AND slug = ?",
          )
          .get(OWNER_A, slug) as Record<string, string> | undefined;
        expect(retained).toBeDefined();
        expect(Object.keys(retained!)).toEqual([
          "classification",
          "previousState",
          "currentState",
          "incomingState",
        ]);
      } finally {
        copy.close();
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  test("migrates an explicitly replaced catalog slug without creating a duplicate", async () => {
    const stamp = Date.now();
    const oldSlug = `loader-old-slug-${stamp}`;
    const newSlug = `loader-new-slug-${stamp}`;
    await installCatalogEntries([entry(OWNER_A, oldSlug, "1.0.0")], deps);
    const originalId = await deps.workflowRepo.resolveSlug(oldSlug, OWNER_A);
    expect(originalId).toBeTruthy();

    const result = await installCatalogEntries(
      [entry(OWNER_A, newSlug, "2.0.0", "public", "Renamed flow", [oldSlug])],
      deps,
    );

    expect(result.updated).toBe(1);
    expect(await deps.workflowRepo.resolveSlug(oldSlug, OWNER_A)).toBeNull();
    expect(await deps.workflowRepo.resolveSlug(newSlug, OWNER_A)).toBe(originalId);
    const migrated = await deps.workflowRepo.get(originalId!, OWNER_A);
    expect(migrated?.metadata?.version).toBe("2.0.0");
    expect(migrated).not.toHaveProperty("previousSlugs");

    const rerun = await installCatalogEntries(
      [entry(OWNER_A, newSlug, "2.0.0", "public", "Renamed flow", [oldSlug])],
      deps,
    );
    expect(rerun.outcomes[0].outcome).toBe("skipped-unchanged");
  });

  test("resolves every candidate path for a conflict captured through a previous slug", async () => {
    const variants = [
      { name: "current", selection: "current" as const, expectedDirective: "user-change" },
      { name: "incoming", selection: "incoming" as const, expectedDirective: "upstream-change" },
      { name: "previous", selection: "previous" as const, expectedDirective: "base" },
      { name: "merged", selection: "current" as const, expectedDirective: "semantic-merge" },
    ];

    for (const variant of variants) {
      const stamp = `${Date.now()}-${variant.name}`;
      const oldSlug = `loader-conflict-old-${stamp}`;
      const newSlug = `loader-conflict-new-${stamp}`;
      const original = entry(OWNER_A, oldSlug, "1.0.0", "public", "base");
      expect(await installCatalogEntry(original, deps)).toBe("installed");
      const originalId = await deps.workflowRepo.resolveSlug(oldSlug, OWNER_A);
      const current = await deps.workflowRepo.get(originalId!, OWNER_A);
      (current!.nodes[1] as { directive: string }).directive = "user-change";
      await deps.mutationService.save({
        graph: current!,
        userId: OWNER_A,
        slug: oldSlug,
        visibility: "public",
        skipAudit: true,
      });

      const incoming = entry(OWNER_A, newSlug, "2.0.0", "public", "upstream-change", [oldSlug]);
      expect(await installCatalogEntry(incoming, deps)).toBe("conflict");

      const mergedGraph = entry(OWNER_A, newSlug, "2.0.0", "public", "semantic-merge").graph;
      const resolution = await runWithMCPContext({ userId: "system-admin" }, () =>
        manageReconciliation({
          action: "resolve",
          reference: `${OWNER_A}/${newSlug}`,
          selection: variant.selection,
          ...inspectedResolution(OWNER_A, newSlug),
          ...(variant.name === "merged" ? { mergedGraph, visibility: "public" as const } : {}),
        }),
      );

      expect(resolution).not.toHaveProperty("isError");
      expect(await deps.workflowRepo.resolveSlug(oldSlug, OWNER_A)).toBeNull();
      expect(await deps.workflowRepo.resolveSlug(newSlug, OWNER_A)).toBe(originalId);
      const resolved = await deps.workflowRepo.get(originalId!, OWNER_A);
      expect((resolved!.nodes[1] as { directive: string }).directive).toBe(
        variant.expectedDirective,
      );
      expect(getWorkflowReconciliationStatusSummary(getSqliteInstance()).status).toBe("ok");

      expect(await installCatalogEntry(incoming, deps)).not.toBe("conflict");
      expect(await deps.workflowRepo.resolveSlug(newSlug, OWNER_A)).toBe(originalId);
    }
  });

  test("uses canonical content identity instead of semantic version equality", async () => {
    const slug = `loader-same-semver-digest-${Date.now()}`;
    const previous = entry(OWNER_A, slug, "1.0.0", "public", "base");
    await installCatalogEntries([previous], deps);
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const current = await deps.workflowRepo.get(id!, OWNER_A);
    (current!.nodes[1] as { directive: string }).directive = "instance-two";
    await deps.mutationService.save({
      graph: current!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    const incoming = entry(OWNER_A, slug, "1.0.0", "public", "upstream-two");
    expect((await installCatalogEntries([incoming], deps)).conflicts).toBe(1);
    const conflict = getWorkflowReconciliationStatus(getSqliteInstance()).conflicts[0];
    expect(conflict.current.lifecycle).toBe("present");
    expect(conflict.incoming.lifecycle).toBe("present");
    expect(managedWorkflowStateDigest(conflict.current)).not.toBe(
      managedWorkflowStateDigest(conflict.incoming),
    );
    if (conflict.previous?.lifecycle === "present") {
      expect(
        managedWorkflowStateDigest({
          ...conflict.previous,
          content: {
            ...conflict.previous.content,
            graph: { ...conflict.previous.content.graph, id: "database-envelope-id" },
          },
        }),
      ).toBe(managedWorkflowStateDigest(conflict.previous));
    }
  });

  test("requires the exact inspected revision before ordinary resolution mutation", async () => {
    const slug = `loader-required-resolution-revision-${Date.now()}`;
    await installCatalogEntries([entry(OWNER_A, slug, "1.0.0", "public", "base")], deps);
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const graph = await deps.workflowRepo.get(id!, OWNER_A);
    (graph!.nodes[1] as { directive: string }).directive = "current";
    await deps.mutationService.save({
      graph: graph!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    await installCatalogEntries([entry(OWNER_A, slug, "2.0.0", "public", "incoming")], deps);
    const sqlite = getSqliteInstance();
    const before = sqlite
      .prepare("SELECT graph FROM workflow WHERE userId = ? AND slug = ?")
      .get(OWNER_A, slug);
    for (const expectedRevision of ["", "0".repeat(64)]) {
      await expect(
        resolveWorkflowReconciliation(
          `${OWNER_A}/${slug}`,
          "incoming",
          { sqlite, mutationService: deps.mutationService },
          undefined,
          { expectedRevision, rationale: "Inspected decision." },
        ),
      ).rejects.toThrow(`MANAGED_WORKFLOW_RECONCILIATION_STALE: ${OWNER_A}/${slug}`);
    }
    expect(
      sqlite.prepare("SELECT graph FROM workflow WHERE userId = ? AND slug = ?").get(OWNER_A, slug),
    ).toEqual(before);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM workflowReconciliationResolution WHERE ownerId = ? AND slug = ?",
        )
        .get(OWNER_A, slug),
    ).toEqual({ count: 0 });
    const inspected = inspectedResolution(OWNER_A, slug);
    await resolveWorkflowReconciliation(
      `${OWNER_A}/${slug}`,
      "incoming",
      { sqlite, mutationService: deps.mutationService },
      undefined,
      { expectedRevision: inspected.revision, rationale: inspected.rationale },
    );
    expect(getWorkflowReconciliationStatusSummary(sqlite).status).toBe("ok");
  });

  test("applies a portable staged decision atomically to a distinct fresh database", async () => {
    const slug = `loader-staged-portable-${Date.now()}`;
    const safeSlug = `${slug}-safe`;
    const addedSlug = `${slug}-added`;
    await installCatalogEntries(
      [
        entry(OWNER_A, slug, "1.0.0", "public", "base"),
        entry(OWNER_A, safeSlug, "1.0.0", "public", "safe-v1"),
      ],
      deps,
    );
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const current = await deps.workflowRepo.get(id!, OWNER_A);
    (current!.nodes[1] as { directive: string }).directive = "instance-change";
    await deps.mutationService.save({
      graph: current!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "reconciliation-portable-"));
    const sourcePath = path.join(temp, "source.db");
    const targetPath = path.join(temp, "target.db");
    try {
      await getSqliteInstance().backup(targetPath);
      const incomingEntries = [
        entry(OWNER_A, slug, "2.0.0", "public", "upstream-change"),
        entry(OWNER_A, safeSlug, "2.0.0", "public", "safe-v2"),
        entry(OWNER_A, addedSlug, "1.0.0", "public", "new-safe-flow"),
      ];
      expect((await installCatalogEntries(incomingEntries, deps)).conflicts).toBe(1);
      await getSqliteInstance().backup(sourcePath);
      const source = new Database(sourcePath);
      const target = new Database(targetPath);
      try {
        const conflict = new WorkflowReconciliationRepository(source).listConflicts()[0];
        const artifact = createWorkflowReconciliationStagedArtifact(
          source,
          "image@sha256:one",
          incomingEntries,
          [
            {
              reference: `${OWNER_A}/${slug}`,
              revision: conflict.revision,
              selection: "incoming",
              rationale: "The upstream implementation supersedes the local experiment.",
            },
          ],
        );
        target.prepare("UPDATE user SET name = ? WHERE id = ?").run("target-only", OWNER_A);
        await applyWorkflowReconciliationStagedArtifact(
          artifact,
          "image@sha256:one",
          incomingEntries,
          { ...deps, sqlite: target },
          { actorId: "system-admin", source: "test-staged" },
        );
        const stored = target
          .prepare("SELECT graph FROM workflow WHERE userId = ? AND slug = ?")
          .get(OWNER_A, slug) as { graph: string };
        expect(JSON.parse(stored.graph).nodes).toEqual(
          expect.arrayContaining([expect.objectContaining({ directive: "upstream-change" })]),
        );
        expect(target.prepare("SELECT name FROM user WHERE id = ?").get(OWNER_A)).toEqual({
          name: "target-only",
        });
        for (const [expectedSlug, directive] of [
          [safeSlug, "safe-v2"],
          [addedSlug, "new-safe-flow"],
        ]) {
          const safe = target
            .prepare("SELECT graph FROM workflow WHERE userId = ? AND slug = ?")
            .get(OWNER_A, expectedSlug) as { graph: string };
          expect(JSON.parse(safe.graph).nodes).toEqual(
            expect.arrayContaining([expect.objectContaining({ directive })]),
          );
        }
        expect(
          target
            .prepare(
              "SELECT selection, merged, rationale FROM workflowReconciliationResolution WHERE ownerId = ? AND slug = ?",
            )
            .get(OWNER_A, slug),
        ).toEqual({
          selection: "incoming",
          merged: 0,
          rationale: "The upstream implementation supersedes the local experiment.",
        });
        expect(
          target
            .prepare(
              "SELECT COUNT(*) AS count FROM workflowReconciliationConflict WHERE ownerId = ? AND slug = ?",
            )
            .get(OWNER_A, slug),
        ).toEqual({ count: 0 });
      } finally {
        source.close();
        target.close();
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  test("rejects staged identity and conflict-set drift without partial mutation", async () => {
    const slug = `loader-staged-stale-${Date.now()}`;
    await installCatalogEntries([entry(OWNER_A, slug, "1.0.0", "public", "base")], deps);
    const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const current = await deps.workflowRepo.get(id!, OWNER_A);
    (current!.nodes[1] as { directive: string }).directive = "instance-change";
    await deps.mutationService.save({
      graph: current!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    const incomingEntries = [entry(OWNER_A, slug, "2.0.0", "public", "incoming")];
    await installCatalogEntries(incomingEntries, deps);
    const sqlite = getSqliteInstance();
    const conflict = getWorkflowReconciliationStatus(sqlite).conflicts[0];
    const artifact = createWorkflowReconciliationStagedArtifact(
      sqlite,
      "image@sha256:expected",
      incomingEntries,
      [
        {
          reference: `${OWNER_A}/${slug}`,
          revision: conflict.revision,
          selection: "incoming",
          rationale: "Use the accepted upstream behavior.",
        },
      ],
    );
    const before = sqlite
      .prepare("SELECT graph FROM workflow WHERE userId = ? AND slug = ?")
      .get(OWNER_A, slug);
    await expect(
      applyWorkflowReconciliationStagedArtifact(
        artifact,
        "image@sha256:different",
        incomingEntries,
        { ...deps, sqlite },
      ),
    ).rejects.toThrow("source or catalog identity changed");
    await expect(
      applyWorkflowReconciliationStagedArtifact(
        artifact,
        "image@sha256:expected",
        [entry(OWNER_A, slug, "2.0.0", "public", "different-catalog-content")],
        { ...deps, sqlite },
      ),
    ).rejects.toThrow("source or catalog identity changed");
    await expect(
      applyWorkflowReconciliationStagedArtifact(
        { ...artifact, catalogDigest: "0".repeat(64), artifactDigest: artifact.artifactDigest },
        "image@sha256:expected",
        incomingEntries,
        { ...deps, sqlite },
      ),
    ).rejects.toThrow("Invalid staged reconciliation artifact digest");
    const { artifactDigest: _artifactDigest, ...malformedBody } = artifact;
    const malformed = {
      ...malformedBody,
      decisions: [{ ...artifact.decisions[0], selection: "unknown" }],
    };
    await expect(
      applyWorkflowReconciliationStagedArtifact(
        {
          ...malformed,
          artifactDigest: workflowReconciliationStagedArtifactDigest(malformed),
        },
        "image@sha256:expected",
        incomingEntries,
        { ...deps, sqlite },
      ),
    ).rejects.toThrow("Invalid staged reconciliation decision schema");
    await expect(
      applyWorkflowReconciliationStagedArtifact(
        { ...artifact, artifactDigest: "0".repeat(64) },
        "image@sha256:expected",
        incomingEntries,
        { ...deps, sqlite },
      ),
    ).rejects.toThrow("Invalid staged reconciliation artifact digest");
    expect(
      sqlite.prepare("SELECT graph FROM workflow WHERE userId = ? AND slug = ?").get(OWNER_A, slug),
    ).toEqual(before);
    const laterGraph = await deps.workflowRepo.get(id!, OWNER_A);
    (laterGraph!.nodes[1] as { directive: string }).directive = "later-current-change";
    await deps.mutationService.save({
      graph: laterGraph!,
      userId: OWNER_A,
      slug,
      visibility: "public",
      skipAudit: true,
    });
    const afterDrift = sqlite
      .prepare("SELECT graph FROM workflow WHERE userId = ? AND slug = ?")
      .get(OWNER_A, slug);
    await expect(
      applyWorkflowReconciliationStagedArtifact(
        artifact,
        "image@sha256:expected",
        incomingEntries,
        { ...deps, sqlite },
      ),
    ).rejects.toThrow("conflict set changed");
    expect(
      sqlite.prepare("SELECT graph FROM workflow WHERE userId = ? AND slug = ?").get(OWNER_A, slug),
    ).toEqual(afterDrift);
  });

  test("rejects a stale later decision before mutating any workflow in a staged batch", async () => {
    const stamp = Date.now();
    const slugs = [`loader-staged-batch-a-${stamp}`, `loader-staged-batch-b-${stamp}`];
    await installCatalogEntries(
      slugs.map((slug) => entry(OWNER_A, slug, "1.0.0", "public", "base")),
      deps,
    );
    for (const slug of slugs) {
      const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
      const graph = await deps.workflowRepo.get(id!, OWNER_A);
      (graph!.nodes[1] as { directive: string }).directive = `current-${slug}`;
      await deps.mutationService.save({
        graph: graph!,
        userId: OWNER_A,
        slug,
        visibility: "public",
        skipAudit: true,
      });
    }
    await installCatalogEntries(
      slugs.map((slug) => entry(OWNER_A, slug, "2.0.0", "public", `incoming-${slug}`)),
      deps,
    );
    const sqlite = getSqliteInstance();
    const conflicts = getWorkflowReconciliationStatus(sqlite).conflicts;
    const artifact = createWorkflowReconciliationStagedArtifact(
      sqlite,
      "image@sha256:batch",
      slugs.map((slug) => entry(OWNER_A, slug, "2.0.0", "public", `incoming-${slug}`)),
      conflicts.map((conflict) => ({
        reference: `${conflict.owner}/${conflict.slug}`,
        revision: conflict.revision,
        selection: "incoming" as const,
        rationale: "Use the accepted upstream batch.",
      })),
    );
    const laterId = await deps.workflowRepo.resolveSlug(slugs[1], OWNER_A);
    const laterGraph = await deps.workflowRepo.get(laterId!, OWNER_A);
    (laterGraph!.nodes[1] as { directive: string }).directive = "later-batch-change";
    await deps.mutationService.save({
      graph: laterGraph!,
      userId: OWNER_A,
      slug: slugs[1],
      visibility: "public",
      skipAudit: true,
    });
    const afterDrift = slugs.map((currentSlug) =>
      sqlite
        .prepare("SELECT graph FROM workflow WHERE userId = ? AND slug = ?")
        .get(OWNER_A, currentSlug),
    );
    await expect(
      applyWorkflowReconciliationStagedArtifact(
        artifact,
        "image@sha256:batch",
        slugs.map((slug) => entry(OWNER_A, slug, "2.0.0", "public", `incoming-${slug}`)),
        { ...deps, sqlite },
      ),
    ).rejects.toThrow("conflict set changed");
    expect(
      slugs.map((slug) =>
        sqlite
          .prepare("SELECT graph FROM workflow WHERE userId = ? AND slug = ?")
          .get(OWNER_A, slug),
      ),
    ).toEqual(afterDrift);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM workflowReconciliationResolution WHERE ownerId = ? AND slug IN (?, ?)",
        )
        .get(OWNER_A, ...slugs),
    ).toEqual({ count: 0 });
  });

  describe("multi-directory catalog → install (Step 2 end-to-end)", () => {
    const ORIGINAL_ENV = { ...process.env };

    function writeFlow(flowsDir: string, fileName: string, body: Record<string, unknown>): void {
      fs.writeFileSync(path.join(flowsDir, fileName), JSON.stringify(body, null, 2));
    }

    function makeCatalogDir(): string {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "loader-multidir-"));
      fs.mkdirSync(path.join(base, "flows"), { recursive: true });
      return base;
    }

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    test("installs the MERGED catalog from two directories, including a real-user-owned flow from the second dir", async () => {
      const publicDir = makeCatalogDir();
      const privateDir = makeCatalogDir();
      const stamp = Date.now();
      const publicSlug = `md-public-${stamp}`;
      const privateSlug = `md-private-${stamp}`;
      try {
        // Public dir: a system-owned public flow.
        writeFlow(path.join(publicDir, "flows"), "pub.json", {
          id: `pub-${stamp}`,
          slug: publicSlug,
          owner: OWNER_A,
          visibility: "public",
          metadata: { name: publicSlug, version: "1.0.0", description: "fixture" },
          nodes: [
            { id: "start", type: "start", connections: { default: "end" } },
            { id: "end", type: "end" },
          ],
        });
        // Private dir (listed last): a real-user-owned private flow.
        writeFlow(path.join(privateDir, "flows"), "priv.json", {
          id: `priv-${stamp}`,
          slug: privateSlug,
          owner: OWNER_B,
          visibility: "private",
          metadata: { name: privateSlug, version: "1.0.0", description: "fixture" },
          nodes: [
            { id: "start", type: "start", connections: { default: "end" } },
            { id: "end", type: "end" },
          ],
        });

        const merged = readWorkflowCatalogs([publicDir, privateDir]);
        expect(merged.length).toBe(2);

        const result = await installCatalogEntries(merged, deps);
        expect(result.installed).toBe(2);

        // Both the public and the private (real-user-owned, from the second dir) flow are installed.
        expect(await deps.workflowRepo.resolveSlug(publicSlug, OWNER_A)).toBeTruthy();
        expect(await deps.workflowRepo.resolveSlug(privateSlug, OWNER_B)).toBeTruthy();

        // Idempotent: re-installing the merged catalog changes nothing.
        const rerun = await installCatalogEntries(
          readWorkflowCatalogs([publicDir, privateDir]),
          deps,
        );
        expect(rerun.installed).toBe(0);
        expect(rerun.skipped).toBe(2);
      } finally {
        fs.rmSync(publicDir, { recursive: true, force: true });
        fs.rmSync(privateDir, { recursive: true, force: true });
      }
    });

    test("a later directory overrides an earlier one on the same (owner, slug) before install", async () => {
      const dirA = makeCatalogDir();
      const dirB = makeCatalogDir();
      const slug = `md-override-${Date.now()}`;
      try {
        writeFlow(path.join(dirA, "flows"), "a.json", {
          slug,
          owner: OWNER_A,
          visibility: "public",
          metadata: { name: "from-A", version: "1.0.0", description: "a" },
          nodes: [
            { id: "start", type: "start", connections: { default: "end" } },
            { id: "end", type: "end" },
          ],
        });
        writeFlow(path.join(dirB, "flows"), "b.json", {
          slug,
          owner: OWNER_A,
          visibility: "public",
          metadata: { name: "from-B", version: "2.0.0", description: "b" },
          nodes: [
            { id: "start", type: "start", connections: { default: "end" } },
            { id: "end", type: "end" },
          ],
        });

        const merged = readWorkflowCatalogs([dirA, dirB]);
        // Only one entry survives the (owner, slug) collision — the later dir (B) wins.
        expect(merged.length).toBe(1);
        expect((merged[0].graph.metadata as { name: string }).name).toBe("from-B");

        const result = await installCatalogEntries(merged, deps);
        expect(result.installed).toBe(1);
        const id = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
        const stored = await deps.workflowRepo.get(id!, OWNER_A);
        expect(stored?.metadata?.version).toBe("2.0.0");
      } finally {
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
      }
    });

    test("with WORKFLOWS_DIRS unset, getWorkflowsDirs() yields the single bundled default (self-host path)", () => {
      delete process.env.WORKFLOWS_DIRS;
      delete process.env.WORKFLOWS_DIR;
      const dirs = getWorkflowsDirs();
      expect(dirs).toEqual(["./workflows/production"]);
      // The merge over the single default dir loads the bundled public catalog (private flows live
      // in the separate private folder, merged only when WORKFLOWS_DIRS includes it).
      const entries = readWorkflowCatalogs(dirs);
      const identities = entries.map((entry) => `${entry.owner}/${entry.slug}`).sort();
      const directCatalogIdentities = readWorkflowCatalog()
        .map((entry) => `${entry.owner}/${entry.slug}`)
        .sort();
      expect(identities).toEqual(directCatalogIdentities);
      expect(identities).toContain("system-moira/workflow-management-flow");
    });
  });
});
