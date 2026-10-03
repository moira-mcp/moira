import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { ArtifactRepository, WorkflowRepository } from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";

describe("Admin filtered inventory pagination", () => {
  let sqlite: Database.Database;
  let workflows: WorkflowRepository;
  let artifacts: ArtifactRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
    sqlite
      .prepare(
        "INSERT INTO user (id,name,email,handle,emailVerified,createdAt,updatedAt) VALUES ('system-admin','Admin','admin@example.test','admin',1,'2026-01-01','2026-01-01')",
      )
      .run();
    workflows = new WorkflowRepository(db);
    artifacts = new ArtifactRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function deleted(id: string, date: number | null, name = "Matching flow") {
    sqlite
      .prepare(
        `INSERT INTO workflow
      (id,userId,slug,name,version,graph,createdAt,updatedAt,deleted,deletedAt,deletedBy)
      VALUES (?, 'system-admin', ?, ?, '1.0.0', '{}', 0, 0, 1, ?, 'system-admin')`,
      )
      .run(id, id, name, date);
  }

  function reported(uuid: string, count = 1) {
    sqlite
      .prepare(
        `INSERT INTO artifact
      (id,uuid,userId,name,content,size,expiresAt,createdAt,updatedAt,reportCount,lastReportedAt)
      VALUES (?, ?, 'system-admin', ?, 'hidden body', 11, 9999999999999, 0, 0, ?, 100)`,
      )
      .run(uuid, uuid, uuid, count);
  }

  it("filters deletion dates before count and offset, includes exact bounds and excludes unknown dates", async () => {
    deleted("newer", 201);
    deleted("end", 200);
    deleted("middle", 150);
    deleted("start", 100);
    deleted("older", 99);
    deleted("unknown", null);
    deleted("other-name", 150, "Unrelated");
    const filter = { fromDate: 100, toDate: 200, search: "Matching", limit: 1, offset: 2 };
    const result = await workflows.listAllDeletedPaginated(filter);
    expect(result.total).toBe(3);
    expect(result.items.map((item) => item.id)).toEqual(["start"]);
    expect(result.items[0].deletedAt).toBe(100);
    expect((await workflows.listAllDeletedPaginated({})).total).toBe(7);
  });

  it("treats epoch zero as a deletion bound and returns the authentic zero date", async () => {
    deleted("epoch", 0);
    deleted("before", -1);
    deleted("after", 1);
    deleted("unknown", null);
    const filter = { fromDate: 0, toDate: 0 };
    const result = await workflows.listAllDeletedPaginated(filter);
    expect(result.total).toBe(1);
    expect(result.items).toEqual([
      { id: "epoch", name: "Matching flow", deletedAt: 0, deletedBy: "system-admin" },
    ]);
  });

  it("caps reported pages and uses a stable UUID order for equal report counts and dates", async () => {
    for (let index = 104; index >= 0; index--)
      reported(`report-${index.toString().padStart(3, "0")}`);
    reported("not-reported", 0);
    const first = await artifacts.listReported({ limit: 10000 });
    expect(first.total).toBe(105);
    expect(first.artifacts).toHaveLength(100);
    expect(first.artifacts[0].uuid).toBe("report-000");
    const last = await artifacts.listReported({ limit: 100, offset: 100 });
    expect(last.artifacts.map((item) => item.uuid)).toEqual([
      "report-100",
      "report-101",
      "report-102",
      "report-103",
      "report-104",
    ]);
    await artifacts.takedown("report-104", "system-admin", "Abuse");
    const active = await artifacts.listReported({
      limit: 100,
      offset: 100,
      includeTakenDown: false,
    });
    expect(active.total).toBe(104);
    expect(active.artifacts.map((item) => item.uuid)).toEqual([
      "report-100",
      "report-101",
      "report-102",
      "report-103",
    ]);
    expect((await artifacts.listReported({})).total).toBe(105);
  });
});
