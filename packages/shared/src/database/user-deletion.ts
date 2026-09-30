/**
 * Deleting a user account. The database deletes everything the user owns by cascade — their runs,
 * their workflows and everyone's runs of those workflows — outside any execution writer, so the
 * change feed records those runs as deleted in the same transaction, before the delete.
 */

import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { recordExecutionsDeleted } from "./execution-change.js";
import { user } from "./schema.js";
import type * as schema from "./schema.js";

export function deleteUserAccount(db: BetterSQLite3Database<typeof schema>, userId: string): void {
  db.transaction(
    (tx) => {
      recordExecutionsDeleted(tx, { userId });
      tx.delete(user).where(eq(user.id, userId)).run();
    },
    { behavior: "immediate" },
  );
}
