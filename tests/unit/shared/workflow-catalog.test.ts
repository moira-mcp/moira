/**
 * Workflow Catalog Reader Unit Tests (Step 12)
 *
 * Verifies the owner-aware catalog representation and enumeration:
 *  - each flow file carries owner + visibility (catalog metadata, not part of the graph body);
 *  - the catalog is enumerated into one entry per file;
 *  - owner/visibility resolve correctly and system vs user ownership is distinguishable;
 *  - catalog identity is (owner, slug) — the same slug under different owners never collides;
 *  - the real production catalog enumerates the full set.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import path from "path";
import os from "os";
import {
  readWorkflowCatalog,
  readWorkflowCatalogs,
  readCatalogEntry,
  catalogByOwnerSlug,
  ownerSlugKey,
  isSystemOwner,
  getCatalogDir,
  getWorkflowsDirs,
  SYSTEM_OWNER_IDS,
} from "@mcp-moira/shared";

function writeFlow(dir: string, fileName: string, body: Record<string, unknown>): string {
  const p = path.join(dir, fileName);
  fs.writeFileSync(p, JSON.stringify(body, null, 2));
  return p;
}

describe("Workflow Catalog Reader", () => {
  let baseDir: string;
  let flowsDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-test-"));
    flowsDir = path.join(baseDir, "flows");
    fs.mkdirSync(flowsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe("isSystemOwner", () => {
    test("recognizes the system owners and rejects user ids", () => {
      expect(SYSTEM_OWNER_IDS).toEqual(["system-admin", "system-moira"]);
      expect(isSystemOwner("system-admin")).toBe(true);
      expect(isSystemOwner("system-moira")).toBe(true);
      expect(isSystemOwner("0sssypxGkwdXBSDdzQLte3Tsu6yFGUBo")).toBe(false);
      expect(isSystemOwner("")).toBe(false);
    });
  });

  describe("readCatalogEntry", () => {
    test("resolves owner/visibility/slug and strips catalog keys from the graph body", () => {
      const p = writeFlow(flowsDir, "uuid-1.json", {
        id: "uuid-1",
        slug: "demo-flow",
        owner: "system-moira",
        visibility: "public",
        metadata: { name: "Demo", version: "1.0.0", description: "d" },
        nodes: [{ id: "start", type: "start", connections: { default: "end" } }],
      });

      const entry = readCatalogEntry(p);

      expect(entry.id).toBe("uuid-1");
      expect(entry.slug).toBe("demo-flow");
      expect(entry.owner).toBe("system-moira");
      expect(entry.visibility).toBe("public");
      expect(entry.isSystemOwner).toBe(true);
      // Graph body excludes catalog-only metadata.
      expect("owner" in entry.graph).toBe(false);
      expect("visibility" in entry.graph).toBe(false);
      expect("nodes" in entry.graph).toBe(true);
      expect("metadata" in entry.graph).toBe(true);
    });

    test("marks a user-owned flow as not system-owned", () => {
      const p = writeFlow(flowsDir, "uuid-2.json", {
        id: "uuid-2",
        slug: "my-private-flow",
        owner: "0sssypxGkwdXBSDdzQLte3Tsu6yFGUBo",
        visibility: "private",
        metadata: { name: "Mine", version: "1.0.0", description: "d" },
        nodes: [{ id: "start", type: "start", connections: { default: "end" } }],
      });

      const entry = readCatalogEntry(p);
      expect(entry.owner).toBe("0sssypxGkwdXBSDdzQLte3Tsu6yFGUBo");
      expect(entry.isSystemOwner).toBe(false);
      expect(entry.visibility).toBe("private");
    });

    test("throws on missing owner", () => {
      const p = writeFlow(flowsDir, "bad-owner.json", {
        slug: "x",
        visibility: "public",
        nodes: [],
      });
      expect(() => readCatalogEntry(p)).toThrow(/owner/);
    });

    test("throws on invalid visibility", () => {
      const p = writeFlow(flowsDir, "bad-vis.json", {
        slug: "x",
        owner: "system-admin",
        visibility: "secret",
        nodes: [],
      });
      expect(() => readCatalogEntry(p)).toThrow(/visibility/);
    });
  });

  describe("readWorkflowCatalog", () => {
    test("returns an empty array when the catalog directory does not exist", () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-empty-"));
      try {
        expect(readWorkflowCatalog(path.join(empty, "production"))).toEqual([]);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });

    test("enumerates one entry per flow file", () => {
      writeFlow(flowsDir, "a.json", {
        slug: "a",
        owner: "system-moira",
        visibility: "public",
        nodes: [],
      });
      writeFlow(flowsDir, "b.json", {
        slug: "b",
        owner: "system-admin",
        visibility: "private",
        nodes: [],
      });

      const entries = readWorkflowCatalog(baseDir);
      expect(entries.length).toBe(2);
      expect(entries.map((e) => e.slug).sort()).toEqual(["a", "b"]);
    });

    test("preserves per-owner duplicates of the same slug under distinct (owner, slug) keys", () => {
      writeFlow(flowsDir, "sys-moira.json", {
        id: "sys-moira",
        slug: "shared-slug",
        owner: "system-moira",
        visibility: "public",
        nodes: [],
      });
      writeFlow(flowsDir, "sys-admin.json", {
        id: "sys-admin",
        slug: "shared-slug",
        owner: "system-admin",
        visibility: "private",
        nodes: [],
      });

      const entries = readWorkflowCatalog(baseDir);
      // Both kept, not collapsed by slug.
      expect(entries.filter((e) => e.slug === "shared-slug").length).toBe(2);

      const byKey = catalogByOwnerSlug(entries);
      expect(byKey.size).toBe(2);
      expect(byKey.get(ownerSlugKey("system-moira", "shared-slug"))?.visibility).toBe("public");
      expect(byKey.get(ownerSlugKey("system-admin", "shared-slug"))?.visibility).toBe("private");
    });
  });

  describe("real production catalog", () => {
    test("enumerates the full set with system and user owners distinguishable", () => {
      // getCatalogDir() resolves against the process cwd → the real repo catalog.
      const realDir = getCatalogDir();
      if (!fs.existsSync(realDir)) {
        throw new Error(`Production catalog dir not found at ${realDir}`);
      }
      const entries = readWorkflowCatalog();

      // Every file is a valid catalog entry with the required metadata.
      // The public OSS repo bundles the public catalog only; private flows live in the
      // separate private catalog folder (moira-infra), merged at build time via WORKFLOWS_DIRS.
      expect(entries.length).toBeGreaterThanOrEqual(30);
      for (const e of entries) {
        expect(typeof e.owner).toBe("string");
        expect(e.owner.length).toBeGreaterThan(0);
        expect(["public", "private"]).toContain(e.visibility);
        expect("owner" in e.graph).toBe(false);
        expect("visibility" in e.graph).toBe(false);
      }

      // Identity is (owner, slug): no two entries share the same key.
      const byKey = catalogByOwnerSlug(entries);
      expect(byKey.size).toBe(entries.length);

      // The bundled public catalog is system-owned (system-admin / system-moira). The
      // real-user-owner guarantee belongs to the MERGED catalog (public + private dirs) and is
      // covered by the multi-directory integration test, not this public-only bundle.
      expect(entries.some((e) => e.isSystemOwner)).toBe(true);
      expect(entries.every((e) => e.isSystemOwner)).toBe(true);
    });
  });

  describe("readWorkflowCatalogs (multi-directory merge)", () => {
    let dirA: string;
    let dirB: string;

    beforeEach(() => {
      dirA = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-A-"));
      dirB = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-B-"));
      fs.mkdirSync(path.join(dirA, "flows"), { recursive: true });
      fs.mkdirSync(path.join(dirB, "flows"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    });

    test("returns the union of two directories", () => {
      writeFlow(path.join(dirA, "flows"), "pub.json", {
        slug: "public-flow",
        owner: "system-moira",
        visibility: "public",
        nodes: [],
      });
      writeFlow(path.join(dirB, "flows"), "priv.json", {
        slug: "private-flow",
        owner: "0sssypxGkwdXBSDdzQLte3Tsu6yFGUBo",
        visibility: "private",
        nodes: [],
      });

      const entries = readWorkflowCatalogs([dirA, dirB]);
      expect(entries.length).toBe(2);
      expect(entries.map((e) => e.slug).sort()).toEqual(["private-flow", "public-flow"]);
      // The merged set carries a real (non-system) owner from the second directory.
      expect(entries.some((e) => !e.isSystemOwner)).toBe(true);
    });

    test("a LATER directory overrides an earlier one on an (owner, slug) collision", () => {
      writeFlow(path.join(dirA, "flows"), "v1.json", {
        id: "v1",
        slug: "shared",
        owner: "system-admin",
        visibility: "private",
        metadata: { name: "From A", version: "1.0.0", description: "a" },
        nodes: [],
      });
      writeFlow(path.join(dirB, "flows"), "v2.json", {
        id: "v2",
        slug: "shared",
        owner: "system-admin",
        visibility: "private",
        metadata: { name: "From B", version: "2.0.0", description: "b" },
        nodes: [],
      });

      const entries = readWorkflowCatalogs([dirA, dirB]);
      // One merged entry for the colliding (owner, slug); the LATER directory (B) wins.
      const matches = entries.filter((e) => e.owner === "system-admin" && e.slug === "shared");
      expect(matches.length).toBe(1);
      expect(matches[0].id).toBe("v2");
      expect((matches[0].graph.metadata as { name: string }).name).toBe("From B");
    });

    test("preserves per-owner duplicate slugs across directories (only exact (owner,slug) collides)", () => {
      writeFlow(path.join(dirA, "flows"), "moira.json", {
        slug: "dup",
        owner: "system-moira",
        visibility: "public",
        nodes: [],
      });
      writeFlow(path.join(dirB, "flows"), "admin.json", {
        slug: "dup",
        owner: "system-admin",
        visibility: "private",
        nodes: [],
      });

      const entries = readWorkflowCatalogs([dirA, dirB]);
      // Same slug, different owners → both survive (distinct (owner, slug) keys).
      expect(entries.filter((e) => e.slug === "dup").length).toBe(2);
      const byKey = catalogByOwnerSlug(entries);
      expect(byKey.get(ownerSlugKey("system-moira", "dup"))?.visibility).toBe("public");
      expect(byKey.get(ownerSlugKey("system-admin", "dup"))?.visibility).toBe("private");
    });

    test("skips missing/empty directories", () => {
      writeFlow(path.join(dirA, "flows"), "only.json", {
        slug: "only",
        owner: "system-moira",
        visibility: "public",
        nodes: [],
      });
      const missing = path.join(dirB, "does-not-exist");

      const entries = readWorkflowCatalogs([dirA, missing, dirB]);
      // dirB has an empty flows/ dir, `missing` does not exist → only dirA's flow remains.
      expect(entries.length).toBe(1);
      expect(entries[0].slug).toBe("only");
    });

    test("a single-directory list equals readWorkflowCatalog(dir)", () => {
      writeFlow(path.join(dirA, "flows"), "a.json", {
        slug: "a",
        owner: "system-moira",
        visibility: "public",
        nodes: [],
      });
      writeFlow(path.join(dirA, "flows"), "b.json", {
        slug: "b",
        owner: "system-admin",
        visibility: "private",
        nodes: [],
      });

      const single = readWorkflowCatalog(dirA);
      const merged = readWorkflowCatalogs([dirA]);
      expect(merged.map((e) => ownerSlugKey(e.owner, e.slug)).sort()).toEqual(
        single.map((e) => ownerSlugKey(e.owner, e.slug)).sort(),
      );
    });
  });

  describe("getWorkflowsDirs (config helper)", () => {
    const ORIGINAL = { ...process.env };

    afterEach(() => {
      process.env = { ...ORIGINAL };
    });

    test("defaults to the single bundled directory when no env is set (backward compatible)", () => {
      delete process.env.WORKFLOWS_DIRS;
      delete process.env.WORKFLOWS_DIR;
      expect(getWorkflowsDirs()).toEqual(["./workflows/production"]);
    });

    test("falls back to the single WORKFLOWS_DIR when WORKFLOWS_DIRS is unset", () => {
      delete process.env.WORKFLOWS_DIRS;
      process.env.WORKFLOWS_DIR = "./custom/catalog";
      expect(getWorkflowsDirs()).toEqual(["./custom/catalog"]);
    });

    test("parses a colon-separated WORKFLOWS_DIRS list in order", () => {
      process.env.WORKFLOWS_DIRS = "./workflows/production:./private-workflows/production";
      expect(getWorkflowsDirs()).toEqual([
        "./workflows/production",
        "./private-workflows/production",
      ]);
    });

    test("drops empty/whitespace-only segments", () => {
      process.env.WORKFLOWS_DIRS = " ./a :: ./b : ";
      expect(getWorkflowsDirs()).toEqual(["./a", "./b"]);
    });
  });
});
