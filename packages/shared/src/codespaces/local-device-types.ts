import { z } from "zod";
import type { CodespaceMachine } from "./resource-types.js";
import type { LocalDeviceControlView } from "./local-management-types.js";
import type { LocalLifecycleEnvelope, LocalLifecycleReply } from "./local-protocol.js";

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
    repositories: z.array(
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
          allowPullRequests: z.boolean().optional(),
        })
        .strict(),
    ),
    machine: z
      .object({
        name: z.literal("local-approved"),
        displayName: safeLabel,
        operatingSystem: z.literal("linux"),
        cpuCores: z.number().int().positive().safe(),
        memoryBytes: z.number().int().positive().safe(),
        storageBytes: z.number().int().positive().safe(),
      })
      .strict(),
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
  control?: LocalDeviceControlView;
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
export type LocalRelayStatus =
  "queued" | "claimed" | "completed" | "refused" | "expired" | "revoked";
export interface LocalRelayRequest extends LocalDeviceAuth {
  authority?: "owner-delete";
  requestId: string;
  resourceId: string;
  resourceGeneration: number;
  digest: string;
  payload: LocalLifecycleEnvelope;
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
  outcome: LocalLifecycleReply | null;
}
export interface LocalRelayAcknowledgement {
  requestId: string;
  digest: string;
  claimId: string;
  status: "completed" | "refused";
  outcome: LocalLifecycleReply;
}
export interface LocalApprovedRepository {
  id: string;
  fullName: string;
  private: boolean;
  machine: CodespaceMachine;
}
export class LocalDeviceError extends Error {
  constructor(
    readonly code: "LOCAL_UNAUTHORIZED" | "LOCAL_CONFLICT" | "LOCAL_EXPIRED" | "LOCAL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "LocalDeviceError";
  }
}
