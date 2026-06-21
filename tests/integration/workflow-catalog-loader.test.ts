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

import { describe, test, expect, beforeAll, afterEach } from "@jest/globals";
import fs from "fs";
import path from "path";
import os from "os";
import {
  getDatabase,
  user,
  WorkflowRepository,
  UserRepository,
  getWorkflowMutationService,
  installCatalogEntries,
  readWorkflowCatalogs,
  getWorkflowsDirs,
  CatalogContentMismatchError,
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
): CatalogEntry {
  return {
    id: `${owner}-${slug}`,
    slug,
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

  test("throws on a same-version content mismatch", async () => {
    const slug = `loader-mismatch-${Date.now()}`;
    await installCatalogEntries(
      [entry(OWNER_A, slug, "1.0.0", "public", "Original directive")],
      deps,
    );

    await expect(
      installCatalogEntries([entry(OWNER_A, slug, "1.0.0", "public", "CHANGED directive")], deps),
    ).rejects.toBeInstanceOf(CatalogContentMismatchError);
  });

  test("non-destructive: loading one owner's flow does not affect another owner's same-slug flow", async () => {
    const slug = `loader-shared-slug-${Date.now()}`;
    await installCatalogEntries([entry(OWNER_A, slug, "1.0.0", "public", "A's flow")], deps);
    await installCatalogEntries([entry(OWNER_B, slug, "1.0.0", "private", "B's flow")], deps);

    // Both exist independently under their own owners.
    const idA = await deps.workflowRepo.resolveSlug(slug, OWNER_A);
    const idB = await deps.workflowRepo.resolveSlug(slug, OWNER_B);
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);

    // Re-loading A unchanged leaves B untouched.
    const rerun = await installCatalogEntries(
      [entry(OWNER_A, slug, "1.0.0", "public", "A's flow")],
      deps,
    );
    expect(rerun.outcomes[0].outcome).toBe("skipped-unchanged");
    expect(await deps.workflowRepo.resolveSlug(slug, OWNER_B)).toBe(idB);
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
      expect(entries.length).toBeGreaterThanOrEqual(30);
    });
  });
});
