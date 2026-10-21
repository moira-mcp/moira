import { z } from "zod";
import { WORKSPACE_REQUEST_ID_PATTERN } from "./workspace-request-id.js";
import { canonicalJson } from "../utils/canonical-json.js";
import { LocalDeviceError, type LocalDeviceAuth } from "./local-device-types.js";

const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        [...value].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      "Control characters are not permitted",
    );
export const localGitAuthorSchema = z
  .object({
    name: text(200),
    email: z.string().trim().email().max(254),
  })
  .strict();
export type LocalGitAuthor = z.infer<typeof localGitAuthorSchema>;
export const agentRepositoryManagementSchema = z
  .object({
    githubUserId: z.string().regex(/^[1-9][0-9]*$/),
    owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
    allowExistingPrivate: z.boolean(),
    allowNewPrivate: z.boolean(),
    allowPush: z.boolean(),
  })
  .strict();
export type AgentRepositoryManagement = z.infer<typeof agentRepositoryManagementSchema>;
export const localManagementRepositorySchema = z
  .object({
    id: z.string().uuid(),
    fullName: z
      .string()
      .max(201)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
      .refine((value) => !value.endsWith(".git")),
    private: z.boolean(),
    allowPush: z.boolean(),
    allowDelete: z.boolean(),
    allowPullRequests: z.boolean().optional(),
  })
  .strict();
export const localDeviceSettingsSchema = z
  .object({
    label: text(80),
    enabled: z.boolean(),
    cpuCores: integer(1, Number.MAX_SAFE_INTEGER),
    memoryBytes: integer(1, Number.MAX_SAFE_INTEGER),
    storageBytes: integer(1, Number.MAX_SAFE_INTEGER),
    dockerBytes: integer(1, Number.MAX_SAFE_INTEGER),
    repositories: z.array(localManagementRepositorySchema),
    gitAuthor: localGitAuthorSchema.nullable(),
    agentRepositoryManagement: agentRepositoryManagementSchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dockerBytes >= value.storageBytes)
      ctx.addIssue({ code: "custom", message: "Storage must also hold the guest root filesystem" });
    if (
      new Set(value.repositories.map((r) => r.id)).size !== value.repositories.length ||
      new Set(value.repositories.map((r) => r.fullName.toLowerCase())).size !==
        value.repositories.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate repository grants" });
  });
export type LocalDeviceSettingsValue = z.infer<typeof localDeviceSettingsSchema>;
export const localControlCeilingSchema = z
  .object({
    cpuCores: integer(1, Number.MAX_SAFE_INTEGER),
    memoryBytes: integer(1, Number.MAX_SAFE_INTEGER),
    storageBytes: integer(1, Number.MAX_SAFE_INTEGER),
    dockerBytes: integer(1, Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type LocalControlCeiling = z.infer<typeof localControlCeilingSchema>;
export const localControlErrorSchema = z
  .object({ code: z.string().regex(/^LOCAL_[A-Z0-9_]{1,80}$/), message: text(500) })
  .strict();
export const localRepositoryAdmissionReceiptSchema = z
  .object({
    requestId: z.string().uuid(),
    githubRepositoryId: z.string().regex(/^[1-9][0-9]*$/),
    localRepositoryId: z.string().uuid(),
    revision: integer(1, Number.MAX_SAFE_INTEGER),
    deviceGeneration: integer(1, Number.MAX_SAFE_INTEGER),
    connectionId: z.string().uuid(),
    repository: localManagementRepositorySchema,
    creationRequestId: z.string().uuid().optional(),
  })
  .strict();
export type LocalRepositoryAdmissionReceipt = z.infer<typeof localRepositoryAdmissionReceiptSchema>;

/** Prove an original applied admission without treating its historical policy as current. */
export function repositoryAdmissionProof(
  value: unknown,
  expected: {
    userId: string;
    deviceId: string;
    connectionId: string;
    deviceGeneration?: number;
    requestId: string;
    creationRequestId?: string;
    githubRepositoryId?: string;
  },
): {
  receipt: LocalRepositoryAdmissionReceipt;
  repository: z.infer<typeof localManagementRepositorySchema>;
  identity: LocalDeviceAuth;
} {
  const original = z
    .object({
      userId: z.literal(expected.userId),
      deviceId: z.literal(expected.deviceId),
      deviceGeneration: z.number().int().positive().safe(),
      connectionId: z.literal(expected.connectionId),
      ownerConnectionId: z.literal(expected.connectionId),
      local: z.object({
        state: z.literal("configured"),
        control: z.object({
          status: z.literal("applied"),
          appliedRevision: z.number().int().positive().safe(),
          repositoryAdmissions: z.array(localRepositoryAdmissionReceiptSchema),
        }),
        policy: z.object({ repositories: z.array(localManagementRepositorySchema) }),
      }),
    })
    .parse(value);
  const matching = original.local.control.repositoryAdmissions.filter(
    (receipt) => receipt.requestId === expected.requestId,
  );
  const receipt = matching[0];
  const repositories = original.local.policy.repositories.filter(
    (repository) => repository.id === receipt?.localRepositoryId,
  );
  const repository = repositories[0];
  if (
    matching.length !== 1 ||
    repositories.length !== 1 ||
    !receipt ||
    !repository ||
    (expected.deviceGeneration !== undefined &&
      original.deviceGeneration !== expected.deviceGeneration) ||
    receipt.deviceGeneration !== original.deviceGeneration ||
    receipt.connectionId !== original.connectionId ||
    receipt.creationRequestId !== expected.creationRequestId ||
    (expected.githubRepositoryId !== undefined &&
      receipt.githubRepositoryId !== expected.githubRepositoryId) ||
    original.local.control.appliedRevision < receipt.revision ||
    receipt.repository.id !== receipt.localRepositoryId ||
    canonicalJson(repository) !== canonicalJson(receipt.repository)
  )
    throw new LocalDeviceError(
      "LOCAL_CONFLICT",
      "The original repository admission is not confirmed.",
    );
  return {
    receipt,
    repository,
    identity: {
      userId: original.userId,
      deviceId: original.deviceId,
      deviceGeneration: original.deviceGeneration,
      connectionId: original.connectionId,
    },
  };
}
export const localDeviceControlViewSchema = z
  .object({
    optedIn: z.boolean(),
    revision: integer(0, Number.MAX_SAFE_INTEGER),
    appliedRevision: integer(0, Number.MAX_SAFE_INTEGER),
    status: z.enum(["not-enabled", "applied", "pending", "rejected"]),
    settings: localDeviceSettingsSchema,
    ceiling: localControlCeilingSchema.nullable(),
    error: localControlErrorSchema.nullable(),
    repositoryAdmissions: z.array(localRepositoryAdmissionReceiptSchema).optional(),
    appliedAgentRepositoryManagement: agentRepositoryManagementSchema.nullable().optional(),
    pendingRequestId: z.string().regex(WORKSPACE_REQUEST_ID_PATTERN).optional(),
  })
  .strict();
export type LocalDeviceControlView = z.infer<typeof localDeviceControlViewSchema>;
export const localControlRequestSchema = z
  .object({
    requestId: z.string().regex(WORKSPACE_REQUEST_ID_PATTERN),
    expectedRevision: integer(0, Number.MAX_SAFE_INTEGER),
    expectedGeneration: integer(1, Number.MAX_SAFE_INTEGER),
    settings: localDeviceSettingsSchema,
  })
  .strict();
export const localControlReportSchema = z
  .object({
    ceiling: localControlCeilingSchema,
    settings: localDeviceSettingsSchema,
    appliedRevision: integer(0, Number.MAX_SAFE_INTEGER),
    rejectedRevision: integer(1, Number.MAX_SAFE_INTEGER).optional(),
    error: localControlErrorSchema.optional(),
  })
  .strict();
export type LocalControlReport = z.infer<typeof localControlReportSchema>;

/** A delegated addition cannot replace a grant or supply its own network authority. */
export function assertAgentRepositoryAdmission(
  delegation: AgentRepositoryManagement | null | undefined,
  repository: z.infer<typeof localManagementRepositorySchema>,
  origin: "existing" | "created" = "existing",
): void {
  if (
    !delegation ||
    !(origin === "created" ? delegation.allowNewPrivate : delegation.allowExistingPrivate) ||
    !repository.private ||
    repository.fullName.split("/")[0].toLowerCase() !== delegation.owner.toLowerCase() ||
    repository.allowPush !== delegation.allowPush ||
    repository.allowDelete ||
    repository.allowPullRequests === true
  )
    throw new Error("Repository addition exceeds the applied agent delegation.");
}

/** Classify physical interruption, independently of who may change repository authority. */
export function isLiveLocalSettingsChange(
  previous: LocalDeviceSettingsValue,
  next: LocalDeviceSettingsValue,
): boolean {
  return previous.enabled === next.enabled && previous.storageBytes === next.storageBytes;
}

/** The local opt-in and server save use the same approved resource bounds. */
export function assertLocalControlSettings(
  settings: LocalDeviceSettingsValue,
  ceiling: LocalControlCeiling,
): void {
  for (const key of Object.keys(ceiling) as (keyof LocalControlCeiling)[]) {
    if (settings[key] > ceiling[key]) throw new Error(`Local control ceiling exceeded: ${key}`);
  }
}
