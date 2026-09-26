/**
 * The bundled playbook catalog: playbooks that ship with Moira are installed under the system
 * owner, upgraded by version, and reconciled three-way like bundled flows — an upstream change
 * applies, a local edit survives, and a change on both sides keeps the local text and is reported.
 * The learning example's reference to its playbook resolves for anybody who saves a copy.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  AuditRepository,
  AuthorizationService,
  MAX_PLAYBOOK_SIZE,
  PlaybookRepository,
  PlaybookService,
  UserRepository,
  WorkflowMutationService,
  WorkflowRepository,
  findCatalogEntryBySlug,
  getWorkflowsDirs,
  installPlaybookCatalog,
  readPlaybookCatalogEntry,
  readPlaybookCatalogs,
  type PlaybookCatalogEntry,
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import * as schema from "../../packages/shared/src/database/schema.js";

const SYSTEM = "system-moira";
const LEARNER = "playbook-catalog-learner";

function entry(overrides: Partial<PlaybookCatalogEntry> = {}): PlaybookCatalogEntry {
  return {
    owner: SYSTEM,
    slug: "clear-report",
    version: "1.0.0",
    name: "Clear report",
    description: "What a short report contains.",
    visibility: "public",
    content: "Say what was asked, what was done and how it was checked.",
    filePath: "/catalog/playbooks/clear-report.json",
    ...overrides,
  };
}

describe("bundled playbook catalog", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let playbooks: PlaybookRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
    const now = new Date().toISOString();
    const insert = sqlite.prepare(
      "INSERT INTO user (id, email, handle, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(SYSTEM, "moira@example.test", "moira", now, now);
    insert.run(LEARNER, "learner@example.test", "learner", now, now);
    playbooks = new PlaybookRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  const classifications = async (entries: PlaybookCatalogEntry[]) =>
    (await installPlaybookCatalog(entries, db)).outcomes.map((outcome) => outcome.classification);

  test("a first start installs the playbook under its owner, public, at revision 1", async () => {
    expect(await classifications([entry()])).toEqual(["first-install"]);
    const installed = await playbooks.get(SYSTEM, "clear-report");
    expect(installed).toMatchObject({
      ownerId: SYSTEM,
      visibility: "public",
      name: "Clear report",
      revision: 1,
      content: entry().content,
    });
  });

  test("a later start with the same catalog changes nothing", async () => {
    await installPlaybookCatalog([entry()], db);
    expect(await classifications([entry()])).toEqual(["unchanged"]);
    expect((await playbooks.get(SYSTEM, "clear-report"))!.revision).toBe(1);
  });

  test("an upstream change applies as a new revision", async () => {
    await installPlaybookCatalog([entry()], db);
    const upgraded = entry({ version: "1.1.0", content: "A new checklist." });
    expect(await classifications([upgraded])).toEqual(["upstream-only"]);
    const stored = await playbooks.get(SYSTEM, "clear-report");
    expect(stored).toMatchObject({ revision: 2, content: "A new checklist." });
    expect((await playbooks.get(SYSTEM, "clear-report", 1))!.content).toBe(entry().content);
  });

  test.each([
    ["the name", { name: "Clear report of work" }],
    ["the visibility", { visibility: "private" as const }],
  ])("an upstream change of %s alone applies", async (_what, change) => {
    await installPlaybookCatalog([entry()], db);
    expect(await classifications([entry({ version: "1.1.0", ...change })])).toEqual([
      "upstream-only",
    ]);
    expect(await playbooks.get(SYSTEM, "clear-report")).toMatchObject(change);
  });

  test("an older catalog does not roll the playbook back", async () => {
    await installPlaybookCatalog(
      [entry({ version: "1.1.0", content: "The newer checklist." })],
      db,
    );
    expect(await classifications([entry({ version: "1.0.0" })])).toEqual(["skipped-older"]);
    expect(await playbooks.get(SYSTEM, "clear-report")).toMatchObject({
      revision: 1,
      content: "The newer checklist.",
    });
  });

  test("new content under an unchanged version is kept out and reported", async () => {
    await installPlaybookCatalog([entry()], db);
    const repackaged = await installPlaybookCatalog([entry({ content: "Changed quietly." })], db);
    expect(repackaged.conflicts).toEqual([{ owner: SYSTEM, slug: "clear-report" }]);
    expect((await playbooks.get(SYSTEM, "clear-report"))!.content).toBe(entry().content);
  });

  test("a local edit survives a start whose catalog did not change", async () => {
    await installPlaybookCatalog([entry()], db);
    await playbooks.save({ ownerId: SYSTEM, slug: "clear-report", content: "Edited here." });
    expect(await classifications([entry()])).toEqual(["user-only"]);
    expect((await playbooks.get(SYSTEM, "clear-report"))!.content).toBe("Edited here.");
  });

  test("a playbook removed here stays removed while the catalog is unchanged", async () => {
    await installPlaybookCatalog([entry()], db);
    const installed = await playbooks.get(SYSTEM, "clear-report");
    await playbooks.remove(installed!.id);
    expect(await classifications([entry()])).toEqual(["user-only"]);
    expect(await playbooks.get(SYSTEM, "clear-report")).toBeNull();
  });

  test("a change on both sides keeps the local text, reports it, and keeps reporting it", async () => {
    await installPlaybookCatalog([entry()], db);
    await playbooks.save({ ownerId: SYSTEM, slug: "clear-report", content: "Edited here." });
    const upgraded = entry({ version: "1.1.0", content: "A new checklist." });

    const first = await installPlaybookCatalog([upgraded], db);
    expect(first.conflicts).toEqual([{ owner: SYSTEM, slug: "clear-report" }]);
    expect((await playbooks.get(SYSTEM, "clear-report"))!.content).toBe("Edited here.");

    // The baseline did not move, so the next start still sees the same two-sided change.
    expect((await installPlaybookCatalog([upgraded], db)).conflicts).toHaveLength(1);
  });

  test("a playbook whose owner does not exist here is skipped, not reassigned", async () => {
    expect(await classifications([entry({ owner: "someone-absent" })])).toEqual([
      "skipped-missing-owner",
    ]);
    expect(await playbooks.get(SYSTEM, "clear-report")).toBeNull();
  });

  test("the shipped catalog holds the English and Russian report playbooks, public and owned by the system", () => {
    const shipped = readPlaybookCatalogs(getWorkflowsDirs()).map(
      ({ owner, slug, visibility }) => `${owner}/${slug}/${visibility}`,
    );
    expect(shipped.sort()).toEqual([
      "system-moira/clear-report-ru/public",
      "system-moira/clear-report/public",
    ]);
  });

  test.each([
    ["without an owner", { owner: undefined }, "missing a non-empty 'owner'"],
    ["with a name the playbook service would refuse", { slug: "Clear Report" }, "invalid 'slug'"],
    ["with an unknown visibility", { visibility: "shared" }, "invalid 'visibility'"],
    ["with a version that is not semver", { version: "latest" }, "invalid 'version'"],
    ["over the size cap", { content: "x".repeat(MAX_PLAYBOOK_SIZE + 1) }, "holds more than"],
  ])("a catalog file %s is refused", (_what, change, message) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-catalog-"));
    try {
      const file = path.join(dir, "playbook.json");
      fs.writeFileSync(file, JSON.stringify({ ...entry(), filePath: undefined, ...change }));
      expect(() => readPlaybookCatalogEntry(file)).toThrow(message);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("a learner's copy of the example", () => {
    let mutations: WorkflowMutationService;

    beforeEach(async () => {
      await installPlaybookCatalog(readPlaybookCatalogs(getWorkflowsDirs()), db);
      mutations = new WorkflowMutationService(
        new WorkflowRepository(db),
        new AuditRepository(db),
        undefined,
        new PlaybookService(
          new PlaybookRepository(db),
          new AuditRepository(db),
          new AuthorizationService(db),
          new UserRepository(db),
        ),
      );
    });

    const copyOf = (slug: string, transform: (text: string) => string = (text) => text) => {
      const graph = structuredClone(
        findCatalogEntryBySlug(slug)!.graph,
      ) as unknown as WorkflowGraph;
      for (const node of graph.nodes as unknown as Array<Record<string, unknown>>) {
        if (typeof node.completionCondition === "string") {
          node.completionCondition = transform(node.completionCondition);
        }
      }
      return graph;
    };

    test.each(["example-simple-steps", "example-simple-steps-ru"])(
      "a copy of %s saves for a user who does not own the playbook",
      async (slug) => {
        const saved = await mutations.save({ graph: copyOf(slug), userId: LEARNER });
        expect(saved.validation.status).toBe("valid");
      },
    );

    test("the same reference without its owner would name the learner's own playbook and is refused", async () => {
      const saved = await mutations.save({
        graph: copyOf("example-simple-steps", (text) =>
          text.replace("{{playbook:@moira/", "{{playbook:"),
        ),
        userId: LEARNER,
      });
      expect(saved.validation.status).toBe("invalid");
      expect(saved.validation.errors.join("\n")).toContain("clear-report");
    });
  });
});
