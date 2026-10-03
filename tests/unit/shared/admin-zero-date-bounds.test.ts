import { afterEach, beforeEach, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { AuditRepository, WorkflowRepository } from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";

let sqlite: Database.Database;
let workflows: WorkflowRepository;
let audit: AuditRepository;
beforeEach(() => {
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,handle,emailVerified,createdAt,updatedAt) VALUES ('date-reader','Reader','reader@example.test','reader',1,'2026-01-01','2026-01-01')",
    )
    .run();
  for (const date of [-1, 0, 1]) {
    sqlite
      .prepare(
        "INSERT INTO workflow(id,userId,slug,name,version,graph,createdAt,updatedAt) VALUES (?, 'date-reader', ?, 'Dated flow', '1.0.0', '{\"metadata\":{},\"nodes\":[]}', 0, ?)",
      )
      .run(`flow-${date}`, `flow-${date}`, date);
    sqlite
      .prepare(
        "INSERT INTO auditLog(id,userId,action,createdAt) VALUES (?, 'date-reader', 'date-fixture', ?)",
      )
      .run(`audit-${date}`, date);
  }
  workflows = new WorkflowRepository(db);
  audit = new AuditRepository(db);
});
afterEach(() => {
  sqlite.close();
});

const ranges = [
  [{ fromDate: 0 }, [0, 1]],
  [{ toDate: 0 }, [-1, 0]],
  [{ fromDate: 0, toDate: 0 }, [0]],
] as const;

test.each(ranges)(
  "workflow updated-date bounds %j apply before count and pagination, including epoch zero",
  async (bounds, dates) => {
    const result = await workflows.listAllWorkflowsPaginated({
      ...bounds,
      sort: "updatedAt",
      sortOrder: "asc",
      limit: 1,
      offset: dates.length - 1,
    });
    expect(result.total).toBe(dates.length);
    expect(result.workflows.map((row) => row.updatedAt)).toEqual([dates.at(-1)]);
  },
);

test.each(ranges)(
  "audit date bounds %j constrain both plain and counted reads, including epoch zero",
  async (bounds, dates) => {
    const filter = { ...bounds, sortOrder: "asc" as const, limit: 1, offset: dates.length - 1 };
    const plain = await audit.list(filter);
    const counted = await audit.listWithTotal(filter);
    expect(counted.total).toBe(dates.length);
    expect(counted.entries.map((row) => row.createdAt)).toEqual([dates.at(-1)]);
    expect(plain.map((row) => row.createdAt)).toEqual([dates.at(-1)]);
  },
);
