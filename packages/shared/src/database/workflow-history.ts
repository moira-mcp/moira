import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";
import { RevisionRepository, REVISION_ENTITY_TYPES } from "./repositories/revision-repository.js";

/** Record a definition write inside the transaction that owns that write. */
export function recordWorkflowRevision(
  db: BetterSQLite3Database<typeof schema>,
  options: { id: string; graph: string; previousGraph?: string; authorId?: string | null },
): number {
  const revisions = new RevisionRepository(db);
  const target = { entityType: REVISION_ENTITY_TYPES.workflow, entityId: options.id };
  if (options.previousGraph !== undefined && !revisions.latestSync(target)) {
    revisions.appendSync({ ...target, content: options.previousGraph, authorId: null });
  }
  return revisions.appendSync({
    ...target,
    content: options.graph,
    authorId: options.authorId ?? null,
  }).revision;
}
