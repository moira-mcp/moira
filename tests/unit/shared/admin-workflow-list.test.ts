/**
 * Unit tests for WorkflowRepository.listAllWorkflowsPaginated (admin listing)
 * Verifies that admin can list ALL workflows across all users with filters.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { WorkflowRepository } from "@mcp-moira/shared";
import path from "path";

import * as schema from "../../../packages/shared/src/database/schema.js";

function createTestGraph(name: string, version = "1.0.0", nodeCount = 2) {
  const nodes: Array<{
    id: string;
    type: "start" | "end" | "step";
    directive: string;
    connections: Record<string, string>;
  }> = [
    {
      id: "start",
      type: "start" as const,
      directive: "Start",
      connections: nodeCount > 2 ? { default: "step-1" } : { default: "end" },
    },
  ];

  for (let i = 1; i < nodeCount - 1; i++) {
    nodes.push({
      id: `step-${i}`,
      type: "step" as const,
      directive: `Step ${i}`,
      connections: { default: i < nodeCount - 2 ? `step-${i + 1}` : "end" },
    });
  }

  nodes.push({
    id: "end",
    type: "end" as const,
    directive: "End",
    connections: {},
  });

  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    metadata: {
      name,
      version,
      description: `Description for ${name}`,
    },
    nodes,
  };
}

describe("WorkflowRepository Admin List", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let repository: WorkflowRepository;
  let sqlite: Database.Database;

  const USER_A = "user-admin-list-a";
  const USER_B = "user-admin-list-b";
  const USER_C = "user-admin-list-c";

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");

    const migrationsPath = path.join(process.cwd(), "packages/web-backend/drizzle");
    migrate(db, { migrationsFolder: migrationsPath });

    repository = new WorkflowRepository(db);

    // Insert test users
    for (const [userId, handle] of [
      [USER_A, "alice"],
      [USER_B, "bob"],
      [USER_C, "charlie"],
    ] as const) {
      sqlite.exec(
        `INSERT INTO user (id, name, email, handle, emailVerified, createdAt, updatedAt) VALUES ('${userId}', '${handle}', '${handle}@test.com', '${handle}', 1, ${Date.now()}, ${Date.now()})`,
      );
    }

    // Create workflows for each user
    await repository.save({
      graph: createTestGraph("Alice Public Flow", "1.0.0", 3),
      userId: USER_A,
      visibility: "public",
    });
    await repository.save({
      graph: createTestGraph("Alice Private Flow", "2.0.0", 5),
      userId: USER_A,
      visibility: "private",
    });
    await repository.save({
      graph: createTestGraph("Bob Public Flow", "1.0.0", 2),
      userId: USER_B,
      visibility: "public",
    });
    await repository.save({
      graph: createTestGraph("Bob Private Flow", "1.0.0", 4),
      userId: USER_B,
      visibility: "private",
    });
    await repository.save({
      graph: createTestGraph("Charlie Flow", "1.0.0", 6),
      userId: USER_C,
      visibility: "private",
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("listAllWorkflowsPaginated", () => {
    it("returns all workflows from all users without ownership constraint", async () => {
      const result = await repository.listAllWorkflowsPaginated({});

      expect(result.total).toBe(5);
      expect(result.workflows).toHaveLength(5);

      // Verify we have workflows from multiple users
      const userIds = new Set(result.workflows.map((w) => w.userId));
      expect(userIds.size).toBe(3);
      expect(userIds).toContain(USER_A);
      expect(userIds).toContain(USER_B);
      expect(userIds).toContain(USER_C);
    });

    it("includes owner handle in results", async () => {
      const result = await repository.listAllWorkflowsPaginated({});

      const aliceWorkflows = result.workflows.filter((w) => w.userId === USER_A);
      expect(aliceWorkflows.length).toBe(2);
      expect(aliceWorkflows[0].ownerHandle).toBe("alice");

      const bobWorkflows = result.workflows.filter((w) => w.userId === USER_B);
      expect(bobWorkflows[0].ownerHandle).toBe("bob");
    });

    it("returns correct fields for each workflow", async () => {
      const result = await repository.listAllWorkflowsPaginated({});
      const wf = result.workflows[0];

      expect(wf).toHaveProperty("id");
      expect(wf).toHaveProperty("slug");
      expect(wf).toHaveProperty("userId");
      expect(wf).toHaveProperty("ownerHandle");
      expect(wf).toHaveProperty("name");
      expect(wf).toHaveProperty("description");
      expect(wf).toHaveProperty("version");
      expect(wf).toHaveProperty("visibility");
      expect(wf).toHaveProperty("nodeCount");
      expect(wf).toHaveProperty("validation");
      expect(wf).toHaveProperty("createdAt");
      expect(wf).toHaveProperty("updatedAt");
      expect(typeof wf.nodeCount).toBe("number");
      expect(wf.nodeCount).toBeGreaterThan(0);
    });

    it("filters by userId", async () => {
      const result = await repository.listAllWorkflowsPaginated({ userId: USER_A });

      expect(result.total).toBe(2);
      expect(result.workflows).toHaveLength(2);
      expect(result.workflows.every((w) => w.userId === USER_A)).toBe(true);
    });

    it("filters by visibility=public", async () => {
      const result = await repository.listAllWorkflowsPaginated({ visibility: "public" });

      expect(result.total).toBe(2);
      expect(result.workflows.every((w) => w.visibility === "public")).toBe(true);
    });

    it("filters by visibility=private", async () => {
      const result = await repository.listAllWorkflowsPaginated({ visibility: "private" });

      expect(result.total).toBe(3);
      expect(result.workflows.every((w) => w.visibility === "private")).toBe(true);
    });

    it("filters by search in name", async () => {
      const result = await repository.listAllWorkflowsPaginated({ search: "Alice" });

      expect(result.total).toBe(2);
      expect(result.workflows.every((w) => w.name.includes("Alice"))).toBe(true);
    });

    it("filters by search in description", async () => {
      const result = await repository.listAllWorkflowsPaginated({ search: "Description for Bob" });

      expect(result.total).toBe(2);
    });

    it("combines userId and visibility filters", async () => {
      const result = await repository.listAllWorkflowsPaginated({
        userId: USER_B,
        visibility: "public",
      });

      expect(result.total).toBe(1);
      expect(result.workflows[0].name).toBe("Bob Public Flow");
    });

    it("supports pagination with limit and offset", async () => {
      const page1 = await repository.listAllWorkflowsPaginated({ limit: 2, offset: 0 });
      expect(page1.workflows).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = await repository.listAllWorkflowsPaginated({ limit: 2, offset: 2 });
      expect(page2.workflows).toHaveLength(2);
      expect(page2.total).toBe(5);

      const page3 = await repository.listAllWorkflowsPaginated({ limit: 2, offset: 4 });
      expect(page3.workflows).toHaveLength(1);
      expect(page3.total).toBe(5);

      // Verify no duplicates across pages
      const allIds = [
        ...page1.workflows.map((w) => w.id),
        ...page2.workflows.map((w) => w.id),
        ...page3.workflows.map((w) => w.id),
      ];
      expect(new Set(allIds).size).toBe(5);
    });

    it("sorts by name ascending", async () => {
      const result = await repository.listAllWorkflowsPaginated({
        sort: "name",
        sortOrder: "asc",
      });

      const names = result.workflows.map((w) => w.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });

    it("sorts by name descending", async () => {
      const result = await repository.listAllWorkflowsPaginated({
        sort: "name",
        sortOrder: "desc",
      });

      const names = result.workflows.map((w) => w.name);
      const sorted = [...names].sort().reverse();
      expect(names).toEqual(sorted);
    });

    it("excludes deleted workflows", async () => {
      // Soft-delete one workflow
      const allBefore = await repository.listAllWorkflowsPaginated({});
      const toDelete = allBefore.workflows.find((w) => w.name === "Charlie Flow")!;
      sqlite.exec(`UPDATE workflow SET deleted = 1 WHERE id = '${toDelete.id}'`);

      const result = await repository.listAllWorkflowsPaginated({});
      expect(result.total).toBe(4);
      expect(result.workflows.find((w) => w.id === toDelete.id)).toBeUndefined();
    });

    it("returns correct nodeCount from graph", async () => {
      const result = await repository.listAllWorkflowsPaginated({ search: "Alice Private" });
      expect(result.workflows[0].nodeCount).toBe(5); // 5-node graph
    });

    it("filters by isValid=true", async () => {
      // Set validation cache on some workflows
      const all = await repository.listAllWorkflowsPaginated({});
      const first = all.workflows[0];
      const second = all.workflows[1];
      await repository.updateValidationCache(first.id, true, []);
      await repository.updateValidationCache(second.id, false, ["Error"]);

      const validOnly = await repository.listAllWorkflowsPaginated({ isValid: true });
      expect(validOnly.total).toBe(1);
      expect(validOnly.workflows[0].id).toBe(first.id);
    });

    it("filters by isValid=false", async () => {
      const all = await repository.listAllWorkflowsPaginated({});
      const first = all.workflows[0];
      const second = all.workflows[1];
      await repository.updateValidationCache(first.id, true, []);
      await repository.updateValidationCache(second.id, false, ["Error in node"]);

      const invalidOnly = await repository.listAllWorkflowsPaginated({ isValid: false });
      expect(invalidOnly.total).toBe(1);
      expect(invalidOnly.workflows[0].id).toBe(second.id);
    });

    it("filters by isValid=null (unknown/not validated)", async () => {
      const all = await repository.listAllWorkflowsPaginated({});
      const first = all.workflows[0];
      await repository.updateValidationCache(first.id, true, []);

      // isValid=null should return workflows that haven't been validated yet
      const unknownOnly = await repository.listAllWorkflowsPaginated({ isValid: null });
      expect(unknownOnly.total).toBe(4); // 5 total - 1 validated = 4 unknown
      expect(unknownOnly.workflows.every((w) => w.id !== first.id)).toBe(true);
    });

    it("filters by date range (fromDate/toDate)", async () => {
      const all = await repository.listAllWorkflowsPaginated({});
      expect(all.total).toBe(5);

      // All workflows were just created, so a range far in the past should match all
      const pastResult = await repository.listAllWorkflowsPaginated({
        fromDate: Date.now() - 60000, // 1 minute ago
      });
      expect(pastResult.total).toBe(5);

      // A range in the future should match none
      const futureResult = await repository.listAllWorkflowsPaginated({
        fromDate: Date.now() + 60000,
      });
      expect(futureResult.total).toBe(0);

      // toDate in the past should match none (workflows created just now)
      const pastToDate = await repository.listAllWorkflowsPaginated({
        toDate: Date.now() - 60000,
      });
      expect(pastToDate.total).toBe(0);
    });

    it("returns empty result for no matches", async () => {
      const result = await repository.listAllWorkflowsPaginated({ search: "nonexistent-xyz" });
      expect(result.total).toBe(0);
      expect(result.workflows).toHaveLength(0);
    });
  });
});
