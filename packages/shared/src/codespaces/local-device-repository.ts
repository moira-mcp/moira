import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "../utils/canonical-json.js";
import { getAccountAccessDenial } from "../auth/account-admission.js";
import {
  CODESPACE_PROVIDER_LOCAL,
  LocalDeviceError,
  localRepositoryTargetId,
  type LocalDeviceAuth,
  type LocalDeviceView,
  type LocalPairingView,
  type LocalResourceBinding,
} from "./local-device-types.js";

export function digestLocalSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
interface DeviceRow {
  id: string;
  userId: string;
  connectionId: string;
  label: string;
  generation: number;
  status: LocalDeviceView["status"];
  credentialDigest: string;
  lastSeenAt: number | null;
  createdAt: number;
}
interface PairingRow {
  id: string;
  userId: string;
  tokenDigest: string;
  deviceId: string | null;
  revision: number;
  confirmedAt: number | null;
  expiresAt: number;
}
function deviceView(row: DeviceRow): LocalDeviceView {
  return {
    userId: row.userId,
    connectionId: row.connectionId,
    deviceId: row.id,
    deviceGeneration: row.generation,
    label: row.label,
    status: row.status,
    owner: { state: "unavailable" },
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}
function pairingView(row: PairingRow, now: number): LocalPairingView {
  return {
    id: row.id,
    deviceId: row.deviceId,
    revision: row.revision,
    expiresAt: row.expiresAt,
    state:
      row.confirmedAt !== null
        ? "confirmed"
        : row.expiresAt <= now
          ? "expired"
          : row.deviceId
            ? "waiting_confirmation"
            : "waiting_local",
  };
}
/** Registration, revocation and routing identity only; settings and grants belong to the owner. */
export class LocalDeviceRepository {
  constructor(private readonly sqlite: Database.Database) {}

  assertAdmitted(userId: string): void {
    const user = this.sqlite
      .prepare("SELECT blocked, approvedAt, emailVerified FROM user WHERE id = ?")
      .get(userId) as
      { blocked: number; approvedAt: string | null; emailVerified: number } | undefined;
    if (
      !user ||
      getAccountAccessDenial(
        {
          userId,
          blocked: !!user.blocked,
          approvedAt: user.approvedAt,
          emailVerified: !!user.emailVerified,
        },
        { requireEmailVerified: true },
      )
    )
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Account access is required.");
  }

  listOwned(
    userId: string,
    now: number,
  ): { devices: LocalDeviceView[]; pairings: LocalPairingView[] } {
    this.assertAdmitted(userId);
    const devices = this.sqlite
      .prepare("SELECT * FROM codespaceLocalDevice WHERE userId = ? ORDER BY createdAt,id")
      .all(userId) as DeviceRow[];
    const pairings = this.sqlite
      .prepare(
        "SELECT * FROM codespaceLocalPairing WHERE userId = ? AND expiresAt > ? ORDER BY createdAt,id",
      )
      .all(userId, now) as PairingRow[];
    return {
      devices: devices.map(deviceView),
      pairings: pairings.map((row) => pairingView(row, now)),
    };
  }

  beginEnrollment(
    userId: string,
    tokenDigest: string,
    now: number,
  ): { pairingId: string; revision: number; expiresAt: number } {
    return this.sqlite
      .transaction(() => {
        this.assertAdmitted(userId);
        this.sqlite.prepare("DELETE FROM codespaceLocalPairing WHERE expiresAt <= ?").run(now);
        const pairingId = randomUUID(),
          expiresAt = now + 10 * 60_000;
        this.sqlite
          .prepare(
            "INSERT INTO codespaceLocalPairing(id,userId,tokenDigest,revision,expiresAt,createdAt) VALUES(?,?,?,1,?,?)",
          )
          .run(pairingId, userId, tokenDigest, expiresAt, now);
        return { pairingId, expiresAt, revision: 1 };
      })
      .immediate();
  }

  approveLocalEnrollment(
    input: {
      pairingId: string;
      tokenDigest: string;
      credentialDigest: string;
      deviceId: string;
      label: string;
    },
    now: number,
  ): LocalDeviceView {
    return this.sqlite
      .transaction(() => {
        const pair = this.requirePairing(input.pairingId, input.tokenDigest, now);
        this.assertAdmitted(pair.userId);
        if (pair.deviceId) {
          const row = this.device(pair.deviceId);
          if (
            !row ||
            row.status === "revoked" ||
            row.id !== input.deviceId ||
            row.credentialDigest !== input.credentialDigest ||
            row.label !== input.label
          )
            throw new LocalDeviceError("LOCAL_CONFLICT", "Pairing request changed.");
          return deviceView(row);
        }
        if (this.device(input.deviceId))
          throw new LocalDeviceError(
            "LOCAL_CONFLICT",
            "Device already enrolled; revoke and use a new local identity.",
          );
        let connection = this.sqlite
          .prepare("SELECT id FROM codespaceConnection WHERE userId = ? AND provider = ?")
          .get(pair.userId, CODESPACE_PROVIDER_LOCAL) as { id: string } | undefined;
        if (!connection) {
          connection = { id: randomUUID() };
          this.sqlite
            .prepare(
              `INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt)
          VALUES(?,?,?,?,?,'connecting',1,?,?)`,
            )
            .run(
              connection.id,
              pair.userId,
              CODESPACE_PROVIDER_LOCAL,
              pair.userId,
              "Local devices",
              now,
              now,
            );
        }
        this.sqlite
          .prepare(
            `INSERT INTO codespaceLocalDevice(id,userId,connectionId,label,generation,status,credentialDigest,lastSeenAt,createdAt,updatedAt)
        VALUES(?,?,?,?,1,'pending',?,?,?,?)`,
          )
          .run(
            input.deviceId,
            pair.userId,
            connection.id,
            input.label,
            input.credentialDigest,
            now,
            now,
            now,
          );
        this.sqlite
          .prepare(
            "UPDATE codespaceLocalPairing SET deviceId = ?, revision = revision + 1 WHERE id = ?",
          )
          .run(input.deviceId, pair.id);
        return deviceView(this.device(input.deviceId)!);
      })
      .immediate();
  }

  pairingStatus(pairingId: string, tokenDigest: string, now: number) {
    const pair = this.requirePairing(pairingId, tokenDigest, now);
    this.assertAdmitted(pair.userId);
    const device = pair.deviceId ? this.device(pair.deviceId) : null;
    return { pairing: pairingView(pair, now), device: device ? deviceView(device) : null };
  }

  confirmEnrollment(
    userId: string,
    pairingId: string,
    expectedRevision: number,
    now: number,
  ): LocalDeviceView {
    return this.sqlite
      .transaction(() => {
        this.assertAdmitted(userId);
        const pair = this.sqlite
          .prepare("SELECT * FROM codespaceLocalPairing WHERE id = ? AND userId = ?")
          .get(pairingId, userId) as PairingRow | undefined;
        if (!pair || pair.expiresAt <= now)
          throw new LocalDeviceError("LOCAL_EXPIRED", "Pairing expired.");
        if (!pair.deviceId || pair.revision !== expectedRevision || pair.confirmedAt !== null)
          throw new LocalDeviceError(
            "LOCAL_CONFLICT",
            "Read the current device before confirming.",
          );
        const device = this.device(pair.deviceId);
        if (!device || device.status !== "pending")
          throw new LocalDeviceError("LOCAL_CONFLICT", "Device is not pending.");
        this.sqlite
          .prepare(
            "UPDATE codespaceLocalDevice SET status = 'active',updatedAt = ? WHERE id = ? AND status = 'pending'",
          )
          .run(now, device.id);
        this.sqlite
          .prepare(
            "UPDATE codespaceLocalPairing SET confirmedAt = ?,revision = revision + 1 WHERE id = ?",
          )
          .run(now, pair.id);
        this.syncConnection(device.connectionId, now);
        return deviceView(this.device(device.id)!);
      })
      .immediate();
  }

  authenticateDevice(credentialDigest: string, now: number): LocalDeviceAuth {
    const row = this.sqlite
      .prepare(
        "SELECT * FROM codespaceLocalDevice WHERE credentialDigest = ? AND status = 'active'",
      )
      .get(credentialDigest) as DeviceRow | undefined;
    if (!row) throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device access denied.");
    this.assertAdmitted(row.userId);
    this.sqlite
      .prepare("UPDATE codespaceLocalDevice SET lastSeenAt = ? WHERE id = ?")
      .run(now, row.id);
    return {
      userId: row.userId,
      deviceId: row.id,
      deviceGeneration: row.generation,
      connectionId: row.connectionId,
    };
  }

  revokeOwned(
    userId: string,
    deviceId: string,
    expectedGeneration: number,
    now: number,
  ): LocalDeviceView {
    return this.sqlite
      .transaction(() => {
        this.assertAdmitted(userId);
        const row = this.device(deviceId);
        if (!row || row.userId !== userId)
          throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device access denied.");
        if (row.generation !== expectedGeneration || row.status === "revoked")
          throw new LocalDeviceError("LOCAL_CONFLICT", "Device generation changed.");
        this.sqlite
          .prepare(
            "UPDATE codespaceLocalDevice SET status = 'revoked',generation = generation + 1,updatedAt = ? WHERE id = ?",
          )
          .run(now, deviceId);
        this.syncConnection(row.connectionId, now);
        return deviceView(this.device(deviceId)!);
      })
      .immediate();
  }

  getActiveDevice(userId: string, deviceId: string): LocalDeviceView {
    const row = this.device(deviceId);
    if (!row || row.userId !== userId || row.status !== "active")
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device access denied.");
    this.assertAdmitted(userId);
    return deviceView(row);
  }

  getDeviceIdentity(
    userId: string,
    deviceId: string,
  ): LocalDeviceAuth & { status: LocalDeviceView["status"] } {
    this.assertAdmitted(userId);
    const row = this.device(deviceId);
    if (!row || row.userId !== userId)
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device access denied.");
    return {
      userId: row.userId,
      deviceId: row.id,
      deviceGeneration: row.generation,
      connectionId: row.connectionId,
      status: row.status,
    };
  }

  bindResource(input: LocalResourceBinding): LocalResourceBinding {
    return this.sqlite
      .transaction(() => {
        this.requireDevice(input);
        const resource = this.sqlite
          .prepare(
            "SELECT userId,connectionId,repositoryId,retiredAt FROM localResourceIdentity WHERE id = ?",
          )
          .get(input.resourceId) as
          | {
              userId: string;
              connectionId: string;
              repositoryId: string;
              retiredAt: number | null;
            }
          | undefined;
        if (
          !resource ||
          resource.userId !== input.userId ||
          resource.connectionId !== input.connectionId ||
          resource.retiredAt !== null ||
          resource.repositoryId !== localRepositoryTargetId(input.deviceId, input.repositoryId)
        )
          throw new LocalDeviceError(
            "LOCAL_UNAUTHORIZED",
            "Resource binding is not locally approved.",
          );
        const old = this.getBinding(input.userId, input.resourceId);
        if (old && canonicalJson(old) !== canonicalJson(input))
          throw new LocalDeviceError("LOCAL_CONFLICT", "Resource binding cannot change.");
        this.sqlite
          .prepare(
            "INSERT OR IGNORE INTO codespaceLocalResourceBinding(resourceId,userId,deviceId,deviceGeneration,repositoryId,profileId) VALUES(?,?,?,?,?,?)",
          )
          .run(
            input.resourceId,
            input.userId,
            input.deviceId,
            input.deviceGeneration,
            input.repositoryId,
            input.profileId,
          );
        return input;
      })
      .immediate();
  }

  getBinding(userId: string, resourceId: string): LocalResourceBinding | null {
    return (
      (this.sqlite
        .prepare(
          `SELECT b.resourceId,b.userId,b.deviceId,b.deviceGeneration,b.repositoryId,b.profileId,r.connectionId
      FROM codespaceLocalResourceBinding b JOIN localResourceIdentity r ON r.id=b.resourceId AND r.userId=b.userId
      JOIN codespaceLocalDevice d ON d.id=b.deviceId AND d.userId=b.userId AND d.generation=b.deviceGeneration AND d.connectionId=r.connectionId
      WHERE b.userId=? AND b.resourceId=? AND b.revokedAt IS NULL AND r.retiredAt IS NULL AND d.status='active'`,
        )
        .get(userId, resourceId) as LocalResourceBinding | undefined) ?? null
    );
  }

  validateRepositoryCreation(
    userId: string,
    device: LocalDeviceAuth,
    input: {
      creationRequestId: string;
      requestId: string;
      githubRepositoryId: string;
      fullName: string;
    },
  ): void {
    this.requireDevice(device);
    const creation = this.sqlite
      .prepare(
        `SELECT requestId FROM codespaceRepositoryRequest
      WHERE requestId=? AND userId=? AND deviceId=? AND deviceGeneration=? AND localConnectionId=?
        AND admissionRequestId=? AND repositoryId=? AND fullName=? AND state='created' AND installationVerified=1`,
      )
      .get(
        input.creationRequestId,
        userId,
        device.deviceId,
        device.deviceGeneration,
        device.connectionId,
        input.requestId,
        input.githubRepositoryId,
        input.fullName,
      );
    if (!creation)
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Repository admission requires confirmed creation provenance.",
      );
  }
  releaseRepositoryCreation(userId: string, requestId: string, now: number): void {
    this.assertAdmitted(userId);
    this.sqlite
      .prepare(
        "UPDATE codespaceRepositoryRequest SET reservationHeld=0,updatedAt=? WHERE requestId=? AND userId=?",
      )
      .run(now, requestId, userId);
  }

  private requireDevice(auth: LocalDeviceAuth): DeviceRow {
    this.assertAdmitted(auth.userId);
    const row = this.device(auth.deviceId);
    if (
      !row ||
      row.userId !== auth.userId ||
      row.connectionId !== auth.connectionId ||
      row.generation !== auth.deviceGeneration ||
      row.status !== "active"
    )
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device generation is no longer active.");
    return row;
  }
  private requirePairing(id: string, tokenDigest: string, now: number): PairingRow {
    const row = this.sqlite
      .prepare("SELECT * FROM codespaceLocalPairing WHERE id=? AND tokenDigest=?")
      .get(id, tokenDigest) as PairingRow | undefined;
    if (!row || row.expiresAt <= now)
      throw new LocalDeviceError("LOCAL_EXPIRED", "Pairing access denied or expired.");
    return row;
  }
  private device(id: string): DeviceRow | undefined {
    return this.sqlite.prepare("SELECT * FROM codespaceLocalDevice WHERE id=?").get(id) as
      DeviceRow | undefined;
  }
  private syncConnection(connectionId: string, now: number): void {
    const active = this.sqlite
      .prepare("SELECT 1 FROM codespaceLocalDevice WHERE connectionId=? AND status='active'")
      .get(connectionId);
    this.sqlite
      .prepare("UPDATE codespaceConnection SET status=?,updatedAt=? WHERE id=?")
      .run(active ? "connected" : "disconnected", now, connectionId);
  }
}
