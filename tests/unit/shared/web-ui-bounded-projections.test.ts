import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sql } from "drizzle-orm";
import path from "node:path";
import {
  AdminAnalyticsRepository,
  ExecutionRepository,
  NoteRepository,
  PlaybookRepository,
  SettingsRepository,
  UserRepository,
  WorkflowRepository,
  parseAnalyticsQuery,
} from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";
import {
  revisionPreviewPrefix,
  renderRevisionPreview,
} from "../../../packages/shared/src/database/revision-preview.js";

const NOW = Date.UTC(2026, 8, 30, 12);
describe("Web UI bounded SQLite projections", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
    db.insert(schema.user)
      .values({
        id: "owner",
        email: "owner@example.test",
        name: "Owner",
        handle: "owner",
        createdAt: "2024-01-01 00:00:00",
        updatedAt: "2024-01-01 00:00:00",
      })
      .run();
  });
  afterEach(() => {
    sqlite.close();
  });

  function observeNativeReads() {
    const prepare = sqlite.prepare.bind(sqlite);
    const reads: unknown[][] = [];
    const observer = jest.spyOn(sqlite, "prepare").mockImplementation(((query: string) => {
      const statement = prepare(query);
      const proxy = new Proxy(statement, {
        get(target, key) {
          const member = Reflect.get(target, key);
          if (key === "raw")
            return (...args: unknown[]) => {
              member.apply(target, args);
              return proxy;
            };
          if (key === "all")
            return (...args: unknown[]) => {
              const rows = member.apply(target, args) as unknown[];
              reads.push(rows);
              return rows;
            };
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      return proxy;
    }) as typeof sqlite.prepare);
    return { reads, restore: () => observer.mockRestore() };
  }

  it.each([
    "x".repeat(100),
    "x".repeat(99) + "😀tail",
    "😀".repeat(1000),
    "before\0after" + "x".repeat(1000),
    "",
    null,
  ])("preserves UTF-16 preview and embedded NUL with bounded native bytes: %s", (content) => {
    const row = db.get<{ prefix: Buffer | null }>(
      sql`SELECT ${revisionPreviewPrefix(sql`${content}`)} AS prefix`,
    )!;
    expect(row.prefix === null || row.prefix.byteLength <= 404).toBe(true);
    const original = content ?? "";
    expect(renderRevisionPreview(row.prefix)).toBe(
      original.length > 100 ? original.substring(0, 100) + "..." : original,
    );
  });

  it("joins only current revisions, preserves tagged sorting/counts and leaves full content available", async () => {
    const content = "a".repeat(99) + "😀" + "z".repeat(10000);
    for (const [id, key, updated] of [
      ["a", "alpha", 2],
      ["z", "zeta", 1],
    ] as const) {
      db.insert(schema.note)
        .values({
          id,
          key,
          userId: "owner",
          tags: '["tag","tag","other"]',
          currentVersion: 2,
          createdAt: new Date(1),
          updatedAt: new Date(updated),
          size: Buffer.byteLength(content),
        })
        .run();
      db.insert(schema.entityRevision)
        .values([
          {
            id: id + "1",
            entityType: "note",
            entityId: id,
            revision: 1,
            content: "obsolete",
            size: 8,
            createdAt: new Date(1),
          },
          {
            id: id + "2",
            entityType: "note",
            entityId: id,
            revision: 2,
            content,
            size: Buffer.byteLength(content),
            createdAt: new Date(2),
          },
        ])
        .run();
    }
    const repository = new NoteRepository(db);
    const native = observeNativeReads();
    const page = await repository.list({
      userId: "owner",
      tag: "tag",
      sort: "key",
      sortOrder: "desc",
      limit: 1,
    });
    native.restore();
    expect(native.reads).toHaveLength(3);
    expect(
      native.reads
        .flat(3)
        .filter(Buffer.isBuffer)
        .map((value) => value.byteLength),
    ).toEqual([404]);
    expect(native.reads.flat(3)).not.toContain(content);
    expect(page.total).toBe(2);
    expect(page.notes.map((row) => row.key)).toEqual(["zeta"]);
    expect(page.notes[0].preview).toBe(content.substring(0, 100) + "...");
    expect(page.allTags.sort()).toEqual(["other", "tag"]);
    const playbooks = new PlaybookRepository(db);
    await playbooks.save({ ownerId: "owner", slug: "example", content });
    expect((await playbooks.list({ ownerId: "owner" })).playbooks[0].preview).toBe(
      content.substring(0, 100) + "...",
    );
    expect((await playbooks.get("owner", "example"))?.content).toBe(content);
  });

  function flow(id: string, created: number, updated = created) {
    const graph = JSON.stringify({
      metadata: { name: "Юникод 😀", version: "1.0.0" },
      nodes: [{ id: "hidden", data: "x".repeat(50000) }],
    });
    db.insert(schema.workflow)
      .values({
        id,
        userId: "owner",
        slug: id,
        name: id,
        version: "1.0.0",
        graph,
        createdAt: new Date(created),
        updatedAt: new Date(updated),
      })
      .run();
    return graph;
  }
  it("uses creation sort and consistent UTF-8 byte size while retaining full engine graphs", async () => {
    const graph = flow("early", 1, 100);
    flow("late", 2, 50);
    const repository = new WorkflowRepository(db);
    const filter = {
      userId: "owner",
      sort: "createdAt" as const,
      sortOrder: "asc" as const,
      limit: 1,
    };
    const native = observeNativeReads();
    const summary = await repository.listSummaries(filter);
    native.restore();
    expect(native.reads.flat(3)).not.toContain(graph);
    expect(
      native.reads
        .flat(3)
        .filter((value) => typeof value === "string")
        .every((value) => value.length < 1000),
    ).toBe(true);
    const full = await repository.listWithFilters(filter);
    expect(summary.total).toBe(2);
    expect(summary.workflows[0].id).toBe("early");
    expect(summary.workflows[0]).not.toHaveProperty("workflow");
    expect(summary.workflows[0].size).toBe(Buffer.byteLength(graph, "utf8"));
    expect(full.workflows[0].size).toBe(summary.workflows[0].size);
    expect(full.workflows[0].workflow.nodes).toHaveLength(1);
    expect((await repository.list("owner"))[0].size).toBe(Buffer.byteLength(graph, "utf8"));
    expect((await repository.getFullInfo("early", "owner"))?.size).toBe(
      Buffer.byteLength(graph, "utf8"),
    );
    sqlite.prepare("UPDATE workflow SET deleted=1 WHERE id='early'").run();
    expect((await repository.listDeleted("owner"))[0].size).toBe(Buffer.byteLength(graph, "utf8"));
  });

  it("bulk built-in settings preserve present JSON null/false/zero and use two reads regardless of definitions", async () => {
    for (let i = 0; i < 40; i++)
      db.insert(schema.settingDefinition)
        .values({
          key: `fixture-${i}`,
          category: "fixture",
          label: "Fixture",
          type: i === 0 ? "json" : i === 1 ? "boolean" : "number",
          defaultValue: i === 0 ? "null" : i === 1 ? "false" : "0",
          createdAt: new Date(1),
          updatedAt: new Date(1),
        })
        .run();
    const repository = new SettingsRepository(db);
    const native = observeNativeReads();
    const values = await repository.getSettings("owner", "fixture");
    native.restore();
    expect(native.reads).toHaveLength(2);
    expect(Object.keys(values)).toHaveLength(40);
    expect(values).toMatchObject({ "fixture-0": null, "fixture-1": false, "fixture-2": 0 });
  });

  it("projects admin choices before SQLite transfer and shares full inventory filters/count/page", async () => {
    const hidden = "legacy-extra-" + "x".repeat(100000);
    sqlite
      .prepare("UPDATE user SET approvedAt=?,isAdmin=1,image=?,blockedReason=? WHERE id='owner'")
      .run(hidden, hidden, hidden);
    for (let i = 0; i < 4; i++)
      db.insert(schema.user)
        .values({
          id: `choice-${i}`,
          email: `choice-${i}@example.test`,
          name: i === 0 ? null : `Choice ${i}`,
          handle: `choice-${i}`,
          createdAt: `2026-01-0${i + 1}`,
          updatedAt: "2026-01-01",
        })
        .run();
    const repository = new UserRepository(db);
    const before = observeNativeReads();
    const full = await repository.listAdmin({ ids: ["owner"] });
    before.restore();
    expect(before.reads.flat(3)).toContain(hidden);
    const after = observeNativeReads();
    const compact = await repository.listAdminLookup({ ids: ["owner"] });
    after.restore();
    expect(after.reads).toHaveLength(2);
    expect(after.reads.flat(3)).not.toContain(hidden);
    expect(compact.users).toEqual([
      { id: "owner", email: "owner@example.test", name: "Owner", isAdmin: true },
    ]);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(full)) / 100,
    );
    for (const filter of [
      { ids: [] },
      { ids: ["choice-0", "choice-2", "missing"], sort: "email" as const },
      { search: "choice", sort: "name" as const, sortOrder: "asc" as const, offset: 1, limit: 2 },
      { search: "example", sort: "createdAt" as const, sortOrder: "desc" as const, limit: 1 },
      { limit: 1000, offset: -1 },
    ]) {
      const management = await repository.listAdmin(filter);
      const choices = await repository.listAdminLookup(filter);
      expect(choices.total).toBe(management.total);
      expect(choices.users).toEqual(
        management.users.map(({ id, name, email, isAdmin }) => ({ id, name, email, isAdmin })),
      );
    }
  });

  it("shares summary and full-list access/filter rules including direct and group grants", async () => {
    db.insert(schema.user)
      .values({
        id: "other",
        email: "other@example.test",
        name: "Other",
        handle: "other",
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      })
      .run();
    for (const id of ["owned", "direct", "grouped", "public", "hidden", "deleted"]) flow(id, 1);
    sqlite.prepare("UPDATE workflow SET userId='other' WHERE id!='owned'").run();
    sqlite.prepare("UPDATE workflow SET visibility='public',isValid=1 WHERE id='public'").run();
    sqlite.prepare("UPDATE workflow SET deleted=1 WHERE id='deleted'").run();
    db.insert(schema.principalGroup)
      .values({ id: "team", name: "Team", createdBy: "owner", createdAt: new Date(1) })
      .run();
    db.insert(schema.principalGroupMember)
      .values({ groupId: "team", userId: "owner", addedAt: new Date(1) })
      .run();
    db.insert(schema.accessGrant)
      .values([
        {
          id: "direct-grant",
          resourceType: "workflow",
          resourceId: "direct",
          userId: "owner",
          grantedBy: "other",
          grantedAt: new Date(1),
        },
        {
          id: "group-grant",
          resourceType: "workflow",
          resourceId: "grouped",
          groupId: "team",
          grantedBy: "other",
          grantedAt: new Date(1),
        },
      ])
      .run();
    const repository = new WorkflowRepository(db);
    for (const options of [
      {},
      { access: "shared" as const },
      { access: "mine" as const },
      { access: "catalog" as const },
      { visibility: "private" as const },
      { validationStatus: "valid" as const },
      { slugs: [] },
      { slugs: ["direct", "hidden"] },
      { search: "public", limit: 1 },
    ]) {
      const filter = { userId: "owner", ...options };
      const summary = await repository.listSummaries(filter);
      const full = await repository.listWithFilters(filter);
      expect(summary.total).toBe(full.total);
      expect(summary.workflows.map((row) => row.id)).toEqual(full.workflows.map((row) => row.id));
      expect(summary.workflows.map((row) => row.id)).not.toContain("hidden");
      expect(summary.workflows.map((row) => row.id)).not.toContain("deleted");
    }
    expect((await repository.listSummaries({ userId: "owner" })).total).toBe(4);
  });

  it("normalizes advanced registration cohorts and leaves malformed timestamps unknown", () => {
    for (const [id, createdAt] of [
      ["space", "2026-09-30 10:00:00"],
      ["iso", "2026-09-30T10:00:00.123Z"],
      ["invalid", "now"],
      ["future", "2026-09-30T12:00:00Z"],
    ])
      db.insert(schema.user)
        .values({
          id,
          email: `${id}@example.test`,
          name: id,
          handle: id,
          createdAt,
          updatedAt: createdAt,
        })
        .run();
    const repository = new AdminAnalyticsRepository(db, () => NOW);
    const query = parseAnalyticsQuery({ range: "today", excludeUserIds: "" });
    expect(repository.conversion(query)).toMatchObject({
      funnel: [
        { stage: "registered", count: 2 },
        { stage: "verified", count: 0 },
        { stage: "first_workflow", count: 0 },
        { stage: "active", count: 0 },
      ],
      registrationTrend: [{ date: "2026-09-30", value: 2 }],
      registrationTrendWindow: { totalBuckets: 1, limited: false },
    });
    expect(repository.engagement(query)).toMatchObject({
      returningUsersRate: 0,
      returningUsersCount: 0,
      avgTimeToFirstWorkflowDays: null,
    });
  });

  it("counts all current runs per workflow without the old hundred-run sample", async () => {
    flow("flow", 1);
    for (let i = 0; i < 125; i++)
      db.insert(schema.workflowExecution)
        .values({
          executionId: `run-${i}`,
          workflowId: "flow",
          userId: "owner",
          state: i === 124 ? "completed" : "running",
          currentNodeId: "task",
          context: "not JSON",
          createdAt: new Date(1),
          updatedAt: new Date(1),
        })
        .run();
    expect(await new ExecutionRepository(db).runningCountsByWorkflow("owner")).toEqual({
      totalWorkflows: 1,
      workflows: [{ workflowId: "flow", executionCount: 124 }],
    });
  });

  it("bounds daily/hourly charts before transfer while full-period counters and unknown all comparison remain honest", () => {
    flow("flow", 1);
    for (let i = 0; i < 400; i++) {
      const at = NOW - (400 - i) * 86400000;
      db.insert(schema.workflowExecution)
        .values({
          executionId: `run-${i}`,
          workflowId: "flow",
          userId: "owner",
          state: "completed",
          currentNodeId: "task",
          context: "not JSON",
          createdAt: new Date(at),
          updatedAt: new Date(at),
          completedAt: new Date(at + 1),
        })
        .run();
      db.insert(schema.auditLog)
        .values({
          id: `audit-${i}`,
          userId: "owner",
          action: "execution:step",
          resource: "execution",
          source: "mcp",
          createdAt: new Date(at),
        })
        .run();
    }
    const repository = new AdminAnalyticsRepository(db, () => NOW);
    const query = parseAnalyticsQuery({ range: "all", excludeUserIds: "" });
    const native = observeNativeReads();
    const overview = repository.overview(query);
    native.restore();
    expect(native.reads.every((rows) => rows.length <= 366)).toBe(true);
    expect(overview.totalExecutions).toBe(400);
    expect(overview.overTime).toHaveLength(366);
    expect(overview.overTimeWindow).toMatchObject({ totalBuckets: 400, limited: true, limit: 366 });
    expect(overview.overTime.map((row) => row.date)).toEqual(
      [...overview.overTime.map((row) => row.date)].sort(),
    );
    expect(repository.engagement(query)).toMatchObject({
      returningUsersRate: null,
      returningUsersCount: null,
      totalActiveUsers: 1,
      activeUsersTrendWindow: { totalBuckets: 400, limited: true },
    });
    const operational = repository.operational("all", "hourly");
    expect(operational.metrics).toHaveLength(6);
    for (const metric of operational.metrics)
      expect(metric).toMatchObject({
        available: true,
        timeSeriesWindow: { totalBuckets: 400, limited: true, granularity: "hourly" },
      });
    expect(operational.metrics.find((metric) => metric.name === "total_calls_per_day")?.value).toBe(
      400,
    );
    expect(
      operational.metrics.find((metric) => metric.name === "workflows_completed_per_day")?.value,
    ).toBe(400);
    expect(operational.metrics.find((metric) => metric.name === "calls_per_second")?.value).toBe(0);
  });
});
