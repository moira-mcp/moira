/**
 * Unit tests for the central authorization layer.
 *
 * The layer exists so that "who may do what" is one decision instead of a rule per table. These
 * tests protect the decision itself, that grants reach a subject directly or through a group, and —
 * the observation that distinguishes a real move from a policy nobody consults — that a product
 * path's answer follows the policy: a user with a grant reads a private workflow through the
 * repository, and the same user without one does not.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readFileSync } from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import {
  AuthorizationService,
  decideAccess,
  RESOURCE_TYPES,
  WorkflowRepository,
  type AuthorizationAction,
} from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const ADMIN = "user-admin";

const privateWorkflow = {
  type: RESOURCE_TYPES.workflow,
  id: "workflow-1",
  ownerId: OWNER,
  visibility: "private" as const,
};
const publicWorkflow = { ...privateWorkflow, id: "workflow-2", visibility: "public" as const };

const ALL_ACTIONS: AuthorizationAction[] = ["view", "use", "edit", "delete", "share", "administer"];

describe("authorization policy", () => {
  it("lets the owner do everything with their own resource", () => {
    for (const action of ALL_ACTIONS) {
      expect(decideAccess({ userId: OWNER }, action, privateWorkflow)).toBe(true);
    }
  });

  it("denies a stranger every action on a private resource", () => {
    for (const action of ALL_ACTIONS) {
      expect(decideAccess({ userId: STRANGER }, action, privateWorkflow)).toBe(false);
    }
  });

  it("lets a stranger read and use a public resource but never change it", () => {
    expect(decideAccess({ userId: STRANGER }, "view", publicWorkflow)).toBe(true);
    expect(decideAccess({ userId: STRANGER }, "use", publicWorkflow)).toBe(true);
    expect(decideAccess({ userId: STRANGER }, "edit", publicWorkflow)).toBe(false);
    expect(decideAccess({ userId: STRANGER }, "delete", publicWorkflow)).toBe(false);
    expect(decideAccess({ userId: STRANGER }, "share", publicWorkflow)).toBe(false);
  });

  it("gives an administrator operator powers only, not the owner's hands", () => {
    const admin = { userId: ADMIN, isAdmin: true };
    expect(decideAccess(admin, "administer", privateWorkflow)).toBe(true);
    expect(decideAccess(admin, "use", privateWorkflow)).toBe(false);
    expect(decideAccess(admin, "edit", privateWorkflow)).toBe(false);
    expect(decideAccess(admin, "view", privateWorkflow)).toBe(false);
  });

  it("honours the level of an explicit grant", () => {
    const subject = { userId: STRANGER };
    expect(decideAccess(subject, "use", privateWorkflow, { level: "use" })).toBe(true);
    expect(decideAccess(subject, "edit", privateWorkflow, { level: "use" })).toBe(false);
    expect(decideAccess(subject, "edit", privateWorkflow, { level: "edit" })).toBe(true);
    expect(decideAccess(subject, "delete", privateWorkflow, { level: "edit" })).toBe(false);
    expect(decideAccess(subject, "share", privateWorkflow, { level: "edit" })).toBe(false);
  });
});

describe("authorization service", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let authorization: AuthorizationService;

  const migrationsFolder = path.join(process.cwd(), "packages/web-backend/drizzle");

  function addUser(id: string, isAdmin = false): void {
    const now = new Date().toISOString();
    sqlite
      .prepare(
        "INSERT INTO user (id, email, handle, isAdmin, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, `${id}@example.test`, id, isAdmin ? 1 : 0, now, now);
  }

  function grant(
    resourceId: string,
    subject: { userId?: string; groupId?: string },
    level: "use" | "edit" = "use",
  ): void {
    sqlite
      .prepare(
        "INSERT INTO accessGrant (id, resourceType, resourceId, userId, groupId, level, grantedBy, grantedAt)" +
          " VALUES (?, 'workflow', ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        resourceId,
        subject.userId ?? null,
        subject.groupId ?? null,
        level,
        OWNER,
        Date.now(),
      );
  }

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder });
    authorization = new AuthorizationService(db);
    addUser(OWNER);
    addUser(STRANGER);
    addUser(ADMIN, true);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("resolves the acting user's operator status from the account", async () => {
    expect((await authorization.subject(ADMIN)).isAdmin).toBe(true);
    expect((await authorization.subject(STRANGER)).isAdmin).toBe(false);
  });

  it("finds a grant made to a group the subject belongs to", async () => {
    const groupId = randomUUID();
    sqlite
      .prepare("INSERT INTO principalGroup (id, name, createdBy, createdAt) VALUES (?, ?, ?, ?)")
      .run(groupId, "Reviewers", OWNER, Date.now());
    sqlite
      .prepare(
        "INSERT INTO principalGroupMember (groupId, userId, role, addedAt) VALUES (?, ?, 'member', ?)",
      )
      .run(groupId, STRANGER, Date.now());
    grant(privateWorkflow.id, { groupId });

    expect(await authorization.can(STRANGER, "use", privateWorkflow)).toBe(true);
  });

  it("takes the wider level when a direct grant and a group grant both apply", async () => {
    const groupId = randomUUID();
    sqlite
      .prepare("INSERT INTO principalGroup (id, name, createdBy, createdAt) VALUES (?, ?, ?, ?)")
      .run(groupId, "Editors", OWNER, Date.now());
    sqlite
      .prepare(
        "INSERT INTO principalGroupMember (groupId, userId, role, addedAt) VALUES (?, ?, 'member', ?)",
      )
      .run(groupId, STRANGER, Date.now());
    grant(privateWorkflow.id, { userId: STRANGER }, "use");
    grant(privateWorkflow.id, { groupId }, "edit");

    expect(await authorization.can(STRANGER, "edit", privateWorkflow)).toBe(true);
  });

  it("decides nothing differently when no group exists", async () => {
    grant(privateWorkflow.id, { userId: STRANGER });
    expect(await authorization.can(STRANGER, "use", privateWorkflow)).toBe(true);
    expect(await authorization.can(STRANGER, "edit", privateWorkflow)).toBe(false);
  });

  it("refuses a second identical grant for the same subject and resource", () => {
    grant(privateWorkflow.id, { userId: STRANGER });

    // SQLite treats NULLs as distinct, so a single index over both subject columns would let the
    // same user be granted the same resource twice; the partial indexes are what prevent it.
    expect(() => grant(privateWorkflow.id, { userId: STRANGER })).toThrow(/UNIQUE/i);
  });

  it("lists a workflow granted to a group for the group's member and not for a stranger", async () => {
    const workflows = new WorkflowRepository(db);
    const saved = await workflows.save({
      graph: {
        name: "Team flow",
        nodes: [],
        connections: [],
        metadata: { name: "Team flow", version: "1.0.0", description: "" },
      } as never,
      userId: OWNER,
    });
    const member = "user-member";
    addUser(member);
    const groupId = randomUUID();
    sqlite
      .prepare("INSERT INTO principalGroup (id, name, createdBy, createdAt) VALUES (?, ?, ?, ?)")
      .run(groupId, "team", OWNER, Date.now());
    sqlite
      .prepare(
        "INSERT INTO principalGroupMember (groupId, userId, role, addedAt) VALUES (?, ?, 'member', ?)",
      )
      .run(groupId, member, Date.now());
    grant(saved.id, { groupId });

    // The list is the surface a person actually sees; a subquery that only knew direct grants would
    // let the policy say "yes" while the list said nothing.
    const forMember = await workflows.listWithFilters({ userId: member });
    const forStranger = await workflows.listWithFilters({ userId: STRANGER });

    expect(forMember.workflows.map((entry) => entry.id)).toContain(saved.id);
    expect(forStranger.workflows.map((entry) => entry.id)).not.toContain(saved.id);
  });

  it("lets a grant that allows editing modify the workflow", async () => {
    const workflows = new WorkflowRepository(db);
    const saved = await workflows.save({
      graph: {
        name: "Editable flow",
        nodes: [],
        connections: [],
        metadata: { name: "Editable flow", version: "1.0.0", description: "" },
      } as never,
      userId: OWNER,
    });

    expect(await workflows.canModify(saved.id, STRANGER)).toBe(false);

    grant(saved.id, { userId: STRANGER }, "edit");

    expect(await workflows.canModify(saved.id, STRANGER)).toBe(true);
  });

  it("does not let a grant that only allows use modify the workflow", async () => {
    const workflows = new WorkflowRepository(db);
    const saved = await workflows.save({
      graph: {
        name: "Read-only flow",
        nodes: [],
        connections: [],
        metadata: { name: "Read-only flow", version: "1.0.0", description: "" },
      } as never,
      userId: OWNER,
    });

    grant(saved.id, { userId: STRANGER }, "use");

    expect(await workflows.canModify(saved.id, STRANGER)).toBe(false);
  });

  it("decides a workflow read the same way the repository answers it", async () => {
    const workflows = new WorkflowRepository(db);
    const saved = await workflows.save({
      graph: {
        name: "Private flow",
        nodes: [],
        connections: [],
        metadata: { name: "Private flow", version: "1.0.0", description: "" },
      } as never,
      userId: OWNER,
    });

    const resource = {
      type: RESOURCE_TYPES.workflow,
      id: saved.id,
      ownerId: OWNER,
      visibility: "private" as const,
    };

    expect(await authorization.can(STRANGER, "view", resource)).toBe(false);
    expect(await workflows.get(saved.id, STRANGER)).toBeNull();

    grant(saved.id, { userId: STRANGER });

    expect(await authorization.can(STRANGER, "view", resource)).toBe(true);
    expect(await workflows.get(saved.id, STRANGER)).not.toBeNull();
  });
});

describe("migration onto access grants", () => {
  const migrationsFolder = path.join(process.cwd(), "packages/web-backend/drizzle");

  function migrationRunner(sqlite: Database.Database): (upToTag: string) => void {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf-8"),
    ) as { entries: Array<{ tag: string }> };
    let next = 0;

    return (upToTag: string) => {
      while (next < journal.entries.length) {
        const entry = journal.entries[next];
        next += 1;
        const sql = readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), "utf-8");
        for (const statement of sql.split("--> statement-breakpoint")) {
          const trimmed = statement.trim();
          if (trimmed) sqlite.exec(trimmed);
        }
        if (entry.tag === upToTag) return;
      }
      throw new Error(`Migration ${upToTag} not found after the ones already applied`);
    };
  }

  it("carries an existing workflow share over as a grant on that workflow", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = OFF");
    const applyMigrationsUpTo = migrationRunner(sqlite);
    applyMigrationsUpTo("0032_entity_revisions");

    const grantedAt = 1_700_000_000_000;
    sqlite
      .prepare(
        "INSERT INTO workflowAccess (id, workflowId, userId, grantedBy, inviteId, grantedAt)" +
          " VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("share-1", "workflow-1", STRANGER, OWNER, null, grantedAt);

    applyMigrationsUpTo("0033_access_grants");

    expect(
      sqlite
        .prepare(
          "SELECT resourceType, resourceId, userId, groupId, level, grantedBy, grantedAt" +
            " FROM accessGrant WHERE id = 'share-1'",
        )
        .get(),
    ).toEqual({
      resourceType: "workflow",
      resourceId: "workflow-1",
      userId: STRANGER,
      groupId: null,
      level: "use",
      grantedBy: OWNER,
      grantedAt,
    });
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflowAccess'")
        .get(),
    ).toBeUndefined();

    sqlite.close();
  });
});
