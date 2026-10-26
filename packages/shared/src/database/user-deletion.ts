/**
 * Deleting a user account. The database deletes everything the user owns by cascade — their runs,
 * their workflows and everyone's runs of those workflows — outside any execution writer, so the
 * change feed records those runs as deleted in the same transaction, before the delete.
 */

import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { recordExecutionsDeleted } from "./execution-change.js";
import { user, entityRevision, workflow } from "./schema.js";
import { REVISION_ENTITY_TYPES } from "./repositories/revision-repository.js";
import type * as schema from "./schema.js";
import {
  AccountResourceRetirementRequiredError,
  assertAccountResourcesRetired,
} from "./account-resource-retirement.js";

export class AccountCredentialRetirementRequiredError extends Error {
  readonly code = "ACCOUNT_CREDENTIAL_RETIREMENT_PENDING";
  constructor() {
    super("Account credential retirement remains pending");
    this.name = "AccountCredentialRetirementRequiredError";
  }
}

export function deleteUserAccount(db: BetterSQLite3Database<typeof schema>, userId: string): void {
  db.transaction(
    (tx) => {
      assertAccountResourcesRetired(
        tx.all<{
          state: string;
        }>(sql`SELECT CASE WHEN retiredAt IS NOT NULL THEN 'deleted' ELSE 'unknown' END AS state FROM localResourceIdentity WHERE userId=${userId}
          UNION ALL SELECT CASE WHEN retirement IN ('retired','uncreated') THEN 'deleted' ELSE 'unknown' END AS state
          FROM githubResourceIdentity WHERE userId=${userId}`),
      );
      const pending = tx.get<{ present: number }>(
        sql`SELECT 1 AS present FROM codespaceCredentialRevocation WHERE userId=${userId} AND (credentialKind <> 'scoped' OR state NOT IN ('disposed','refused')) LIMIT 1`,
      );
      const parent = tx.get<{ present: number }>(
        sql`SELECT 1 AS present FROM codespaceCredentialVault v JOIN codespaceConnection c ON c.id=v.connectionId WHERE c.userId=${userId} LIMIT 1`,
      );
      const uncertainParent = tx.get<{ present: number }>(
        sql`SELECT 1 AS present FROM codespaceConnection WHERE userId=${userId} AND (lastErrorCode IN ('AUTH_GRANT_REVOCATION_REQUIRED','CREDENTIAL_UNREADABLE') OR refreshLeaseId IS NOT NULL OR status='revocation_pending') LIMIT 1`,
      );
      if (pending || parent || uncertainParent)
        throw new AccountCredentialRetirementRequiredError();
      const unretiredConnection = tx.get<{ present: number }>(
        sql`SELECT 1 AS present FROM codespaceConnection WHERE userId=${userId} AND status <> 'disconnected' LIMIT 1`,
      );
      if (unretiredConnection) throw new AccountCredentialRetirementRequiredError();
      const unsettledRepository = tx.get<{ present: number }>(
        sql`SELECT 1 AS present FROM codespaceRepositoryRequest WHERE userId=${userId} AND state NOT IN ('created','rejected') LIMIT 1`,
      );
      if (unsettledRepository) throw new AccountResourceRetirementRequiredError();
      // Only confirmed retired ownership is removed. All effects remain inside this transaction.
      tx.run(
        sql`DELETE FROM localResourceIdentity WHERE userId=${userId} AND retiredAt IS NOT NULL`,
      );
      tx.run(sql`DELETE FROM workspaceAgentCredential WHERE userId=${userId}`);
      tx.run(sql`DELETE FROM githubWorkspaceRenewal WHERE userId=${userId}`);
      tx.run(
        sql`DELETE FROM githubResourceIdentity WHERE userId=${userId} AND retirement IN ('retired','uncreated')`,
      );
      tx.run(sql`DELETE FROM codespaceLocalPairing WHERE userId=${userId}`);
      tx.run(
        sql`DELETE FROM codespaceRepositoryRequest WHERE userId=${userId} AND state IN ('created','rejected')`,
      );
      tx.run(sql`DELETE FROM codespaceLocalDevice WHERE userId=${userId}`);
      tx.run(sql`DELETE FROM codespaceConnection WHERE userId=${userId} AND status='disconnected'`);
      recordExecutionsDeleted(tx, { userId });
      tx.run(
        sql`DELETE FROM ${entityRevision} WHERE ${entityRevision.entityType}=${REVISION_ENTITY_TYPES.workflow} AND ${entityRevision.entityId} IN (SELECT ${workflow.id} FROM ${workflow} WHERE ${workflow.userId}=${userId})`,
      );
      tx.delete(user).where(eq(user.id, userId)).run();
    },
    { behavior: "immediate" },
  );
}
