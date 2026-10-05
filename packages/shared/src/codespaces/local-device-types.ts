import { z } from "zod";
import type { CodespaceMachine } from "./resource-types.js";

export const CODESPACE_PROVIDER_LOCAL = "local-sandboxes" as const;
const identifier = z.string().uuid();
export function localRepositoryTargetId(deviceId: string, repositoryId: string): string {
  return `local:${identifier.parse(deviceId)}:${identifier.parse(repositoryId)}`;
}
export function parseLocalRepositoryTargetId(value: string): {
  deviceId: string;
  repositoryId: string;
} {
  const [prefix, deviceId, repositoryId, extra] = value.split(":");
  if (prefix !== "local" || extra !== undefined) throw new Error("Invalid local repository target");
  return { deviceId: identifier.parse(deviceId), repositoryId: identifier.parse(repositoryId) };
}
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeLabel = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0)!;
        return code >= 32 && code !== 127;
      }),
    "Invalid device label",
  );
export const localPublicPolicySchema = z
  .object({
    version: z.literal(1),
    deviceId: identifier,
    label: safeLabel,
    enabled: z.boolean(),
    leaseUntil: integer,
    repositories: z
      .array(
        z
          .object({
            id: identifier,
            fullName: z
              .string()
              .max(201)
              .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
            private: z.boolean(),
            allowPush: z.boolean(),
            allowDelete: z.boolean(),
            domains: z
              .array(
                z
                  .string()
                  .max(253)
                  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
              )
              .max(64),
          })
          .strict(),
      )
      .max(64),
    machine: z
      .object({
        name: z.literal("local-approved"),
        displayName: safeLabel,
        operatingSystem: z.literal("linux"),
        cpuCores: z.number().int().min(1).max(32),
        memoryBytes: z
          .number()
          .int()
          .min(1024 ** 3)
          .max(64 * 1024 ** 3),
        storageBytes: z
          .number()
          .int()
          .min(4 * 1024 ** 3)
          .max(1024 ** 4),
      })
      .strict(),
    maxSandboxes: z.number().int().min(1).max(8),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (
      new Set(policy.repositories.map((r) => r.id)).size !== policy.repositories.length ||
      new Set(policy.repositories.map((r) => r.fullName.toLowerCase())).size !==
        policy.repositories.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate repository grant" });
  });
export type LocalPublicPolicy = z.infer<typeof localPublicPolicySchema>;
export interface LocalDeviceAuth {
  userId: string;
  deviceId: string;
  deviceGeneration: number;
  connectionId: string;
}
export interface LocalDeviceView extends LocalDeviceAuth {
  label: string;
  status: "pending" | "active" | "revoked";
  policy: LocalPublicPolicy;
  lastSeenAt: number | null;
  createdAt: number;
}
export interface LocalPairingView {
  id: string;
  revision: number;
  deviceId: string | null;
  state: "waiting_local" | "waiting_confirmation" | "confirmed" | "expired";
  expiresAt: number;
}
export interface LocalResourceBinding extends LocalDeviceAuth {
  resourceId: string;
  repositoryId: string;
  profileId: string;
}
const localRelayPartSchema = z
  .object({ transferId: identifier, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: integer })
  .strict();
export const localRelayPayloadReferenceSchema = z
  .object({
    parts: z.array(localRelayPartSchema).min(1).max(32),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: integer.max(24 * 1024 * 1024),
  })
  .strict()
  .refine(
    (ref) =>
      ref.parts.reduce((sum, part) => sum + part.size, 0) === ref.size &&
      new Set(ref.parts.map((part) => part.transferId)).size === ref.parts.length,
    "Invalid payload parts",
  );
export type LocalRelayPayloadReference = z.infer<typeof localRelayPayloadReferenceSchema>;
export type LocalRelayStatus =
  "queued" | "claimed" | "completed" | "refused" | "expired" | "revoked";
export interface LocalRelayRequest extends LocalDeviceAuth {
  requestId: string;
  resourceId: string;
  resourceGeneration: number;
  digest: string;
  payloadReference: LocalRelayPayloadReference;
  deadlineAt: number;
}
export interface LocalRelayClaim extends LocalRelayRequest {
  claimId: string;
  claimExpiresAt: number;
}
export interface LocalRelayResult {
  requestId: string;
  digest: string;
  status: LocalRelayStatus;
  outcomeReference: LocalRelayPayloadReference | null;
}
export interface LocalRelayAcknowledgement {
  requestId: string;
  digest: string;
  claimId: string;
  status: "completed" | "refused";
  outcomeReference: LocalRelayPayloadReference;
}
export interface LocalApprovedRepository {
  id: string;
  fullName: string;
  private: boolean;
  machine: CodespaceMachine;
}
export class LocalDeviceError extends Error {
  constructor(
    readonly code:
      | "LOCAL_UNAUTHORIZED"
      | "LOCAL_CONFLICT"
      | "LOCAL_EXPIRED"
      | "LOCAL_CAPACITY"
      | "LOCAL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "LocalDeviceError";
  }
}
