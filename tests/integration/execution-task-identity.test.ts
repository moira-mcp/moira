import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConflictError,
  ExecutionAttemptRepository,
  ExecutionRepository,
  ValidationError,
  metadataRevision,
} from "@mcp-moira/shared";
import {
  InMemoryRepository,
  type WorkflowExecution,
  type PresentedExecutionAttempt,
} from "@mcp-moira/workflow-engine";
import * as schema from "../../packages/shared/src/database/schema.js";

function execution(): WorkflowExecution {
  return {
    executionId: "named-run",
    workflowId: "flow",
    userId: "owner",
    status: "running",
    currentNodeId: "task",
    waitingForInputNodeId: "task",
    revision: 0,
    globalContext: {
      variables: { topic: "keep" },
      nodeStates: {},
      executionId: "named-run",
      workflowId: "flow",
      userId: "owner",
    },
    note: "A completely arbitrary operational note",
    createdAt: 1,
    updatedAt: 20,
    visits: [{ seq: 0, nodeId: "task", exitKey: null, changes: {}, enteredAt: 20 }],
    awaitingUser: { id: "question", nodeId: "task", question: "Proceed?", since: 20 },
  };
}

function presented(id = "attempt"): PresentedExecutionAttempt {
  return {
    attemptId: id,
    userId: "owner",
    executionId: "named-run",
    executionRevision: 0,
    nodeId: "task",
    workflowId: "flow",
    workflowVersion: "1.0.0",
    workflowDigest: "digest",
    continuationDigest: "continuation",
    continuationFacts: "{}",
    response: "Task",
    createdAt: 20,
  };
}

describe("independent task identity persistence", () => {
  let directory: string;
  let first: Database.Database;
  let second: Database.Database;
  let repository: ExecutionRepository;
  let other: ExecutionRepository;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "moira-task-identity-"));
    first = new Database(join(directory, "moira.db"));
    first.pragma("journal_mode = WAL");
    first.pragma("foreign_keys = OFF");
    migrate(drizzle(first, { schema }), {
      migrationsFolder: join(process.cwd(), "packages/web-backend/drizzle"),
    });
    second = new Database(first.name);
    second.pragma("foreign_keys = OFF");
    repository = new ExecutionRepository(drizzle(first, { schema }));
    other = new ExecutionRepository(drizzle(second, { schema }));
    await repository.save(execution());
    await repository.setAwaitingUser("named-run", "owner", {
      id: "question",
      question: "Proceed?",
      since: 20,
    });
    jest.useFakeTimers({ now: 1_000 });
  });

  afterEach(() => {
    jest.useRealTimers();
    second.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const rename = (
    repo: ExecutionRepository,
    title = "Release preparation",
    expected = metadataRevision(null),
    revision = 0,
    owner = "owner",
  ) => repo.updateExecutionTaskTitle("named-run", owner, revision, expected, title);

  function stored() {
    return second
      .prepare(
        "SELECT taskIdentity, lastActivityAt, updatedAt, revision FROM workflowExecution WHERE executionId = 'named-run'",
      )
      .get() as {
      taskIdentity: string | null;
      lastActivityAt: number;
      updatedAt: number;
      revision: number;
    };
  }

  test("rename persists separate identity and activity without consuming a presented step or other metadata", async () => {
    const attempts = new ExecutionAttemptRepository(first);
    attempts.createPresented(presented());
    const before = (await repository.get("named-run"))!;
    const result = await rename(other, "  Release preparation  ");
    expect(result).toMatchObject({
      changed: true,
      revision: 0,
      taskIdentity: { title: "Release preparation", changedAt: 1_000 },
    });
    expect(result.taskIdentity.changeId).not.toBe("");
    const after = (await repository.get("named-run"))!;
    expect(after.note).toBe(before.note);
    expect(after.globalContext).toEqual(before.globalContext);
    expect(after.awaitingUser).toEqual(before.awaitingUser);
    expect(after.awaitingUser?.question).toBe("Proceed?");
    expect(after.parentExecutionId).toEqual(before.parentExecutionId);
    expect(after.reminders).toEqual(before.reminders);
    expect(after.revision).toBe(0);
    expect(attempts.getCurrent("named-run", "owner")?.attemptId).toBe("attempt");
    expect(JSON.parse(stored().taskIdentity!)).toEqual(result.taskIdentity);
    expect(stored().lastActivityAt).toBe(1_000);
    expect((await repository.getManyForProgress(["named-run"]))[0].taskIdentity).toEqual(
      result.taskIdentity,
    );
  });

  test("normalized no-op changes neither stored bytes, timestamps, step/target revisions nor feed events", async () => {
    const result = await rename(repository);
    const before = stored();
    const events = second.prepare("SELECT count(*) AS count FROM executionChange").get();
    jest.setSystemTime(2_000);
    const noop = await rename(other, " Release preparation ", result.taskIdentityRevision);
    expect(noop).toEqual({ ...result, changed: false });
    expect(stored()).toEqual(before);
    expect(second.prepare("SELECT count(*) AS count FROM executionChange").get()).toEqual(events);
  });

  test.each(["", "   ", "x".repeat(501), "name\n", "\tname", "name\u0000", "\u200b"])(
    "invalid title %j is refused without mutation",
    async (title) => {
      await expect(rename(repository, title)).rejects.toBeInstanceOf(ValidationError);
      expect(stored().taskIdentity).toBeNull();
      expect(stored().lastActivityAt).toBe(20);
    },
  );

  test("stale step and target requests fail even when the proposed title already matches", async () => {
    const changed = await rename(repository);
    await expect(
      rename(other, "Release preparation", metadataRevision(null)),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      rename(other, "Release preparation", changed.taskIdentityRevision, 1),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      rename(other, "Release preparation", changed.taskIdentityRevision, 0, "stranger"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(stored().lastActivityAt).toBe(1_000);
  });

  test("same-clock A→B→A does not restore an old metadata revision", async () => {
    const a = await rename(repository, "A");
    const b = await rename(other, "B", a.taskIdentityRevision);
    const restored = await rename(repository, "A", b.taskIdentityRevision);
    expect(restored.taskIdentity.changedAt).toBe(a.taskIdentity.changedAt);
    expect(restored.taskIdentityRevision).not.toBe(a.taskIdentityRevision);
    await expect(rename(other, "C", a.taskIdentityRevision)).rejects.toBeInstanceOf(ConflictError);
  });

  test("two title writers with one snapshot cannot both commit", async () => {
    const results = await Promise.allSettled([
      rename(repository, "First"),
      rename(other, "Second"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.any(ConflictError) }),
    ]);
  });

  test("terminal runs refuse matching and different titles", async () => {
    const changed = await rename(repository);
    first
      .prepare("UPDATE workflowExecution SET state = 'completed' WHERE executionId = 'named-run'")
      .run();
    for (const title of ["Release preparation", "Other"]) {
      await expect(rename(other, title, changed.taskIdentityRevision)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  test.each([
    "save",
    "context",
    "note",
    "parent",
    "reminder",
    "cancel",
    "recover",
    "complete",
  ] as const)(
    "%s preserves a newer title and its activity when existing progress timestamps are older",
    async (writer) => {
      const old = (await repository.get("named-run"))!;
      const attempts = new ExecutionAttemptRepository(first);
      if (writer === "recover" || writer === "complete") attempts.createPresented(presented());
      const renamed = await rename(other);
      if (writer === "save") await repository.save({ ...old, updatedAt: 30 });
      if (writer === "context")
        await repository.updateContext(
          "named-run",
          { variables: { added: true } },
          0,
          metadataRevision(old.globalContext),
          { nodeId: "task", exitKey: null, changes: { added: true }, enteredAt: 30 },
        );
      if (writer === "note") await repository.updateNote("named-run", "Different arbitrary note");
      if (writer === "parent") {
        const parent = execution();
        parent.executionId = "parent";
        parent.globalContext.executionId = "parent";
        await repository.save(parent);
        await repository.setParent("named-run", "parent", "owner", 0, metadataRevision(null));
      }
      if (writer === "reminder")
        await repository.updateReminders(
          "named-run",
          "owner",
          0,
          [],
          [{ id: "reminder", text: "Follow up", status: "active", createdAt: 30, updatedAt: 30 }],
        );
      if (writer === "cancel") {
        jest.setSystemTime(40);
        await repository.cancelExecution("named-run", {
          timestamp: 40,
          nodeId: "task",
          errorType: "system",
          message: "Cancel",
        });
      }
      if (writer === "recover")
        attempts.recoverToNode({
          expectedExecution: old,
          execution: { ...old, currentNodeId: "next", waitingForInputNodeId: "next" },
          nextAttempt: { ...presented("next-attempt"), nodeId: "next", executionRevision: 1 },
        });
      if (writer === "complete") {
        const claim = attempts.claim({
          attemptId: "attempt",
          userId: "owner",
          executionId: "named-run",
          executionRevision: 0,
          nodeId: "task",
          workflowId: "flow",
          continuationDigest: "continuation",
          inputFingerprint: "answer",
          ownerId: "worker",
          now: 30,
          leaseMs: 10_000,
        });
        if (claim.kind !== "claimed") throw new Error(claim.kind);
        attempts.complete({
          attemptId: "attempt",
          ownerId: "worker",
          fence: claim.fence,
          inputFingerprint: "answer",
          expectedExecution: old,
          execution: { ...old, status: "completed", completedAt: 40, updatedAt: 40 },
          response: "Done",
        });
      }
      expect(JSON.parse(stored().taskIdentity!)).toEqual(renamed.taskIdentity);
      expect(stored().lastActivityAt).toBe(1_000);
      const consequences = {
        save: { revision: 1, updatedAt: 30 },
        context: {
          globalContext: { variables: { added: true } },
          visits: expect.arrayContaining([expect.objectContaining({ enteredAt: 30 })]),
        },
        note: { note: "Different arbitrary note" },
        parent: { parentExecutionId: "parent" },
        reminder: { reminders: [expect.objectContaining({ id: "reminder" })] },
        cancel: { status: "completed", completedAt: 40 },
        recover: { currentNodeId: "next", revision: 1 },
        complete: { status: "completed", completedAt: 40, revision: 1 },
      };
      expect(await repository.get("named-run")).toMatchObject(consequences[writer]);
    },
  );

  test("blocked-start cancellation and stop merge current title activity despite earlier operation clocks", async () => {
    await rename(repository);
    first
      .prepare(
        `INSERT INTO executionMutationAttempt
      (attemptId, operation, userId, executionId, executionRevision, nodeId, workflowId, workflowVersion, workflowDigest, state, createdAt, updatedAt)
      VALUES ('start', 'start', 'owner', 'named-run', 0, 'task', 'flow', '1.0.0', 'digest', 'outcome_unknown', 20, 20)`,
      )
      .run();
    const attempts = new ExecutionAttemptRepository(first);
    expect(
      attempts.cancelWithStartAttempt("named-run", "owner", 0, {
        timestamp: 40,
        nodeId: "task",
        errorType: "system",
        message: "Cancel blocked start",
      }),
    ).toBe(true);
    expect(stored().lastActivityAt).toBe(1_000);
    first
      .prepare(
        "UPDATE workflowExecution SET state = 'running', completedAt = NULL WHERE executionId = 'named-run'",
      )
      .run();
    jest.setSystemTime(40);
    expect(attempts.stopExecution("named-run", "owner", 0, "Stop").changed).toBe(true);
    expect(stored().lastActivityAt).toBe(1_000);
    expect(JSON.parse(stored().taskIdentity!).title).toBe("Release preparation");
  });
});

describe("in-memory independent task identity parity", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test.each(["save", "recover", "complete"] as const)(
    "%s replacement preserves current identity and activity",
    async (writer) => {
      const repository = new InMemoryRepository();
      await repository.saveExecution(execution());
      const old = (await repository.getExecution("named-run"))!;
      if (writer !== "save") await repository.createPresentedExecutionAttempt(presented());
      jest.useFakeTimers({ now: 1_000 });
      const renamed = await repository.updateExecutionTaskTitle(
        "named-run",
        "owner",
        0,
        metadataRevision(null),
        "Release",
      );
      if (writer === "save") await repository.saveExecution({ ...old, updatedAt: 40 });
      if (writer === "recover")
        await repository.recoverExecutionToNode({
          expectedExecution: old,
          execution: { ...old, currentNodeId: "next", waitingForInputNodeId: "next" },
          nextAttempt: { ...presented("next-attempt"), nodeId: "next", executionRevision: 1 },
        });
      if (writer === "complete") {
        const claim = await repository.claimExecutionAttempt({
          attemptId: "attempt",
          userId: "owner",
          executionId: "named-run",
          executionRevision: 0,
          nodeId: "task",
          workflowId: "flow",
          continuationDigest: "continuation",
          inputFingerprint: "answer",
          ownerId: "worker",
          now: 30,
          leaseMs: 10_000,
        });
        if (claim.kind !== "claimed") throw new Error(claim.kind);
        await repository.completeExecutionAttempt({
          attemptId: "attempt",
          ownerId: "worker",
          fence: claim.fence,
          inputFingerprint: "answer",
          expectedExecution: old,
          execution: { ...old, status: "completed", completedAt: 40, updatedAt: 40 },
          response: "Done",
        });
      }
      const current = (await repository.getExecution("named-run"))!;
      expect(current.taskIdentity).toEqual(renamed.taskIdentity);
      expect(current.lastActivityAt).toBe(1_000);
      expect(current).toMatchObject(
        {
          save: { revision: 1, updatedAt: 40 },
          recover: { revision: 1, currentNodeId: "next" },
          complete: { revision: 1, status: "completed", completedAt: 40 },
        }[writer],
      );
    },
  );

  test("no-op preserves timestamps and stale/unowned/terminal no-ops still refuse", async () => {
    const repository = new InMemoryRepository();
    await repository.saveExecution(execution());
    jest.useFakeTimers({ now: 1_000 });
    const changed = await repository.updateExecutionTaskTitle(
      "named-run",
      "owner",
      0,
      metadataRevision(null),
      "Release",
    );
    jest.setSystemTime(2_000);
    expect(
      await repository.updateExecutionTaskTitle(
        "named-run",
        "owner",
        0,
        changed.taskIdentityRevision,
        " Release ",
      ),
    ).toEqual({ ...changed, changed: false });
    expect((await repository.getExecution("named-run"))!.updatedAt).toBe(1_000);
    await expect(
      repository.updateExecutionTaskTitle(
        "named-run",
        "owner",
        0,
        metadataRevision(null),
        "Release",
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      repository.updateExecutionTaskTitle(
        "named-run",
        "stranger",
        0,
        changed.taskIdentityRevision,
        "Release",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const current = (await repository.getExecution("named-run"))!;
    await repository.saveExecution({ ...current, status: "completed" });
    await expect(
      repository.updateExecutionTaskTitle(
        "named-run",
        "owner",
        1,
        changed.taskIdentityRevision,
        "Release",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
