import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  WorkspaceMachine,
  WorkspaceResourcePolicy,
  WorkspaceResourceRecord,
  WorkspaceResourceState,
  WorkspaceRepositoryTarget,
} from "./resource-types.js";

const ACTIVE_STATES = [
  "create_pending",
  "create_submitted",
  "usable",
  "start_pending",
  "stop_pending",
  "stopped",
  "delete_pending",
  "cleanup_pending",
  "ambiguous",
] as const;

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function digestWorkspaceCapability(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface ResourceRow extends Omit<WorkspaceResourceRecord, "machine"> {
  machineName: string;
  machineDisplayName: string;
  machineOperatingSystem: string;
  machineCpuCores: number;
  machineMemoryBytes: number;
  machineStorageBytes: number;
}

function mapRow(row: ResourceRow): WorkspaceResourceRecord {
  const {
    machineName,
    machineDisplayName,
    machineOperatingSystem,
    machineCpuCores,
    machineMemoryBytes,
    machineStorageBytes,
    ...record
  } = row;
  return {
    ...record,
    machine: {
      name: machineName,
      displayName: machineDisplayName,
      operatingSystem: machineOperatingSystem,
      cpuCores: machineCpuCores,
      memoryBytes: machineMemoryBytes,
      storageBytes: machineStorageBytes,
    },
  };
}

export type ReserveWorkspaceResult =
  | { outcome: "reserved"; resource: WorkspaceResourceRecord; capability: string }
  | { outcome: "disabled" | "limit" | "not_approved"; reason: string };

export class WorkspaceResourceRepository {
  constructor(private readonly sqlite: Database.Database) {}

  private isDisabled(provider: string): boolean {
    const row = this.sqlite
      .prepare(
        `SELECT 1 FROM workspaceProviderControl
         WHERE disabled = 1 AND scope IN ('global', ?) LIMIT 1`,
      )
      .get(`provider:${provider}`);
    return Boolean(row);
  }

  listControls(provider: string): Array<{
    scope: "global" | `provider:${string}`;
    disabled: boolean;
    reason: string | null;
    updatedAt: number | null;
  }> {
    const rows = this.sqlite
      .prepare(
        `SELECT scope, disabled, reason, updatedAt FROM workspaceProviderControl
         WHERE scope IN ('global', ?)`,
      )
      .all(`provider:${provider}`) as Array<{
      scope: string;
      disabled: number;
      reason: string | null;
      updatedAt: number;
    }>;
    const byScope = new Map(rows.map((row) => [row.scope, row]));
    return (["global", `provider:${provider}`] as const).map((scope) => {
      const row = byScope.get(scope);
      return {
        scope,
        disabled: row ? row.disabled === 1 : false,
        reason: row?.reason ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  countActive(provider: string): number {
    return (
      this.sqlite
        .prepare(
          `SELECT COUNT(*) count FROM workspaceResource
           WHERE provider = ? AND state IN (${placeholders(ACTIVE_STATES)})`,
        )
        .get(provider, ...ACTIVE_STATES) as { count: number }
    ).count;
  }

  /** Records that the reconciliation loop would claim now, regardless of active claims. */
  dueSummary(now: number): { count: number; oldestUpdatedAt: number | null } {
    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) count, MIN(updatedAt) oldest FROM workspaceResource
         WHERE state IN ('create_pending', 'create_submitted', 'cleanup_pending', 'ambiguous',
                         'usable', 'start_pending', 'stop_pending', 'delete_pending')
           AND (state != 'usable' OR retentionPolicy != 'persistent' AND remoteExpiresAt <= ?)`,
      )
      .get(now) as { count: number; oldest: number | null };
    return { count: row.count, oldestUpdatedAt: row.count > 0 ? row.oldest : null };
  }

  getControl(provider: string): { disabled: boolean; reason: string | null } {
    const rows = this.sqlite
      .prepare(
        `SELECT scope, reason FROM workspaceProviderControl
         WHERE disabled = 1 AND scope IN ('global', ?) ORDER BY scope LIMIT 1`,
      )
      .all(`provider:${provider}`) as Array<{ scope: string; reason: string | null }>;
    return { disabled: rows.length > 0, reason: rows[0]?.reason ?? null };
  }

  getApprovedConnection(
    userId: string,
    provider: string,
    repositoryId: string,
  ): {
    connectionId: string;
    externalAccountId: string;
    authorizationGeneration: number;
    repository: WorkspaceRepositoryTarget;
  } | null {
    const row = this.sqlite
      .prepare(
        `SELECT c.id connectionId, c.externalAccountId,
                c.credentialGeneration authorizationGeneration,
                r.externalRepositoryId, r.fullName, r.private
         FROM workspaceConnection c JOIN workspaceConnectionRepository r ON r.connectionId = c.id
         WHERE c.userId = ? AND c.provider = ? AND c.status = 'connected'
           AND r.externalRepositoryId = ?`,
      )
      .get(userId, provider, repositoryId) as
      | {
          connectionId: string;
          externalAccountId: string;
          authorizationGeneration: number;
          externalRepositoryId: string;
          fullName: string;
          private: number;
        }
      | undefined;
    return row
      ? {
          connectionId: row.connectionId,
          externalAccountId: row.externalAccountId,
          authorizationGeneration: row.authorizationGeneration,
          repository: {
            id: row.externalRepositoryId,
            fullName: row.fullName,
            private: row.private === 1,
          },
        }
      : null;
  }

  listApprovedRepositories(userId: string, provider: string): WorkspaceRepositoryTarget[] {
    const rows = this.sqlite
      .prepare(
        `SELECT r.externalRepositoryId, r.fullName, r.private
         FROM workspaceConnection c JOIN workspaceConnectionRepository r ON r.connectionId = c.id
         WHERE c.userId = ? AND c.provider = ? AND c.status = 'connected'
         ORDER BY r.fullName`,
      )
      .all(userId, provider) as Array<{
      externalRepositoryId: string;
      fullName: string;
      private: number;
    }>;
    return rows.map((row) => ({
      id: row.externalRepositoryId,
      fullName: row.fullName,
      private: row.private === 1,
    }));
  }

  reserveCreate(input: {
    userId: string;
    provider: string;
    connectionId: string;
    authorizationGeneration: number;
    repository: WorkspaceRepositoryTarget;
    requestedRef: string;
    machine: WorkspaceMachine;
    externalAccountId: string;
    policy: WorkspaceResourcePolicy;
    now: number;
  }): ReserveWorkspaceResult {
    const transaction = this.sqlite.transaction(() => {
      if (this.isDisabled(input.provider)) {
        return { outcome: "disabled", reason: "Workspace provider is disabled" } as const;
      }
      const connection = this.sqlite
        .prepare(
          `SELECT c.id FROM workspaceConnection c
           WHERE c.userId = ? AND c.provider = ? AND c.status = 'connected'
             AND c.externalAccountId = ? AND c.id = ? AND c.credentialGeneration = ?
             AND EXISTS (SELECT 1 FROM workspaceConnectionRepository grantRow
               WHERE grantRow.connectionId = c.id AND grantRow.externalRepositoryId = ?)`,
        )
        .get(
          input.userId,
          input.provider,
          input.externalAccountId,
          input.connectionId,
          input.authorizationGeneration,
          input.repository.id,
        ) as { id: string } | undefined;
      if (!connection) {
        return { outcome: "not_approved", reason: "Repository is not approved" } as const;
      }

      const capacity = this.checkCreateCapacity(
        input.userId,
        input.provider,
        input.policy,
        input.now,
      );
      if (capacity) return capacity;
      const day = utcDay(input.now);

      const id = randomUUID();
      const capability = randomBytes(32).toString("base64url");
      const operationMarker = `moira-${randomBytes(12).toString("hex")}`;
      this.sqlite
        .prepare(
          `INSERT INTO workspaceResource
           (id, userId, connectionId, authorizationGeneration, provider, repositoryId, repositoryFullName,
            requestedRef, operationMarker, machineName, machineDisplayName,
            machineOperatingSystem, machineCpuCores, machineMemoryBytes, machineStorageBytes,
            state, retentionPolicy, desiredState, observedState, generation,
            createDeadlineAt, remoteExpiresAt, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'create_pending', 'persistent', 'running', 'provisioning', 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.userId,
          connection.id,
          input.authorizationGeneration,
          input.provider,
          input.repository.id,
          input.repository.fullName,
          input.requestedRef,
          operationMarker,
          input.machine.name,
          input.machine.displayName,
          input.machine.operatingSystem,
          input.machine.cpuCores,
          input.machine.memoryBytes,
          input.machine.storageBytes,
          input.now + input.policy.createDeadlineMs,
          input.now + input.policy.remoteTtlMs,
          input.now,
          input.now,
        );
      this.sqlite
        .prepare(
          `INSERT INTO workspaceProviderMutation
           (id, resourceId, userId, provider, generation, kind, attempt, createdAt)
           VALUES (?, ?, ?, ?, 1, 'create', 1, ?)`,
        )
        .run(randomUUID(), id, input.userId, input.provider, input.now);
      this.sqlite
        .prepare(
          `INSERT INTO workspaceLifecycleCapability (resourceId, userId, capabilityHash, createdAt)
           VALUES (?, ?, ?, ?)`,
        )
        .run(id, input.userId, digestWorkspaceCapability(capability), input.now);
      this.sqlite
        .prepare(
          `INSERT INTO workspacePolicyUsage
           (userId, provider, utcDay, submittedOperations, requiredCleanupOperations, updatedAt)
           VALUES (?, ?, ?, 1, 0, ?)
           ON CONFLICT(userId, provider, utcDay) DO UPDATE SET
             submittedOperations = submittedOperations + 1, updatedAt = excluded.updatedAt`,
        )
        .run(input.userId, input.provider, day, input.now);
      return {
        outcome: "reserved",
        resource: this.requireById(id),
        capability,
      } as const;
    });
    return transaction.immediate();
  }

  checkCreateCapacity(
    userId: string,
    provider: string,
    policy: WorkspaceResourcePolicy,
    now: number,
  ): { outcome: "limit"; reason: string } | null {
    const activeSql = placeholders(ACTIVE_STATES);
    const userActive = (
      this.sqlite
        .prepare(
          `SELECT COUNT(*) count FROM workspaceResource
        WHERE userId = ? AND provider = ? AND state IN (${activeSql})`,
        )
        .get(userId, provider, ...ACTIVE_STATES) as { count: number }
    ).count;
    const globalActive = (
      this.sqlite
        .prepare(
          `SELECT COUNT(*) count FROM workspaceResource
        WHERE provider = ? AND state IN (${activeSql})`,
        )
        .get(provider, ...ACTIVE_STATES) as { count: number }
    ).count;
    if (userActive >= policy.maxActivePerUser || globalActive >= policy.maxActiveGlobal) {
      return { outcome: "limit", reason: "Workspace concurrency limit reached" };
    }
    const last = this.sqlite
      .prepare(
        `SELECT createdAt FROM workspaceResource
      WHERE userId = ? AND provider = ? ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(userId, provider) as { createdAt: number } | undefined;
    if (last && last.createdAt > now - policy.createThrottleMs) {
      return { outcome: "limit", reason: "Workspace create throttle reached" };
    }
    const usage = this.sqlite
      .prepare(
        `SELECT submittedOperations FROM workspacePolicyUsage
      WHERE userId = ? AND provider = ? AND utcDay = ?`,
      )
      .get(userId, provider, utcDay(now)) as { submittedOperations: number } | undefined;
    return (usage?.submittedOperations ?? 0) >= policy.maxOperationsPerDay
      ? { outcome: "limit", reason: "Daily workspace operation budget reached" }
      : null;
  }

  private requireById(id: string): WorkspaceResourceRecord {
    const row = this.sqlite.prepare("SELECT * FROM workspaceResource WHERE id = ?").get(id) as
      ResourceRow | undefined;
    if (!row) throw new Error("Workspace resource disappeared");
    return mapRow(row);
  }

  getOwned(userId: string, resourceId: string): WorkspaceResourceRecord | null {
    const row = this.sqlite
      .prepare("SELECT * FROM workspaceResource WHERE id = ? AND userId = ?")
      .get(resourceId, userId) as ResourceRow | undefined;
    return row ? mapRow(row) : null;
  }

  hasCurrentAuthorization(userId: string, resourceId: string): boolean {
    return Boolean(
      this.sqlite
        .prepare(
          `SELECT 1 FROM workspaceResource r
           JOIN workspaceConnection c ON c.id = r.connectionId
           JOIN workspaceConnectionRepository grantRow
             ON grantRow.connectionId = c.id AND grantRow.externalRepositoryId = r.repositoryId
           WHERE r.id = ? AND r.userId = ? AND c.userId = r.userId
             AND c.provider = r.provider AND c.status = 'connected'
             AND (r.externalOwnerId IS NULL OR c.externalAccountId = r.externalOwnerId)
             AND c.credentialGeneration = r.authorizationGeneration`,
        )
        .get(resourceId, userId),
    );
  }

  getByCapability(userId: string, capability: string): WorkspaceResourceRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT r.* FROM workspaceResource r JOIN workspaceLifecycleCapability c ON c.resourceId = r.id
         WHERE r.userId = ? AND c.userId = ? AND c.capabilityHash = ?`,
      )
      .get(userId, userId, digestWorkspaceCapability(capability)) as ResourceRow | undefined;
    return row ? mapRow(row) : null;
  }

  listOwned(userId: string, provider: string): WorkspaceResourceRecord[] {
    return (
      this.sqlite
        .prepare(
          "SELECT * FROM workspaceResource WHERE userId = ? AND provider = ? ORDER BY createdAt",
        )
        .all(userId, provider) as ResourceRow[]
    ).map(mapRow);
  }

  listAuthorizationRebindCandidates(
    userId: string,
    provider: string,
  ): Array<{ resource: WorkspaceResourceRecord; authorizationGeneration: number }> {
    const rows = this.sqlite
      .prepare(
        `SELECT r.*, c.credentialGeneration currentAuthorizationGeneration
         FROM workspaceResource r
         JOIN workspaceConnection c ON c.id = r.connectionId
         JOIN workspaceConnectionRepository grantRow
           ON grantRow.connectionId = c.id AND grantRow.externalRepositoryId = r.repositoryId
         WHERE r.userId = ? AND r.provider = ? AND c.userId = r.userId
           AND c.provider = r.provider AND c.status = 'connected'
           AND c.externalAccountId = r.externalOwnerId
           AND c.credentialGeneration != r.authorizationGeneration
           AND r.state NOT IN ('deleted', 'rejected')`,
      )
      .all(userId, provider) as Array<ResourceRow & { currentAuthorizationGeneration: number }>;
    return rows.map(({ currentAuthorizationGeneration, ...row }) => ({
      resource: mapRow(row),
      authorizationGeneration: currentAuthorizationGeneration,
    }));
  }

  nextAuthorizationRebindUser(provider: string, userId?: string): string | null {
    const row = this.sqlite
      .prepare(
        `SELECT r.userId FROM workspaceResource r
         JOIN workspaceConnection c ON c.id = r.connectionId
         JOIN workspaceConnectionRepository grantRow
           ON grantRow.connectionId = c.id AND grantRow.externalRepositoryId = r.repositoryId
         WHERE r.provider = ? AND (? IS NULL OR r.userId = ?)
           AND c.userId = r.userId AND c.provider = r.provider AND c.status = 'connected'
           AND c.externalAccountId = r.externalOwnerId
           AND c.credentialGeneration != r.authorizationGeneration
           AND r.state NOT IN ('deleted', 'rejected')
         ORDER BY r.updatedAt, r.id LIMIT 1`,
      )
      .get(provider, userId ?? null, userId ?? null) as { userId: string } | undefined;
    return row?.userId ?? null;
  }

  rebindAuthorization(input: {
    userId: string;
    resourceId: string;
    resourceGeneration: number;
    expectedAuthorizationGeneration: number;
    authorizationGeneration: number;
    now: number;
  }): boolean {
    const transaction = this.sqlite.transaction(() => {
      const changed = this.sqlite
        .prepare(
          `UPDATE workspaceResource SET authorizationGeneration = ?,
           lastOutcome = 'authorization_reverified', updatedAt = ?
           WHERE id = ? AND userId = ? AND generation = ? AND authorizationGeneration = ?
             AND EXISTS (SELECT 1 FROM workspaceConnection c
               JOIN workspaceConnectionRepository grantRow ON grantRow.connectionId = c.id
               WHERE c.id = workspaceResource.connectionId AND c.userId = workspaceResource.userId
                 AND c.provider = workspaceResource.provider AND c.status = 'connected'
                 AND c.externalAccountId = workspaceResource.externalOwnerId
                 AND c.credentialGeneration = ?
                 AND grantRow.externalRepositoryId = workspaceResource.repositoryId)`,
        )
        .run(
          input.authorizationGeneration,
          input.now,
          input.resourceId,
          input.userId,
          input.resourceGeneration,
          input.expectedAuthorizationGeneration,
          input.authorizationGeneration,
        ).changes;
      if (changed !== 1) return false;
      this.sqlite
        .prepare(
          `UPDATE workspaceOperation SET authorizationGeneration = ?, updatedAt = ?
           WHERE resourceId = ? AND userId = ? AND authorizationGeneration = ?
             AND (state IN ('reserved', 'running', 'cancel_pending', 'reconcile_pending')
               OR (remoteCleanupPending = 1
                 AND state IN ('succeeded', 'failed', 'cancelled', 'timed_out')))`,
        )
        .run(
          input.authorizationGeneration,
          input.now,
          input.resourceId,
          input.userId,
          input.expectedAuthorizationGeneration,
        );
      return true;
    });
    return transaction.immediate();
  }

  markSubmitted(input: {
    resourceId: string;
    expectedGeneration: number;
    claimId: string;
    claimExpiresAt: number;
    now: number;
  }): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = 'create_submitted', generation = generation + 1,
           lastOutcome = NULL, claimId = ?, claimExpiresAt = ?, updatedAt = ?
           WHERE id = ? AND generation = ? AND state = 'create_pending'
             AND NOT EXISTS (
               SELECT 1 FROM workspaceProviderControl c
               WHERE c.disabled = 1
                 AND c.scope IN ('global', 'provider:' || workspaceResource.provider)
             )`,
        )
        .run(
          input.claimId,
          input.claimExpiresAt,
          input.now,
          input.resourceId,
          input.expectedGeneration,
        ).changes === 1
    );
  }

  markRejected(
    resourceId: string,
    expectedGeneration: number,
    reason: string,
    now: number,
  ): boolean {
    return (
      this.transition(resourceId, expectedGeneration, "create_pending", "rejected", now, reason) ||
      this.transition(resourceId, expectedGeneration, "create_submitted", "rejected", now, reason)
    );
  }

  markClaimedCreateRejected(
    resourceId: string,
    generation: number,
    claimId: string,
    reason: string,
    now: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = 'rejected', desiredState = 'deleted',
           observedState = 'absent', generation = generation + 1,
           lastOutcome = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
           WHERE id = ? AND generation = ? AND claimId = ? AND state = 'create_submitted'`,
        )
        .run(reason, now, resourceId, generation, claimId).changes === 1
    );
  }

  private transition(
    id: string,
    generation: number,
    from: WorkspaceResourceState,
    to: WorkspaceResourceState,
    now: number,
    outcome: string | null,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = ?, desiredState = 'deleted',
         observedState = 'absent', generation = generation + 1,
         lastOutcome = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND generation = ? AND state = ?`,
        )
        .run(to, outcome, now, id, generation, from).changes === 1
    );
  }

  adopt(input: {
    resourceId: string;
    expectedGeneration: number;
    resourceName: string;
    ownerId: string;
    billableOwnerId: string;
    state: "usable" | "cleanup_pending";
    outcome: string;
    cleanupDeadlineAt?: number;
    claimId: string;
    now: number;
  }): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET providerResourceName = ?, externalOwnerId = ?,
         billableOwnerId = ?, state = ?, desiredState = ?, observedState = ?,
         generation = generation + 1, lastOutcome = ?,
         cleanupDeadlineAt = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND generation = ? AND claimId = ? AND state = 'create_submitted'`,
        )
        .run(
          input.resourceName,
          input.ownerId,
          input.billableOwnerId,
          input.state,
          input.state === "usable" ? "running" : "deleted",
          input.state === "usable" ? "running" : "failed",
          input.outcome,
          input.cleanupDeadlineAt ?? null,
          input.now,
          input.resourceId,
          input.expectedGeneration,
          input.claimId,
        ).changes === 1
    );
  }

  bindSubmittedResource(input: {
    resourceId: string;
    expectedGeneration: number;
    resourceName: string;
    ownerId: string;
    billableOwnerId: string;
    outcome: string;
    claimId: string;
    now: number;
  }): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET providerResourceName = ?, externalOwnerId = ?,
         billableOwnerId = ?, lastOutcome = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND generation = ? AND claimId = ? AND state = 'create_submitted'`,
        )
        .run(
          input.resourceName,
          input.ownerId,
          input.billableOwnerId,
          input.outcome,
          input.now,
          input.resourceId,
          input.expectedGeneration,
          input.claimId,
        ).changes === 1
    );
  }

  bindCleanupResource(input: {
    resourceId: string;
    generation: number;
    claimId: string;
    resourceName: string;
    ownerId: string;
    billableOwnerId: string;
    now: number;
  }): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET providerResourceName = ?, externalOwnerId = ?,
           billableOwnerId = ?, lastOutcome = 'cleanup_resource_discovered', updatedAt = ?
           WHERE id = ? AND generation = ? AND claimId = ? AND state = 'cleanup_pending'
             AND providerResourceName IS NULL`,
        )
        .run(
          input.resourceName,
          input.ownerId,
          input.billableOwnerId,
          input.now,
          input.resourceId,
          input.generation,
          input.claimId,
        ).changes === 1
    );
  }

  bindReturnedCleanupResource(input: {
    resourceId: string;
    resourceName: string;
    ownerId: string;
    billableOwnerId: string;
    now: number;
  }): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET providerResourceName = ?, externalOwnerId = ?,
           billableOwnerId = ?, lastOutcome = 'create_returned_during_cleanup', updatedAt = ?
           WHERE id = ? AND state IN ('cleanup_pending', 'stop_pending', 'delete_pending')
             AND providerResourceName IS NULL`,
        )
        .run(input.resourceName, input.ownerId, input.billableOwnerId, input.now, input.resourceId)
        .changes === 1
    );
  }

  markAmbiguous(resourceId: string, generation: number, claimId: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = 'ambiguous', generation = generation + 1,
         lastOutcome = 'multiple_exact_matches', claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND generation = ? AND claimId = ? AND state = 'create_submitted'`,
        )
        .run(now, resourceId, generation, claimId).changes === 1
    );
  }

  requestCleanup(
    userId: string,
    resourceId: string,
    capability: string,
    deadlineAt: number,
    now: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = 'cleanup_pending', desiredState = 'deleted',
         generation = generation + 1,
         cleanupDeadlineAt = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND userId = ? AND state NOT IN ('deleted', 'rejected')
           AND EXISTS (SELECT 1 FROM workspaceLifecycleCapability c
             WHERE c.resourceId = workspaceResource.id AND c.userId = ? AND c.capabilityHash = ?)`,
        )
        .run(deadlineAt, now, resourceId, userId, userId, digestWorkspaceCapability(capability))
        .changes === 1
    );
  }

  requestCleanupSystem(
    resourceId: string,
    generation: number,
    deadlineAt: number,
    now: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = 'cleanup_pending', desiredState = 'deleted',
         generation = generation + 1,
         cleanupDeadlineAt = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND generation = ? AND state = 'usable'`,
        )
        .run(deadlineAt, now, resourceId, generation).changes === 1
    );
  }

  requestStart(
    userId: string,
    resourceId: string,
    policy: WorkspaceResourcePolicy,
    now: number,
  ): WorkspaceResourceRecord | "disabled" | "limit" | null {
    const transaction = this.sqlite.transaction(() => {
      const current = this.getOwned(userId, resourceId);
      if (
        !current ||
        current.retentionPolicy !== "persistent" ||
        ["deleted", "rejected", "delete_pending"].includes(current.state)
      ) {
        return null;
      }
      if (
        current.desiredState === "running" &&
        ["create_pending", "create_submitted", "usable", "start_pending"].includes(current.state)
      ) {
        return current;
      }
      if (!current.providerResourceName) return null;
      if (this.isDisabled(current.provider)) return "disabled";
      const usage = this.sqlite
        .prepare(
          `SELECT submittedOperations FROM workspacePolicyUsage
           WHERE userId = ? AND provider = ? AND utcDay = ?`,
        )
        .get(userId, current.provider, utcDay(now)) as { submittedOperations: number } | undefined;
      if ((usage?.submittedOperations ?? 0) >= policy.maxOperationsPerDay) return "limit";
      const changed = this.sqlite
        .prepare(
          `UPDATE workspaceResource SET desiredState = 'running', state = 'start_pending',
           generation = generation + 1, lastOutcome = 'start_requested', claimId = NULL,
           claimExpiresAt = NULL, updatedAt = ? WHERE id = ? AND userId = ? AND generation = ?`,
        )
        .run(now, resourceId, userId, current.generation).changes;
      if (changed !== 1) return null;
      this.recordLifecycleMutation(
        resourceId,
        userId,
        current.provider,
        current.generation + 1,
        "start",
        now,
      );
      return this.requireById(resourceId);
    });
    return transaction.immediate();
  }

  requestStop(userId: string, resourceId: string, now: number): WorkspaceResourceRecord | null {
    const transaction = this.sqlite.transaction(() => {
      const current = this.getOwned(userId, resourceId);
      if (
        !current ||
        current.retentionPolicy !== "persistent" ||
        ["deleted", "rejected", "delete_pending"].includes(current.state)
      ) {
        return null;
      }
      if (
        current.desiredState === "stopped" &&
        ["stop_pending", "stopped"].includes(current.state)
      ) {
        return current;
      }
      if (current.state === "create_pending") {
        const cancelled = this.sqlite
          .prepare(
            `UPDATE workspaceResource SET desiredState = 'deleted', observedState = 'absent',
             state = 'deleted', generation = generation + 1,
             lastOutcome = 'stop_before_submission', updatedAt = ?
             WHERE id = ? AND userId = ? AND generation = ? AND state = 'create_pending'`,
          )
          .run(now, resourceId, userId, current.generation).changes;
        if (cancelled !== 1) return null;
        this.recordLifecycleMutation(
          resourceId,
          userId,
          current.provider,
          current.generation + 1,
          "stop",
          now,
        );
        return this.requireById(resourceId);
      }
      const changed = this.sqlite
        .prepare(
          `UPDATE workspaceResource SET desiredState = 'stopped', state = 'stop_pending',
           generation = generation + 1, lastOutcome = 'stop_requested', claimId = NULL,
           claimExpiresAt = NULL, updatedAt = ? WHERE id = ? AND userId = ? AND generation = ?`,
        )
        .run(now, resourceId, userId, current.generation).changes;
      if (changed !== 1) return null;
      this.cancelOperationsForGeneration(
        resourceId,
        current.generation + 1,
        now,
        "workspace_stop_requested",
      );
      this.recordLifecycleMutation(
        resourceId,
        userId,
        current.provider,
        current.generation + 1,
        "stop",
        now,
      );
      return this.requireById(resourceId);
    });
    return transaction.immediate();
  }

  requestDelete(
    userId: string,
    resourceId: string,
    expectedGeneration: number,
    now: number,
  ): WorkspaceResourceRecord | "conflict" | null {
    const transaction = this.sqlite.transaction(() => {
      const current = this.getOwned(userId, resourceId);
      if (!current || ["deleted", "rejected"].includes(current.state)) return null;
      if (current.generation !== expectedGeneration) return "conflict";
      if (current.desiredState === "deleted" && current.state === "delete_pending") return current;
      const changed = this.sqlite
        .prepare(
          `UPDATE workspaceResource SET desiredState = 'deleted', state = 'delete_pending',
           generation = generation + 1, lastOutcome = 'delete_requested', claimId = NULL,
           claimExpiresAt = NULL, updatedAt = ? WHERE id = ? AND userId = ? AND generation = ?`,
        )
        .run(now, resourceId, userId, current.generation).changes;
      if (changed !== 1) return null;
      this.cancelOperationsForGeneration(
        resourceId,
        current.generation + 1,
        now,
        "workspace_delete_requested",
      );
      this.recordLifecycleMutation(
        resourceId,
        userId,
        current.provider,
        current.generation + 1,
        "delete",
        now,
      );
      return this.requireById(resourceId);
    });
    return transaction.immediate();
  }

  completeLifecycle(input: {
    resourceId: string;
    generation: number;
    desiredState: "running" | "stopped" | "deleted";
    observedState: "running" | "stopped" | "absent";
    state: "usable" | "stopped" | "deleted";
    outcome: string;
    now: number;
  }): boolean {
    const transaction = this.sqlite.transaction(() => {
      const changed = this.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = ?, observedState = ?, lastOutcome = ?,
           claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
           WHERE id = ? AND generation = ? AND desiredState = ?`,
        )
        .run(
          input.state,
          input.observedState,
          input.outcome,
          input.now,
          input.resourceId,
          input.generation,
          input.desiredState,
        ).changes;
      if (changed !== 1) return false;
      if (input.desiredState !== "running") {
        this.sqlite
          .prepare(
            `UPDATE workspaceOperation SET state = 'cancelled',
             lastOutcome = 'exact_workspace_stopped', claimId = NULL,
             claimExpiresAt = NULL, updatedAt = ? WHERE resourceId = ?
             AND state IN ('reserved', 'running', 'cancel_pending', 'reconcile_pending')`,
          )
          .run(input.now, input.resourceId);
        if (input.desiredState === "deleted") {
          this.sqlite
            .prepare(
              `UPDATE workspaceOperation SET remoteCleanupPending = 0, updatedAt = ?
               WHERE resourceId = ? AND remoteCleanupPending = 1`,
            )
            .run(input.now, input.resourceId);
        }
      }
      return true;
    });
    return transaction.immediate();
  }

  completeAbsentPersistentLifecycle(
    resourceId: string,
    generation: number,
    desiredState: "running" | "stopped",
    outcome: string,
    now: number,
  ): boolean {
    const transaction = this.sqlite.transaction(() => {
      const changed = this.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = 'deleted', desiredState = 'deleted',
           observedState = 'absent', lastOutcome = ?, claimId = NULL,
           claimExpiresAt = NULL, updatedAt = ?
           WHERE id = ? AND generation = ? AND desiredState = ?
             AND retentionPolicy = 'persistent'`,
        )
        .run(outcome, now, resourceId, generation, desiredState).changes;
      if (changed !== 1) return false;
      this.sqlite
        .prepare(
          `UPDATE workspaceOperation SET state = 'cancelled', remoteCleanupPending = 0,
           lastOutcome = 'exact_workspace_absent', claimId = NULL,
           claimExpiresAt = NULL, updatedAt = ? WHERE resourceId = ?
             AND state IN ('reserved', 'running', 'cancel_pending', 'reconcile_pending')`,
        )
        .run(now, resourceId);
      this.sqlite
        .prepare(
          `UPDATE workspaceOperation SET remoteCleanupPending = 0, updatedAt = ?
           WHERE resourceId = ? AND remoteCleanupPending = 1`,
        )
        .run(now, resourceId);
      return true;
    });
    return transaction.immediate();
  }

  markLifecyclePending(
    resourceId: string,
    generation: number,
    outcome: string,
    observedState: WorkspaceResourceRecord["observedState"],
    now: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET observedState = ?, lastOutcome = ?, claimId = NULL,
           claimExpiresAt = NULL, updatedAt = ?
           WHERE id = ? AND generation = ?`,
        )
        .run(observedState, outcome, now, resourceId, generation).changes === 1
    );
  }

  bindLifecycleIdentity(input: {
    resourceId: string;
    generation: number;
    resourceName: string;
    ownerId: string;
    billableOwnerId: string;
    now: number;
  }): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET providerResourceName = ?, externalOwnerId = ?,
           billableOwnerId = ?, lastOutcome = 'lifecycle_resource_discovered', updatedAt = ?
           WHERE id = ? AND generation = ? AND providerResourceName IS NULL`,
        )
        .run(
          input.resourceName,
          input.ownerId,
          input.billableOwnerId,
          input.now,
          input.resourceId,
          input.generation,
        ).changes === 1
    );
  }

  requestPersistentStopsForUser(userId: string, provider: string, now: number): number {
    const transaction = this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare(
          `SELECT id, generation, provider FROM workspaceResource WHERE userId = ? AND provider = ?
           AND retentionPolicy = 'persistent'
           AND state IN ('create_submitted', 'usable', 'ambiguous', 'start_pending')`,
        )
        .all(userId, provider) as Array<{ id: string; generation: number; provider: string }>;
      let changed = 0;
      for (const row of rows) {
        const result = this.sqlite
          .prepare(
            `UPDATE workspaceResource SET desiredState = 'stopped', state = 'stop_pending',
             generation = generation + 1, lastOutcome = 'disconnect_stop_requested',
             claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
             WHERE id = ? AND generation = ?`,
          )
          .run(now, row.id, row.generation);
        if (result.changes === 1) {
          changed++;
          this.cancelOperationsForGeneration(
            row.id,
            row.generation + 1,
            now,
            "disconnect_stop_requested",
          );
          this.recordLifecycleMutation(
            row.id,
            userId,
            row.provider,
            row.generation + 1,
            "stop",
            now,
            true,
          );
        }
      }
      return changed;
    });
    return transaction.immediate();
  }

  private recordLifecycleMutation(
    resourceId: string,
    userId: string,
    provider: string,
    generation: number,
    kind: "start" | "stop" | "delete",
    now: number,
    required = false,
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO workspaceProviderMutation
         (id, resourceId, userId, provider, generation, kind, attempt, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(randomUUID(), resourceId, userId, provider, generation, kind, now);
    this.sqlite
      .prepare(
        `INSERT INTO workspacePolicyUsage
         (userId, provider, utcDay, submittedOperations, requiredCleanupOperations, updatedAt)
         VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(userId, provider, utcDay) DO UPDATE SET
         submittedOperations = submittedOperations + 1,
         requiredCleanupOperations = requiredCleanupOperations + excluded.requiredCleanupOperations,
         updatedAt = excluded.updatedAt`,
      )
      .run(userId, provider, utcDay(now), required ? 1 : 0, now);
  }

  private cancelOperationsForGeneration(
    resourceId: string,
    newGeneration: number,
    now: number,
    outcome: string,
  ): void {
    this.sqlite
      .prepare(
        `UPDATE workspaceOperation SET state = 'cancel_pending', lastOutcome = ?, updatedAt = ?
         WHERE resourceId = ? AND resourceGeneration < ?
           AND state IN ('reserved', 'running', 'reconcile_pending')`,
      )
      .run(outcome, now, resourceId, newGeneration);
  }

  requestAllCleanupForUser(
    userId: string,
    provider: string,
    deadlineAt: number,
    now: number,
  ): number {
    return this.sqlite
      .transaction(() => {
        this.sqlite
          .prepare(
            `UPDATE workspaceResource SET state = 'rejected', desiredState = 'deleted',
           observedState = 'absent', generation = generation + 1,
           lastOutcome = 'disconnect_before_submission', claimId = NULL,
           claimExpiresAt = NULL, updatedAt = ?
           WHERE userId = ? AND provider = ? AND state = 'create_pending'`,
          )
          .run(now, userId, provider);
        return this.sqlite
          .prepare(
            `UPDATE workspaceResource SET state = 'cleanup_pending', desiredState = 'deleted',
           generation = generation + 1,
           cleanupDeadlineAt = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
           WHERE userId = ? AND provider = ?
             AND retentionPolicy = 'legacy_disposable'
             AND state IN ('create_submitted', 'usable', 'ambiguous')`,
          )
          .run(deadlineAt, now, userId, provider).changes;
      })
      .immediate();
  }

  claimDue(
    claimId: string,
    now: number,
    leaseExpiresAt: number,
    userId?: string,
  ): WorkspaceResourceRecord | null {
    const transaction = this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT id, generation FROM workspaceResource
           WHERE state IN ('create_pending', 'create_submitted', 'cleanup_pending', 'ambiguous',
                           'usable', 'start_pending', 'stop_pending', 'delete_pending')
             AND (? IS NULL OR userId = ?)
             AND (claimExpiresAt IS NULL OR claimExpiresAt <= ?)
             AND (state != 'usable' OR retentionPolicy != 'persistent' AND remoteExpiresAt <= ?)
           ORDER BY CASE state
             WHEN 'delete_pending' THEN 0 WHEN 'stop_pending' THEN 1 WHEN 'cleanup_pending' THEN 2
             WHEN 'start_pending' THEN 3 WHEN 'ambiguous' THEN 4 ELSE 5 END,
                    updatedAt LIMIT 1`,
        )
        .get(userId ?? null, userId ?? null, now, now) as
        { id: string; generation: number } | undefined;
      if (!row) return null;
      const changed = this.sqlite
        .prepare(
          `UPDATE workspaceResource SET claimId = ?, claimExpiresAt = ?, updatedAt = ?
           WHERE id = ? AND generation = ? AND (claimExpiresAt IS NULL OR claimExpiresAt <= ?)`,
        )
        .run(claimId, leaseExpiresAt, now, row.id, row.generation, now).changes;
      return changed === 1 ? this.requireById(row.id) : null;
    });
    return transaction.immediate();
  }

  releaseClaim(
    resourceId: string,
    generation: number,
    claimId: string,
    outcome: string,
    now: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET claimId = NULL, claimExpiresAt = NULL,
         lastOutcome = ?, updatedAt = ? WHERE id = ? AND generation = ? AND claimId = ?`,
        )
        .run(outcome, now, resourceId, generation, claimId).changes === 1
    );
  }

  recordRequiredCleanupMutation(input: {
    resourceId: string;
    generation: number;
    claimId: string;
    kind: "stop" | "delete";
    now: number;
  }): boolean {
    const transaction = this.sqlite.transaction(() => {
      const resource = this.sqlite
        .prepare(
          `SELECT userId, provider FROM workspaceResource
           WHERE id = ? AND generation = ? AND claimId = ? AND state = 'cleanup_pending'`,
        )
        .get(input.resourceId, input.generation, input.claimId) as
        { userId: string; provider: string } | undefined;
      if (!resource) return false;
      const attempt = (
        this.sqlite
          .prepare(
            `SELECT COALESCE(MAX(attempt), 0) + 1 attempt FROM workspaceProviderMutation
             WHERE resourceId = ? AND generation = ? AND kind = ?`,
          )
          .get(input.resourceId, input.generation, input.kind) as { attempt: number }
      ).attempt;
      this.sqlite
        .prepare(
          `INSERT INTO workspaceProviderMutation
           (id, resourceId, userId, provider, generation, kind, attempt, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.resourceId,
          resource.userId,
          resource.provider,
          input.generation,
          input.kind,
          attempt,
          input.now,
        );
      this.sqlite
        .prepare(
          `INSERT INTO workspacePolicyUsage
           (userId, provider, utcDay, submittedOperations, requiredCleanupOperations, updatedAt)
           VALUES (?, ?, ?, 1, 1, ?)
           ON CONFLICT(userId, provider, utcDay) DO UPDATE SET
             submittedOperations = submittedOperations + 1,
             requiredCleanupOperations = requiredCleanupOperations + 1,
             updatedAt = excluded.updatedAt`,
        )
        .run(resource.userId, resource.provider, utcDay(input.now), input.now);
      return true;
    });
    return transaction.immediate();
  }

  completeDeleted(resourceId: string, generation: number, claimId: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = 'deleted', desiredState = 'deleted',
         observedState = 'absent', generation = generation + 1,
         lastOutcome = 'verified_absent', claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND generation = ? AND claimId = ? AND providerResourceName IS NOT NULL`,
        )
        .run(now, resourceId, generation, claimId).changes === 1
    );
  }

  completeWithoutRemoteResource(
    resourceId: string,
    generation: number,
    claimId: string,
    now: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = 'deleted', desiredState = 'deleted',
           observedState = 'absent', generation = generation + 1,
           lastOutcome = 'verified_never_created', claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
           WHERE id = ? AND generation = ? AND claimId = ? AND state = 'cleanup_pending'
             AND providerResourceName IS NULL`,
        )
        .run(now, resourceId, generation, claimId).changes === 1
    );
  }

  expireUnsubmitted(resourceId: string, generation: number, claimId: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = 'rejected', desiredState = 'deleted',
         observedState = 'absent', generation = generation + 1,
         lastOutcome = 'submission_not_started', claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND generation = ? AND claimId = ? AND state = 'create_pending'`,
        )
        .run(now, resourceId, generation, claimId).changes === 1
    );
  }

  setControl(input: {
    scope: "global" | `provider:${string}`;
    disabled: boolean;
    reason: string | null;
    updatedBy: string | null;
    now: number;
    cleanupDeadlineAt: number;
  }): number {
    const transaction = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO workspaceProviderControl (scope, disabled, reason, updatedAt, updatedBy)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET
           disabled = excluded.disabled, reason = excluded.reason,
           updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`,
        )
        .run(input.scope, input.disabled ? 1 : 0, input.reason, input.now, input.updatedBy);
      if (!input.disabled) return 0;
      const provider = input.scope.startsWith("provider:") ? input.scope.slice(9) : null;
      const pending = provider
        ? this.sqlite
            .prepare(
              `UPDATE workspaceResource SET state = 'rejected', desiredState = 'deleted',
               observedState = 'absent', generation = generation + 1,
               lastOutcome = 'provider_disabled_before_submission', updatedAt = ?
               WHERE provider = ? AND state = 'create_pending'`,
            )
            .run(input.now, provider)
        : this.sqlite
            .prepare(
              `UPDATE workspaceResource SET state = 'rejected', desiredState = 'deleted',
               observedState = 'absent', generation = generation + 1,
               lastOutcome = 'provider_disabled_before_submission', updatedAt = ?
               WHERE state = 'create_pending'`,
            )
            .run(input.now);
      const persistentRows = (
        provider
          ? this.sqlite
              .prepare(
                `SELECT id, generation, userId, provider FROM workspaceResource WHERE provider = ?
               AND retentionPolicy = 'persistent'
               AND state IN ('create_submitted', 'usable', 'ambiguous', 'start_pending')`,
              )
              .all(provider)
          : this.sqlite
              .prepare(
                `SELECT id, generation, userId, provider FROM workspaceResource
               WHERE retentionPolicy = 'persistent'
               AND state IN ('create_submitted', 'usable', 'ambiguous', 'start_pending')`,
              )
              .all()
      ) as Array<{ id: string; generation: number; userId: string; provider: string }>;
      let persistentChanged = 0;
      for (const row of persistentRows) {
        const stopped = this.sqlite
          .prepare(
            `UPDATE workspaceResource SET desiredState = 'stopped', state = 'stop_pending',
             generation = generation + 1, lastOutcome = 'provider_disabled_stop_requested',
             claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
             WHERE id = ? AND generation = ?`,
          )
          .run(input.now, row.id, row.generation);
        if (stopped.changes === 1) {
          persistentChanged++;
          this.cancelOperationsForGeneration(
            row.id,
            row.generation + 1,
            input.now,
            "provider_disabled_stop_requested",
          );
          this.recordLifecycleMutation(
            row.id,
            row.userId,
            row.provider,
            row.generation + 1,
            "stop",
            input.now,
            true,
          );
        }
      }
      const result = provider
        ? this.sqlite
            .prepare(
              `UPDATE workspaceResource SET state = 'cleanup_pending', desiredState = 'deleted',
             generation = generation + 1,
             cleanupDeadlineAt = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
             WHERE provider = ? AND retentionPolicy = 'legacy_disposable'
               AND state IN ('create_submitted', 'usable', 'ambiguous')`,
            )
            .run(input.cleanupDeadlineAt, input.now, provider)
        : this.sqlite
            .prepare(
              `UPDATE workspaceResource SET state = 'cleanup_pending', desiredState = 'deleted',
             generation = generation + 1,
             cleanupDeadlineAt = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
             WHERE retentionPolicy = 'legacy_disposable'
               AND state IN ('create_submitted', 'usable', 'ambiguous')`,
            )
            .run(input.cleanupDeadlineAt, input.now);
      return pending.changes + persistentChanged + result.changes;
    });
    return transaction.immediate();
  }
}
