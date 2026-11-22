import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/** Call inside the transaction that creates or updates the administrator. */
export function writeAdminCredential(
  db: Database.Database,
  userId: string,
  hashedPassword: string,
): boolean {
  const accounts = db
    .prepare(
      "SELECT id, userId FROM account WHERE providerId = 'credential' AND (userId = ? OR accountId = ?)",
    )
    .all(userId, userId) as { id: string; userId: string }[];
  if (accounts.length > 1 || accounts.some((account) => account.userId !== userId)) {
    throw new Error("Ambiguous administrator password credential ownership");
  }
  const existingAccount = accounts[0];
  const createdAccount = !existingAccount;

  if (createdAccount) {
    db.prepare(
      `INSERT INTO account (id, userId, accountId, providerId, password, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(randomUUID(), userId, userId, "credential", hashedPassword);
  } else {
    db.prepare(
      `UPDATE account
          SET accountId = ?, password = ?, updatedAt = datetime('now')
        WHERE id = ? AND userId = ? AND providerId = 'credential'`,
    ).run(userId, hashedPassword, existingAccount.id, userId);
  }
  return createdAccount;
}
