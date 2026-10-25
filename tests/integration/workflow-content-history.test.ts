import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import {
  WorkflowRepository,
  WorkflowService,
  WorkflowMutationService,
  AuditRepository,
  deleteUserAccount,
} from "@mcp-moira/shared";
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
    return sqlite
      .prepare(
        "SELECT revision, content, authorId FROM entityRevision WHERE entityType='workflow' AND entityId=? ORDER BY revision",
      )
      .all(id) as Array<{ revision: number; content: string; authorId: string | null }>;
  }

  function service() {
    const audit = new AuditRepository(db);
    const result = new WorkflowService(repository, audit);
    result.setMutationService(new WorkflowMutationService(repository, audit));
    return result;
  }

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
  });
});
