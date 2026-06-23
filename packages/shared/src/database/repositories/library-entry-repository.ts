/**
 * Library Entry Repository — Drizzle queries for a user's non-implicit library
 * memberships (flows ADDED from the marketplace or SHARED via a private link).
 *
 * Core and own flows are resolved implicitly by the service and are NOT stored
 * here. UNIQUE (userId, workflowId) — a workflow appears at most once in a user's
 * library.
 */

import { eq, and } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { libraryEntry } from "../schema.js";
import type * as schema from "../schema.js";
import { v4 as uuidv4 } from "uuid";

/** A library entry row as stored. */
export type LibraryEntryRecord = typeof libraryEntry.$inferSelect;

/** Origin of a library entry. */
export type LibrarySource = "added" | "shared";

/** Linkage semantics. */
export type LibraryKind = "reference" | "copy";

/** Fields accepted when adding a library entry. */
export interface AddLibraryEntryInput {
  userId: string;
  workflowId: string;
  source: LibrarySource;
  kind: LibraryKind;
  listingId?: string | null;
}

export class LibraryEntryRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /** Add a library entry. Returns the stored row. */
  async add(input: AddLibraryEntryInput): Promise<LibraryEntryRecord> {
    const row = {
      id: uuidv4(),
      userId: input.userId,
      workflowId: input.workflowId,
      source: input.source,
      kind: input.kind,
      listingId: input.listingId ?? null,
      addedAt: new Date(),
    };
    await this.db.insert(libraryEntry).values(row);
    const created = await this.getByUserAndWorkflow(input.userId, input.workflowId);
    if (!created) {
      throw new Error(`Failed to add library entry for workflow ${input.workflowId}`);
    }
    return created;
  }

  /** Get a user's library entry for a specific workflow, if any. */
  async getByUserAndWorkflow(
    userId: string,
    workflowId: string,
  ): Promise<LibraryEntryRecord | null> {
    const [row] = await this.db
      .select()
      .from(libraryEntry)
      .where(and(eq(libraryEntry.userId, userId), eq(libraryEntry.workflowId, workflowId)))
      .limit(1);
    return row ?? null;
  }

  /** All of a user's library entries. */
  async listByUser(userId: string): Promise<LibraryEntryRecord[]> {
    return this.db.select().from(libraryEntry).where(eq(libraryEntry.userId, userId));
  }

  /** Remove a user's library entry for a workflow. Returns true if a row was removed. */
  async remove(userId: string, workflowId: string): Promise<boolean> {
    const result = await this.db
      .delete(libraryEntry)
      .where(and(eq(libraryEntry.userId, userId), eq(libraryEntry.workflowId, workflowId)));
    return result.changes > 0;
  }
}
