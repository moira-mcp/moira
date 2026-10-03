import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import {
  AdminAnalyticsRepository,
  ExecutionAttemptRepository,
  UserRepository,
  parseAnalyticsQuery,
} from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0, 123);
const HOUR = 3600000;
describe("Bounded administrative analytics on actual migrated SQLite", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let repository: AdminAnalyticsRepository;
  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
    repository = new AdminAnalyticsRepository(db, () => NOW);
    for (const id of ["admin", "old", "inactive", "session", "expired", "blocked"]) {
      const createdAt = new Date(
        id === "inactive" ? NOW - 1000 : NOW - 90 * 24 * HOUR,
      ).toISOString();
      db.insert(schema.user)
        .values({
          id,
          email: `${id}@example.test`,
          name: id,
          handle: id,
          isAdmin: id === "admin",
          createdAt,
          updatedAt: createdAt,
        })
        .run();
    }
    for (const [id, owner, visibility] of [
      ["private", "old", "private"],
      ["public", "old", "public"],
      ["admin-flow", "admin", "private"],
    ]) {
      db.insert(schema.workflow)
        .values({
          id,
          userId: owner,
          slug: id,
          name: `${id} flow`,
          version: "1.0.0",
          visibility,
          graph: "malformed graph",
          createdAt: new Date(NOW - HOUR),
          updatedAt: new Date(NOW - HOUR),
        })
        .run();
    }
  });
  afterEach(() => {
    sqlite.close();
  });
  function run(
    id: string,
    options: {
      userId?: string;
      createdAt?: number;
      state?: string;
      errors?: string;
      waiting?: boolean;
    } = {},
  ) {
    const createdAt = options.createdAt ?? NOW - 10000;
    db.insert(schema.workflowExecution)
      .values({
        executionId: id,
        workflowId: options.userId === "admin" ? "admin-flow" : "private",
        userId: options.userId ?? "old",
        state: options.state ?? "running",
        currentNodeId: "task",
        waitingForInputNodeId: options.waiting ? "task" : null,
        context: "malformed context",
        errors: options.errors ?? null,
        createdAt: new Date(createdAt),
        updatedAt: new Date(NOW - 1),
        completedAt: options.state === "completed" ? new Date(NOW - 100) : null,
      })
      .run();
  }
  function audit(
    id: string,
    userId: string,
    action: string,
    at: number,
    resourceId = "old-run",
    metadata?: string,
  ) {
    db.insert(schema.auditLog)
      .values({
        id,
        userId,
        action,
        resource: "execution",
        resourceId,
        metadata,
        createdAt: new Date(at),
      })
      .run();
  }
  const query = (range = "month", excluded?: string, limit = "6", offset = "0") =>
    parseAnalyticsQuery({
      range,
      ...(excluded === undefined ? {} : { excludeUserIds: excluded }),
      limit,
      offset,
    });
  test("counts private ownership and gives two completed runs with one refusal exactly 50 percent success", () => {
    run("success", { state: "completed", errors: '[{"errorType":"degradation"}]' });
    run("failure", { state: "completed", errors: '[{"message":"legacy refusal"}]' });
    run("excluded", { userId: "admin", state: "completed" });
    expect(repository.overview(query())).toMatchObject({
      totalUsers: 5,
      totalWorkflows: 2,
      totalExecutions: 2,
      completedExecutions: 2,
      failedExecutions: 1,
      successfulExecutions: 1,
      successRate: 50,
      activeUsers: 1,
      scope: { exclusions: { mode: "default-admins", effectiveCount: 1 } },
    });
    expect(repository.overview(query("month", "")).totalExecutions).toBe(3);
    expect(repository.overview(query("month", "old,missing"))).toMatchObject({
      totalExecutions: 1,
      totalWorkflows: 1,
      scope: { exclusions: { mode: "custom", userIds: ["missing", "old"], effectiveCount: 1 } },
    });
    sqlite.prepare("UPDATE user SET isAdmin=1 WHERE id='old'").run();
    expect(repository.overview(query()).totalExecutions).toBe(0);
  });
  test("native outcome scalars and series distinguish genuine completion, refusals and every stop marker", () => {
    const stops = new ExecutionAttemptRepository(sqlite);
    run("clean-stop");
    expect(stops.stopExecution("clean-stop", "old", 0, "Task deliberately abandoned")).toEqual({
      changed: true,
      revision: 1,
    });
    expect(repository.overview(query())).toMatchObject({
      totalExecutions: 1,
      completedExecutions: 0,
      failedExecutions: 0,
      stoppedExecutions: 1,
      successfulExecutions: 0,
      successRate: 0,
      avgDurationMs: 0,
      overTime: [{ count: 1, completed: 0, failed: 0, stopped: 1 }],
    });
    expect(repository.topWorkflows(query()).workflows[0]).toMatchObject({
      completedCount: 0,
      failedCount: 0,
      stoppedCount: 1,
      successRate: 0,
      avgDurationMs: 0,
    });
    run("success", { state: "completed", errors: '[{"errorType":"degradation"}]' });
    run("failure", { state: "completed", errors: '[{"message":"legacy refusal"}]' });
    run("stop-with-refusal", { errors: '[{"errorType":"validation"}]' });
    stops.stopExecution("stop-with-refusal", "old", 0, "No further work");
    run("empty-running-marker", { errors: '[{"errorType":"validation"}]' });
    sqlite
      .prepare("UPDATE workflowExecution SET stopReason='' WHERE executionId=?")
      .run("empty-running-marker");
    run("raw-failed", { state: "failed", errors: '[{"errorType":"validation"}]' });
    expect(repository.overview(query())).toMatchObject({
      totalExecutions: 6,
      activeExecutions: 0,
      completedExecutions: 2,
      failedExecutions: 1,
      stoppedExecutions: 3,
      successfulExecutions: 1,
      successRate: 50,
      avgDurationMs: 9900,
      overTime: [{ count: 6, completed: 2, failed: 1, stopped: 3 }],
    });
    expect(repository.topWorkflows(query()).workflows[0]).toMatchObject({
      executionCount: 6,
      completedCount: 2,
      failedCount: 1,
      stoppedCount: 3,
      successRate: 50,
      avgDurationMs: 9900,
    });
    expect(
      sqlite
        .prepare("SELECT state, stopReason FROM workflowExecution WHERE executionId=?")
        .get("empty-running-marker"),
    ).toEqual({ state: "running", stopReason: "" });
  });
  test("stopped buckets preserve the bounded chart window independently of full-period scoped outcomes", () => {
    for (let index = 0; index < 400; index++) {
      const createdAt = NOW - (400 - index) * 24 * HOUR;
      run(`bucket-${index}`, {
        createdAt,
        state: index % 4 === 3 ? "running" : "completed",
        errors: index % 4 === 1 ? '[{"errorType":"validation"}]' : '[{"errorType":"degradation"}]',
      });
      sqlite
        .prepare("UPDATE workflowExecution SET completedAt=?, stopReason=? WHERE executionId=?")
        .run(
          createdAt + (index % 4 < 2 ? 100 : 999999),
          index % 4 < 2 ? null : "",
          `bucket-${index}`,
        );
    }
    const result = repository.overview(query("all"));
    expect(result).toMatchObject({
      totalExecutions: 400,
      completedExecutions: 200,
      failedExecutions: 100,
      stoppedExecutions: 200,
      successfulExecutions: 100,
      activeExecutions: 0,
      successRate: 50,
      avgDurationMs: 100,
      scope: {
        startAt: 0,
        endAt: NOW,
        asOf: NOW,
        exclusions: { mode: "default-admins", effectiveCount: 1 },
      },
      overTimeWindow: { granularity: "daily", limit: 366, totalBuckets: 400, limited: true },
    });
    expect(result.overTime).toHaveLength(366);
    expect(result.overTime.reduce((count, bucket) => count + bucket.count, 0)).toBe(366);
    expect(result.overTime.map((bucket) => bucket.date)).toEqual(
      [...result.overTime.map((bucket) => bucket.date)].sort(),
    );
    expect(result.overTimeWindow.firstDate).toBe(result.overTime[0].date);
    expect(result.overTimeWindow.lastDate).toBe(result.overTime.at(-1)?.date);
    for (const bucket of result.overTime) {
      expect(bucket.completed + bucket.stopped).toBe(1);
      expect(bucket.failed).toBeLessThanOrEqual(bucket.completed);
    }
    expect(repository.overview(query("all", "old"))).toMatchObject({
      totalExecutions: 0,
      completedExecutions: 0,
      stoppedExecutions: 0,
      avgDurationMs: 0,
      overTime: [],
      overTimeWindow: { totalBuckets: 0, limited: false, firstDate: null, lastDate: null },
    });
  });
  test("reports old accounts with recent accepted steps and fresh sessions, never mere registration, blocked login or expired session", () => {
    run("old-run", { createdAt: NOW - 50 * 24 * HOUR });
    audit("step", "old", "execution:step", NOW - 1000);
    audit("future", "old", "execution:update-context", NOW + 1000);
    audit("signup", "inactive", "auth:sign_up", NOW - 1000);
    // Better Auth auto-signs up with a session and obtains these stamps separately.
    db.insert(schema.session)
      .values({
        id: "signup-session",
        token: "signup-session",
        userId: "inactive",
        createdAt: new Date(NOW - 1000).toISOString(),
        updatedAt: new Date(NOW - 999).toISOString(),
        expiresAt: new Date(NOW + 7 * 24 * HOUR).toISOString(),
      })
      .run();
    audit("denial", "blocked", "auth:sign_in", NOW - 1000, "blocked", '{"blocked":true}');
    for (const id of ["session", "expired"])
      db.insert(schema.session)
        .values({
          id,
          token: id,
          userId: id,
          createdAt: new Date(NOW - HOUR).toISOString(),
          updatedAt: new Date(NOW - 250).toISOString(),
          refreshedAt: new Date(NOW - 250).toISOString(),
          expiresAt: new Date(NOW + (id === "expired" ? -1 : HOUR)).toISOString(),
        })
        .run();
    const result = repository.users(query("30m"));
    expect(result.activePeople.map((person) => person.userId)).toEqual(["session", "old"]);
    expect(result.activePeopleTotal).toBe(2);
    expect(result.activePeople[0].recentSessionAt).toBe(NOW - 250);
    expect(result.activePeople[1]).toMatchObject({
      executionCount: 0,
      runningExecutions: 1,
      lastStepAt: NOW - 1000,
      currentExecutions: [
        {
          executionId: "old-run",
          workflowName: "private flow",
          currentNodeId: "task",
          lastStepAt: NOW - 1000,
        },
      ],
    });
    const registration = repository.registrations(query("week"));
    expect(registration.total).toBe(1);
    expect(registration.users[0]).toMatchObject({
      userId: "inactive",
      registeredAt: NOW - 1000,
      lastActivityAt: null,
      lastStepAt: null,
      recentSessionAt: null,
    });
    expect(repository.userActivities(["inactive"]).get("inactive")?.lastActivityAt).toBeNull();
    audit("login", "inactive", "auth:sign_in", NOW - 100, "signup-session");
    expect(repository.users(query("30m")).activePeople[0]).toMatchObject({
      userId: "inactive",
      lastActivityAt: NOW - 100,
      recentSessionAt: null,
    });
  });
  test("uses observed renewal with normalized timestamps and consistent scope, expiry and future boundaries", () => {
    const insert = (id: string, userId: string, refreshedAt: string | null, expiresAt: string) =>
      db
        .insert(schema.session)
        .values({
          id,
          token: id,
          userId,
          refreshedAt,
          expiresAt,
          createdAt: new Date(NOW - 90 * 24 * HOUR).toISOString(),
          updatedAt: new Date(NOW - 1).toISOString(),
        })
        .run();
    const at = Date.UTC(2026, 8, 30, 11, 45);
    insert("renewed", "session", "2026-09-30 11:45:00", "2026-09-30 13:00:00");
    insert(
      "admin-renewed",
      "admin",
      new Date(at + 1000).toISOString(),
      new Date(NOW + HOUR).toISOString(),
    );
    insert("expired-renewed", "expired", new Date(at).toISOString(), new Date(NOW).toISOString());
    insert(
      "future-renewed",
      "blocked",
      new Date(NOW).toISOString(),
      new Date(NOW + HOUR).toISOString(),
    );
    insert("unknown-renewal", "old", null, new Date(NOW + HOUR).toISOString());
    insert("invalid-renewal", "inactive", "now", new Date(NOW + HOUR).toISOString());
    const result = repository.users(query("30m"));
    expect(result).toMatchObject({
      activePeopleTotal: 1,
      scope: {
        startAt: NOW - HOUR / 2,
        endAt: NOW,
        asOf: NOW,
        exclusions: { mode: "default-admins", effectiveCount: 1 },
      },
      activePeople: [{ userId: "session", recentSessionAt: at, lastActivityAt: at }],
    });
    expect(repository.users(query("30m", "")).activePeople.map((person) => person.userId)).toEqual([
      "admin",
      "session",
    ]);
    expect(
      repository.users(query("30m", "session")).activePeople.map((person) => person.userId),
    ).toEqual(["admin"]);
    expect(repository.users(query("15m", "")).activePeople.map((person) => person.userId)).toEqual([
      "admin",
    ]);
    const management = repository.userActivities([
      "session",
      "admin",
      "expired",
      "blocked",
      "old",
      "inactive",
    ]);
    expect(management.get("session")?.lastActivityAt).toBe(at);
    expect(management.get("admin")?.lastActivityAt).toBe(at + 1000);
    for (const id of ["expired", "blocked", "old", "inactive"])
      expect(management.get(id)?.lastActivityAt).toBeNull();
  });
  test("preserves genuine epoch-zero accepted activity while distinguishing absent observations", () => {
    audit("epoch-step", "old", "execution:step", 0);
    db.insert(schema.session)
      .values({
        id: "epoch-renewed",
        token: "epoch-renewed",
        userId: "session",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        refreshedAt: "1970-01-01T00:00:00.000Z",
        expiresAt: new Date(NOW + HOUR).toISOString(),
      })
      .run();
    audit("later-action", "session", "execution:step", 1000);
    const result = repository.users(query("all"));
    expect(result.activePeople.map((person) => [person.userId, person.lastActivityAt])).toEqual([
      ["session", 1000],
      ["old", 0],
    ]);
    const management = repository.userActivities(["old", "session", "inactive"]);
    expect(management.get("old")?.lastActivityAt).toBe(0);
    expect(management.get("session")?.lastActivityAt).toBe(1000);
    expect(management.get("inactive")?.lastActivityAt).toBeNull();
    sqlite.prepare("DELETE FROM auditLog WHERE id='later-action'").run();
    expect(repository.userActivities(["session"]).get("session")?.lastActivityAt).toBe(0);
  });
  test("uses half-open intervals and bounded participant summaries with exclusions", () => {
    run("boundary-start", { createdAt: NOW - HOUR });
    run("boundary-end", { createdAt: NOW });
    run("participant", { userId: "session" });
    run("admin", { userId: "admin" });
    const result = repository.topWorkflows(query("hour"));
    expect(result.total).toBe(1);
    expect(result.workflows[0]).toMatchObject({
      workflowId: "private",
      executionCount: 2,
      participantCount: 2,
      lastRunAt: NOW - 10000,
      topUsers: [
        { userId: "old", executionCount: 1 },
        { userId: "session", executionCount: 1 },
      ],
    });
    expect(
      repository
        .topWorkflows(query("hour", "session"))
        .workflows.find((flow) => flow.workflowId === "private")?.participantCount,
    ).toBe(1);
  });
  test("normalizes same-day SQLite and ISO registration timestamps before filtering and chronological pagination", () => {
    sqlite.prepare("UPDATE user SET createdAt=? WHERE id='old'").run("2026-09-30 11:45:00");
    sqlite
      .prepare("UPDATE user SET createdAt=? WHERE id='inactive'")
      .run("2026-09-30T11:30:00.000Z");
    sqlite
      .prepare("UPDATE user SET createdAt=? WHERE id='expired'")
      .run("2026-09-30T12:00:00.123Z");
    const result = repository.registrations(query("today", undefined, "1"));
    expect(result.total).toBe(2);
    expect(result.users.map((person) => person.userId)).toEqual(["old"]);
    expect(result.users[0].registeredAt).toBe(Date.UTC(2026, 8, 30, 11, 45));
    expect(
      repository
        .registrations(query("today", undefined, "1", "1"))
        .users.map((person) => person.userId),
    ).toEqual(["inactive"]);
    expect(repository.users(query("today")).newUsers).toBe(2);
  });
  test("attention distinguishes old accepted-step input wait from ordinary, completed and unknown waits", () => {
    for (const id of ["stale", "recent", "unknown", "done"])
      run(id, { waiting: true, state: id === "done" ? "completed" : "running" });
    audit("stale-step", "old", "execution:step", NOW - 2 * HOUR, "stale");
    audit("recent-step", "old", "execution:step", NOW - 1000, "recent");
    audit("done-step", "old", "execution:step", NOW - 2 * HOUR, "done");
    run("failure", {
      state: "completed",
      errors: JSON.stringify([{ errorType: "validation", timestamp: NOW - 1000 }]),
    });
    run("locked");
    db.insert(schema.executionLock)
      .values({
        id: "lock",
        executionId: "locked",
        nodeId: "task",
        reason: "Review",
        lockedBy: "old",
        pin: "hash",
        status: "active",
        createdAt: new Date(NOW - 500),
      })
      .run();
    const identity = {
      title: "Review this task",
      changedAt: NOW - 1000,
      changeId: "attention-title",
    };
    sqlite
      .prepare("UPDATE workflowExecution SET taskIdentity=?, note=? WHERE executionId='locked'")
      .run(JSON.stringify(identity), "Separate operational note");
    const result = repository.attention(query("week", undefined, "2"));
    expect(result.total).toBe(3);
    expect(result.executions.map((item) => [item.executionId, item.reason])).toEqual([
      ["locked", "locked"],
      ["failure", "refusal"],
    ]);
    expect(result.executions[0]).toMatchObject({
      taskTitle: identity.title,
      taskIdentity: identity,
      note: "Separate operational note",
      displayStatus: "locked",
      revision: 0,
      stopCapability: { available: false, revision: 0, reason: "not-owner" },
    });
    expect(
      repository.attention(query("week", undefined, "2"), "old").executions[0].stopCapability,
    ).toEqual({ available: true, revision: 0 });
    expect(repository.attention(query("week", undefined, "2", "2")).executions).toEqual([
      expect.objectContaining({
        executionId: "stale",
        reason: "stale-input",
        lastStepAt: NOW - 2 * HOUR,
      }),
    ]);
  });
  test("management enrichment keeps excluded administrators and bounds samples without reading large context or graph", () => {
    for (let index = 0; index < 8; index++) {
      run(`old-${index}`);
      audit(`step-${index}`, "old", "execution:step", NOW - 1000 + index, `old-${index}`);
    }
    run("admin", { userId: "admin" });
    const before = repository.users(query("30m"));
    sqlite.prepare("UPDATE workflowExecution SET context=?").run("x".repeat(1_000_000));
    sqlite.prepare("UPDATE workflow SET graph=?").run("x".repeat(1_000_000));
    expect(repository.users(query("30m"))).toEqual(before);
    expect(before.activePeople[0].currentExecutions).toHaveLength(2);
    expect(JSON.stringify(before).length).toBeLessThan(4000);
    expect(repository.userActivities(["admin"]).get("admin")?.executionsCount).toBe(1);
  });
  test("management ID lookup filters before pagination and retains exact owned workflow counts", async () => {
    const users = new UserRepository(db);
    const selected = await users.listAdmin({
      ids: ["old", "admin"],
      sort: "email",
      sortOrder: "asc",
      limit: 1,
    });
    expect(selected.total).toBe(2);
    expect(selected.users).toEqual([expect.objectContaining({ id: "admin", workflowsCount: 1 })]);
    expect(await users.listAdmin({ ids: [] })).toEqual({ total: 0, users: [] });
    expect((await users.listAdmin({ ids: ["old"] })).users[0].workflowsCount).toBe(2);
  });
});
