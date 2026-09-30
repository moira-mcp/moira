import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";

/**
 * The execution row carries columns derived from the run's state (`gateWaiting`, the agent's open
 * question `awaitingUser`, which a move off its node clears, and `lastActivityAt` / `refusalCount`,
 * derived from the visits, completion and journal a writer stores). A writer
 * that stores the cursor without them leaves a stale flag no test of another writer would notice,
 * so the set of writers is pinned here. Adding a writer fails this test until the writer is added
 * to the inventory below — which is the moment to decide what it must keep true.
 *
 * Deleting a workflow or a user deletes their executions through the foreign-key cascade, outside
 * any execution writer, so those deletes are writers of the execution table too.
 */

const root = process.cwd();
const sourceRoots = [
  "packages/shared/src",
  "packages/workflow-engine/src",
  "packages/web-backend/src",
  "packages/mcp-server/src",
  "scripts",
];

const WRITE_PATTERNS = [
  /\.(?:insert|update|delete)\(\s*workflowExecution\s*\)/g,
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+workflowExecution\b/gi,
  /\.delete\(\s*(?:workflow|user)\s*\)/g,
  /\bDELETE\s+FROM\s+(?:workflow|user)\b/gi,
];

/** Every file that writes the execution table, with how many write sites it has and what they are. */
const INVENTORY: Record<string, { sites: number; writers: string }> = {
  "packages/shared/src/database/repositories/execution-repository.ts": {
    sites: 12,
    writers:
      "save (update, insert), delete, deleteCompletedOlderThan, updateNote, setAwaitingUser, setParent, updateReminders, updateContext, appendError, cancelExecution, clearErrors",
  },
  "packages/shared/src/database/repositories/execution-attempt-repository.ts": {
    sites: 4,
    writers: "claimStart, cancelWithStartAttempt, recoverToNode, complete",
  },
  "packages/shared/src/database/gate-waiting.ts": {
    sites: 1,
    writers: "recomputeGateWaiting (a new workflow version re-decides paused runs)",
  },
  "packages/shared/src/database/repositories/workflow-repository.ts": {
    sites: 1,
    writers: "delete (hard workflow delete cascades to its executions)",
  },
  "packages/shared/src/database/repositories/workflow-reconciliation-repository.ts": {
    sites: 1,
    writers: "applyWorkflow absent lifecycle (catalog removal cascades to executions)",
  },
  "packages/web-backend/src/routes/admin.ts": {
    sites: 1,
    writers: "admin user deletion (cascades to the user's executions)",
  },
  "scripts/run-migrations.ts": {
    sites: 3,
    writers: "one-off data migrations of legacy statuses and errors",
  },
};

function sourceFiles(path: string): string[] {
  const absolute = resolve(root, path);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative(root, child));
    return entry.isFile() && [".ts", ".tsx", ".mjs", ".js"].includes(extname(entry.name))
      ? [child]
      : [];
  });
}

function writeSites(text: string): number {
  return WRITE_PATTERNS.reduce((count, pattern) => count + (text.match(pattern)?.length ?? 0), 0);
}

describe("writers of the execution row", () => {
  test("every file that writes the execution table is in the inventory with its exact write sites", () => {
    const found: Record<string, number> = {};
    for (const file of sourceRoots.flatMap(sourceFiles)) {
      const sites = writeSites(readFileSync(file, "utf8"));
      if (sites > 0) found[relative(root, file)] = sites;
    }
    const expected = Object.fromEntries(
      Object.entries(INVENTORY).map(([file, entry]) => [file, entry.sites]),
    );
    expect(found).toEqual(expected);
  });

  test("the inventory's pattern finds the writes it is meant to find", () => {
    expect(writeSites("db.update(workflowExecution).set({ note })")).toBe(1);
    expect(writeSites("`UPDATE workflowExecution SET state = ?`")).toBe(1);
    expect(writeSites("tx.delete(user).where(eq(user.id, id))")).toBe(1);
    expect(writeSites("SELECT * FROM workflowExecution")).toBe(0);
  });

  test("every raw statement that moves a run's cursor also stores gateWaiting", () => {
    const text = readFileSync(
      resolve(root, "packages/shared/src/database/repositories/execution-attempt-repository.ts"),
      "utf8",
    );
    const statements = [...text.matchAll(/`((?:INSERT INTO|UPDATE) workflowExecution[^`]*)`/g)]
      .map((match) => match[1])
      .filter((sql) => /currentNodeId/.test(sql));
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) expect(sql).toMatch(/gateWaiting/);
  });

  test("every raw statement that moves an existing run's cursor also decides the agent's question", () => {
    const text = readFileSync(
      resolve(root, "packages/shared/src/database/repositories/execution-attempt-repository.ts"),
      "utf8",
    );
    const updates = [...text.matchAll(/`(UPDATE workflowExecution[^`]*)`/g)]
      .map((match) => match[1])
      .filter((sql) => /currentNodeId = \?|state = 'completed'/.test(sql));
    expect(updates.length).toBe(3);
    for (const sql of updates) expect(sql).toMatch(/awaitingUser = NULL/);
  });
});
