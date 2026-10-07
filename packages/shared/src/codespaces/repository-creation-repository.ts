import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "../utils/canonical-json.js";
import { LocalDeviceRepository, digestLocalSecret } from "./local-device-repository.js";
import { LocalDeviceError } from "./local-device-types.js";
import { MAX_LOCAL_WORK_LEASE_MS } from "./local-management-types.js";

export interface RepositoryCreationInput {
  deviceId: string;
  requestId: string;
  repositoryName: string;
  installationId: string;
}
export interface RepositoryCreationAuthority {
  githubConnectionId: string;
  githubUserId: string;
  owner: string;
  credentialGeneration: number;
}
export interface RepositoryCreationRecord
  extends RepositoryCreationInput, RepositoryCreationAuthority {
  userId: string;
  fingerprint: string;
  deviceGeneration: number;
  localConnectionId: string;
  delegation: string;
  marker: string;
  admissionRequestId: string;
  state: "prepared" | "submitted" | "unknown" | "created" | "rejected";
  repositoryId: string | null;
  fullName: string | null;
  installationVerified: number;
  reservationHeld: number;
  claimId: string | null;
  claimExpiresAt: number | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Durable private-repository requests exist independently of a VM or workflow. */
export class RepositoryCreationRepository {
  private readonly devices: LocalDeviceRepository;
  constructor(private readonly sqlite: Database.Database) {
    this.devices = new LocalDeviceRepository(sqlite);
  }
  getOwned(userId: string, requestId: string): RepositoryCreationRecord | null {
    this.devices.assertAdmitted(userId);
    return (
      (this.sqlite
        .prepare("SELECT * FROM codespaceRepositoryRequest WHERE userId=? AND requestId=?")
        .get(userId, requestId) as RepositoryCreationRecord | undefined) ?? null
    );
  }
  private deviceAuthority(
    userId: string,
    input: RepositoryCreationInput,
    authority: RepositoryCreationAuthority,
    now: number,
    admissionPending = false,
  ) {
    const device = this.devices.getActiveDevice(userId, input.deviceId);
    const control = device.control;
    const delegation = control?.appliedAgentRepositoryManagement;
    if (
      !control ||
      (!admissionPending &&
        (control.status !== "applied" || control.revision !== control.appliedRevision)) ||
      !delegation?.allowNewPrivate ||
      delegation.githubUserId !== authority.githubUserId ||
      delegation.owner.toLowerCase() !== authority.owner.toLowerCase() ||
      !device.policy.enabled ||
      device.policy.leaseUntil <= now ||
      device.policy.leaseUntil > now + MAX_LOCAL_WORK_LEASE_MS
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Apply new-private-repository delegation and a valid work lease first.",
      );
    return { device, delegation };
  }
  reserve(
    userId: string,
    input: RepositoryCreationInput,
    authority: RepositoryCreationAuthority,
    now: number,
  ): RepositoryCreationRecord {
    return this.sqlite
      .transaction(() => {
        const fingerprint = digestLocalSecret(canonicalJson(input));
        const old = this.getOwned(userId, input.requestId);
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new LocalDeviceError(
              "LOCAL_CONFLICT",
              "Repository creation request identity changed.",
            );
          return old;
        }
        const { device, delegation } = this.deviceAuthority(userId, input, authority, now);
        const receipts = device.control!.repositoryAdmissions ?? [];
        const usage = this.sqlite
          .prepare(
            "SELECT COALESCE(SUM(reservationHeld),0) held FROM codespaceRepositoryRequest WHERE deviceId=?",
          )
          .get(input.deviceId) as { held: number };
        if (
          receipts.length + usage.held >= delegation.maxRepositories ||
          device.policy.repositories.length + usage.held >= 64
        )
          throw new LocalDeviceError(
            "LOCAL_CAPACITY",
            "Repository creation reservations exhaust the owner's admission limit.",
          );
        if (
          this.sqlite
            .prepare(
              "SELECT requestId FROM codespaceRepositoryRequest WHERE requestId=? OR (userId=? AND githubUserId=? AND lower(repositoryName)=lower(?) AND state!='rejected')",
            )
            .get(input.requestId, userId, authority.githubUserId, input.repositoryName)
        )
          throw new LocalDeviceError(
            "LOCAL_CONFLICT",
            "A repository creation request already retains this identity.",
          );
        this.sqlite
          .prepare(
            `INSERT INTO codespaceRepositoryRequest
        (requestId,userId,deviceId,deviceGeneration,localConnectionId,githubConnectionId,githubUserId,owner,credentialGeneration,
         repositoryName,installationId,fingerprint,delegation,marker,admissionRequestId,state,reservationHeld,installationVerified,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',1,0,?,?)`,
          )
          .run(
            input.requestId,
            userId,
            input.deviceId,
            device.deviceGeneration,
            device.connectionId,
            authority.githubConnectionId,
            authority.githubUserId,
            authority.owner,
            authority.credentialGeneration,
            input.repositoryName,
            input.installationId,
            fingerprint,
            canonicalJson(delegation),
            randomBytes(32).toString("hex"),
            randomUUID(),
            now,
            now,
          );
        return this.getOwned(userId, input.requestId)!;
      })
      .immediate();
  }
  assertCurrent(
    record: RepositoryCreationRecord,
    authority: RepositoryCreationAuthority,
    now: number,
  ): void {
    const observed = this.devices.getActiveDevice(record.userId, record.deviceId);
    const admissionPending =
      record.reservationHeld === 0 &&
      observed.control?.status === "pending" &&
      observed.control.repositoryAdmissions?.some(
        (receipt) =>
          receipt.requestId === record.admissionRequestId &&
          receipt.revision === observed.control!.revision,
      ) === true &&
      canonicalJson(observed.control.settings.agentRepositoryManagement) === record.delegation;
    const { device, delegation } = this.deviceAuthority(
      record.userId,
      record,
      authority,
      now,
      admissionPending,
    );
    if (
      device.deviceGeneration !== record.deviceGeneration ||
      device.connectionId !== record.localConnectionId ||
      authority.githubConnectionId !== record.githubConnectionId ||
      authority.githubUserId !== record.githubUserId ||
      authority.owner.toLowerCase() !== record.owner.toLowerCase() ||
      canonicalJson(delegation) !== record.delegation
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Repository creation authority changed; restore the original owner consent.",
      );
  }
  claim(userId: string, requestId: string, now: number): RepositoryCreationRecord | null {
    return this.sqlite
      .transaction(() => {
        const old = this.getOwned(userId, requestId);
        if (
          !old ||
          old.state === "rejected" ||
          (old.claimExpiresAt !== null && old.claimExpiresAt > now)
        )
          return null;
        const claimId = randomUUID();
        this.sqlite
          .prepare(
            "UPDATE codespaceRepositoryRequest SET claimId=?,claimExpiresAt=?,state=CASE WHEN state='submitted' THEN 'unknown' ELSE state END,updatedAt=? WHERE userId=? AND requestId=?",
          )
          .run(claimId, now + 120_000, now, userId, requestId);
        return this.getOwned(userId, requestId)!;
      })
      .immediate();
  }
  submit(
    record: RepositoryCreationRecord,
    authority: RepositoryCreationAuthority,
    now: number,
  ): void {
    this.sqlite
      .transaction(() => {
        this.assertCurrent(record, authority, now);
        const changed = this.sqlite
          .prepare(
            "UPDATE codespaceRepositoryRequest SET state='submitted',errorCode=NULL,updatedAt=? WHERE requestId=? AND userId=? AND state='prepared' AND claimId=? AND claimExpiresAt>?",
          )
          .run(now, record.requestId, record.userId, record.claimId, now).changes;
        if (changed !== 1)
          throw new LocalDeviceError(
            "LOCAL_CONFLICT",
            "The repository create attempt was already submitted.",
          );
      })
      .immediate();
  }
  recordCreated(
    record: RepositoryCreationRecord,
    repositoryId: string,
    fullName: string,
    now: number,
  ): void {
    const changed = this.sqlite
      .prepare(
        "UPDATE codespaceRepositoryRequest SET state='created',repositoryId=?,fullName=?,errorCode=NULL,updatedAt=? WHERE requestId=? AND userId=? AND claimId=? AND state IN ('submitted','unknown')",
      )
      .run(repositoryId, fullName, now, record.requestId, record.userId, record.claimId).changes;
    if (changed !== 1)
      throw new LocalDeviceError(
        "LOCAL_CONFLICT",
        "Repository result belongs to a retired creation attempt.",
      );
  }
  mark(
    record: RepositoryCreationRecord,
    state: RepositoryCreationRecord["state"],
    errorCode: string | null,
    now: number,
  ): void {
    this.sqlite
      .prepare(
        "UPDATE codespaceRepositoryRequest SET state=?,errorCode=?,reservationHeld=CASE WHEN ?='rejected' THEN 0 ELSE reservationHeld END,updatedAt=? WHERE requestId=? AND userId=? AND claimId=?",
      )
      .run(state, errorCode, state, now, record.requestId, record.userId, record.claimId);
  }
  confirmInstallation(record: RepositoryCreationRecord, now: number): void {
    this.sqlite
      .prepare(
        "UPDATE codespaceRepositoryRequest SET installationVerified=1,errorCode=NULL,updatedAt=? WHERE requestId=? AND userId=? AND claimId=? AND state='created'",
      )
      .run(now, record.requestId, record.userId, record.claimId);
  }
  releaseClaim(record: RepositoryCreationRecord, now: number): void {
    this.sqlite
      .prepare(
        "UPDATE codespaceRepositoryRequest SET claimId=NULL,claimExpiresAt=NULL,updatedAt=? WHERE requestId=? AND userId=? AND claimId=?",
      )
      .run(now, record.requestId, record.userId, record.claimId);
  }
}
