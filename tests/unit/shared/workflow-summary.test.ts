import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import {
  AuthorizationService,
  WorkflowRepository,
  type AuthorizationAction,
  type AuthorizationResource,
} from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";

describe("authorized workflow summaries and batched reads", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
    for (const id of ["owner", "reader", "operator"]) {
      db.insert(schema.user)
        .values({
          id,
          email: `${id}@example.test`,
          name: id,
          handle: id,
          isAdmin: id === "operator",
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
        })
        .run();
    }
    db.insert(schema.principalGroup)
      .values({ id: "team", name: "Team", createdBy: "owner", createdAt: new Date(1) })
      .run();
    db.insert(schema.principalGroupMember)
      .values({ groupId: "team", userId: "reader", addedAt: new Date(1) })
      .run();
  });
  afterEach(() => {
    sqlite.close();
  });

  function flow(
    id: string,
    owner = "owner",
    visibility: "public" | "private" = "private",
    created = 1,
    updated = 1,
  ) {
    const graph = JSON.stringify({
      metadata: { name: "Юникод 😀", version: "1.0.0" },
      nodes: [{ id: "hidden", directive: "x".repeat(100000) }],
    });
    db.insert(schema.workflow)
      .values({
        id,
        userId: owner,
        slug: id,
        name: id,
        version: "1.0.0",
        graph,
        visibility,
        createdAt: new Date(created),
        updatedAt: new Date(updated),
      })
      .run();
    return graph;
  }
  function grant(
    id: string,
    group = false,
    level: "use" | "edit" = "use",
    type: "workflow" | "note" = "workflow",
  ) {
    db.insert(schema.accessGrant)
      .values({
        id: `${type}-${id}-${group}`,
        resourceType: type,
        resourceId: id,
        ...(group ? { groupId: "team" } : { userId: "reader" }),
        level,
        grantedBy: "owner",
        grantedAt: new Date(1),
      })
      .run();
  }

  it("returns metadata across the SQLite boundary, exact UTF-8 size, and leaves full graphs available", async () => {
    const graph = flow("early", "reader", "private", 1, 100);
    flow("late", "reader", "private", 2, 50);
    const prepare = sqlite.prepare.bind(sqlite);
    const native: unknown[][] = [];
    const observer = jest.spyOn(sqlite, "prepare").mockImplementation(((query: string) => {
      const statement = prepare(query);
      return new Proxy(statement, {
        get(target, key) {
          const member = Reflect.get(target, key);
          if (key === "all")
            return (...args: unknown[]) => {
              const rows = member.apply(target, args) as unknown[];
              native.push(rows);
              return rows;
            };
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    }) as typeof sqlite.prepare);
    const repository = new WorkflowRepository(db);
    const filter = {
      userId: "reader",
      sort: "createdAt" as const,
      sortOrder: "asc" as const,
      limit: 1,
    };
    const summary = await repository.listSummaries(filter);
    observer.mockRestore();
    expect(Buffer.byteLength(JSON.stringify(native), "utf8")).toBeLessThan(2000);
    expect(JSON.stringify(native)).not.toContain("x".repeat(1000));
    expect(summary.total).toBe(2);
    expect(summary.workflows[0].id).toBe("early"); // Creation order differs from update order in this fixture.
    expect(summary.workflows[0]).not.toHaveProperty("workflow");
    expect(summary.workflows[0].metadata).toHaveProperty("schemaVersion");
    expect(summary.workflows[0].size).toBe(Buffer.byteLength(graph, "utf8"));
    const full = await repository.listWithFilters(filter);
    expect(full.workflows[0].id).toBe("early");
    expect(full.workflows[0].workflow.nodes).toHaveLength(1);
    expect(full.workflows[0].size).toBe(summary.workflows[0].size);
  });

  it("shares direct/group/public/owner visibility, filter counts and deterministic bounded pages", async () => {
    for (const id of ["owned", "direct", "grouped", "public", "hidden", "deleted"])
      flow(id, id === "owned" ? "reader" : "owner", id === "public" ? "public" : "private");
    grant("direct");
    grant("grouped", true);
    sqlite.prepare("UPDATE workflow SET deleted=1 WHERE id='deleted'").run();
    sqlite.prepare("UPDATE workflow SET isValid=1 WHERE id='public'").run();
    const repository = new WorkflowRepository(db);
    for (const options of [
      {},
      { access: "mine" as const },
      { access: "shared" as const },
      { access: "catalog" as const },
      { visibility: "private" as const },
      { validationStatus: "valid" as const },
      { validationStatus: "unknown" as const },
      { slugs: [] },
      { slugs: ["direct", "hidden"] },
      { search: "public", limit: 1 },
      { offset: 1, limit: 2 },
      { limit: 1000, offset: -2 },
    ]) {
      const filter = { userId: "reader", ...options };
      const summary = await repository.listSummaries(filter);
      const full = await repository.listWithFilters(filter);
      expect(summary.total).toBe(full.total);
      expect(summary.workflows).toEqual(full.workflows.map(({ workflow: _graph, ...row }) => row));
    }
    expect(
      (await repository.listSummaries({ userId: "reader", limit: 1, offset: 1 })).workflows.map(
        (row) => row.id,
      ),
    ).toEqual(["grouped"]);
    expect((await repository.listSummaries({ userId: "reader" })).total).toBe(4);
    for (let i = 0; i < 105; i++) flow(`many-${i}`, "reader");
    const clamped = await repository.listSummaries({ userId: "reader", limit: 1000, offset: -2 });
    expect(clamped.total).toBe(109);
    expect(clamped.workflows).toHaveLength(100);
    expect(
      (await repository.listSummaries({ userId: "reader", offset: 100 })).workflows,
    ).toHaveLength(9);
  });

  it("batch policy preserves every action, strongest grants and resource type without operator impersonation", async () => {
    grant("direct");
    grant("grouped", true);
    grant("strong");
    grant("strong", true, "edit");
    grant("typed", false, "edit", "note");
    const resources: AuthorizationResource[] = [
      { type: "workflow", id: "own", ownerId: "reader" },
      { type: "workflow", id: "public", ownerId: "owner", visibility: "public" },
      ...["direct", "grouped", "strong", "hidden", "typed"].map((id): AuthorizationResource => ({
        type: "workflow",
        id,
        ownerId: "owner",
        visibility: "private",
      })),
      { type: "note", id: "typed", ownerId: "owner" },
      { type: "workflow", id: "operator-owned", ownerId: "operator" },
    ];
    const authorization = new AuthorizationService(db);
    const actions: AuthorizationAction[] = ["view", "use", "edit", "delete", "share", "administer"];
    for (const actor of ["reader", "operator"])
      for (const action of actions) {
        expect(await authorization.canMany(actor, action, resources)).toEqual(
          await Promise.all(
            resources.map((resource) => authorization.can(actor, action, resource)),
          ),
        );
      }
    expect(await authorization.canMany("reader", "edit", resources)).toEqual([
      true,
      false,
      false,
      false,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(await authorization.canMany("operator", "view", resources)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(await authorization.canMany("reader", "view", [])).toEqual([]);
  });

  it("reads many mixed workflow authorities in a bounded number of queries and excludes inaccessible graphs", async () => {
    for (let i = 0; i < 50; i++) flow(`public-${i}`, "owner", "public");
    flow("private");
    flow("direct");
    grant("direct");
    const statements: string[] = [];
    const prepare = sqlite.prepare.bind(sqlite);
    const observer = jest.spyOn(sqlite, "prepare").mockImplementation(((query: string) => {
      statements.push(query);
      return prepare(query);
    }) as typeof sqlite.prepare);
    const result = await new WorkflowRepository(db).getManyForUser(
      [...Array.from({ length: 50 }, (_, i) => `public-${i}`), "private", "direct", "missing"],
      "reader",
    );
    observer.mockRestore();
    expect(result.size).toBe(51);
    expect(result.has("private")).toBe(false);
    expect(result.has("direct")).toBe(true);
    expect(statements.filter((query) => query.toLowerCase().startsWith("select"))).toHaveLength(4);
  });
});
