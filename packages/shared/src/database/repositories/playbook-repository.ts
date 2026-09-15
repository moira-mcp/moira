/**
 * Storage for playbooks — named, reusable behaviour text an author references from workflow nodes.
 *
 * The repository owns the playbook's identity: its machine name, human name, description and
 * visibility. Content is not stored here at all; every revision of it lives in the shared revision
 * store, which is also what makes history, restore and comparison work the same way they do for a
 * note or a global setting.
 *
 * The revision store holds no foreign key back to a playbook, so removing one removes its history
 * here, explicitly.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { entityRevision, playbook } from "../schema.js";
import type * as schema from "../schema.js";
import { createLogger } from "../../logging/logger.js";
import {
  DEFAULT_REVISION_PREVIEW_CHARS,
  REVISION_ENTITY_TYPES,
  RevisionRepository,
  type RevisionSummary,
} from "./revision-repository.js";
import type { RevisionDiffPart } from "../../services/revision-diff.js";

/** How many past versions of one playbook are kept. */
export const MAX_PLAYBOOK_REVISIONS = 50;

/** Largest content a single playbook may hold, in bytes. */
export const MAX_PLAYBOOK_SIZE = 100 * 1024;

export type PlaybookVisibility = "private" | "public";

/** A playbook without its content, as a listing shows it. */
export interface PlaybookSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: PlaybookVisibility;
  ownerId: string;
  revision: number;
  size: number;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

/** A playbook with the content of one revision. */
export interface Playbook extends PlaybookSummary {
  content: string;
}

export interface SavePlaybookOptions {
  ownerId: string;
  slug: string;
  content: string;
  name?: string;
  description?: string | null;
  visibility?: PlaybookVisibility;
  /** Who wrote this revision; the owner unless a grant let somebody else edit. */
  authorId?: string;
}

export interface PlaybookListFilter {
  ownerId: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PlaybookListResult {
  playbooks: PlaybookSummary[];
  total: number;
}

type PlaybookRow = typeof playbook.$inferSelect;

/** Listing-sized rendering of a playbook's text. */
function previewOf(content: string | null): string {
  if (!content) return "";
  return content.length > DEFAULT_REVISION_PREVIEW_CHARS
    ? `${content.substring(0, DEFAULT_REVISION_PREVIEW_CHARS)}...`
    : content;
}

export class PlaybookRepository {
  private logger = createLogger({ component: "PlaybookRepository" });
  private revisions: RevisionRepository;

  constructor(private db: BetterSQLite3Database<typeof schema>) {
    this.revisions = new RevisionRepository(db);
  }

  private revisionTarget(playbookId: string) {
    return { entityType: REVISION_ENTITY_TYPES.playbook, entityId: playbookId } as const;
  }

  /**
   * Playbooks owned by this user, newest first.
   *
   * One query: the current content joins in through the revision store, so a page of playbooks
   * costs one read rather than one per row, and the preview comes from the same text the reader
   * would open.
   */
  async list(filter: PlaybookListFilter): Promise<PlaybookListResult> {
    const { ownerId, search, limit = 50, offset = 0 } = filter;
    const conditions = [eq(playbook.userId, ownerId)];
    if (search) {
      const pattern = `%${search}%`;
      const matches = or(
        like(playbook.slug, pattern),
        like(playbook.name, pattern),
        like(playbook.description, pattern),
      );
      if (matches) conditions.push(matches);
    }
    const where = and(...conditions);

    const [count] = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(playbook)
      .where(where);

    const rows = await this.db
      .select({ row: playbook, content: entityRevision.content })
      .from(playbook)
      .leftJoin(
        entityRevision,
        and(
          eq(entityRevision.entityType, REVISION_ENTITY_TYPES.playbook),
          eq(entityRevision.entityId, playbook.id),
          eq(entityRevision.revision, playbook.currentRevision),
        ),
      )
      .where(where)
      .orderBy(desc(playbook.updatedAt))
      .limit(limit)
      .offset(offset);

    return {
      playbooks: rows.map(({ row, content }) => this.toSummary(row, content)),
      total: count?.total ?? 0,
    };
  }

  /** One playbook by owner and machine name, with the content of a revision. */
  async get(ownerId: string, slug: string, revision?: number): Promise<Playbook | null> {
    const row = await this.row(ownerId, slug);
    if (!row) return null;

    const stored = await this.revisions.get(
      this.revisionTarget(row.id),
      revision ?? row.currentRevision,
    );
    if (!stored) return null;

    return {
      ...this.toSummary(row, stored.content),
      revision: stored.revision,
      size: stored.size,
      content: stored.content ?? "",
    };
  }

  /** One playbook by id, without its content. */
  async getById(playbookId: string): Promise<PlaybookSummary | null> {
    const [found] = await this.db
      .select({ row: playbook, content: entityRevision.content })
      .from(playbook)
      .leftJoin(
        entityRevision,
        and(
          eq(entityRevision.entityType, REVISION_ENTITY_TYPES.playbook),
          eq(entityRevision.entityId, playbook.id),
          eq(entityRevision.revision, playbook.currentRevision),
        ),
      )
      .where(eq(playbook.id, playbookId))
      .limit(1);
    return found ? this.toSummary(found.row, found.content) : null;
  }

  /** Create a playbook or write a new revision of an existing one. */
  async save(options: SavePlaybookOptions): Promise<{ id: string; revision: number }> {
    const { ownerId, slug, content, name, description, visibility, authorId } = options;
    const now = new Date();
    const size = Buffer.byteLength(content, "utf8");
    const existing = await this.row(ownerId, slug);

    const id = existing?.id ?? randomUUID();
    if (!existing) {
      await this.db.insert(playbook).values({
        id,
        userId: ownerId,
        slug,
        name: name ?? slug,
        description: description ?? null,
        visibility: visibility ?? "private",
        currentRevision: 1,
        size,
        createdAt: now,
        updatedAt: now,
      });
    }

    const appended = await this.revisions.append({
      ...this.revisionTarget(id),
      content,
      authorId: authorId ?? ownerId,
      maxRevisions: MAX_PLAYBOOK_REVISIONS,
    });

    await this.db
      .update(playbook)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(visibility !== undefined ? { visibility } : {}),
        currentRevision: appended.revision,
        size,
        updatedAt: now,
      })
      .where(eq(playbook.id, id));

    this.logger.debug("save() wrote a revision", { id, revision: appended.revision });
    return { id, revision: appended.revision };
  }

  /** Change who may read a playbook. */
  async setVisibility(playbookId: string, visibility: PlaybookVisibility): Promise<void> {
    await this.db
      .update(playbook)
      .set({ visibility, updatedAt: new Date() })
      .where(eq(playbook.id, playbookId));
  }

  /** Remove a playbook and the history that belongs to it. */
  async remove(playbookId: string): Promise<boolean> {
    // The revision store keeps no foreign key back to this table; removing the history is the
    // owner's job and nothing else does it.
    await this.revisions.deleteHistory(this.revisionTarget(playbookId));
    const result = await this.db.delete(playbook).where(eq(playbook.id, playbookId));
    return result.changes > 0;
  }

  /** Version history of a playbook, newest first. */
  async history(playbookId: string): Promise<RevisionSummary[]> {
    return this.revisions.list(this.revisionTarget(playbookId));
  }

  /** Compare two stored revisions of a playbook. */
  async compare(
    playbookId: string,
    from: number,
    to: number,
  ): Promise<{ from: number; to: number; parts: RevisionDiffPart[] } | null> {
    return this.revisions.compare(this.revisionTarget(playbookId), from, to);
  }

  private async row(ownerId: string, slug: string): Promise<PlaybookRow | null> {
    const [row] = await this.db
      .select()
      .from(playbook)
      .where(and(eq(playbook.userId, ownerId), eq(playbook.slug, slug)))
      .limit(1);
    return row ?? null;
  }

  private toSummary(row: PlaybookRow, content: string | null): PlaybookSummary {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      visibility: row.visibility === "public" ? "public" : "private",
      ownerId: row.userId,
      revision: row.currentRevision,
      size: row.size,
      preview: previewOf(content),
      createdAt: (row.createdAt as Date).getTime(),
      updatedAt: (row.updatedAt as Date).getTime(),
    };
  }
}
