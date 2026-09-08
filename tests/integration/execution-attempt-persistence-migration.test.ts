import { describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ExecutionAttemptRepository,
  ExecutionRepository,
  type ExecutionAttemptClaimResult,
} from "@mcp-moira/shared";
import { workflowGraphDigest } from "@mcp-moira/workflow-engine";
import type {
  PreparedStartExecutionAttempt,
  PresentedExecutionAttempt,
  WorkflowExecution,
  WorkflowGraph,
} from "@mcp-moira/workflow-engine";

const MIGRATIONS = path.resolve(process.cwd(), "packages/web-backend/drizzle");

function seedBaseline(sqlite: Database.Database) {
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO user (id, email, handle, createdAt, updatedAt)
       VALUES ('attempt-user', 'attempt@example.test', 'attempt-user', ?, ?)`,
    )
    .run(new Date(now).toISOString(), new Date(now).toISOString());
  sqlite
    .prepare(
      `INSERT INTO workflow (id, userId, slug, name, description, version, graph, visibility, createdAt, updatedAt)
       VALUES ('attempt-workflow', 'attempt-user', 'attempt-workflow', 'Attempt workflow',
         'Migration preservation', '1.0.0', '{}', 'private', ?, ?)`,
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO workflowExecution
       (executionId, workflowId, userId, state, currentNodeId, waitingForInputNodeId,
        context, revision, reminders, createdAt, updatedAt)
       VALUES ('attempt-execution', 'attempt-workflow', 'attempt-user', 'running', 'task', 'task',
         ?, 3, '[]', ?, ?)`,
    )
    .run(
      JSON.stringify({
        variables: { preserved: true },
        nodeStates: {},
        executionId: "attempt-execution",
        workflowId: "attempt-workflow",
        userId: "attempt-user",
      }),
      now,
      now,
    );
}

function presented(): PresentedExecutionAttempt {
  return {
    attemptId: "attempt-1",
    userId: "attempt-user",
    executionId: "attempt-execution",
    executionRevision: 3,
    nodeId: "task",
    workflowId: "attempt-workflow",
    workflowVersion: "1.0.0",
    workflowDigest: "digest",
    response: "Process ID: attempt-execution\nStep attempt ID: attempt-1\n\nTask",
    createdAt: Date.now(),
  };
}

function startGraph(): WorkflowGraph {
  return {
    id: "attempt-workflow",
    metadata: { name: "Attempt workflow", version: "1.0.0", description: "Start attempt" },
    nodes: [
      { type: "start", id: "start", connections: { default: "task" } },
      {
        type: "agent-directive",
        id: "task",
        directive: "Task",
        completionCondition: "Done",
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

function preparedStart(index: number, now = Date.now()): PreparedStartExecutionAttempt {
  const graph = startGraph();
  return {
    attemptId: `start-attempt-${index}`,
    userId: "attempt-user",
    reservedExecutionId: `start-execution-${index}`,
    workflowId: graph.id!,
    workflowVersion: graph.metadata.version,
    workflowDigest: workflowGraphDigest(graph),
    requestPayload: JSON.stringify({
      note: null,
      parentExecutionId: null,
      skipNotificationCheck: true,
    }),
    inputFingerprint: `start-fingerprint-${index}`,
    expiresAt: now + 15 * 60_000,
    createdAt: now,
  };
}

describe("execution attempt migration and persistence", () => {
  test("the migration preserves baseline relational data and creates usable attempt storage", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-attempt-migration-"));
    const filename = path.join(directory, "moira.db");
    const sqlite = new Database(filename);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
      sqlite.exec("DROP TABLE executionMutationAttempt");
      sqlite
        .prepare(
          "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)",
        )
        .run();
      seedBaseline(sqlite);

      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });

      expect(sqlite.prepare("SELECT email FROM user WHERE id = 'attempt-user'").get()).toEqual({
        email: "attempt@example.test",
      });
      expect(
        sqlite.prepare("SELECT slug FROM workflow WHERE id = 'attempt-workflow'").get(),
      ).toEqual({ slug: "attempt-workflow" });
      expect(
        sqlite
          .prepare("SELECT revision, context FROM workflowExecution WHERE executionId = ?")
          .get("attempt-execution"),
      ).toEqual(expect.objectContaining({ revision: 3 }));

      const attempts = new ExecutionAttemptRepository(sqlite);
      attempts.createPresented(presented());
      expect(attempts.get("attempt-1")?.state).toBe("presented");
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("a completed receipt and current presentation survive repository restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-attempt-restart-"));
    const filename = path.join(directory, "moira.db");
    let sqlite = new Database(filename);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
      seedBaseline(sqlite);
      let attempts = new ExecutionAttemptRepository(sqlite);
      attempts.createPresented(presented());
      const claim: ExecutionAttemptClaimResult = attempts.claim({
        attemptId: "attempt-1",
        userId: "attempt-user",
        executionId: "attempt-execution",
        executionRevision: 3,
        nodeId: "task",
        workflowId: "attempt-workflow",
        workflowVersion: "1.0.0",
        workflowDigest: "digest",
        inputFingerprint: "fingerprint",
        ownerId: "owner",
        now: Date.now(),
        leaseMs: 30_000,
      });
      expect(claim.kind).toBe("claimed");
      const execution = await new ExecutionRepository(drizzle(sqlite)).get("attempt-execution");
      const next: PresentedExecutionAttempt = {
        ...presented(),
        attemptId: "attempt-2",
        nodeId: "next",
        response: "Process ID: attempt-execution\nStep attempt ID: attempt-2\n\nNext",
      };
      const changed: WorkflowExecution = {
        ...execution!,
        currentNodeId: "next",
        waitingForInputNodeId: "next",
        updatedAt: Date.now(),
      };
      expect(
        attempts.complete({
          attemptId: "attempt-1",
          ownerId: "owner",
          fence: claim.kind === "claimed" ? claim.fence : 0,
          inputFingerprint: "fingerprint",
          execution: changed,
          expectedExecution: execution!,
          response: "durable receipt",
          nextAttempt: next,
        }),
      ).toBe(true);
      sqlite.close();

      sqlite = new Database(filename);
      attempts = new ExecutionAttemptRepository(sqlite);
      expect(attempts.get("attempt-1")?.response).toBe("durable receipt");
      expect(attempts.getCurrent("attempt-execution", "attempt-user")?.attemptId).toBe("attempt-2");
    } finally {
      if (sqlite.open) sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("cleanup keeps the current attempt and the newest one thousand receipts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-attempt-retention-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
      seedBaseline(sqlite);
      const now = Date.now();
      const insert = sqlite.prepare(
        `INSERT INTO executionMutationAttempt
         (attemptId, operation, userId, executionId, executionRevision, nodeId, workflowId,
          workflowVersion, workflowDigest, inputFingerprint, state, response, createdAt, updatedAt,
          completedAt)
         VALUES (?, 'step', 'attempt-user', 'attempt-execution', 3, 'task', 'attempt-workflow',
          '1.0.0', 'digest', 'fingerprint', 'completed', ?, ?, ?, ?)`,
      );
      sqlite.transaction(() => {
        for (let index = 0; index < 1_002; index += 1) {
          const timestamp = now - index;
          insert.run(`receipt-${index}`, `response-${index}`, timestamp, timestamp, timestamp);
        }
      })();
      new ExecutionAttemptRepository(sqlite).createPresented({
        ...presented(),
        attemptId: "current-old-presentation",
        createdAt: now - 8 * 24 * 60 * 60 * 1_000,
      });

      const removed = new ExecutionAttemptRepository(sqlite).cleanup(now);
      expect(removed).toBe(2);
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS count FROM executionMutationAttempt WHERE state = 'completed'",
          )
          .get(),
      ).toEqual({ count: 1_000 });
      expect(new ExecutionAttemptRepository(sqlite).get("current-old-presentation")?.state).toBe(
        "presented",
      );
      expect(new ExecutionAttemptRepository(sqlite).get("receipt-0")?.response).toBe("response-0");
      expect(new ExecutionAttemptRepository(sqlite).get("receipt-1001")).toBeNull();
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("cleanup independently evicts completed receipts older than seven days", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-attempt-age-retention-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
      seedBaseline(sqlite);
      const now = Date.now();
      const insert = sqlite.prepare(
        `INSERT INTO executionMutationAttempt
         (attemptId, operation, userId, executionId, executionRevision, nodeId, workflowId,
          workflowVersion, workflowDigest, inputFingerprint, state, response, createdAt, updatedAt,
          completedAt)
         VALUES (?, 'step', 'attempt-user', 'attempt-execution', 3, 'task', 'attempt-workflow',
          '1.0.0', 'digest', 'fingerprint', 'completed', ?, ?, ?, ?)`,
      );
      const expiredAt = now - 7 * 24 * 60 * 60 * 1_000 - 1;
      insert.run("expired-by-age", "expired", expiredAt, expiredAt, expiredAt);
      insert.run("fresh-by-age", "fresh", now, now, now);

      const attempts = new ExecutionAttemptRepository(sqlite);
      expect(attempts.cleanup(now)).toBe(1);
      expect(attempts.get("expired-by-age")).toBeNull();
      expect(attempts.get("fresh-by-age")?.response).toBe("fresh");
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("separate SQLite connections preserve a live fenced owner", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-attempt-owners-"));
    const filename = path.join(directory, "moira.db");
    const firstSqlite = new Database(filename);
    let secondSqlite: Database.Database | undefined;
    try {
      firstSqlite.pragma("journal_mode = WAL");
      migrate(drizzle(firstSqlite), { migrationsFolder: MIGRATIONS });
      seedBaseline(firstSqlite);
      secondSqlite = new Database(filename);
      secondSqlite.pragma("journal_mode = WAL");
      const first = new ExecutionAttemptRepository(firstSqlite);
      const second = new ExecutionAttemptRepository(secondSqlite);
      first.createPresented(presented());
      const claimInput = {
        attemptId: "attempt-1",
        userId: "attempt-user",
        executionId: "attempt-execution",
        executionRevision: 3,
        nodeId: "task",
        workflowId: "attempt-workflow",
        workflowVersion: "1.0.0",
        workflowDigest: "digest",
        inputFingerprint: "fingerprint",
        ownerId: "first-process",
        now: 1_000,
        leaseMs: 30_000,
      };
      const claim = first.claim(claimInput);
      expect(claim.kind).toBe("claimed");
      expect(second.claim({ ...claimInput, ownerId: "second-process" }).kind).toBe("processing");
      expect(
        first.heartbeat(
          "attempt-1",
          "first-process",
          claim.kind === "claimed" ? claim.fence : 0,
          20_000,
          30_000,
        ),
      ).toBe(true);
      expect(second.reconcileExpired(31_001)).toEqual({ start: 0, step: 0 });

      const execution = await new ExecutionRepository(drizzle(firstSqlite)).get(
        "attempt-execution",
      );
      expect(
        first.complete({
          attemptId: "attempt-1",
          ownerId: "first-process",
          fence: claim.kind === "claimed" ? claim.fence : 0,
          inputFingerprint: "fingerprint",
          execution: { ...execution!, status: "completed", currentNodeId: null },
          expectedExecution: execution!,
          response: "first owner receipt",
        }),
      ).toBe(true);
      expect(second.get("attempt-1")?.response).toBe("first owner receipt");
    } finally {
      secondSqlite?.close();
      firstSqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("start claim atomically creates one reserved execution and persists one replay receipt", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-start-attempt-atomic-"));
    const filename = path.join(directory, "moira.db");
    const firstSqlite = new Database(filename);
    let secondSqlite: Database.Database | undefined;
    try {
      firstSqlite.pragma("journal_mode = WAL");
      migrate(drizzle(firstSqlite), { migrationsFolder: MIGRATIONS });
      seedBaseline(firstSqlite);
      const graph = startGraph();
      firstSqlite
        .prepare("UPDATE workflow SET graph = ? WHERE id = 'attempt-workflow'")
        .run(JSON.stringify(graph));
      secondSqlite = new Database(filename);
      secondSqlite.pragma("journal_mode = WAL");
      const first = new ExecutionAttemptRepository(firstSqlite);
      const second = new ExecutionAttemptRepository(secondSqlite);
      const prepared = preparedStart(1);
      first.prepareStart(prepared);
      const execution: WorkflowExecution = {
        executionId: prepared.reservedExecutionId,
        workflowId: graph.id!,
        userId: prepared.userId,
        currentNodeId: "start",
        globalContext: {
          variables: {},
          nodeStates: {},
          executionId: prepared.reservedExecutionId,
          workflowId: graph.id!,
          userId: prepared.userId,
        },
        status: "running",
        note: null,
        parentExecutionId: null,
        revision: 0,
        reminders: [],
        createdAt: prepared.createdAt,
        updatedAt: prepared.createdAt,
      };
      const input = {
        attemptId: prepared.attemptId,
        userId: prepared.userId,
        workflowId: prepared.workflowId,
        workflowVersion: prepared.workflowVersion,
        workflowDigest: prepared.workflowDigest,
        ownerId: "first-owner",
        now: prepared.createdAt,
        leaseMs: 30_000,
        execution,
      };
      const claim = first.claimStart(input);
      expect(claim.kind).toBe("claimed");
      expect(second.claimStart({ ...input, ownerId: "second-owner" }).kind).toBe("processing");
      expect(
        firstSqlite
          .prepare("SELECT count(*) AS count FROM workflowExecution WHERE executionId = ?")
          .get(prepared.reservedExecutionId),
      ).toEqual({ count: 1 });
      expect(
        first.complete({
          attemptId: prepared.attemptId,
          ownerId: "first-owner",
          fence: claim.kind === "claimed" ? claim.fence : 0,
          inputFingerprint: prepared.inputFingerprint,
          execution: { ...execution, currentNodeId: "task", waitingForInputNodeId: "task" },
          expectedExecution: execution,
          response: "durable start receipt",
        }),
      ).toBe(true);
      expect(second.claimStart({ ...input, ownerId: "second-owner" })).toEqual(
        expect.objectContaining({ kind: "completed", response: "durable start receipt" }),
      );
    } finally {
      secondSqlite?.close();
      firstSqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("start preparation storage evicts the oldest reservation above the per-user bound", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-start-attempt-bound-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
      seedBaseline(sqlite);
      const graph = startGraph();
      sqlite
        .prepare("UPDATE workflow SET graph = ? WHERE id = 'attempt-workflow'")
        .run(JSON.stringify(graph));
      const attempts = new ExecutionAttemptRepository(sqlite);
      const now = Date.now();
      for (let index = 0; index < 101; index += 1) {
        attempts.prepareStart(preparedStart(index, now + index));
      }
      expect(attempts.get("start-attempt-0")).toBeNull();
      expect(attempts.get("start-attempt-100")?.state).toBe("presented");
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS count FROM executionMutationAttempt WHERE operation = 'start' AND state = 'presented'",
          )
          .get(),
      ).toEqual({ count: 100 });
      const evicted = preparedStart(0, now);
      const rejected = attempts.claimStart({
        attemptId: evicted.attemptId,
        userId: evicted.userId,
        workflowId: evicted.workflowId,
        workflowVersion: evicted.workflowVersion,
        workflowDigest: evicted.workflowDigest,
        ownerId: "evicted-owner",
        now: now + 101,
        leaseMs: 30_000,
        execution: {
          executionId: evicted.reservedExecutionId,
          workflowId: evicted.workflowId,
          userId: evicted.userId,
          currentNodeId: "start",
          globalContext: {
            variables: {},
            nodeStates: {},
            executionId: evicted.reservedExecutionId,
            workflowId: evicted.workflowId,
            userId: evicted.userId,
          },
          status: "running",
          note: null,
          parentExecutionId: null,
          revision: 0,
          reminders: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      expect(rejected.kind).toBe("invalid");
      expect(
        sqlite
          .prepare("SELECT 1 FROM workflowExecution WHERE executionId = ?")
          .get(evicted.reservedExecutionId),
      ).toBeUndefined();
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("a failed ownership update rolls back the reserved execution insertion", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-start-attempt-rollback-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
      seedBaseline(sqlite);
      const graph = startGraph();
      sqlite
        .prepare("UPDATE workflow SET graph = ? WHERE id = 'attempt-workflow'")
        .run(JSON.stringify(graph));
      const attempts = new ExecutionAttemptRepository(sqlite);
      const prepared = preparedStart(50);
      attempts.prepareStart(prepared);
      sqlite.exec(`CREATE TRIGGER fail_start_claim BEFORE UPDATE ON executionMutationAttempt
        WHEN NEW.state = 'executing' AND NEW.attemptId = 'start-attempt-50'
        BEGIN SELECT RAISE(ABORT, 'forced claim failure'); END`);
      expect(() =>
        attempts.claimStart({
          attemptId: prepared.attemptId,
          userId: prepared.userId,
          workflowId: prepared.workflowId,
          workflowVersion: prepared.workflowVersion,
          workflowDigest: prepared.workflowDigest,
          ownerId: "rollback-owner",
          now: prepared.createdAt,
          leaseMs: 30_000,
          execution: {
            executionId: prepared.reservedExecutionId,
            workflowId: prepared.workflowId,
            userId: prepared.userId,
            currentNodeId: "start",
            globalContext: {
              variables: {},
              nodeStates: {},
              executionId: prepared.reservedExecutionId,
              workflowId: prepared.workflowId,
              userId: prepared.userId,
            },
            status: "running",
            note: null,
            parentExecutionId: null,
            revision: 0,
            reminders: [],
            createdAt: prepared.createdAt,
            updatedAt: prepared.createdAt,
          },
        }),
      ).toThrow("forced claim failure");
      expect(attempts.get(prepared.attemptId)?.state).toBe("presented");
      expect(
        sqlite
          .prepare("SELECT 1 FROM workflowExecution WHERE executionId = ?")
          .get(prepared.reservedExecutionId),
      ).toBeUndefined();
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("an unknown start and its execution remain attached after database restart", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-start-attempt-restart-"));
    const filename = path.join(directory, "moira.db");
    let sqlite = new Database(filename);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
      seedBaseline(sqlite);
      const graph = startGraph();
      sqlite
        .prepare("UPDATE workflow SET graph = ? WHERE id = 'attempt-workflow'")
        .run(JSON.stringify(graph));
      let attempts = new ExecutionAttemptRepository(sqlite);
      const prepared = preparedStart(60);
      attempts.prepareStart(prepared);
      const claim = attempts.claimStart({
        attemptId: prepared.attemptId,
        userId: prepared.userId,
        workflowId: prepared.workflowId,
        workflowVersion: prepared.workflowVersion,
        workflowDigest: prepared.workflowDigest,
        ownerId: "crashed-owner",
        now: prepared.createdAt,
        leaseMs: 30_000,
        execution: {
          executionId: prepared.reservedExecutionId,
          workflowId: prepared.workflowId,
          userId: prepared.userId,
          currentNodeId: "start",
          globalContext: {
            variables: {},
            nodeStates: {},
            executionId: prepared.reservedExecutionId,
            workflowId: prepared.workflowId,
            userId: prepared.userId,
          },
          status: "running",
          note: null,
          parentExecutionId: null,
          revision: 0,
          reminders: [],
          createdAt: prepared.createdAt,
          updatedAt: prepared.createdAt,
        },
      });
      expect(claim.kind).toBe("claimed");
      expect(
        attempts.markOutcomeUnknown(
          prepared.attemptId,
          "crashed-owner",
          claim.kind === "claimed" ? claim.fence : 0,
          prepared.createdAt + 1,
        ),
      ).toBe(true);
      sqlite.close();

      sqlite = new Database(filename);
      attempts = new ExecutionAttemptRepository(sqlite);
      expect(attempts.getBlockingStart(prepared.reservedExecutionId, prepared.userId)?.state).toBe(
        "outcome_unknown",
      );
      expect(
        sqlite
          .prepare("SELECT state FROM workflowExecution WHERE executionId = ?")
          .get(prepared.reservedExecutionId),
      ).toEqual({ state: "running" });
      expect(
        attempts.cancelWithStartAttempt(prepared.reservedExecutionId, prepared.userId, 1, {
          timestamp: prepared.createdAt + 2,
          nodeId: "start",
          errorType: "system",
          message: "stale cancellation",
        }),
      ).toBe(false);
      expect(
        attempts.getBlockingStart(prepared.reservedExecutionId, prepared.userId),
      ).not.toBeNull();
      expect(
        attempts.cancelWithStartAttempt(prepared.reservedExecutionId, prepared.userId, 0, {
          timestamp: prepared.createdAt + 3,
          nodeId: "start",
          errorType: "system",
          message: "owner recovery",
        }),
      ).toBe(true);
      expect(attempts.getBlockingStart(prepared.reservedExecutionId, prepared.userId)).toBeNull();
      expect(
        sqlite
          .prepare("SELECT error FROM workflowExecution WHERE executionId = ?")
          .get(prepared.reservedExecutionId),
      ).toEqual({ error: "owner recovery" });
      expect(
        attempts.cancelWithStartAttempt(prepared.reservedExecutionId, prepared.userId, 1, {
          timestamp: prepared.createdAt + 4,
          nodeId: "start",
          errorType: "system",
          message: "blocking attempt already retired",
        }),
      ).toBe(false);
    } finally {
      if (sqlite.open) sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("cleanup applies completed start receipt age and per-user count bounds", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-start-receipt-retention-"));
    const sqlite = new Database(path.join(directory, "moira.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
      seedBaseline(sqlite);
      const now = Date.now();
      const insert = sqlite.prepare(
        `INSERT INTO executionMutationAttempt
         (attemptId, operation, userId, reservedExecutionId, workflowId, workflowVersion,
          workflowDigest, requestPayload, inputFingerprint, state, response, createdAt, updatedAt,
          completedAt)
         VALUES (?, 'start', 'attempt-user', ?, 'attempt-workflow', '1.0.0', 'digest', '{}',
          'fingerprint', 'completed', ?, ?, ?, ?)`,
      );
      sqlite.transaction(() => {
        for (let index = 0; index < 1_001; index += 1) {
          const timestamp = now - index;
          insert.run(
            `completed-start-${index}`,
            `reserved-completed-${index}`,
            `response-${index}`,
            timestamp,
            timestamp,
            timestamp,
          );
        }
        const expired = now - 7 * 24 * 60 * 60 * 1_000 - 1;
        insert.run(
          "completed-start-expired",
          "reserved-expired",
          "expired",
          expired,
          expired,
          expired,
        );
      })();
      const attempts = new ExecutionAttemptRepository(sqlite);
      expect(attempts.cleanup(now)).toBe(2);
      expect(attempts.get("completed-start-0")?.response).toBe("response-0");
      expect(attempts.get("completed-start-1000")).toBeNull();
      expect(attempts.get("completed-start-expired")).toBeNull();
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
