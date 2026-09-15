/**
 * Storage for the shared revision history.
 *
 * Every versioned entity in the product — notes, global settings, playbooks — keeps its content
 * revisions here. The repository knows nothing about those entities beyond an opaque type and id,
 * which is what lets one history serve all of them.
 *
 * Retention is the one policy the caller chooses, because it belongs to the entity rather than to
 * the history: a note keeps a bounded tail of revisions, an administrative setting keeps far fewer
 * writes and a different tail. Appending is the only way content enters; an existing revision is
 * never rewritten.
 */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { entityRevision } from "../schema.js";
import { createLogger } from "../../logging/logger.js";
import { compareRevisionContent, type RevisionDiffPart } from "../../services/revision-diff.js";
import type * as schema from "../schema.js";

/** Entity kinds the shared history serves. */
export const REVISION_ENTITY_TYPES = {
  note: "note",
  globalSetting: "global-setting",
  playbook: "playbook",
} as const;

export type RevisionEntityType = (typeof REVISION_ENTITY_TYPES)[keyof typeof REVISION_ENTITY_TYPES];

/** Address of a versioned entity inside the shared history. */
export interface RevisionTarget {
  entityType: RevisionEntityType;
  entityId: string;
}

/** A stored revision with its content; null content means the entity had no content at all. */
export interface Revision {
  revision: number;
  content: string | null;
  size: number;
  authorId: string | null;
  createdAt: number;
}

/**
 * A stored revision as a history listing shows it: metadata plus a short preview instead of the
 * whole content, so listing a long history does not carry every revision's text with it.
 */
export interface RevisionSummary extends Omit<Revision, "content"> {
  preview: string;
}

/** Preview length used when the caller does not ask for another one. */
export const DEFAULT_REVISION_PREVIEW_CHARS = 100;

export interface AppendRevisionOptions extends RevisionTarget {
  content: string | null;
  authorId?: string | null;
  /** Keep at most this many newest revisions; omit to keep every revision. */
  maxRevisions?: number;
}

/** Short, listing-sized rendering of a revision's content; absent content previews as empty. */
function previewOf(content: string | null, previewChars: number): string {
  if (!content) return "";
  return content.length > previewChars ? `${content.substring(0, previewChars)}...` : content;
}

export class RevisionRepository {
  private logger = createLogger({ component: "RevisionRepository" });

  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /**
   * Append a revision and return it.
   *
   * The number is derived from the highest one currently stored, so a pruned tail never causes a
   * reused number: pruning removes the oldest rows, not the newest.
   */
  async append(options: AppendRevisionOptions): Promise<Revision> {
    const { entityType, entityId, content, authorId = null, maxRevisions } = options;
    const size = Buffer.byteLength(content ?? "", "utf8");
    const createdAt = new Date();
    const revision = (await this.highestRevision({ entityType, entityId })) + 1;

    await this.db.insert(entityRevision).values({
      id: randomUUID(),
      entityType,
      entityId,
      revision,
      content,
      size,
      authorId,
      createdAt,
    });

    if (maxRevisions !== undefined) {
      await this.prune({ entityType, entityId }, maxRevisions);
    }

    return { revision, content, size, authorId, createdAt: createdAt.getTime() };
  }

  /** The newest revision, or null when the entity has no history. */
  async latest(target: RevisionTarget): Promise<Revision | null> {
    const [row] = await this.db
      .select()
      .from(entityRevision)
      .where(
        and(
          eq(entityRevision.entityType, target.entityType),
          eq(entityRevision.entityId, target.entityId),
        ),
      )
      .orderBy(desc(entityRevision.revision))
      .limit(1);
    return row ? this.toRevision(row) : null;
  }

  /** One revision by number, or null when it is absent or already pruned. */
  async get(target: RevisionTarget, revision: number): Promise<Revision | null> {
    const [row] = await this.db
      .select()
      .from(entityRevision)
      .where(
        and(
          eq(entityRevision.entityType, target.entityType),
          eq(entityRevision.entityId, target.entityId),
          eq(entityRevision.revision, revision),
        ),
      )
      .limit(1);
    return row ? this.toRevision(row) : null;
  }

  /** The stored history, newest first, with a preview in place of the full content. */
  async list(
    target: RevisionTarget,
    options: { previewChars?: number } = {},
  ): Promise<RevisionSummary[]> {
    const previewChars = options.previewChars ?? DEFAULT_REVISION_PREVIEW_CHARS;
    const rows = await this.db
      .select({
        revision: entityRevision.revision,
        size: entityRevision.size,
        content: entityRevision.content,
        authorId: entityRevision.authorId,
        createdAt: entityRevision.createdAt,
      })
      .from(entityRevision)
      .where(
        and(
          eq(entityRevision.entityType, target.entityType),
          eq(entityRevision.entityId, target.entityId),
        ),
      )
      .orderBy(desc(entityRevision.revision));

    return rows.map((row) => ({
      revision: row.revision,
      size: row.size,
      preview: previewOf(row.content, previewChars),
      authorId: row.authorId ?? null,
      createdAt: (row.createdAt as Date).getTime(),
    }));
  }

  /**
   * Compare two stored revisions of one entity, oldest first in the pair's reading.
   *
   * Returns null when either revision is unknown or has fallen out of the retained tail, so a
   * caller can tell "nothing differs" from "there is nothing to compare".
   */
  async compare(
    target: RevisionTarget,
    from: number,
    to: number,
  ): Promise<{ from: number; to: number; parts: RevisionDiffPart[] } | null> {
    const [before, after] = await Promise.all([this.get(target, from), this.get(target, to)]);
    if (!before || !after) return null;
    return { from, to, parts: compareRevisionContent(before.content, after.content) };
  }

  /** Remove an entity's whole history; the owner calls this when it deletes the entity itself. */
  async deleteHistory(target: RevisionTarget): Promise<void> {
    await this.db
      .delete(entityRevision)
      .where(
        and(
          eq(entityRevision.entityType, target.entityType),
          eq(entityRevision.entityId, target.entityId),
        ),
      );
  }

  /** Total stored size of an entity's history, in bytes. */
  async totalSize(target: RevisionTarget): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${entityRevision.size}), 0)` })
      .from(entityRevision)
      .where(
        and(
          eq(entityRevision.entityType, target.entityType),
          eq(entityRevision.entityId, target.entityId),
        ),
      );
    return row?.total ?? 0;
  }

  private async highestRevision(target: RevisionTarget): Promise<number> {
    const [row] = await this.db
      .select({ revision: entityRevision.revision })
      .from(entityRevision)
      .where(
        and(
          eq(entityRevision.entityType, target.entityType),
          eq(entityRevision.entityId, target.entityId),
        ),
      )
      .orderBy(desc(entityRevision.revision))
      .limit(1);
    return row?.revision ?? 0;
  }

  private async prune(target: RevisionTarget, maxRevisions: number): Promise<void> {
    const rows = await this.db
      .select({ id: entityRevision.id })
      .from(entityRevision)
      .where(
        and(
          eq(entityRevision.entityType, target.entityType),
          eq(entityRevision.entityId, target.entityId),
        ),
      )
      .orderBy(asc(entityRevision.revision));

    if (rows.length <= maxRevisions) return;

    const doomed = rows.slice(0, rows.length - maxRevisions);
    await this.db.delete(entityRevision).where(
      inArray(
        entityRevision.id,
        doomed.map((row) => row.id),
      ),
    );
    this.logger.debug("prune() dropped oldest revisions", {
      entityType: target.entityType,
      entityId: target.entityId,
      droppedCount: doomed.length,
    });
  }

  private toRevision(row: typeof entityRevision.$inferSelect): Revision {
    return {
      revision: row.revision,
      content: row.content,
      size: row.size,
      authorId: row.authorId ?? null,
      createdAt: (row.createdAt as Date).getTime(),
    };
  }
}
