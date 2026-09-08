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
             AND c.externalAccountId = ? AND c.id = ? AND c.credentialGeneration = ?`,
        )
        .get(
          input.userId,
          input.provider,
          input.externalAccountId,
          input.connectionId,
          input.authorizationGeneration,
        ) as
        { id: string } | undefined;
      if (!connection) {
        return { outcome: "not_approved", reason: "Repository is not approved" } as const;
      }

      const activeSql = placeholders(ACTIVE_STATES);
      const userActive = (
        this.sqlite
          .prepare(
            `SELECT COUNT(*) count FROM workspaceResource
             WHERE userId = ? AND provider = ? AND state IN (${activeSql})`,
          )
          .get(input.userId, input.provider, ...ACTIVE_STATES) as { count: number }
      ).count;
      const globalActive = (
        this.sqlite
          .prepare(
            `SELECT COUNT(*) count FROM workspaceResource
             WHERE provider = ? AND state IN (${activeSql})`,
          )
          .get(input.provider, ...ACTIVE_STATES) as { count: number }
      ).count;
      if (
        userActive >= input.policy.maxActivePerUser ||
        globalActive >= input.policy.maxActiveGlobal
      ) {
        return { outcome: "limit", reason: "Workspace concurrency limit reached" } as const;
      }
      const last = this.sqlite
        .prepare(
          `SELECT createdAt FROM workspaceResource
           WHERE userId = ? AND provider = ? ORDER BY createdAt DESC LIMIT 1`,
        )
        .get(input.userId, input.provider) as { createdAt: number } | undefined;
      if (last && last.createdAt > input.now - input.policy.createThrottleMs) {
        return { outcome: "limit", reason: "Workspace create throttle reached" } as const;
      }
      const day = utcDay(input.now);
      const usage = this.sqlite
        .prepare(
          `SELECT submittedOperations FROM workspacePolicyUsage
           WHERE userId = ? AND provider = ? AND utcDay = ?`,
        )
        .get(input.userId, input.provider, day) as { submittedOperations: number } | undefined;
      if ((usage?.submittedOperations ?? 0) >= input.policy.maxOperationsPerDay) {
        return { outcome: "limit", reason: "Daily workspace operation budget reached" } as const;
      }

      const id = randomUUID();
      const capability = randomBytes(32).toString("base64url");
      const operationMarker = `moira-${randomBytes(12).toString("hex")}`;
      this.sqlite
        .prepare(
          `INSERT INTO workspaceResource
           (id, userId, connectionId, provider, repositoryId, repositoryFullName,
            requestedRef, operationMarker, machineName, machineDisplayName,
            machineOperatingSystem, machineCpuCores, machineMemoryBytes, machineStorageBytes,
            state, generation, createDeadlineAt, remoteExpiresAt, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create_pending', 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.userId,
          connection.id,
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
          `UPDATE workspaceResource SET state = 'rejected', generation = generation + 1,
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
          `UPDATE workspaceResource SET state = ?, generation = generation + 1,
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
         billableOwnerId = ?, state = ?, generation = generation + 1, lastOutcome = ?,
         cleanupDeadlineAt = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND generation = ? AND claimId = ? AND state = 'create_submitted'`,
        )
        .run(
          input.resourceName,
          input.ownerId,
          input.billableOwnerId,
          input.state,
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
           WHERE id = ? AND state = 'cleanup_pending' AND providerResourceName IS NULL`,
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
          `UPDATE workspaceResource SET state = 'cleanup_pending', generation = generation + 1,
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
          `UPDATE workspaceResource SET state = 'cleanup_pending', generation = generation + 1,
         cleanupDeadlineAt = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND generation = ? AND state = 'usable'`,
        )
        .run(deadlineAt, now, resourceId, generation).changes === 1
    );
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
            `UPDATE workspaceResource SET state = 'rejected', generation = generation + 1,
           lastOutcome = 'disconnect_before_submission', claimId = NULL,
           claimExpiresAt = NULL, updatedAt = ?
           WHERE userId = ? AND provider = ? AND state = 'create_pending'`,
          )
          .run(now, userId, provider);
        return this.sqlite
          .prepare(
            `UPDATE workspaceResource SET state = 'cleanup_pending', generation = generation + 1,
           cleanupDeadlineAt = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
           WHERE userId = ? AND provider = ?
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
           WHERE state IN ('create_pending', 'create_submitted', 'cleanup_pending', 'ambiguous', 'usable')
             AND (? IS NULL OR userId = ?)
             AND (claimExpiresAt IS NULL OR claimExpiresAt <= ?)
             AND (state != 'usable' OR remoteExpiresAt <= ?)
           ORDER BY CASE state WHEN 'cleanup_pending' THEN 0 WHEN 'ambiguous' THEN 1 ELSE 2 END,
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
          `UPDATE workspaceResource SET state = 'deleted', generation = generation + 1,
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
          `UPDATE workspaceResource SET state = 'deleted', generation = generation + 1,
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
          `UPDATE workspaceResource SET state = 'rejected', generation = generation + 1,
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
              `UPDATE workspaceResource SET state = 'rejected', generation = generation + 1,
               lastOutcome = 'provider_disabled_before_submission', updatedAt = ?
               WHERE provider = ? AND state = 'create_pending'`,
            )
            .run(input.now, provider)
        : this.sqlite
            .prepare(
              `UPDATE workspaceResource SET state = 'rejected', generation = generation + 1,
               lastOutcome = 'provider_disabled_before_submission', updatedAt = ?
               WHERE state = 'create_pending'`,
            )
            .run(input.now);
      const result = provider
        ? this.sqlite
            .prepare(
              `UPDATE workspaceResource SET state = 'cleanup_pending', generation = generation + 1,
             cleanupDeadlineAt = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
             WHERE provider = ? AND state IN ('create_submitted', 'usable', 'ambiguous')`,
            )
            .run(input.cleanupDeadlineAt, input.now, provider)
        : this.sqlite
            .prepare(
              `UPDATE workspaceResource SET state = 'cleanup_pending', generation = generation + 1,
             cleanupDeadlineAt = ?, claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
             WHERE state IN ('create_submitted', 'usable', 'ambiguous')`,
            )
            .run(input.cleanupDeadlineAt, input.now);
      return pending.changes + result.changes;
    });
    return transaction.immediate();
  }
}
