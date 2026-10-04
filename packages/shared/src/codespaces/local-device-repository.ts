import { createHash, randomBytes, randomUUID } from "node:crypto";

export const CODESPACE_PROVIDER_LOCAL = "local-sandboxes" as const;
import type Database from "better-sqlite3";
import { getSqliteInstance } from "../database/connection.js";
import type { CodespaceMachine, CodespaceRepositoryTarget } from "./resource-types.js";
import type { CodespaceRepositoryResolver } from "./resource-service.js";

export const LOCAL_DEVICE_PROTOCOL_VERSION = 1 as const;
const PAIRING_TTL_MS = 10 * 60_000;
const DEVICE_OFFLINE_MS = 45_000;
const RELAY_MAX_LIFETIME_MS = 15 * 60_000;
const RELAY_LEASE_MS = 45_000;
const RELAY_MAX_BYTES = 1024 * 1024;

export interface LocalDeviceRepositoryGrant {
  id: string;
  fullName: string;
  private: boolean;
}

export interface LocalDeviceSpaceSnapshot {
  id: string;
  name: string;
  repositoryId: string;
  operationMarker: string;
  ref: string;
  createdAt: number;
  lastStartedAt: number | null;
  generation: number;
  state: string;
  phase: string;
  failure: string | null;
}

export interface LocalDeviceSnapshot {
  version: typeof LOCAL_DEVICE_PROTOCOL_VERSION;
  deviceId: string;
  label: string;
  enabled: boolean;
  leaseUntil: number;
  repositories: LocalDeviceRepositoryGrant[];
  machine: CodespaceMachine;
  maxSandboxes: number;
  spaces: LocalDeviceSpaceSnapshot[];
}

export interface LocalDeviceView {
  id: string;
  label: string;
  state: "online" | "offline" | "revoked";
  enabled: boolean;
  leaseUntil: number;
  generation: number;
  lastSeenAt: number | null;
  repositories: CodespaceRepositoryTarget[];
  machine: CodespaceMachine;
}

export interface LocalDeviceAuthority {
  deviceId: string;
  userId: string;
  generation: number;
}

function localProviderLabel(): string {
  return "Moira Local";
}


export interface LocalRelayClaim {
  id: string;
  leaseId: string;
  expiresAt: number;
  request: unknown;
}

interface DeviceRow {
  id: string;
  userId: string;
  label: string;
  generation: number;
  enabled: number;
  leaseUntil: number;
  machineName: string;
  machineDisplayName: string;
  machineOperatingSystem: string;
  machineCpuCores: number;
  machineMemoryBytes: number;
  machineStorageBytes: number;
  maxSandboxes: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

interface RepositoryRow {
  externalRepositoryId: string;
  publicRepositoryId: string;
  fullName: string;
  private: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSnapshot(snapshot: LocalDeviceSnapshot): void {
  if (
    snapshot.version !== LOCAL_DEVICE_PROTOCOL_VERSION ||
    snapshot.deviceId.length !== 36 ||
    snapshot.label.length < 1 ||
    snapshot.label.length > 80 ||
    !Number.isSafeInteger(snapshot.leaseUntil) ||
    !Number.isSafeInteger(snapshot.maxSandboxes) ||
    snapshot.maxSandboxes < 1 ||
    snapshot.maxSandboxes > 8 ||
    snapshot.repositories.length > 64 ||
    snapshot.spaces.length > 64
  ) {
    throw new Error("Invalid local device snapshot");
  }
}

export class LocalDeviceRepository implements CodespaceRepositoryResolver {
  constructor(private readonly sqlite: Database.Database = getSqliteInstance()) {}

  createPairing(userId: string, now = Date.now()): { code: string; expiresAt: number } {
    const code = randomBytes(24).toString("base64url");
    const expiresAt = now + PAIRING_TTL_MS;
    const tx = this.sqlite.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM codespaceLocalPairing WHERE userId = ? AND consumedAt IS NULL")
        .run(userId);
      this.cleanupExpired(now);
      this.sqlite
        .prepare(
          `INSERT INTO codespaceLocalPairing
           (id, userId, codeDigest, expiresAt, consumedAt, createdAt)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(randomUUID(), userId, digest(code), expiresAt, now);
    });
    tx.immediate();
    return { code, expiresAt };
  }

  enroll(
    code: string,
    snapshot: LocalDeviceSnapshot,
    now = Date.now(),
  ): { deviceId: string; token: string; generation: number; userId: string } {
    assertSnapshot(snapshot);
    const token = randomBytes(32).toString("base64url");
    const tx = this.sqlite.transaction(() => {
      const pairing = this.sqlite
        .prepare(
          `SELECT id, userId FROM codespaceLocalPairing
           WHERE codeDigest = ? AND consumedAt IS NULL AND expiresAt >= ?`,
        )
        .get(digest(code), now) as { id: string; userId: string } | undefined;
      if (!pairing) throw new Error("Local pairing is invalid or expired");
      const existing = this.sqlite
        .prepare("SELECT userId, generation FROM codespaceLocalDevice WHERE id = ?")
        .get(snapshot.deviceId) as { userId: string; generation: number } | undefined;
      if (existing && existing.userId !== pairing.userId) {
        throw new Error("Local device is already owned by another user");
      }

      this.ensureConnection(pairing.userId, now);
      const generation = (existing?.generation ?? 0) + 1;
      if (existing) {
        this.sqlite
          .prepare(
            `UPDATE codespaceLocalDevice
             SET label = ?, tokenDigest = ?, generation = ?, enabled = ?, leaseUntil = ?,
                 snapshotVersion = ?, machineName = ?, machineDisplayName = ?,
                 machineOperatingSystem = ?, machineCpuCores = ?, machineMemoryBytes = ?,
                 machineStorageBytes = ?, maxSandboxes = ?, lastSeenAt = ?, revokedAt = NULL,
                 updatedAt = ?
             WHERE id = ? AND userId = ?`,
          )
          .run(
            snapshot.label,
            digest(token),
            generation,
            snapshot.enabled ? 1 : 0,
            snapshot.leaseUntil,
            snapshot.version,
            snapshot.machine.name,
            snapshot.machine.displayName,
            snapshot.machine.operatingSystem,
            snapshot.machine.cpuCores,
            snapshot.machine.memoryBytes,
            snapshot.machine.storageBytes,
            snapshot.maxSandboxes,
            now,
            now,
            snapshot.deviceId,
            pairing.userId,
          );
      } else {
        this.sqlite
          .prepare(
            `INSERT INTO codespaceLocalDevice
             (id, userId, label, tokenDigest, generation, enabled, leaseUntil, snapshotVersion,
              machineName, machineDisplayName, machineOperatingSystem, machineCpuCores,
              machineMemoryBytes, machineStorageBytes, maxSandboxes, lastSeenAt, revokedAt,
              createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            snapshot.deviceId,
            pairing.userId,
            snapshot.label,
            digest(token),
            generation,
            snapshot.enabled ? 1 : 0,
            snapshot.leaseUntil,
            snapshot.version,
            snapshot.machine.name,
            snapshot.machine.displayName,
            snapshot.machine.operatingSystem,
            snapshot.machine.cpuCores,
            snapshot.machine.memoryBytes,
            snapshot.machine.storageBytes,
            snapshot.maxSandboxes,
            now,
            now,
            now,
          );
      }
      this.syncSnapshot(pairing.userId, snapshot, now);
      const consumed = this.sqlite
        .prepare(
          "UPDATE codespaceLocalPairing SET consumedAt = ? WHERE id = ? AND consumedAt IS NULL",
        )
        .run(now, pairing.id);
      if (consumed.changes !== 1) throw new Error("Local pairing was already consumed");
      return { deviceId: snapshot.deviceId, token, generation, userId: pairing.userId };
    });
    return tx.immediate();
  }

  authenticate(token: string): LocalDeviceAuthority | null {
    const row = this.sqlite
      .prepare(
        `SELECT id deviceId, userId, generation FROM codespaceLocalDevice
         WHERE tokenDigest = ? AND revokedAt IS NULL`,
      )
      .get(digest(token)) as LocalDeviceAuthority | undefined;
    return row ?? null;
  }

  heartbeat(token: string, snapshot: LocalDeviceSnapshot, now = Date.now()): LocalDeviceAuthority {
    assertSnapshot(snapshot);
    const authority = this.authenticate(token);
    if (!authority || authority.deviceId !== snapshot.deviceId) {
      throw new Error("Local device credential is invalid");
    }
    const tx = this.sqlite.transaction(() => {
      const changed = this.sqlite
        .prepare(
          `UPDATE codespaceLocalDevice
           SET label = ?, enabled = ?, leaseUntil = ?, snapshotVersion = ?,
               machineName = ?, machineDisplayName = ?, machineOperatingSystem = ?,
               machineCpuCores = ?, machineMemoryBytes = ?, machineStorageBytes = ?,
               maxSandboxes = ?, lastSeenAt = ?, updatedAt = ?
           WHERE id = ? AND userId = ? AND generation = ? AND revokedAt IS NULL`,
        )
        .run(
          snapshot.label,
          snapshot.enabled ? 1 : 0,
          snapshot.leaseUntil,
          snapshot.version,
          snapshot.machine.name,
          snapshot.machine.displayName,
          snapshot.machine.operatingSystem,
          snapshot.machine.cpuCores,
          snapshot.machine.memoryBytes,
          snapshot.machine.storageBytes,
          snapshot.maxSandboxes,
          now,
          now,
          authority.deviceId,
          authority.userId,
          authority.generation,
        );
      if (changed.changes !== 1) throw new Error("Local device generation changed");
      this.syncSnapshot(authority.userId, snapshot, now);
    });
    tx.immediate();
    return authority;
  }


  revoke(userId: string, deviceId: string, generation: number, now = Date.now()): boolean {
    const tx = this.sqlite.transaction(() => {
      const publicIds = (
        this.sqlite
          .prepare("SELECT publicRepositoryId FROM codespaceLocalRepository WHERE deviceId = ?")
          .all(deviceId) as Array<{ publicRepositoryId: string }>
      ).map((row) => row.publicRepositoryId);
      const changed = this.sqlite
        .prepare(
          `UPDATE codespaceLocalDevice
           SET revokedAt = ?, enabled = 0, leaseUntil = 0, generation = generation + 1, updatedAt = ?
           WHERE id = ? AND userId = ? AND generation = ? AND revokedAt IS NULL`,
        )
        .run(now, now, deviceId, userId, generation);
      if (changed.changes !== 1) return false;
      this.sqlite
        .prepare(
          `UPDATE codespaceLocalRelay
           SET state = 'expired', leaseId = NULL, leaseExpiresAt = NULL, updatedAt = ?
           WHERE deviceId = ? AND userId = ? AND state IN ('queued','leased')`,
        )
        .run(now, deviceId, userId);
      const connection = this.connectionFor(userId);
      if (connection && publicIds.length > 0) {
        const placeholders = publicIds.map(() => "?").join(",");
        this.sqlite
          .prepare(
            `DELETE FROM codespaceConnectionRepository
             WHERE connectionId = ? AND externalRepositoryId IN (${placeholders})`,
          )
          .run(connection.id, ...publicIds);
      }
      if (connection) {
        this.sqlite
          .prepare(
            "DELETE FROM codespaceConnectionInstallation WHERE connectionId = ? AND externalInstallationId = ?",
          )
          .run(connection.id, deviceId);
      }
      this.refreshConnectionStatus(userId, now);
      return true;
    });
    return tx.immediate();
  }

  listDevices(userId: string, now = Date.now()): LocalDeviceView[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, userId, label, generation, enabled, leaseUntil, machineName,
                machineDisplayName, machineOperatingSystem, machineCpuCores,
                machineMemoryBytes, machineStorageBytes, maxSandboxes, lastSeenAt, revokedAt
         FROM codespaceLocalDevice WHERE userId = ? ORDER BY createdAt, id`,
      )
      .all(userId) as DeviceRow[];
    return rows.map((row) => this.projectDevice(row, now));
  }

  getDeviceForRepository(
    userId: string,
    publicRepositoryId: string,
    now = Date.now(),
  ): LocalDeviceView | null {
    const row = this.sqlite
      .prepare(
        `SELECT d.id, d.userId, d.label, d.generation, d.enabled, d.leaseUntil,
                d.machineName, d.machineDisplayName, d.machineOperatingSystem,
                d.machineCpuCores, d.machineMemoryBytes, d.machineStorageBytes,
                d.maxSandboxes, d.lastSeenAt, d.revokedAt
         FROM codespaceLocalDevice d
         JOIN codespaceLocalRepository r ON r.deviceId = d.id
         WHERE d.userId = ? AND r.publicRepositoryId = ?`,
      )
      .get(userId, publicRepositoryId) as DeviceRow | undefined;
    return row ? this.projectDevice(row, now) : null;
  }

  getDeviceById(userId: string, deviceId: string, now = Date.now()): LocalDeviceView | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, userId, label, generation, enabled, leaseUntil, machineName,
                machineDisplayName, machineOperatingSystem, machineCpuCores,
                machineMemoryBytes, machineStorageBytes, maxSandboxes, lastSeenAt, revokedAt
         FROM codespaceLocalDevice WHERE id = ? AND userId = ?`,
      )
      .get(deviceId, userId) as DeviceRow | undefined;
    return row ? this.projectDevice(row, now) : null;
  }

  getApprovedConnection(
    userId: string,
    providerId: string,
    repositoryId: string,
  ): {
    connectionId: string;
    externalAccountId: string;
    authorizationGeneration: number;
    repository: CodespaceRepositoryTarget;
  } | null {
    if (providerId !== CODESPACE_PROVIDER_LOCAL) return null;
    const row = this.sqlite
      .prepare(
        `SELECT c.id connectionId, c.externalAccountId,
                c.credentialGeneration authorizationGeneration,
                r.publicRepositoryId, r.fullName, r.private
         FROM codespaceConnection c
         JOIN codespaceLocalDevice d ON d.userId = c.userId
         JOIN codespaceLocalRepository r ON r.deviceId = d.id
         WHERE c.userId = ? AND c.provider = ? AND c.status = 'connected'
           AND d.revokedAt IS NULL AND r.publicRepositoryId = ?`,
      )
      .get(userId, providerId, repositoryId) as
      | {
          connectionId: string;
          externalAccountId: string;
          authorizationGeneration: number;
          publicRepositoryId: string;
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
            id: row.publicRepositoryId,
            fullName: row.fullName,
            private: row.private === 1,
          },
        }
      : null;
  }

  listApprovedRepositories(userId: string, providerId: string): CodespaceRepositoryTarget[] {
    if (providerId !== CODESPACE_PROVIDER_LOCAL) return [];
    const rows = this.sqlite
      .prepare(
        `SELECT r.publicRepositoryId id, r.fullName, r.private
         FROM codespaceLocalDevice d
         JOIN codespaceLocalRepository r ON r.deviceId = d.id
         WHERE d.userId = ? AND d.revokedAt IS NULL
         ORDER BY r.fullName, r.publicRepositoryId`,
      )
      .all(userId) as Array<{ id: string; fullName: string; private: number }>;
    return rows.map((row) => ({ id: row.id, fullName: row.fullName, private: row.private === 1 }));
  }

  getProviderResource(userId: string, name: string) {
    return this.sqlite
      .prepare("SELECT r.* FROM codespaceLocalResource r JOIN codespaceLocalDevice d ON d.id = r.deviceId WHERE d.userId = ? AND d.revokedAt IS NULL AND r.providerResourceName = ?")
      .get(userId, name) ?? null;
  }


  listProviderResources(userId: string) {
    return this.sqlite
      .prepare(
        "SELECT r.* FROM codespaceLocalResource r JOIN codespaceLocalDevice d ON d.id = r.deviceId WHERE d.userId = ? AND d.revokedAt IS NULL ORDER BY r.createdAt, r.providerResourceName",
      )
      .all(userId);
  }

  private serializeRelay(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized, "utf8") > RELAY_MAX_BYTES
    ) {
      throw new Error("Local relay payload exceeds its bound");
    }
    return serialized;
  }


  enqueueRelay(
    userId: string,
    deviceId: string,
    dedupeKey: string,
    request: unknown,
    now = Date.now(),
  ): { id: string; deviceGeneration: number } {
    if (dedupeKey.length < 1 || dedupeKey.length > 255) {
      throw new Error("Invalid relay dedupe key");
    }
    const requestJson = this.serializeRelay(request);
    const tx = this.sqlite.transaction(() => {
      this.cleanupExpired(now);
      const device = this.sqlite
        .prepare(
          "SELECT generation, enabled, leaseUntil, lastSeenAt, revokedAt FROM codespaceLocalDevice WHERE id = ? AND userId = ?",
        )
        .get(deviceId, userId) as
        | {
            generation: number;
            enabled: number;
            leaseUntil: number;
            lastSeenAt: number | null;
            revokedAt: number | null;
          }
        | undefined;
      if (
        !device ||
        device.revokedAt !== null ||
        device.enabled !== 1 ||
        device.leaseUntil <= now ||
        device.lastSeenAt === null ||
        now - device.lastSeenAt > DEVICE_OFFLINE_MS
      ) {
        throw new Error("Local device is offline or not authorized");
      }
      const existing = this.sqlite
        .prepare(
          "SELECT id, requestJson, deviceGeneration FROM codespaceLocalRelay WHERE deviceId = ? AND dedupeKey = ?",
        )
        .get(deviceId, dedupeKey) as
        | { id: string; requestJson: string; deviceGeneration: number }
        | undefined;
      if (existing) {
        if (existing.requestJson !== requestJson || existing.deviceGeneration !== device.generation) {
          throw new Error("Local relay replay conflicts with its durable request");
        }
        return { id: existing.id, deviceGeneration: existing.deviceGeneration };
      }
      const id = randomUUID();
      this.sqlite
        .prepare(
          "INSERT INTO codespaceLocalRelay (id, userId, deviceId, deviceGeneration, dedupeKey, requestJson, state, leaseId, leaseExpiresAt, replyJson, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?, ?)",
        )
        .run(id, userId, deviceId, device.generation, dedupeKey, requestJson, now + RELAY_MAX_LIFETIME_MS, now, now);
      return { id, deviceGeneration: device.generation };
    });
    return tx.immediate();
  }


  claimRelay(credential: string, now = Date.now()): LocalRelayClaim | null {
    const authority = this.authenticate(credential);
    if (!authority) throw new Error("Local device credential is invalid");
    const row = this.sqlite
      .prepare(
        "SELECT id, requestJson, expiresAt FROM codespaceLocalRelay WHERE deviceId = ? AND userId = ? AND deviceGeneration = ? AND expiresAt > ? AND state = 'queued' ORDER BY createdAt, id LIMIT 1",
      )
      .get(authority.deviceId, authority.userId, authority.generation, now) as
      | { id: string; requestJson: string; expiresAt: number }
      | undefined;
    if (!row) return null;
    const leaseId = randomUUID();
    const changed = this.sqlite
      .prepare(
        "UPDATE codespaceLocalRelay SET state = 'leased', leaseId = ?, leaseExpiresAt = ?, updatedAt = ? WHERE id = ? AND state = 'queued'",
      )
      .run(leaseId, Math.min(row.expiresAt, now + RELAY_LEASE_MS), now, row.id);
    return changed.changes === 1
      ? { id: row.id, leaseId, expiresAt: row.expiresAt, request: JSON.parse(row.requestJson) as unknown }
      : null;
  }


  submitRelayReply(
    credential: string,
    relayId: string,
    leaseId: string,
    reply: unknown,
    now = Date.now(),
  ): boolean {
    const authority = this.authenticate(credential);
    if (!authority) throw new Error("Local device credential is invalid");
    const replyJson = this.serializeRelay(reply);
    return (
      this.sqlite
        .prepare(
          "UPDATE codespaceLocalRelay SET state = 'replied', replyJson = ?, leaseId = NULL, leaseExpiresAt = NULL, updatedAt = ? WHERE id = ? AND userId = ? AND deviceId = ? AND deviceGeneration = ? AND state = 'leased' AND leaseId = ? AND leaseExpiresAt > ? AND expiresAt > ?",
        )
        .run(replyJson, now, relayId, authority.userId, authority.deviceId, authority.generation, leaseId, now, now).changes === 1
    );
  }

  readRelay(userId: string, relayId: string, now = Date.now()) {
    this.cleanupExpired(now);
    const row = this.sqlite
      .prepare("SELECT state, replyJson FROM codespaceLocalRelay WHERE id = ? AND userId = ?")
      .get(relayId, userId) as { state: string; replyJson: string | null } | undefined;
    return row
      ? { state: row.state, reply: row.replyJson === null ? null : (JSON.parse(row.replyJson) as unknown) }
      : null;
  }


  cleanupExpired(now = Date.now()): void {
    this.sqlite.prepare(
      "UPDATE codespaceLocalRelay SET state = 'queued', leaseId = NULL, leaseExpiresAt = NULL, updatedAt = ? WHERE state = 'leased' AND leaseExpiresAt <= ? AND expiresAt > ?",
    ).run(now, now, now);
    this.sqlite.prepare(
      "UPDATE codespaceLocalRelay SET state = 'expired', leaseId = NULL, leaseExpiresAt = NULL, updatedAt = ? WHERE state IN ('queued','leased') AND expiresAt <= ?",
    ).run(now, now);
    this.sqlite.prepare("DELETE FROM codespaceLocalRelay WHERE expiresAt < ?")
      .run(now - RELAY_MAX_LIFETIME_MS);
    this.sqlite.prepare("DELETE FROM codespaceLocalPairing WHERE expiresAt < ? OR consumedAt < ?")
      .run(now - PAIRING_TTL_MS, now - PAIRING_TTL_MS);
  }

  getExternalRepository(userId: string, repositoryId: string):
    { deviceId: string; externalRepositoryId: string; fullName: string } | null {
    return (this.sqlite.prepare(
      `SELECT r.deviceId, r.externalRepositoryId, r.fullName
       FROM codespaceLocalRepository r JOIN codespaceLocalDevice d ON d.id = r.deviceId
       WHERE d.userId = ? AND d.revokedAt IS NULL AND r.publicRepositoryId = ?`,
    ).get(userId, repositoryId) as
      { deviceId: string; externalRepositoryId: string; fullName: string } | undefined) ?? null;
  }

  identityForUser(userId: string): string | null {
    return this.connectionFor(userId)?.externalAccountId ?? null;
  }

  private connectionFor(userId: string):
    { id: string; externalAccountId: string; credentialGeneration: number } | null {
    return (this.sqlite.prepare(
      "SELECT id, externalAccountId, credentialGeneration FROM codespaceConnection WHERE userId = ? AND provider = ?",
    ).get(userId, CODESPACE_PROVIDER_LOCAL) as
      { id: string; externalAccountId: string; credentialGeneration: number } | undefined) ?? null;
  }

  private ensureConnection(userId: string, now: number):
    { id: string; externalAccountId: string; credentialGeneration: number } {
    const existing = this.connectionFor(userId);
    if (existing) {
      this.sqlite.prepare(
        "UPDATE codespaceConnection SET status = 'connected', lastErrorCode = NULL, updatedAt = ? WHERE id = ?",
      ).run(now, existing.id);
      return existing;
    }
    const id = randomUUID();
    const externalAccountId = `local-user-${digest(userId).slice(0, 32)}`;
    this.sqlite.prepare(
      `INSERT INTO codespaceConnection
       (id, userId, provider, externalAccountId, externalLogin, status, grantsRefreshedAt,
        grantsVersion, credentialGeneration, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'Moira Local', 'connected', ?, 0, 1, ?, ?)`,
    ).run(id, userId, CODESPACE_PROVIDER_LOCAL, externalAccountId, now, now, now);
    return { id, externalAccountId, credentialGeneration: 1 };
  }

  private publicRepositoryId(deviceId: string, repositoryId: string): string {
    return `${CODESPACE_PROVIDER_LOCAL}:${deviceId}:${repositoryId}`;
  }

  providerResourceName(deviceId: string, spaceId: string): string {
    return `${CODESPACE_PROVIDER_LOCAL}:${deviceId}:${spaceId}`;
  }

