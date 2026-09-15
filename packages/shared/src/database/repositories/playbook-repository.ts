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
import { playbook } from "../schema.js";
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

/** Listing-sized rendering of a playbook's current text. */
function previewOfContent(content: string | null): string {
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

  /** Playbooks owned by this user, newest first. */
  async list(filter: PlaybookListFilter): Promise<PlaybookListResult> {
    const { ownerId, search, limit = 50, offset = 0 } = filter;
    const conditions = [eq(playbook.userId, ownerId), eq(playbook.deleted, false)];
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
      .select()
      .from(playbook)
      .where(where)
      .orderBy(desc(playbook.updatedAt))
      .limit(limit)
      .offset(offset);

    const playbooks = await Promise.all(rows.map((row) => this.toSummary(row)));
    return { playbooks, total: count?.total ?? 0 };
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
      ...(await this.toSummary(row)),
      revision: stored.revision,
      size: stored.size,
      content: stored.content ?? "",
    };
  }

  /** One playbook by id, without its content — used where a reference is resolved. */
  async getById(playbookId: string): Promise<PlaybookSummary | null> {
    const [row] = await this.db
      .select()
      .from(playbook)
      .where(and(eq(playbook.id, playbookId), eq(playbook.deleted, false)))
      .limit(1);
    return row ? this.toSummary(row) : null;
  }

  /** Create a playbook or write a new revision of an existing one. */
  async save(options: SavePlaybookOptions): Promise<{ id: string; revision: number }> {
    const { ownerId, slug, content, name, description, visibility, authorId } = options;
    const now = new Date();
    const size = Buffer.byteLength(content, "utf8");
    const existing = await this.row(ownerId, slug, { includeDeleted: true });

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
        deleted: false,
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
        // Saving over a removed playbook brings it back, as saving a note does.
        deleted: false,
        deletedAt: null,
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
    const [row] = await this.db
      .select({ id: playbook.id })
      .from(playbook)
      .where(eq(playbook.id, playbookId))
      .limit(1);
    if (!row) return false;

    // The revision store keeps no foreign key back to this table; removing the history is the
    // owner's job and nothing else does it.
    await this.revisions.deleteHistory(this.revisionTarget(playbookId));
    await this.db.delete(playbook).where(eq(playbook.id, playbookId));
    return true;
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

  private async row(
    ownerId: string,
    slug: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<typeof playbook.$inferSelect | null> {
    const conditions = [eq(playbook.userId, ownerId), eq(playbook.slug, slug)];
    if (!options.includeDeleted) conditions.push(eq(playbook.deleted, false));
    const [row] = await this.db
      .select()
      .from(playbook)
      .where(and(...conditions))
      .limit(1);
    return row ?? null;
  }

  /**
   * Metadata plus a short preview of the current text.
   *
   * The preview comes from the newest revision alone: reading the whole history to show one line
   * would make listing a page of playbooks cost every revision of every one of them.
   */
  private async toSummary(row: typeof playbook.$inferSelect): Promise<PlaybookSummary> {
    const latest = await this.revisions.latest(this.revisionTarget(row.id));
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      visibility: row.visibility === "public" ? "public" : "private",
      ownerId: row.userId,
      revision: row.currentRevision,
      size: row.size,
      preview: previewOfContent(latest?.content ?? null),
      createdAt: (row.createdAt as Date).getTime(),
      updatedAt: (row.updatedAt as Date).getTime(),
    };
  }
}
