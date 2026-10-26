import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  WorkflowRepository,
  WorkflowService,
  WorkflowMutationService,
  AuditRepository,
  deleteUserAccount,
  RevisionRepository,
} from "@mcp-moira/shared";
import {
  migrateWorkflowRevisionPayloads,
  readRevisionPayload,
} from "../../packages/shared/src/database/revision-payload.js";
import { WorkflowReconciliationRepository } from "../../packages/shared/src/database/repositories/workflow-reconciliation-repository.js";
import { upgradeStoredWorkflowDefinitions } from "../../packages/shared/src/services/workflow-definition-upgrade.js";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import * as schema from "../../packages/shared/src/database/schema.js";

const OWNER = "history-owner";
const graph = (description: string): WorkflowGraph => ({
  metadata: { name: "History fixture", version: "1.0.0", description },
  nodes: [
    { id: "start", type: "start", connections: { default: "end" } },
    { id: "end", type: "end" },
  ],
  variableRegistry: { tone: { type: "string", description: "Tone", default: "plain" } },
});

describe("workflow content history", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let repository: WorkflowRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: path.resolve("packages/web-backend/drizzle") });
    for (const id of [OWNER, "other", "reader", "stranger"])
      sqlite
        .prepare("INSERT INTO user(id,email,name,handle,createdAt,updatedAt) VALUES (?,?,?,?,?,?)")
        .run(id, `${id}@example.test`, id, id, "now", "now");
    sqlite.pragma("foreign_keys = ON");
    repository = new WorkflowRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function snapshots(id: string) {
    const rows = sqlite
      .prepare(
        "SELECT revision, content, payloadId, authorId FROM entityRevision WHERE entityType='workflow' AND entityId=? ORDER BY revision",
      )
      .all(id) as Array<{
      revision: number;
      content: string | null;
      payloadId: string | null;
      authorId: string | null;
    }>;
    return rows.map(({ payloadId, ...row }) => ({
      ...row,
      content:
        payloadId === null
          ? row.content!
          : readRevisionPayload(
              db
                .select()
                .from(schema.revisionPayload)
                .where(eq(schema.revisionPayload.id, payloadId))
                .get() ?? null,
              id,
            ),
    }));
  }

  function service() {
    const audit = new AuditRepository(db);
    const result = new WorkflowService(repository, audit);
    result.setMutationService(new WorkflowMutationService(repository, audit));
    return result;
  }

  test("a compressed snapshot survives an actual process-locale change and equal content still deduplicates", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "moira-revision-locale-"));
    const source = (name: string) => JSON.stringify(pathToFileURL(path.resolve(name)).href);
    const script = `
      import Database from "better-sqlite3";
      import { drizzle } from "drizzle-orm/better-sqlite3";
      import { migrate } from "drizzle-orm/better-sqlite3/migrator";
      import { readFileSync, writeFileSync } from "node:fs";
      import { RevisionRepository } from ${source("packages/shared/src/database/repositories/revision-repository.ts")};
      import { canonicalJson } from ${source("packages/shared/src/utils/canonical-json.ts")};
      import * as schema from ${source("packages/shared/src/database/schema.ts")};
      const input = JSON.parse(readFileSync(0, "utf8"));
      const sqlite = new Database(input.database);
      const db = drizzle(sqlite, { schema });
      if (input.first) migrate(db, { migrationsFolder: "packages/web-backend/drizzle" });
      const revisions = new RevisionRepository(db);
      const target = { entityType: "workflow", entityId: "locale-portable" };
      try {
      const before = await revisions.get(target, 1);
      const appended = await revisions.append({ ...target, content: JSON.stringify(input.value) });
      const after = await revisions.get(target, appended.revision);
      const count = sqlite.prepare("SELECT count(*) AS count FROM revisionPayload").get().count;
      writeFileSync(input.result, JSON.stringify({ locale: Intl.DateTimeFormat().resolvedOptions().locale, legacy: canonicalJson(input.value), before: before?.content, after: after.content, revision: appended.revision, count }));
      } catch (error) {
        process.stderr.write(String(error));
        process.exitCode = 1;
      } finally {
        sqlite.close();
      }
    `;
    const value = { name: "English", имя: "Русский", nested: [{ name: "First", имя: "Второй" }] };
    const run = (locale: string, first: boolean) => {
      const result = path.join(directory, locale + ".json");
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, LC_ALL: locale, LANG: locale },
        input: JSON.stringify({
          database: path.join(directory, "history.db"),
          result,
          first,
          value,
        }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return JSON.parse(readFileSync(result, "utf8")) as {
        locale: string;
        legacy: string;
        before?: string;
        after: string;
        revision: number;
        count: number;
      };
    };
    try {
      const english = run("en_US.UTF-8", true);
      const russian = run("ru_RU.UTF-8", false);
      expect(english.locale).toBe("en-US");
      expect(russian.locale).toBe("ru-RU");
      expect(russian.legacy).not.toBe(english.legacy);
      expect(JSON.parse(russian.before!)).toEqual(value);
      expect(JSON.parse(russian.after)).toEqual(value);
      expect(russian.revision).toBe(2);
      expect(russian.count).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("separate saves retain complete immutable snapshots even when semantic versions repeat", async () => {
    const { id } = await repository.save({ graph: graph("first"), userId: OWNER });
    const first = await repository.get(id, OWNER);
    await repository.save({
      graph: { ...first!, metadata: graph("second").metadata },
      userId: OWNER,
    });
    const history = snapshots(id);
    expect(history.map((item) => item.revision)).toEqual([1, 2]);
    expect(history.map((item) => JSON.parse(item.content).metadata.description)).toEqual([
      "first",
      "second",
    ]);
    expect(JSON.parse(history[0].content)).toEqual(first);
    expect(history.map((item) => item.authorId)).toEqual([OWNER, OWNER]);
  });

  test("a stale write creates no snapshot and a failed append rolls back the graph", async () => {
    const { id } = await repository.save({ graph: graph("accepted"), userId: OWNER });
    const original = await repository.get(id, OWNER);
    await expect(
      repository.save({
        graph: { ...original!, metadata: graph("stale").metadata },
        userId: OWNER,
        expectedRevision: 8,
      }),
    ).rejects.toMatchObject({ name: "WorkflowRevisionConflictError" });
    expect(snapshots(id)).toHaveLength(1);
    sqlite.exec(
      "CREATE TRIGGER refuse_history BEFORE INSERT ON entityRevision WHEN NEW.entityType='workflow' BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
    );
    await expect(
      repository.save({
        graph: { ...original!, metadata: graph("must roll back").metadata },
        userId: OWNER,
        expectedRevision: 0,
      }),
    ).rejects.toThrow("history unavailable");
    expect(await repository.get(id, OWNER)).toEqual(original);
    expect((await repository.getFullInfo(id, OWNER))?.revision).toBe(0);
    expect(snapshots(id)).toHaveLength(1);
    expect(sqlite.prepare("SELECT count(*) AS count FROM revisionPayload").get()).toEqual({
      count: 1,
    });
  });

  test("equal definitions share compressed complete bytes while every save retains its own revision", async () => {
    const initial = graph("Repeated readable text. ".repeat(500));
    const { id } = await repository.save({ graph: initial, userId: OWNER });
    const current = (await repository.get(id, OWNER))!;
    await repository.save({
      graph: {
        nodes: current.nodes,
        metadata: current.metadata,
        id: current.id,
        variableRegistry: current.variableRegistry,
      },
      userId: OWNER,
    });
    const rows = sqlite
      .prepare(
        "SELECT revision, content, payloadId, authorId FROM entityRevision WHERE entityId=? ORDER BY revision",
      )
      .all(id) as Array<{ revision: number; content: null; payloadId: string; authorId: string }>;
    expect(rows.map((row) => row.revision)).toEqual([1, 2]);
    expect(rows.map((row) => row.authorId)).toEqual([OWNER, OWNER]);
    expect(rows.map((row) => row.content)).toEqual([null, null]);
    expect(rows[1].payloadId).toBe(rows[0].payloadId);
    const payloads = db.select().from(schema.revisionPayload).all();
    expect(payloads).toHaveLength(1);
    const bytes = gunzipSync(payloads[0].data);
    expect(bytes.length).toBe(payloads[0].decodedSize);
    expect(payloads[0].data.length).toBeLessThan(bytes.length / 2);
    expect(bytes.toString()).not.toContain('\n  "');
    expect(JSON.parse(bytes.toString())).toEqual(current);
    expect((await repository.getRevision(id, 1))?.content).toContain('\n  "');
    await repository.save({
      graph: { ...current, metadata: { ...current.metadata, description: "One changed line" } },
      userId: OWNER,
    });
    await service().rollback(id, OWNER, 1, 2);
    expect(snapshots(id).map((row) => row.revision)).toEqual([1, 2, 3, 4]);
    expect(db.select().from(schema.revisionPayload).all()).toHaveLength(2);
    expect(await repository.get(id, OWNER)).toEqual(current);
    expect(
      (await service().compareRevisions(id, OWNER, 2, 3))?.parts.find((part) => part.added)?.value,
    ).toContain("One changed line");
  });

  test("forward conversion preserves legacy revision metadata and leaves other entity storage unchanged", async () => {
    const { id } = await repository.save({ graph: graph("legacy"), userId: OWNER });
    const current = await repository.get(id, OWNER);
    sqlite.prepare("DELETE FROM entityRevision WHERE entityId=?").run(id);
    const insert = sqlite.prepare(
      "INSERT INTO entityRevision(id,entityType,entityId,revision,content,size,authorId,createdAt) VALUES(?,?,?,?,?,?,?,?)",
    );
    for (const [revision, content, authorId] of [
      [1, JSON.stringify(current, null, 2), OWNER],
      [2, JSON.stringify(current), null],
    ] as const)
      insert.run(
        `legacy-${revision}`,
        "workflow",
        id,
        revision,
        content,
        Buffer.byteLength(content),
        authorId,
        123 + revision,
      );
    insert.run("plain-note", "note", "note-id", 1, "plain note", 10, OWNER, 321);
    insert.run("null-setting", "global-setting", "setting", 1, null, 0, OWNER, 456);
    const metadata = () =>
      sqlite
        .prepare(
          "SELECT id,entityType,entityId,revision,size,authorId,createdAt FROM entityRevision ORDER BY id",
        )
        .all();
    const before = metadata();
    expect(JSON.parse((await repository.getRevision(id, 1))!.content!)).toEqual(current);
    migrateWorkflowRevisionPayloads(db);
    expect(metadata()).toEqual(before);
    expect(
      sqlite.prepare("SELECT content FROM entityRevision WHERE entityType='workflow'").all(),
    ).toEqual([{ content: null }, { content: null }]);
    expect(db.select().from(schema.revisionPayload).all()).toHaveLength(1);
    expect(JSON.parse((await repository.getRevision(id, 2))!.content!)).toEqual(current);
    const plain = sqlite
      .prepare(
        "SELECT content,payloadId FROM entityRevision WHERE id IN ('plain-note','null-setting') ORDER BY id",
      )
      .all();
    expect(plain).toEqual([
      { content: null, payloadId: null },
      { content: "plain note", payloadId: null },
    ]);
    migrateWorkflowRevisionPayloads(db);
    expect(metadata()).toEqual(before);
    expect(db.select().from(schema.revisionPayload).all()).toHaveLength(1);
  });

  test("a malformed legacy snapshot rolls back conversion instead of discarding original content", () => {
    sqlite
      .prepare(
        "INSERT INTO entityRevision(id,entityType,entityId,revision,content,size,createdAt) VALUES('valid','workflow','legacy',1,'{}',2,1),('broken','workflow','legacy',2,'not-json',8,2)",
      )
      .run();
    const before = sqlite.prepare("SELECT * FROM entityRevision ORDER BY revision").all();
    expect(() => migrateWorkflowRevisionPayloads(db)).toThrow();
    expect(sqlite.prepare("SELECT * FROM entityRevision ORDER BY revision").all()).toEqual(before);
    expect(db.select().from(schema.revisionPayload).all()).toEqual([]);
  });

  test.each(["missing", "corrupt", "digest", "codec", "size"] as const)(
    "%s full payload is an explicit failure, never an empty successful revision",
    async (damage) => {
      const { id } = await repository.save({ graph: graph("retained"), userId: OWNER });
      if (damage === "missing") {
        sqlite.pragma("foreign_keys = OFF");
        sqlite.prepare("DELETE FROM revisionPayload").run();
      } else if (damage === "corrupt")
        sqlite.prepare("UPDATE revisionPayload SET data=?").run(Buffer.from("not-gzip"));
      else if (damage === "digest")
        sqlite.prepare("UPDATE revisionPayload SET digest=?").run("0".repeat(64));
      else if (damage === "codec")
        sqlite.prepare("UPDATE revisionPayload SET codec='unknown'").run();
      else sqlite.prepare("UPDATE revisionPayload SET decodedSize=1").run();
      await expect(repository.getRevision(id, 1)).rejects.toThrow(
        "Revision payload is missing or corrupt",
      );
      await expect(repository.compareRevisions(id, 1, 1)).rejects.toThrow(
        "Revision payload is missing or corrupt",
      );
      await expect(service().rollback(id, OWNER, 1, 0)).rejects.toThrow(
        "Revision payload is missing or corrupt",
      );
      expect((await repository.get(id, OWNER))?.metadata.description).toBe("retained");
    },
  );

  test("pruning keeps referenced payloads and direct deletion removes only their final reference", async () => {
    const revisions = new RevisionRepository(db);
    const target = { entityType: "workflow" as const, entityId: "retained" };
    await revisions.append({ ...target, content: '{"value":"same"}', maxRevisions: 2 });
    await revisions.append({ ...target, content: '{"value":"same"}', maxRevisions: 2 });
    await revisions.append({ ...target, content: '{"value":"different"}', maxRevisions: 2 });
    expect((await revisions.list(target)).map((row) => row.revision)).toEqual([3, 2]);
    expect(db.select().from(schema.revisionPayload).all()).toHaveLength(2);
    sqlite
      .prepare("DELETE FROM entityRevision WHERE entityId=? AND revision=2")
      .run(target.entityId);
    expect(db.select().from(schema.revisionPayload).all()).toHaveLength(1);
    expect(JSON.parse((await revisions.get(target, 3))!.content!)).toEqual({ value: "different" });
    await revisions.deleteHistory(target);
    expect(db.select().from(schema.revisionPayload).all()).toEqual([]);
  });

  test.each(["rollback", "guarded edit"] as const)(
    "%s refuses a deletion completed after its final authority read without changing the deleted row or history",
    async (operation) => {
      const api = service();
      const { id } = await api.save({ graph: graph("first"), userId: OWNER });
      await api.save({ graph: { ...graph("second"), id }, userId: OWNER, expectedRevision: 0 });
      const before = snapshots(id);
      const ordinarySave = repository.save.bind(repository);
      const ordinaryCanModify = repository.canModify.bind(repository);
      let saving = false;
      let deletionSucceeded = false;
      let deletedRow: unknown;
      // Pause the authorisation result only once the content writer has begun, after rollback's
      // own admission. This models the acknowledged second writer at the actual async boundary.
      repository.save = async (options) => {
        saving = true;
        return ordinarySave(options);
      };
      repository.canModify = async (...args) => {
        const allowed = await ordinaryCanModify(...args);
        if (saving) {
          deletionSucceeded = await repository.softDelete(id, OWNER);
          deletedRow = sqlite.prepare("SELECT * FROM workflow WHERE id=?").get(id);
        }
        return allowed;
      };

      const attempted =
        operation === "rollback"
          ? api.rollback(id, OWNER, 1, 1)
          : api.save({
              graph: { ...graph("must not overwrite deletion"), id },
              userId: OWNER,
              isUpdate: true,
              expectedRevision: 1,
            });
      await expect(attempted).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });
      expect(deletionSucceeded).toBe(true);
      expect(deletedRow).toMatchObject({ deleted: 1, revision: 1 });
      expect(sqlite.prepare("SELECT * FROM workflow WHERE id=?").get(id)).toEqual(deletedRow);
      expect(snapshots(id)).toEqual(before);
    },
  );

  test("explicit creation ignores a supplied guard while leaving an existing deleted definition untouched", async () => {
    const { id } = await repository.save({ graph: graph("deleted"), userId: OWNER });
    await repository.softDelete(id, OWNER);
    const before = sqlite.prepare("SELECT * FROM workflow WHERE id=?").get(id);
    const history = snapshots(id);
    const created = await service().save({
      graph: graph("explicit new definition"),
      userId: OWNER,
      isUpdate: false,
      expectedRevision: 999,
    });
    expect(created.id).not.toBe(id);
    expect(created.revision).toBe(0);
    expect((await repository.get(created.id, OWNER))?.metadata.description).toBe(
      "explicit new definition",
    );
    expect(sqlite.prepare("SELECT * FROM workflow WHERE id=?").get(id)).toEqual(before);
    expect(snapshots(id)).toEqual(history);
  });

  test("the first edit of a pre-feature workflow records its actual previous graph once", async () => {
    const { id } = await repository.save({ graph: graph("before feature"), userId: OWNER });
    sqlite.prepare("DELETE FROM entityRevision WHERE entityType='workflow' AND entityId=?").run(id);
    const before = await repository.get(id, OWNER);
    await repository.save({
      graph: { ...before!, metadata: graph("first new edit").metadata },
      userId: OWNER,
    });
    const rows = snapshots(id);
    expect(rows.map((row) => JSON.parse(row.content).metadata.description)).toEqual([
      "before feature",
      "first new edit",
    ]);
    expect(rows.map((row) => row.authorId)).toEqual([null, OWNER]);
  });

  test("rollback appends a new full definition while retaining publication, identity and grants", async () => {
    const api = service();
    const initial: WorkflowGraph = {
      ...graph("first"),
      nodes: [
        { id: "start", type: "start", connections: { default: "work" } },
        {
          id: "work",
          type: "agent-directive",
          directive: "Write in a {{tone}} tone",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
      systemReminder: "Keep the authored reminder",
      runtimePolicy: { externalVariableWrites: { tone: { allowedNodeIds: ["work"] } } },
    };
    const { id } = await api.save({ graph: initial, userId: OWNER, visibility: "private" });
    const original = await repository.get(id, OWNER);
    await api.save({ graph: { ...original!, metadata: graph("second").metadata }, userId: OWNER });
    await repository.updateVisibility(id, OWNER, "public");
    sqlite
      .prepare(
        "INSERT INTO accessGrant (id, resourceType, resourceId, userId, level, grantedBy, grantedAt) VALUES ('history-reader','workflow',?,'reader','use',?,?)",
      )
      .run(id, OWNER, Date.now());
    const grants = sqlite.prepare("SELECT * FROM accessGrant WHERE resourceId=?").all(id);
    await expect(api.history(id, "stranger")).rejects.toMatchObject({
      code: "WORKFLOW_ACCESS_DENIED",
    });
    await expect(api.rollback(id, "reader", 1, 1)).rejects.toMatchObject({
      code: "WORKFLOW_ACCESS_DENIED",
    });
    const restored = await api.rollback(id, OWNER, 1, 1);
    expect(restored).toMatchObject({
      workflowId: id,
      revision: 2,
      historyRevision: 3,
      restoredFrom: 1,
    });
    expect(await repository.get(id, OWNER)).toEqual(original);
    expect((await repository.getFullInfo(id, OWNER))?.visibility).toBe("public");
    expect(sqlite.prepare("SELECT * FROM accessGrant WHERE resourceId=?").all(id)).toEqual(grants);
    expect(snapshots(id).map((row) => JSON.parse(row.content).metadata.description)).toEqual([
      "first",
      "second",
      "first",
    ]);
    const diff = await api.compareRevisions(id, OWNER, 1, 2);
    expect(diff?.parts.find((part) => part.added)?.value).toContain("second");
    expect(await api.compareRevisions(id, OWNER, 1, 99)).toBeNull();
    expect(
      (await api.compareRevisions(id, OWNER, 1, 1))?.parts.every(
        (part) => !part.added && !part.removed,
      ),
    ).toBe(true);
    await expect(api.rollback(id, OWNER, 1, 1)).rejects.toMatchObject({
      name: "WorkflowRevisionConflictError",
    });
    expect(snapshots(id)).toHaveLength(3);
  });

  test("an invalid stored definition cannot replace the current valid graph or create history", async () => {
    const invalid = { ...graph("old invalid"), nodes: [{ id: "end", type: "end" as const }] };
    const { id } = await repository.save({ graph: invalid, userId: OWNER });
    await repository.save({ graph: { ...graph("valid now"), id }, userId: OWNER });
    const before = await repository.get(id, OWNER);
    await expect(service().rollback(id, OWNER, 1, 1)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(await repository.get(id, OWNER)).toEqual(before);
    expect(snapshots(id)).toHaveLength(2);
  });

  test("catalog replacement and removal share history and preserve system authorship", async () => {
    const { id } = await repository.save({ graph: graph("local"), userId: OWNER });
    const catalog = new WorkflowReconciliationRepository(sqlite);
    const common = {
      preconditions: [],
      conflictPreconditions: [],
      baselinePreconditions: [],
      baselines: [],
      conflicts: [],
      clearConflicts: [],
    };
    catalog.apply({
      ...common,
      workflows: [
        {
          owner: OWNER,
          slug: "history-fixture",
          workflowId: id,
          state: {
            lifecycle: "present",
            content: { graph: { ...graph("catalog") }, visibility: "private" },
          },
        },
      ],
    });
    expect(snapshots(id).map((row) => row.authorId)).toEqual([OWNER, null]);
    expect(JSON.parse(snapshots(id)[1].content).metadata.description).toBe("catalog");
    catalog.apply({
      ...common,
      workflows: [
        { owner: OWNER, slug: "history-fixture", workflowId: id, state: { lifecycle: "absent" } },
      ],
    });
    expect(snapshots(id)).toEqual([]);
    expect(await repository.get(id, OWNER)).toBeNull();
  });

  test("startup schema upgrade records a new snapshot without rewriting previous history", async () => {
    const { id } = await repository.save({ graph: graph("before upgrade"), userId: OWNER });
    const oldGraph = graph("legacy stored graph");
    sqlite
      .prepare("UPDATE workflow SET graph=? WHERE id=?")
      .run(JSON.stringify({ ...oldGraph, id }), id);
    sqlite.prepare("DELETE FROM entityRevision WHERE entityType='workflow' AND entityId=?").run(id);
    expect(upgradeStoredWorkflowDefinitions(sqlite).workflows).toBe(1);
    const before = snapshots(id);
    expect(before).toHaveLength(2);
    expect(JSON.parse(before[0].content).metadata.schemaVersion).toBeUndefined();
    expect(JSON.parse(before[1].content).metadata.schemaVersion).toBe(1);
    expect(upgradeStoredWorkflowDefinitions(sqlite).workflows).toBe(0);
    expect(snapshots(id)).toEqual(before);
  });

  test("soft deletion retains history, permanent deletion and account cascade remove only owned history", async () => {
    const first = await repository.save({ graph: graph("soft then hard"), userId: OWNER });
    const other = await repository.save({ graph: graph("other owner"), userId: "other" });
    await repository.softDelete(first.id, OWNER);
    expect(snapshots(first.id)).toHaveLength(1);
    await repository.delete(first.id, OWNER);
    expect(snapshots(first.id)).toEqual([]);
    const last = await repository.save({ graph: graph("account deleted"), userId: OWNER });
    deleteUserAccount(db, OWNER);
    expect(snapshots(last.id)).toEqual([]);
    expect(await repository.get(last.id, OWNER)).toBeNull();
    expect(snapshots(other.id)).toHaveLength(1);
    expect(
      db.select({ entityId: schema.revisionPayload.entityId }).from(schema.revisionPayload).all(),
    ).toEqual([{ entityId: other.id }]);
  });
});
