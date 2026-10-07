import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "../utils/canonical-json.js";
import { getAccountAccessDenial } from "../auth/account-admission.js";
import {
  CODESPACE_PROVIDER_LOCAL,
  LocalDeviceError,
  localPublicPolicySchema,
  localRepositoryTargetId,
  localRelayPayloadReferenceSchema,
  type LocalDeviceAuth,
  type LocalDeviceView,
  type LocalPairingView,
  type LocalPublicPolicy,
  type LocalResourceBinding,
  type LocalRelayRequest,
  type LocalRelayClaim,
  type LocalRelayResult,
  type LocalRelayAcknowledgement,
  type LocalRelayPayloadReference,
} from "./local-device-types.js";
import {
  MAX_LOCAL_WORK_LEASE_MS,
  assertLocalControlSettings,
  localDeviceControlViewSchema,
  assertAgentRepositoryAdmission,
  localRepositoryAdmissionReceiptSchema,
  type LocalRepositoryAdmissionReceipt,
  type LocalControlReport,
  type LocalDeviceControlView,
  type LocalDeviceSettingsValue,
} from "./local-management-types.js";

export function digestLocalSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
const RELAY_REPLAY_RETENTION_MS = 60 * 60_000;
const MAX_RETAINED_RELAY_REQUESTS_PER_DEVICE = 2048;
const MAX_RETAINED_RELAY_REQUESTS_PER_OWNER = 8192;
interface DeviceRow {
  id: string;
  userId: string;
  connectionId: string;
  label: string;
  generation: number;
  status: LocalDeviceView["status"];
  credentialDigest: string;
  policy: string;
  policyDigest: string;
  control: string | null;
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
interface RelayRow extends LocalDeviceAuth {
  requestId: string;
  resourceId: string;
  resourceGeneration: number;
  digest: string;
  inputReference: string;
  outputReference: string | null;
  status: LocalRelayResult["status"];
  claimId: string | null;
  claimExpiresAt: number | null;
  deadlineAt: number;
}
function deviceView(row: DeviceRow): LocalDeviceView {
  return {
    userId: row.userId,
    connectionId: row.connectionId,
    deviceId: row.id,
    deviceGeneration: row.generation,
    label: row.label,
    status: row.status,
    policy: localPublicPolicySchema.parse(JSON.parse(row.policy)),
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    ...(row.control
      ? { control: localDeviceControlViewSchema.parse(JSON.parse(row.control)) }
      : {}),
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
function result(row: RelayRow): LocalRelayResult {
  return {
    requestId: row.requestId,
    digest: row.digest,
    status: row.status,
    outcomeReference: row.outputReference
      ? localRelayPayloadReferenceSchema.parse(JSON.parse(row.outputReference))
      : null,
  };
}

/** Transactions own pairing, device generations, and exact relay authority. */
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
    this.sqlite.transaction(() => this.pruneRelayMetadata(userId, now)).immediate();
    const devices = this.sqlite
      .prepare("SELECT * FROM codespaceLocalDevice WHERE userId = ? ORDER BY createdAt,id LIMIT 64")
      .all(userId) as DeviceRow[];
    const pairings = this.sqlite
      .prepare(
        "SELECT * FROM codespaceLocalPairing WHERE userId = ? AND expiresAt > ? ORDER BY createdAt,id LIMIT 16",
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
        const count = this.sqlite
          .prepare("SELECT COUNT(*) count FROM codespaceLocalPairing WHERE userId = ?")
          .get(userId) as { count: number };
        if (count.count >= 16)
          throw new LocalDeviceError("LOCAL_CAPACITY", "Too many pending pairings.");
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
      policy: LocalPublicPolicy;
    },
    now: number,
  ): LocalDeviceView {
    return this.sqlite
      .transaction(() => {
        const pair = this.requirePairing(input.pairingId, input.tokenDigest, now);
        this.assertAdmitted(pair.userId);
        const policy = canonicalJson(input.policy),
          policyDigest = digestLocalSecret(policy);
        if (pair.deviceId) {
          const row = this.device(pair.deviceId);
          if (
            !row ||
            row.status === "revoked" ||
            row.id !== input.policy.deviceId ||
            row.credentialDigest !== input.credentialDigest ||
            row.policyDigest !== policyDigest
          )
            throw new LocalDeviceError("LOCAL_CONFLICT", "Pairing request changed.");
          return deviceView(row);
        }
        if (this.device(input.policy.deviceId))
          throw new LocalDeviceError(
            "LOCAL_CONFLICT",
            "Device already enrolled; revoke and use a new local identity.",
          );
        const count = this.sqlite
          .prepare(
            "SELECT COUNT(*) count FROM codespaceLocalDevice WHERE userId = ? AND status != 'revoked'",
          )
          .get(pair.userId) as { count: number };
        if (count.count >= 32)
          throw new LocalDeviceError("LOCAL_CAPACITY", "Device limit reached.");
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
            `INSERT INTO codespaceLocalDevice(id,userId,connectionId,label,generation,status,credentialDigest,policy,policyDigest,lastSeenAt,createdAt,updatedAt)
        VALUES(?,?,?,?,1,'pending',?,?,?,?,?,?)`,
          )
          .run(
            input.policy.deviceId,
            pair.userId,
            connection.id,
            input.policy.label,
            input.credentialDigest,
            policy,
            policyDigest,
            now,
            now,
            now,
          );
        this.sqlite
          .prepare(
            "UPDATE codespaceLocalPairing SET deviceId = ?, revision = revision + 1 WHERE id = ?",
          )
          .run(input.policy.deviceId, pair.id);
        return deviceView(this.device(input.policy.deviceId)!);
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

  heartbeat(
    auth: LocalDeviceAuth,
    policy: LocalPublicPolicy,
    now: number,
    report?: LocalControlReport,
  ): LocalDeviceView {
    return this.sqlite
      .transaction(() => {
        const row = this.requireDevice(auth);
        this.pruneRelayMetadata(row.userId, now);
        if (policy.deviceId !== row.id)
          throw new LocalDeviceError("LOCAL_CONFLICT", "Device identity changed.");
        const encoded = canonicalJson(policy);
        if (report) {
          if (
            report.settings.label !== policy.label ||
            report.settings.enabled !== policy.enabled ||
            report.settings.leaseUntil !== policy.leaseUntil ||
            report.settings.cpuCores !== policy.machine.cpuCores ||
            report.settings.memoryBytes !== policy.machine.memoryBytes ||
            report.settings.storageBytes !== policy.machine.storageBytes ||
            canonicalJson(report.settings.repositories) !== canonicalJson(policy.repositories)
          )
            throw new LocalDeviceError(
              "LOCAL_INVALID",
              "Applied settings do not match the device policy.",
            );
          const previous = row.control
            ? localDeviceControlViewSchema.parse(JSON.parse(row.control))
            : null;
          if (
            report.appliedRevision > (previous?.revision ?? 0) ||
            report.appliedRevision < (previous?.appliedRevision ?? 0)
          )
            throw new LocalDeviceError(
              "LOCAL_CONFLICT",
              "Control acknowledgement changed revision.",
            );
          if (
            previous?.ceiling &&
            canonicalJson(previous.ceiling) !== canonicalJson(report.ceiling)
          )
            throw new LocalDeviceError(
              "LOCAL_CONFLICT",
              "Reapprove a changed control ceiling locally.",
            );
          const control: LocalDeviceControlView = previous ?? {
            optedIn: true,
            revision: 0,
            appliedRevision: 0,
            status: "applied",
            settings: report.settings,
            ceiling: report.ceiling,
            error: null,
          };
          if (
            previous &&
            report.appliedRevision > previous.appliedRevision &&
            report.appliedRevision === previous.revision &&
            canonicalJson(report.settings) !== canonicalJson(previous.settings)
          )
            throw new LocalDeviceError(
              "LOCAL_CONFLICT",
              "Applied revision differs from its requested settings.",
            );
          control.optedIn = true;
          control.ceiling = report.ceiling;
          control.appliedRevision = report.appliedRevision;
          control.appliedAgentRepositoryManagement = report.settings.agentRepositoryManagement;
          if (report.appliedRevision === control.revision) {
            control.status = "applied";
            control.settings = report.settings;
            control.error = null;
          } else if (report.rejectedRevision === control.revision && report.error) {
            control.status = "rejected";
            control.error = report.error;
          }
          this.sqlite
            .prepare("UPDATE codespaceLocalDevice SET control=? WHERE id=?")
            .run(canonicalJson(control), row.id);
        }
        this.sqlite
          .prepare(
            "UPDATE codespaceLocalDevice SET label = ?,policy = ?,policyDigest = ?,lastSeenAt = ?,updatedAt = ? WHERE id = ?",
          )
          .run(policy.label, encoded, digestLocalSecret(encoded), now, now, row.id);
        this.syncConnection(row.connectionId, now);
        return deviceView(this.device(row.id)!);
      })
      .immediate();
  }

  requestSettings(
    userId: string,
    deviceId: string,
    expectedGeneration: number,
    expectedRevision: number,
    settings: LocalDeviceSettingsValue,
    now: number,
  ): LocalDeviceView {
    return this.sqlite
      .transaction(() => {
        this.assertAdmitted(userId);
        const row = this.device(deviceId);
        if (!row || row.userId !== userId || row.status !== "active")
          throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device access denied.");
        const control = row.control
          ? localDeviceControlViewSchema.parse(JSON.parse(row.control))
          : null;
        if (!control?.optedIn || !control.ceiling)
          throw new LocalDeviceError(
            "LOCAL_CONFLICT",
            "Update this companion and opt in to web control on the computer first.",
          );
        if (row.generation !== expectedGeneration || control.revision !== expectedRevision)
          throw new LocalDeviceError(
            "LOCAL_CONFLICT",
            "Device settings changed; reload before saving.",
          );
        try {
          assertLocalControlSettings(settings, control.ceiling, now);
        } catch {
          throw new LocalDeviceError(
            "LOCAL_INVALID",
            "Settings exceed the locally approved envelope or finite lease.",
          );
        }
        control.revision++;
        control.settings = settings;
        control.status = "pending";
        control.error = null;
        this.sqlite
          .prepare("UPDATE codespaceLocalDevice SET control=?,updatedAt=? WHERE id=?")
          .run(canonicalJson(control), now, row.id);
        return deviceView(this.device(row.id)!);
      })
      .immediate();
  }

  /** The caller supplies a freshly verified GitHub identity, never arbitrary settings. */
  requestRepositoryAdmission(
    userId: string,
    deviceId: string,
    input: Omit<
      LocalRepositoryAdmissionReceipt,
      "revision" | "connectionId" | "localRepositoryId"
    > & {
      expectedRevision: number;
    },
    now: number,
  ): LocalDeviceView {
    return this.sqlite
      .transaction(() => {
        const device = this.getActiveDevice(userId, deviceId);
        const control = device.control;
        if (!control?.optedIn || !control.ceiling)
          throw new LocalDeviceError(
            "LOCAL_UNAUTHORIZED",
            "Approve web control on this device first.",
          );
        const receipts = control.repositoryAdmissions ?? [];
        const previous = receipts.find((receipt) => receipt.requestId === input.requestId);
        if (previous) {
          if (
            previous.githubRepositoryId !== input.githubRepositoryId ||
            previous.creationRequestId !== input.creationRequestId ||
            previous.deviceGeneration !== input.deviceGeneration ||
            canonicalJson(previous.repository) !== canonicalJson(input.repository)
          )
            throw new LocalDeviceError("LOCAL_CONFLICT", "Repository request identity changed.");
          return device;
        }
        if (
          device.deviceGeneration !== input.deviceGeneration ||
          control.revision !== input.expectedRevision ||
          control.status !== "applied" ||
          control.appliedRevision !== control.revision
        )
          throw new LocalDeviceError(
            "LOCAL_CONFLICT",
            "Wait for applied device settings and reload before adding a repository.",
          );
        this.requireLease(device.policy, now);
        if (input.creationRequestId) {
          const creation = this.sqlite
            .prepare(
              `SELECT requestId FROM codespaceRepositoryRequest
            WHERE requestId=? AND userId=? AND deviceId=? AND deviceGeneration=? AND localConnectionId=?
              AND admissionRequestId=? AND repositoryId=? AND fullName=? AND state='created' AND installationVerified=1`,
            )
            .get(
              input.creationRequestId,
              userId,
              deviceId,
              device.deviceGeneration,
              device.connectionId,
              input.requestId,
              input.githubRepositoryId,
              input.repository.fullName,
            );
          if (!creation)
            throw new LocalDeviceError(
              "LOCAL_UNAUTHORIZED",
              "New repository admission requires confirmed Moira creation provenance.",
            );
        }
        try {
          assertAgentRepositoryAdmission(
            control.settings.agentRepositoryManagement,
            input.repository,
            input.creationRequestId ? "created" : "existing",
          );
        } catch {
          throw new LocalDeviceError(
            "LOCAL_UNAUTHORIZED",
            "Repository exceeds the applied owner delegation.",
          );
        }
        if (
          control.settings.repositories.some(
            (repository) =>
              repository.id === input.repository.id ||
              repository.fullName.toLowerCase() === input.repository.fullName.toLowerCase(),
          )
        )
          throw new LocalDeviceError(
            "LOCAL_CONFLICT",
            "This repository already has a local grant.",
          );
        const receipt = localRepositoryAdmissionReceiptSchema.parse({
          requestId: input.requestId,
          githubRepositoryId: input.githubRepositoryId,
          deviceGeneration: input.deviceGeneration,
          repository: input.repository,
          ...(input.creationRequestId ? { creationRequestId: input.creationRequestId } : {}),
          localRepositoryId: input.repository.id,
          connectionId: device.connectionId,
          revision: control.revision + 1,
        });
        control.revision = receipt.revision;
        control.settings = {
          ...control.settings,
          repositories: [...control.settings.repositories, receipt.repository],
        };
        control.repositoryAdmissions = [...receipts, receipt];
        control.status = "pending";
        control.error = null;
        this.sqlite
          .prepare("UPDATE codespaceLocalDevice SET control=?,updatedAt=? WHERE id=?")
          .run(canonicalJson(control), now, deviceId);
        if (input.creationRequestId)
          this.sqlite
            .prepare(
              "UPDATE codespaceRepositoryRequest SET reservationHeld=0,updatedAt=? WHERE requestId=? AND userId=?",
            )
            .run(now, input.creationRequestId, userId);
        return deviceView(this.device(deviceId)!);
      })
      .immediate();
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
        this.sqlite
          .prepare(
            "UPDATE codespaceLocalRelay SET status = 'revoked',updatedAt = ? WHERE deviceId = ? AND deviceGeneration = ? AND status IN ('queued','claimed')",
          )
          .run(now, deviceId, expectedGeneration);
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

  authorizeGitHubOperation(
    auth: LocalDeviceAuth,
    resourceId: string,
    resourceGeneration: number,
    action: "fetch" | "push" | "pull_request",
    now: number,
  ): LocalPublicPolicy["repositories"][number] {
    const policy = localPublicPolicySchema.parse(JSON.parse(this.requireDevice(auth).policy));
    this.requireDispatch(
      {
        ...auth,
        resourceId,
        resourceGeneration,
        deadlineAt: Math.min(now + 120_000, policy.leaseUntil),
      },
      now,
    );
    const binding = this.getBinding(auth.userId, resourceId)!;
    const repository = policy.repositories.find((repo) => repo.id === binding.repositoryId)!;
    const resource = this.sqlite
      .prepare(
        "SELECT repositoryId,repositoryFullName FROM codespaceResource WHERE id=? AND userId=?",
      )
      .get(resourceId, auth.userId) as
      { repositoryId: string; repositoryFullName: string } | undefined;
    if (
      !resource ||
      resource.repositoryId !== localRepositoryTargetId(auth.deviceId, repository.id) ||
      resource.repositoryFullName.toLowerCase() !== repository.fullName.toLowerCase()
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "The resource no longer names this approved repository.",
      );
    if (
      (action === "push" && !repository.allowPush) ||
      (action === "pull_request" && repository.allowPullRequests !== true)
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "The local repository operation is not approved.",
      );
    return repository;
  }

  authorizeOwnedGitHubOperation(
    userId: string,
    resourceId: string,
    action: "fetch" | "push" | "pull_request",
    now: number,
  ) {
    this.assertAdmitted(userId);
    const resource = this.sqlite
      .prepare("SELECT generation FROM codespaceResource WHERE id=? AND userId=? AND provider=?")
      .get(resourceId, userId, CODESPACE_PROVIDER_LOCAL) as { generation: number } | undefined;
    const binding = this.getBinding(userId, resourceId);
    if (!resource || !binding)
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Local resource access denied.");
    const auth: LocalDeviceAuth = {
      userId,
      deviceId: binding.deviceId,
      deviceGeneration: binding.deviceGeneration,
      connectionId: binding.connectionId,
    };
    return {
      auth,
      resourceGeneration: resource.generation,
      repository: this.authorizeGitHubOperation(auth, resourceId, resource.generation, action, now),
    };
  }

  bindResource(input: LocalResourceBinding, now: number): LocalResourceBinding {
    return this.sqlite
      .transaction(() => {
        const device = this.requireDevice(input),
          policy = localPublicPolicySchema.parse(JSON.parse(device.policy));
        this.requireLease(policy, now);
        const resource = this.sqlite
          .prepare(
            "SELECT userId,connectionId,provider,repositoryId,machineName FROM codespaceResource WHERE id = ?",
          )
          .get(input.resourceId) as
          | {
              userId: string;
              connectionId: string;
              provider: string;
              repositoryId: string;
              machineName: string;
            }
          | undefined;
        if (
          !resource ||
          resource.userId !== input.userId ||
          resource.connectionId !== input.connectionId ||
          resource.provider !== CODESPACE_PROVIDER_LOCAL ||
          resource.repositoryId !== localRepositoryTargetId(input.deviceId, input.repositoryId) ||
          resource.machineName !== input.profileId ||
          !policy.repositories.some((repo) => repo.id === input.repositoryId) ||
          policy.machine.name !== input.profileId
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
          `SELECT b.*,d.connectionId FROM codespaceLocalResourceBinding b JOIN codespaceLocalDevice d ON d.id=b.deviceId
      WHERE b.userId=? AND b.resourceId=?`,
        )
        .get(userId, resourceId) as LocalResourceBinding | undefined) ?? null
    );
  }

  enqueue(input: LocalRelayRequest, now: number): LocalRelayResult {
    return this.sqlite
      .transaction(() => {
        this.requireDispatch(input, now);
        this.pruneRelayMetadata(input.userId, now);
        const previous = this.relay(input.requestId);
        if (previous) {
          if (
            previous.userId !== input.userId ||
            previous.deviceId !== input.deviceId ||
            previous.deviceGeneration !== input.deviceGeneration ||
            previous.connectionId !== input.connectionId ||
            previous.resourceId !== input.resourceId ||
            previous.resourceGeneration !== input.resourceGeneration ||
            previous.digest !== input.digest ||
            previous.deadlineAt !== input.deadlineAt ||
            previous.inputReference !== canonicalJson(input.payloadReference)
          )
            throw new LocalDeviceError("LOCAL_CONFLICT", "Relay request identity changed.");
          return result(previous);
        }
        const retained = this.sqlite
          .prepare(
            "SELECT COUNT(*) count,SUM(CASE WHEN deviceId=? THEN 1 ELSE 0 END) deviceCount FROM codespaceLocalRelay WHERE userId=?",
          )
          .get(input.deviceId, input.userId) as { count: number; deviceCount: number | null };
        if (
          retained.count >= MAX_RETAINED_RELAY_REQUESTS_PER_OWNER ||
          (retained.deviceCount ?? 0) >= MAX_RETAINED_RELAY_REQUESTS_PER_DEVICE
        )
          throw new LocalDeviceError("LOCAL_CAPACITY", "Retained device relay metadata is full.");
        this.verifyPayload(input.userId, input.payloadReference, "local_relay_input", now);
        const usage = this.sqlite
          .prepare(
            "SELECT COUNT(*) count FROM codespaceLocalRelay WHERE deviceId = ? AND status IN ('queued','claimed') AND deadlineAt > ?",
          )
          .get(input.deviceId, now) as { count: number };
        if (usage.count >= 128)
          throw new LocalDeviceError("LOCAL_CAPACITY", "Device relay queue is full.");
        this.sqlite
          .prepare(
            `INSERT INTO codespaceLocalRelay(requestId,userId,deviceId,deviceGeneration,connectionId,resourceId,resourceGeneration,digest,inputReference,status,deadlineAt,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
          )
          .run(
            input.requestId,
            input.userId,
            input.deviceId,
            input.deviceGeneration,
            input.connectionId,
            input.resourceId,
            input.resourceGeneration,
            input.digest,
            canonicalJson(input.payloadReference),
            input.deadlineAt,
            now,
            now,
          );
        return result(this.relay(input.requestId)!);
      })
      .immediate();
  }

  claim(auth: LocalDeviceAuth, limit: number, now: number): LocalRelayClaim[] {
    return this.sqlite
      .transaction(() => {
        const device = this.requireDevice(auth),
          policy = localPublicPolicySchema.parse(JSON.parse(device.policy));
        this.requireLease(policy, now);
        this.pruneRelayMetadata(auth.userId, now);
        const rows = this.sqlite
          .prepare(
            `SELECT * FROM codespaceLocalRelay WHERE deviceId=? AND deviceGeneration=? AND deadlineAt>?
        AND (status='queued' OR (status='claimed' AND claimExpiresAt<=?)) ORDER BY createdAt,requestId LIMIT ?`,
          )
          .all(auth.deviceId, auth.deviceGeneration, now, now, limit) as RelayRow[];
        const claims: LocalRelayClaim[] = [];
        for (const row of rows) {
          try {
            this.requireDispatch(row, now);
            this.verifyPayload(
              row.userId,
              localRelayPayloadReferenceSchema.parse(JSON.parse(row.inputReference)),
              "local_relay_input",
              now,
            );
          } catch (error) {
            if (!(error instanceof LocalDeviceError)) throw error;
            this.sqlite
              .prepare(
                "UPDATE codespaceLocalRelay SET status='refused',updatedAt=? WHERE requestId=?",
              )
              .run(now, row.requestId);
            continue;
          }
          const claimId = randomUUID(),
            claimExpiresAt = Math.min(row.deadlineAt, policy.leaseUntil, now + 30_000);
          this.sqlite
            .prepare(
              "UPDATE codespaceLocalRelay SET status='claimed',claimId=?,claimExpiresAt=?,updatedAt=? WHERE requestId=?",
            )
            .run(claimId, claimExpiresAt, now, row.requestId);
          claims.push({
            ...auth,
            requestId: row.requestId,
            resourceId: row.resourceId,
            resourceGeneration: row.resourceGeneration,
            digest: row.digest,
            payloadReference: localRelayPayloadReferenceSchema.parse(
              JSON.parse(row.inputReference),
            ),
            deadlineAt: row.deadlineAt,
            claimId,
            claimExpiresAt,
          });
        }
        return claims;
      })
      .immediate();
  }

  acknowledge(
    auth: LocalDeviceAuth,
    ack: LocalRelayAcknowledgement,
    now: number,
  ): LocalRelayResult {
    return this.sqlite
      .transaction(() => {
        this.requireDevice(auth);
        const row = this.requireRelayOwner(auth, ack.requestId);
        if (row.digest !== ack.digest || row.claimId !== ack.claimId)
          throw new LocalDeviceError("LOCAL_CONFLICT", "Relay acknowledgement changed.");
        const encoded = canonicalJson(ack.outcomeReference);
        if (row.status === "completed" || row.status === "refused") {
          if (row.status !== ack.status || row.outputReference !== encoded)
            throw new LocalDeviceError("LOCAL_CONFLICT", "Relay result changed.");
          return result(row);
        }
        this.requireDispatch(row, now);
        if (row.status !== "claimed" || row.claimExpiresAt === null || row.claimExpiresAt <= now)
          throw new LocalDeviceError("LOCAL_EXPIRED", "Relay claim expired.");
        this.authorizeOutput(auth, ack, now);
        this.sqlite
          .prepare(
            "UPDATE codespaceLocalRelay SET status=?,outputReference=?,updatedAt=? WHERE requestId=? AND claimId=? AND status='claimed'",
          )
          .run(ack.status, encoded, now, ack.requestId, ack.claimId);
        return result(this.relay(ack.requestId)!);
      })
      .immediate();
  }

  getResult(userId: string, requestId: string): LocalRelayResult | null {
    this.assertAdmitted(userId);
    const row = this.relay(requestId);
    return row?.userId === userId ? result(row) : null;
  }
  getRequest(userId: string, requestId: string): LocalRelayRequest | null {
    this.assertAdmitted(userId);
    const row = this.relay(requestId);
    if (!row || row.userId !== userId) return null;
    return {
      userId: row.userId,
      deviceId: row.deviceId,
      deviceGeneration: row.deviceGeneration,
      connectionId: row.connectionId,
      requestId: row.requestId,
      resourceId: row.resourceId,
      resourceGeneration: row.resourceGeneration,
      digest: row.digest,
      payloadReference: localRelayPayloadReferenceSchema.parse(JSON.parse(row.inputReference)),
      deadlineAt: row.deadlineAt,
    };
  }
  authorizeOutput(auth: LocalDeviceAuth, ack: LocalRelayAcknowledgement, now: number): void {
    const claim = this.authorizePayload(auth, ack.requestId, ack.claimId, now);
    if (claim.digest !== ack.digest)
      throw new LocalDeviceError("LOCAL_CONFLICT", "Relay acknowledgement changed.");
    this.verifyPayload(auth.userId, ack.outcomeReference, "local_relay_output", now);
    for (const part of ack.outcomeReference.parts) {
      if (
        !this.sqlite
          .prepare(
            "SELECT transferId FROM codespaceLocalRelayPart WHERE transferId=? AND requestId=? AND claimId=?",
          )
          .get(part.transferId, ack.requestId, ack.claimId)
      )
        throw new LocalDeviceError(
          "LOCAL_UNAUTHORIZED",
          "Result part belongs to another relay claim.",
        );
    }
  }

  registerOutputPart(
    auth: LocalDeviceAuth,
    requestId: string,
    claimId: string,
    part: LocalRelayPayloadReference["parts"][number],
    now: number,
  ): void {
    this.sqlite
      .transaction(() => {
        this.authorizePayload(auth, requestId, claimId, now);
        this.verifyPayload(
          auth.userId,
          { parts: [part], sha256: part.sha256, size: part.size },
          "local_relay_output",
          now,
        );
        const count = this.sqlite
          .prepare(
            `SELECT COUNT(*) count,COALESCE(SUM(t.observedSize),0) bytes FROM codespaceLocalRelayPart p
        JOIN codespaceTransfer t ON t.id=p.transferId WHERE p.requestId=? AND p.claimId=?`,
          )
          .get(requestId, claimId) as { count: number; bytes: number };
        if (count.count >= 32 || count.bytes + part.size > 24 * 1024 * 1024)
          throw new LocalDeviceError("LOCAL_CAPACITY", "Relay result exceeds its bound.");
        this.sqlite
          .prepare(
            "INSERT INTO codespaceLocalRelayPart(transferId,requestId,claimId) VALUES(?,?,?)",
          )
          .run(part.transferId, requestId, claimId);
      })
      .immediate();
  }

  renewClaim(
    auth: LocalDeviceAuth,
    requestId: string,
    claimId: string,
    now: number,
  ): LocalRelayClaim {
    return this.sqlite
      .transaction(() => {
        const claim = this.authorizePayload(auth, requestId, claimId, now);
        const policy = localPublicPolicySchema.parse(JSON.parse(this.requireDevice(auth).policy));
        this.sqlite
          .prepare(
            "UPDATE codespaceLocalRelay SET claimExpiresAt=?,updatedAt=? WHERE requestId=? AND claimId=?",
          )
          .run(
            Math.min(claim.deadlineAt, policy.leaseUntil, now + 30_000),
            now,
            requestId,
            claimId,
          );
        return this.authorizePayload(auth, requestId, claimId, now);
      })
      .immediate();
  }

  /** Blob reads/uploads must call this after authenticating the device and before touching bytes. */
  authorizePayload(
    auth: LocalDeviceAuth,
    requestId: string,
    claimId: string,
    now: number,
  ): LocalRelayClaim {
    const row = this.requireRelayOwner(auth, requestId);
    this.requireDispatch(row, now);
    if (
      row.status !== "claimed" ||
      row.claimId !== claimId ||
      !row.claimExpiresAt ||
      row.claimExpiresAt <= now
    )
      throw new LocalDeviceError("LOCAL_EXPIRED", "Relay claim expired.");
    return {
      ...auth,
      requestId: row.requestId,
      resourceId: row.resourceId,
      resourceGeneration: row.resourceGeneration,
      digest: row.digest,
      payloadReference: localRelayPayloadReferenceSchema.parse(JSON.parse(row.inputReference)),
      deadlineAt: row.deadlineAt,
      claimId: row.claimId,
      claimExpiresAt: row.claimExpiresAt,
    };
  }

  private verifyPayload(
    userId: string,
    reference: LocalRelayPayloadReference,
    purpose: string,
    now: number,
  ): void {
    for (const part of reference.parts) {
      const owned = this.sqlite
        .prepare(
          `SELECT id FROM codespaceTransfer WHERE id=? AND userId=? AND purpose=? AND sha256=?
        AND observedSize=? AND state IN ('ready','claimed') AND expiresAt>?`,
        )
        .get(part.transferId, userId, purpose, part.sha256, part.size, now);
      if (!owned)
        throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Private payload ownership denied.");
    }
  }
  /** Keep live authority and the full replay horizon; capacity never evicts a fresh receipt. */
  private pruneRelayMetadata(userId: string, now: number): void {
    this.sqlite
      .prepare(
        "UPDATE codespaceLocalRelay SET status='expired',updatedAt=? WHERE userId=? AND status IN ('queued','claimed') AND deadlineAt<=?",
      )
      .run(now, userId, now);
    this.sqlite
      .prepare(
        "DELETE FROM codespaceLocalRelay WHERE userId=? AND status NOT IN ('queued','claimed') AND deadlineAt<?",
      )
      .run(userId, now - RELAY_REPLAY_RETENTION_MS);
  }
  private requireRelayOwner(auth: LocalDeviceAuth, requestId: string): RelayRow {
    this.requireDevice(auth);
    const row = this.relay(requestId);
    if (
      !row ||
      row.userId !== auth.userId ||
      row.deviceId !== auth.deviceId ||
      row.deviceGeneration !== auth.deviceGeneration ||
      row.connectionId !== auth.connectionId
    )
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Relay ownership denied.");
    return row;
  }
  private requireDispatch(
    input: LocalDeviceAuth & { resourceId: string; resourceGeneration: number; deadlineAt: number },
    now: number,
  ): void {
    const row = this.requireDevice(input),
      policy = localPublicPolicySchema.parse(JSON.parse(row.policy));
    this.requireLease(policy, now);
    const binding = this.getBinding(input.userId, input.resourceId);
    const resource = this.sqlite
      .prepare(
        `SELECT r.generation,r.state,r.repositoryId,r.repositoryFullName,r.authorizationGeneration,c.credentialGeneration,c.status FROM codespaceResource r
      JOIN codespaceConnection c ON c.id=r.connectionId WHERE r.id=? AND r.userId=? AND r.connectionId=? AND r.provider=?`,
      )
      .get(input.resourceId, input.userId, input.connectionId, CODESPACE_PROVIDER_LOCAL) as
      | {
          generation: number;
          state: string;
          repositoryId: string;
          repositoryFullName: string;
          authorizationGeneration: number;
          credentialGeneration: number;
          status: string;
        }
      | undefined;
    if (
      !binding ||
      binding.deviceId !== input.deviceId ||
      binding.deviceGeneration !== input.deviceGeneration ||
      !resource ||
      resource.generation !== input.resourceGeneration ||
      resource.authorizationGeneration !== resource.credentialGeneration ||
      resource.status !== "connected" ||
      resource.state === "deleted" ||
      resource.state === "rejected" ||
      !policy.repositories.some(
        (repo) =>
          repo.id === binding.repositoryId &&
          resource.repositoryId === localRepositoryTargetId(input.deviceId, repo.id) &&
          resource.repositoryFullName.toLowerCase() === repo.fullName.toLowerCase(),
      ) ||
      policy.machine.name !== binding.profileId
    )
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Relay resource authority changed.");
    if (input.deadlineAt <= now || input.deadlineAt > policy.leaseUntil)
      throw new LocalDeviceError("LOCAL_EXPIRED", "Relay work lease expired.");
  }
  private requireLease(policy: LocalPublicPolicy, now: number): void {
    if (
      !policy.enabled ||
      policy.leaseUntil <= now ||
      policy.leaseUntil > now + MAX_LOCAL_WORK_LEASE_MS
    )
      throw new LocalDeviceError("LOCAL_EXPIRED", "Renew the device work lease locally.");
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
  private relay(id: string): RelayRow | undefined {
    return this.sqlite.prepare("SELECT * FROM codespaceLocalRelay WHERE requestId=?").get(id) as
      RelayRow | undefined;
  }
  private syncConnection(connectionId: string, now: number): void {
    const devices = this.sqlite
      .prepare("SELECT * FROM codespaceLocalDevice WHERE connectionId=? AND status='active'")
      .all(connectionId) as DeviceRow[];
    this.sqlite
      .prepare("DELETE FROM codespaceConnectionRepository WHERE connectionId=?")
      .run(connectionId);
    for (const device of devices)
      for (const repo of localPublicPolicySchema.parse(JSON.parse(device.policy)).repositories)
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO codespaceConnectionRepository(connectionId,externalInstallationId,externalRepositoryId,fullName,private,createdAt)
        VALUES(?,?,?,?,?,?)`,
          )
          .run(
            connectionId,
            device.id,
            localRepositoryTargetId(device.id, repo.id),
            repo.fullName,
            repo.private ? 1 : 0,
            now,
          );
    this.sqlite
      .prepare(
        "UPDATE codespaceConnection SET status=?,grantsRefreshedAt=?,grantsVersion=grantsVersion+1,updatedAt=? WHERE id=?",
      )
      .run(devices.length ? "connected" : "disconnected", now, now, connectionId);
  }
}
