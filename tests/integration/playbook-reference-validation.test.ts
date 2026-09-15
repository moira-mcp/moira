/**
 * Playbook references are checked while a workflow is edited.
 *
 * A directive that names a playbook the author cannot read would run with that text missing. The
 * editing path says so instead, so the author learns it at the keyboard rather than mid-run.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import {
  AuditRepository,
  AuthorizationService,
  PlaybookRepository,
  PlaybookService,
  UserRepository,
  WorkflowMutationService,
  WorkflowRepository,
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import * as schema from "../../packages/shared/src/database/schema.js";

const AUTHOR = "playbook-reference-author";

function graphReferencing(reference: string): WorkflowGraph {
  return {
    metadata: {
      name: "Referencing flow",
      version: "1.0.0",
      description: "A flow that names a playbook in its directive",
    },
    nodes: [
      { id: "start", type: "start", connections: { default: "work" } },
      {
        id: "work",
        type: "agent-directive",
        directive: `Follow this standard: ${reference}`,
        completionCondition: "The work follows the standard.",
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  } as unknown as WorkflowGraph;
}

describe("playbook references while editing", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let mutationService: WorkflowMutationService;
  let playbooks: PlaybookService;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });

    const now = new Date().toISOString();
    sqlite
      .prepare("INSERT INTO user (id, email, handle, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)")
      .run(AUTHOR, `${AUTHOR}@example.test`, `handle-of-${AUTHOR}`, now, now);

    playbooks = new PlaybookService(
      new PlaybookRepository(db),
      new AuditRepository(db),
      new AuthorizationService(db),
      new UserRepository(db),
    );
    mutationService = new WorkflowMutationService(
      new WorkflowRepository(db),
      new AuditRepository(db),
      undefined,
      playbooks,
    );
  });

  afterEach(() => {
    sqlite.close();
  });

  it("refuses a definition that names a playbook the author cannot read", async () => {
    const result = await mutationService.save({
      graph: graphReferencing("{{playbook:review-standard}}"),
      userId: AUTHOR,
    });

    expect(result.validation.status).toBe("invalid");
    expect(result.validation.errors.join("\n")).toContain("review-standard");
    expect(result.validation.errors.join("\n")).toContain("not available to you");
  });

  it("accepts the same definition once the playbook exists", async () => {
    await playbooks.save(AUTHOR, { slug: "review-standard", content: "Read the diff." });

    const result = await mutationService.save({
      graph: graphReferencing("{{playbook:review-standard}}"),
      userId: AUTHOR,
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.validation.status).toBe("valid");
  });

  it("ignores an escaped reference, so a definition may document the syntax", async () => {
    const result = await mutationService.save({
      graph: graphReferencing("write it as \\{{playbook:review-standard}}"),
      userId: AUTHOR,
    });

    expect(result.validation.errors).toEqual([]);
    expect(result.validation.status).toBe("valid");
  });

  it("refuses a reference to another author's private playbook", async () => {
    const now = new Date().toISOString();
    sqlite
      .prepare("INSERT INTO user (id, email, handle, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)")
      .run("other-author", "other@example.test", "handle-of-other", now, now);
    await playbooks.save("other-author", { slug: "private-standard", content: "Theirs." });

    const result = await mutationService.save({
      graph: graphReferencing("{{playbook:@handle-of-other/private-standard}}"),
      userId: AUTHOR,
    });

    expect(result.validation.status).toBe("invalid");
    expect(result.validation.errors.join("\n")).toContain("private-standard");
  });

  it("leaves a definition without references untouched by the check", async () => {
    const result = await mutationService.save({
      graph: graphReferencing("no reference at all"),
      userId: AUTHOR,
    });

    expect(result.validation.status).toBe("valid");
  });
});
