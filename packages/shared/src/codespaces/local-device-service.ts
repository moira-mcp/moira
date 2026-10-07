import { randomBytes } from "node:crypto";
import { z } from "zod";
import { LocalDeviceRepository, digestLocalSecret } from "./local-device-repository.js";
import {
  localControlReportSchema,
  localControlRequestSchema,
  type LocalControlReport,
  type LocalRepositoryAdmissionReceipt,
} from "./local-management-types.js";
import {
  LocalDeviceError,
  localPublicPolicySchema,
  localRelayPayloadReferenceSchema,
  type LocalDeviceAuth,
  type LocalPublicPolicy,
  type LocalRelayAcknowledgement,
  type LocalRelayRequest,
  type LocalResourceBinding,
} from "./local-device-types.js";

const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const id = z.string().uuid();
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const localEnrollmentSchema = z
  .object({
    pairingId: id,
    pairingToken: secret,
    credential: secret,
    policy: localPublicPolicySchema,
  })
  .strict();
export const localAcknowledgementSchema = z
  .object({
    requestId: id,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    claimId: id,
    status: z.enum(["completed", "refused"]),
    outcomeReference: localRelayPayloadReferenceSchema,
  })
  .strict();
const relayRequestSchema = z
  .object({
    userId: z.string().min(1).max(128),
    deviceId: id,
    deviceGeneration: generation,
    connectionId: id,
    requestId: id,
    resourceId: id,
    resourceGeneration: generation,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    payloadReference: localRelayPayloadReferenceSchema,
    deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** Shared authority service used by Settings, outbound relay and the local provider. */
export class LocalDeviceService {
  constructor(
    readonly repository: LocalDeviceRepository,
    private readonly now: () => number = Date.now,
  ) {}
  listOwned(userId: string) {
    return this.repository.listOwned(userId, this.now());
  }
  beginEnrollment(userId: string) {
    const pairingToken = randomBytes(32).toString("base64url");
    return {
      ...this.repository.beginEnrollment(userId, digestLocalSecret(pairingToken), this.now()),
      pairingToken,
    };
  }
  approveLocalEnrollment(value: unknown) {
    const input = localEnrollmentSchema.parse(value);
    return this.repository.approveLocalEnrollment(
      {
        pairingId: input.pairingId,
        tokenDigest: digestLocalSecret(input.pairingToken),
        credentialDigest: digestLocalSecret(input.credential),
        policy: input.policy,
      },
      this.now(),
    );
  }
  pairingStatus(value: unknown) {
    const input = z.object({ pairingId: id, pairingToken: secret }).strict().parse(value);
    return this.repository.pairingStatus(
      input.pairingId,
      digestLocalSecret(input.pairingToken),
      this.now(),
    );
  }
  confirmEnrollment(userId: string, pairingId: string, expectedRevision: number) {
    return this.repository.confirmEnrollment(
      userId,
      id.parse(pairingId),
      generation.parse(expectedRevision),
      this.now(),
    );
  }
  authenticateDevice(credential: string): LocalDeviceAuth {
    if (!secret.safeParse(credential).success)
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device access denied.");
    return this.repository.authenticateDevice(digestLocalSecret(credential), this.now());
  }
  heartbeat(auth: LocalDeviceAuth, policy: LocalPublicPolicy, report?: LocalControlReport) {
    return this.repository.heartbeat(
      auth,
      localPublicPolicySchema.parse(policy),
      this.now(),
      report ? localControlReportSchema.parse(report) : undefined,
    );
  }
  requestSettings(userId: string, deviceId: string, value: unknown) {
    const input = localControlRequestSchema.parse(value);
    return this.repository.requestSettings(
      userId,
      id.parse(deviceId),
      input.expectedGeneration,
      input.expectedRevision,
      input.settings,
      this.now(),
    );
  }
  revokeOwned(userId: string, deviceId: string, expectedGeneration: number) {
    return this.repository.revokeOwned(
      userId,
      id.parse(deviceId),
      generation.parse(expectedGeneration),
      this.now(),
    );
  }
  requestRepositoryAdmission(
    userId: string,
    deviceId: string,
    input: Omit<
      LocalRepositoryAdmissionReceipt,
      "revision" | "connectionId" | "localRepositoryId"
    > & {
      expectedRevision: number;
    },
  ) {
    return this.repository.requestRepositoryAdmission(
      userId,
      id.parse(deviceId),
      input,
      this.now(),
    );
  }
  getActiveDevice(userId: string, deviceId: string) {
    return this.repository.getActiveDevice(userId, id.parse(deviceId));
  }
  authorizeGitHubOperation(
    auth: LocalDeviceAuth,
    resourceId: string,
    resourceGeneration: number,
    action: "fetch" | "push" | "pull_request",
  ) {
    return this.repository.authorizeGitHubOperation(
      auth,
      id.parse(resourceId),
      generation.parse(resourceGeneration),
      action,
      this.now(),
    );
  }
  authorizeOwnedGitHubOperation(
    userId: string,
    resourceId: string,
    action: "fetch" | "push" | "pull_request",
  ) {
    return this.repository.authorizeOwnedGitHubOperation(
      userId,
      id.parse(resourceId),
      action,
      this.now(),
    );
  }
  bindResource(binding: LocalResourceBinding) {
    return this.repository.bindResource(binding, this.now());
  }
  getBinding(userId: string, resourceId: string) {
    return this.repository.getBinding(userId, resourceId);
  }
  enqueue(request: LocalRelayRequest) {
    const input = relayRequestSchema.parse(request) as LocalRelayRequest;
    if (input.digest !== input.payloadReference.sha256)
      throw new LocalDeviceError("LOCAL_INVALID", "Payload digest differs from relay identity.");
    return this.repository.enqueue(input, this.now());
  }
  claim(auth: LocalDeviceAuth, limit = 1) {
    return this.repository.claim(auth, z.number().int().min(1).max(8).parse(limit), this.now());
  }
  acknowledge(auth: LocalDeviceAuth, ack: LocalRelayAcknowledgement) {
    return this.repository.acknowledge(
      auth,
      localAcknowledgementSchema.parse(ack) as LocalRelayAcknowledgement,
      this.now(),
    );
  }
  getResult(userId: string, requestId: string) {
    return this.repository.getResult(userId, requestId);
  }
  getRequest(userId: string, requestId: string) {
    return this.repository.getRequest(userId, requestId);
  }
  authorizePayload(auth: LocalDeviceAuth, requestId: string, claimId: string) {
    return this.repository.authorizePayload(
      auth,
      id.parse(requestId),
      id.parse(claimId),
      this.now(),
    );
  }
  registerOutputPart(
    auth: LocalDeviceAuth,
    requestId: string,
    claimId: string,
    part: LocalRelayRequest["payloadReference"]["parts"][number],
  ) {
    return this.repository.registerOutputPart(
      auth,
      id.parse(requestId),
      id.parse(claimId),
      part,
      this.now(),
    );
  }
  renewClaim(auth: LocalDeviceAuth, requestId: string, claimId: string) {
    return this.repository.renewClaim(auth, id.parse(requestId), id.parse(claimId), this.now());
  }
  authorizeOutput(auth: LocalDeviceAuth, ack: LocalRelayAcknowledgement) {
    return this.repository.authorizeOutput(
      auth,
      localAcknowledgementSchema.parse(ack) as LocalRelayAcknowledgement,
      this.now(),
    );
  }
}
