import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  WorkspaceOperationRecord,
  WorkspaceOperationResult,
  WorkspaceResourcePolicy,
  WorkspaceResourceRecord,
} from "./resource-types.js";
import { WorkspaceResourceRepository } from "./resource-repository.js";

const ACTIVE_OPERATION_STATES = [
  "reserved",
  "running",
  "cancel_pending",
  "reconcile_pending",
] as const;

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  for (let length = maximumBytes; length >= 0; length--) {
    const candidate = bytes.subarray(0, length).toString("utf8");
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) return candidate;
  }
  return "";
}

interface ReserveOperationResult {
  outcome: "reserved" | "not_found" | "not_running" | "disabled" | "limit";
  operation?: WorkspaceOperationRecord;
  workspace?: WorkspaceResourceRecord;
}

export class WorkspaceOperationRepository {
  constructor(private readonly sqlite: Database.Database) {}

  reserve(input: {
    userId: string;
    resourceId: string;
    inputBytes: number;
    stdoutLimitBytes: number;
    stderrLimitBytes: number;
    deadlineAt: number;
    policy: WorkspaceResourcePolicy;
    now: number;
  }): ReserveOperationResult {
    const transaction = this.sqlite.transaction(() => {
      if (!input.policy.enabled) return { outcome: "disabled" } as ReserveOperationResult;
      const authorized = this.sqlite
        .prepare(
          `SELECT r.id FROM workspaceResource r
           JOIN workspaceConnection c ON c.id = r.connectionId
           JOIN workspaceConnectionRepository grantRow
             ON grantRow.connectionId = c.id AND grantRow.externalRepositoryId = r.repositoryId
           WHERE r.id = ? AND r.userId = ? AND r.state = 'usable'
             AND r.desiredState = 'running'
             AND r.providerResourceName IS NOT NULL
             AND c.userId = r.userId AND c.provider = r.provider AND c.status = 'connected'
             AND c.externalAccountId = r.externalOwnerId
             AND c.credentialGeneration = r.authorizationGeneration`,
        )
        .get(input.resourceId, input.userId) as { id: string } | undefined;
      if (!authorized) {
        const owned = this.sqlite
          .prepare("SELECT 1 FROM workspaceResource WHERE id = ? AND userId = ?")
          .get(input.resourceId, input.userId);
        return { outcome: owned ? "not_running" : "not_found" } as ReserveOperationResult;
      }
      const workspace = new WorkspaceResourceRepository(this.sqlite).getOwned(
        input.userId,
        authorized.id,
      );
      if (!workspace) throw new Error("Authorized workspace disappeared");
      const disabled = this.sqlite
        .prepare(
          `SELECT 1 FROM workspaceProviderControl
           WHERE disabled = 1 AND scope IN ('global', ?) LIMIT 1`,
        )
        .get(`provider:${workspace.provider}`);
      if (disabled) return { outcome: "disabled" } as ReserveOperationResult;

      const activeSql = ACTIVE_OPERATION_STATES.map(() => "?").join(", ");
      const userCount = (
        this.sqlite
          .prepare(
            `SELECT COUNT(*) count FROM workspaceOperation
             WHERE userId = ? AND state IN (${activeSql})`,
          )
          .get(input.userId, ...ACTIVE_OPERATION_STATES) as { count: number }
      ).count;
      const globalCount = (
        this.sqlite
          .prepare(`SELECT COUNT(*) count FROM workspaceOperation WHERE state IN (${activeSql})`)
          .get(...ACTIVE_OPERATION_STATES) as { count: number }
      ).count;
      if (
        userCount >= (input.policy.maxConcurrentOperationsPerUser ?? 2) ||
        globalCount >= (input.policy.maxConcurrentOperationsGlobal ?? 20)
      ) {
        return { outcome: "limit" } as ReserveOperationResult;
      }
      const utcDay = new Date(input.now).toISOString().slice(0, 10);
      const usage = this.sqlite
        .prepare(
          `SELECT submittedOperations FROM workspacePolicyUsage
           WHERE userId = ? AND provider = ? AND utcDay = ?`,
        )
        .get(input.userId, workspace.provider, utcDay) as
        { submittedOperations: number } | undefined;
      if ((usage?.submittedOperations ?? 0) >= input.policy.maxOperationsPerDay) {
        return { outcome: "limit" } as ReserveOperationResult;
      }
      const id = randomUUID();
      const remoteMarker = `moira-op-${randomBytes(16).toString("hex")}`;
      this.sqlite
        .prepare(
          `INSERT INTO workspaceOperation
           (id, userId, resourceId, resourceGeneration, authorizationGeneration, provider,
            providerResourceName, remoteMarker, kind, state, inputBytes,
            stdoutLimitBytes, stderrLimitBytes, deadlineAt,
            createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exec', 'reserved', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.userId,
          workspace.id,
          workspace.generation,
          workspace.authorizationGeneration,
          workspace.provider,
          workspace.providerResourceName,
          remoteMarker,
          input.inputBytes,
          input.stdoutLimitBytes,
          input.stderrLimitBytes,
          input.deadlineAt,
          input.now,
          input.now,
        );
      this.sqlite
        .prepare(
          `INSERT INTO workspacePolicyUsage
           (userId, provider, utcDay, submittedOperations, requiredCleanupOperations, updatedAt)
           VALUES (?, ?, ?, 1, 0, ?) ON CONFLICT(userId, provider, utcDay) DO UPDATE SET
           submittedOperations = submittedOperations + 1, updatedAt = excluded.updatedAt`,
        )
        .run(input.userId, workspace.provider, utcDay, input.now);
      return {
        outcome: "reserved",
        operation: this.requireOwned(input.userId, id),
        workspace,
      } as ReserveOperationResult;
    });
    return transaction.immediate();
  }

  getOwned(userId: string, operationId: string): WorkspaceOperationRecord | null {
    const row = this.sqlite
      .prepare("SELECT * FROM workspaceOperation WHERE id = ? AND userId = ?")
      .get(operationId, userId) as WorkspaceOperationRecord | undefined;
    return row ?? null;
  }

  listOwned(userId: string, resourceId: string): WorkspaceOperationRecord[] {
    return this.sqlite
      .prepare(
        `SELECT * FROM workspaceOperation WHERE userId = ? AND resourceId = ?
         ORDER BY createdAt, id`,
      )
      .all(userId, resourceId) as WorkspaceOperationRecord[];
  }

  getContext(
    userId: string,
    operationId: string,
  ): { operation: WorkspaceOperationRecord; workspace: WorkspaceResourceRecord } | null {
    const operation = this.getOwned(userId, operationId);
    if (!operation) return null;
    const workspace = new WorkspaceResourceRepository(this.sqlite).getOwned(
      userId,
      operation.resourceId,
    );
    return workspace ? { operation, workspace } : null;
  }

  private requireOwned(userId: string, operationId: string): WorkspaceOperationRecord {
    const record = this.getOwned(userId, operationId);
    if (!record) throw new Error("Workspace operation disappeared");
    return record;
  }

  markRunning(
    userId: string,
    operationId: string,
    expectedGeneration: number,
    now: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceOperation SET state = 'running', lastOutcome = 'remote_started',
           claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
           WHERE id = ? AND userId = ? AND resourceGeneration = ?
             AND state = 'reconcile_pending' AND lastOutcome = 'dispatch_submitted'
             AND EXISTS (SELECT 1 FROM workspaceResource r WHERE r.id = resourceId
               AND r.userId = ? AND r.generation = resourceGeneration
               AND r.desiredState = 'running' AND r.state = 'usable')`,
        )
        .run(now, operationId, userId, expectedGeneration, userId).changes === 1
    );
  }

  recordConnectorRunning(
    userId: string,
    resourceId: string,
    generation: number,
    now: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceResource SET observedState = 'running',
           lastOutcome = 'connector_observed_running', updatedAt = ?
           WHERE id = ? AND userId = ? AND generation = ?
             AND desiredState = 'running' AND state = 'usable'`,
        )
        .run(now, resourceId, userId, generation).changes === 1
    );
  }

  canDispatch(userId: string, operationId: string, now: number): boolean {
    return Boolean(
      this.sqlite
        .prepare(
          `SELECT 1 FROM workspaceOperation operation
           JOIN workspaceResource resource ON resource.id = operation.resourceId
           JOIN workspaceConnection connection ON connection.id = resource.connectionId
           JOIN workspaceConnectionRepository grantRow
             ON grantRow.connectionId = connection.id
             AND grantRow.externalRepositoryId = resource.repositoryId
           WHERE operation.id = ? AND operation.userId = ? AND operation.state = 'reserved'
             AND operation.deadlineAt > ?
             AND resource.userId = operation.userId
             AND resource.generation = operation.resourceGeneration
             AND resource.state = 'usable' AND resource.desiredState = 'running'
             AND connection.status = 'connected'
             AND connection.externalAccountId = resource.externalOwnerId
             AND connection.credentialGeneration = operation.authorizationGeneration
             AND NOT EXISTS (SELECT 1 FROM workspaceProviderControl control
               WHERE control.disabled = 1
                 AND control.scope IN ('global', 'provider:' || operation.provider))`,
        )
        .get(operationId, userId, now),
    );
  }

  beginDispatch(
    userId: string,
    operationId: string,
    expectedGeneration: number,
    claimId: string,
    claimExpiresAt: number,
    now: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceOperation SET state = 'reconcile_pending',
           lastOutcome = 'dispatch_submitted', claimId = ?, claimExpiresAt = ?, updatedAt = ?
           WHERE id = ? AND userId = ? AND resourceGeneration = ? AND state = 'reserved'
             AND deadlineAt > ?
             AND EXISTS (SELECT 1 FROM workspaceResource resource
               JOIN workspaceConnection connection ON connection.id = resource.connectionId
               JOIN workspaceConnectionRepository grantRow
                 ON grantRow.connectionId = connection.id
                 AND grantRow.externalRepositoryId = resource.repositoryId
               WHERE resource.id = workspaceOperation.resourceId
                 AND resource.userId = workspaceOperation.userId
                 AND resource.generation = workspaceOperation.resourceGeneration
                 AND resource.state = 'usable' AND resource.desiredState = 'running'
                 AND connection.status = 'connected'
                 AND connection.externalAccountId = resource.externalOwnerId
                 AND connection.credentialGeneration = workspaceOperation.authorizationGeneration)
             AND NOT EXISTS (SELECT 1 FROM workspaceProviderControl control
               WHERE control.disabled = 1
                 AND control.scope IN ('global', 'provider:' || workspaceOperation.provider))`,
        )
        .run(claimId, claimExpiresAt, now, operationId, userId, expectedGeneration, now).changes ===
      1
    );
  }

  cancelBeforeDispatch(
    userId: string,
    operationId: string,
    now: number,
    outcome = "dispatch_fenced",
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceOperation SET state = 'cancelled', remoteCleanupPending = 0,
           resultExpiresAt = NULL, claimId = NULL, claimExpiresAt = NULL,
           lastOutcome = ?, updatedAt = ?
           WHERE id = ? AND userId = ? AND state = 'reserved'`,
        )
        .run(outcome, now, operationId, userId).changes === 1
    );
  }

  complete(
    userId: string,
    operationId: string,
    expectedGeneration: number,
    result: WorkspaceOperationResult,
    maxStdoutBytes: number,
    maxStderrBytes: number,
    resultExpiresAt: number,
    now: number,
  ): WorkspaceOperationResult | null {
    const stdout = truncateUtf8(result.stdout, maxStdoutBytes);
    const stderr = truncateUtf8(result.stderr, maxStderrBytes);
    const operation = this.getOwned(userId, operationId);
    if (!operation) return null;
    const terminalState =
      result.state === "succeeded" &&
      !this.sqlite
        .prepare(
          `SELECT 1 FROM workspaceResource WHERE id = ? AND userId = ?
           AND generation = ? AND desiredState = 'running'`,
        )
        .get(operation.resourceId, userId, expectedGeneration)
        ? "cancelled"
        : result.state;
    const changed = this.sqlite
      .prepare(
        `UPDATE workspaceOperation SET state = ?, outputBytes = ?, exitCode = ?,
           resultExpiresAt = ?, lastOutcome = 'remote_terminal',
           claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
           WHERE id = ? AND userId = ? AND resourceGeneration = ?
             AND state IN ('reserved', 'running', 'cancel_pending', 'reconcile_pending')`,
      )
      .run(
        terminalState,
        Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
        result.exitCode,
        resultExpiresAt,
        now,
        operationId,
        userId,
        expectedGeneration,
      ).changes;
    return changed === 1 ? { ...result, state: terminalState, stdout, stderr } : null;
  }

  markReconcilePending(userId: string, operationId: string, outcome: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceOperation SET state = 'reconcile_pending', lastOutcome = ?,
           claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
           WHERE id = ? AND userId = ? AND state IN ('reserved', 'running', 'reconcile_pending')`,
        )
        .run(outcome, now, operationId, userId).changes === 1
    );
  }

  requestCancel(userId: string, operationId: string, now: number): WorkspaceOperationRecord | null {
    this.sqlite
      .prepare(
        `UPDATE workspaceOperation SET state = 'cancel_pending', lastOutcome = 'cancel_requested',
         updatedAt = ? WHERE id = ? AND userId = ?
         AND state IN ('reserved', 'running', 'reconcile_pending')`,
      )
      .run(now, operationId, userId);
    return this.getOwned(userId, operationId);
  }

  markRemoteFinalized(userId: string, operationId: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceOperation SET remoteCleanupPending = 0,
           claimId = NULL, claimExpiresAt = NULL, updatedAt = ?
           WHERE id = ? AND userId = ? AND remoteCleanupPending = 1
             AND state IN ('succeeded', 'failed', 'cancelled', 'timed_out')`,
        )
        .run(now, operationId, userId).changes === 1
    );
  }

  claimDue(
    claimId: string,
    now: number,
    leaseExpiresAt: number,
    userId?: string,
  ): WorkspaceOperationRecord | null {
    const transaction = this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT id, userId FROM workspaceOperation operation
           WHERE (
             state IN ('running', 'cancel_pending', 'reconcile_pending')
             OR (state = 'reserved' AND deadlineAt <= ?)
             OR (remoteCleanupPending = 1
               AND state IN ('succeeded', 'failed', 'cancelled', 'timed_out')
               AND resultExpiresAt IS NOT NULL AND resultExpiresAt <= ?
               AND EXISTS (SELECT 1 FROM workspaceResource resource
                 JOIN workspaceConnection connection ON connection.id = resource.connectionId
                 JOIN workspaceConnectionRepository grantRow
                   ON grantRow.connectionId = connection.id
                   AND grantRow.externalRepositoryId = resource.repositoryId
                 WHERE resource.id = operation.resourceId
                   AND resource.userId = operation.userId
                   AND resource.state = 'usable' AND resource.desiredState = 'running'
                   AND connection.status = 'connected'
                   AND connection.externalAccountId = resource.externalOwnerId
                   AND connection.credentialGeneration = operation.authorizationGeneration)))
             AND (? IS NULL OR operation.userId = ?)
             AND (claimExpiresAt IS NULL OR claimExpiresAt <= ?)
           ORDER BY CASE WHEN state = 'reserved' THEN 0
             WHEN remoteCleanupPending = 1
               AND state IN ('succeeded', 'failed', 'cancelled', 'timed_out') THEN 0
             WHEN state = 'cancel_pending' THEN 1 WHEN state = 'reconcile_pending' THEN 2
             ELSE 3 END,
                    updatedAt, id LIMIT 1`,
        )
        .get(now, now, userId ?? null, userId ?? null, now) as
        { id: string; userId: string } | undefined;
      if (!row) return null;
      const changed = this.sqlite
        .prepare(
          `UPDATE workspaceOperation SET claimId = ?, claimExpiresAt = ?, updatedAt = ?
           WHERE id = ? AND (claimExpiresAt IS NULL OR claimExpiresAt <= ?)`,
        )
        .run(claimId, leaseExpiresAt, now, row.id, now).changes;
      return changed === 1 ? this.requireOwned(row.userId, row.id) : null;
    });
    return transaction.immediate();
  }

  releaseClaim(operationId: string, claimId: string, outcome: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceOperation SET claimId = NULL, claimExpiresAt = NULL,
           lastOutcome = ?, updatedAt = ? WHERE id = ? AND claimId = ?`,
        )
        .run(outcome, now, operationId, claimId).changes === 1
    );
  }
}
