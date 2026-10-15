import { z } from "zod";
import { WORKSPACE_REQUEST_ID_PATTERN } from "./workspace-request-id.js";
import {
  localDeviceSettingsSchema,
  localManagementRepositorySchema,
} from "./local-management-types.js";

export const controllerRequestIdSchema = z.string().regex(WORKSPACE_REQUEST_ID_PATTERN);
export const GITHUB_PROVIDER_REASON_MAX_LENGTH = 300;
const providerReply = {
  status: z.number().int().min(100).max(599),
  githubRequestId: z
    .string()
    .regex(/^[A-Fa-f0-9]+(?::[A-Fa-f0-9]+)*$/)
    .optional(),
  reason: z.string().max(GITHUB_PROVIDER_REASON_MAX_LENGTH).optional(),
};
export const providerReplySchema = z
  .object({ status: providerReply.status, githubRequestId: providerReply.githubRequestId })
  .strict();
export const providerObservationSchema = z
  .object({
    name: z.string().min(1),
    repositoryId: z.string().regex(/^[1-9][0-9]*$/),
    repositoryFullName: z.string().min(1),
    state: z.string().min(1),
  })
  .passthrough();
const providerIdentityObservation = providerObservationSchema
  .pick({ name: true, repositoryId: true, repositoryFullName: true })
  .extend({
    ownerId: z.string().regex(/^[1-9][0-9]*$/),
    billableOwnerId: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strip();
/** Safe evidence attached to the original owner receipt; it never authorizes a replay. */
export const providerFailureSchema = z.union([
  z
    .object({
      kind: z.literal("transport"),
      phase: z.literal("request"),
      cause: z.enum(["timeout", "request_failed"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("transport"),
      phase: z.literal("body"),
      cause: z.enum(["timeout", "request_failed"]),
      status: providerReply.status,
      githubRequestId: providerReply.githubRequestId,
    })
    .strict(),
  z.object({ kind: z.literal("http"), phase: z.literal("request"), ...providerReply }).strict(),
  z
    .object({
      kind: z.literal("reply_invalid"),
      phase: z.enum(["json", "projection"]),
      ...providerReply,
    })
    .strict(),
  z
    .object({
      kind: z.literal("authority_changed"),
      phase: z.literal("publication"),
      ...providerReply,
      resource: providerIdentityObservation.optional(),
    })
    .strict(),
]);
export type GitHubProviderFailure = z.infer<typeof providerFailureSchema>;
/** Exact provider refusals; timeout/acceptance/server failures remain uncertain. */
export function isConfirmedGitHubCreationRefusalStatus(status: number): boolean {
  return [400, 401, 402, 403, 404, 409, 422, 429].includes(status);
}
export const controllerIdentitySchema = z.object({
  userId: z.string().min(1),
  deviceId: z.string().uuid(),
  deviceGeneration: z.number().int().positive(),
  connectionId: z.string().uuid(),
});
export type ControllerIdentity = z.infer<typeof controllerIdentitySchema>;

const generation = z.number().int().positive();
export const controllerLifecycleSchema = z.discriminatedUnion("action", [
  z
    .object({
      requestId: controllerRequestIdSchema,
      expectedGeneration: generation,
      action: z.literal("create"),
      repositoryId: z.string().uuid(),
      ref: z.string().min(1).max(255),
      operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
    })
    .strict(),
  z
    .object({
      requestId: controllerRequestIdSchema,
      expectedGeneration: generation,
      action: z.literal("start"),
    })
    .strict(),
  z
    .object({
      requestId: controllerRequestIdSchema,
      expectedGeneration: generation,
      action: z.literal("stop"),
    })
    .strict(),
  z
    .object({
      requestId: controllerRequestIdSchema,
      expectedGeneration: generation,
      action: z.literal("delete"),
      ownerConfirmed: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      requestId: controllerRequestIdSchema,
      expectedGeneration: generation,
      action: z.literal("snapshot"),
    })
    .strict(),
]);
export type ControllerLifecycle = z.infer<typeof controllerLifecycleSchema>;
export const controllerSettingsSchema = z
  .object({
    requestId: controllerRequestIdSchema,
    expectedGeneration: generation,
    expectedRevision: z.number().int().nonnegative(),
    settings: localDeviceSettingsSchema,
  })
  .strict();
export type ControllerSettings = z.infer<typeof controllerSettingsSchema>;
export const controllerResourceRegistrationSchema = z
  .object({
    resourceId: z.string().uuid(),
    repositoryId: z.string().uuid(),
    resourceGeneration: z.literal(1),
    operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
    ref: z.string().min(1).max(255),
  })
  .strict();
export type ControllerResourceRegistration = z.infer<typeof controllerResourceRegistrationSchema>;
export const controllerRepositorySchema = z
  .object({
    requestId: controllerRequestIdSchema,
    githubRepositoryId: z.string().regex(/^[1-9][0-9]*$/),
    deviceGeneration: generation,
    expectedRevision: z.number().int().nonnegative(),
    repository: localManagementRepositorySchema,
    creationRequestId: z.string().uuid().optional(),
  })
  .strict();

export const controllerOperationSchema = z
  .object({
    requestId: controllerRequestIdSchema,
    state: z.enum(["absent", "accepted", "completed", "unconfirmed"]),
    outcome: z
      .discriminatedUnion("ok", [
        z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
        z
          .object({
            ok: z.literal(false),
            error: z
              .object({
                code: z.string(),
                message: z.string(),
                securityRequestId: controllerRequestIdSchema.optional(),
                providerFailure: providerFailureSchema.optional(),
              })
              .strict(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export type ControllerOperation = z.infer<typeof controllerOperationSchema>;

/** Fixed GitHub lifecycle inputs are issued from a verified cloud assignment. */
const githubCreation = {
  repositoryId: z.string().regex(/^[1-9][0-9]*$/),
  repositoryFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ref: z.string().min(1).max(255),
  operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
  authorizationGeneration: generation,
  devcontainerPath: z.string().min(1).optional(),
};
const githubAction = {
  requestId: controllerRequestIdSchema,
  expectedGeneration: generation,
};
export const controllerGitHubLifecycleSchema = z.discriminatedUnion("action", [
  z.object({ ...githubAction, ...githubCreation, action: z.literal("create") }).strict(),
  ...(["start", "stop", "adopt"] as const).map((action) =>
    z.object({ ...githubAction, action: z.literal(action) }).strict(),
  ),
  z
    .object({
      ...githubAction,
      action: z.literal("delete"),
      rebindPurpose: z.literal("retire").optional(),
    })
    .strict(),
]);
export type ControllerGitHubLifecycle = z.infer<typeof controllerGitHubLifecycleSchema>;

export const githubProviderActionSchema = z
  .object({
    requestId: controllerRequestIdSchema,
    resourceGeneration: generation,
    action: z.enum(["create", "get", "start", "stop", "delete"]),
  })
  .strict();
export type GitHubProviderAction = z.infer<typeof githubProviderActionSchema>;

export const githubProvisionProofSchema = z
  .object({
    requestId: controllerRequestIdSchema,
    resourceGeneration: generation,
    authorizationGeneration: generation,
    providerResourceName: z.string().min(1),
    repositoryId: z.string().regex(/^[1-9][0-9]*$/),
    repositoryFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    environmentIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    root: z.string().startsWith("/"),
    rootDevice: z.string().regex(/^[0-9]+$/),
    rootInode: z.string().regex(/^[0-9]+$/),
    release: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type GitHubProvisionProof = z.infer<typeof githubProvisionProofSchema>;

export const githubControllerResourceSchema = z
  .object({
    resourceId: z.string().uuid(),
    resourceGeneration: generation,
    authorizationGeneration: generation,
    repositoryId: z.string().regex(/^[1-9][0-9]*$/),
    repositoryFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    requestedRef: z.string().min(1),
    devcontainerPath: z.string().min(1).optional(),
    operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
    providerResourceName: z.string().min(1).nullable(),
    retirement: z.enum(["uncreated", "unknown", "owned", "retired"]),
    state: z.enum([
      "unknown",
      "creating",
      "provisioning",
      "running",
      "stopped",
      "deleted",
      "failed",
    ]),
    desiredState: z.enum(["running", "stopped", "deleted"]),
    environmentIdentity: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    pendingRequestIds: z.array(controllerRequestIdSchema),
    observedAt: z.number().int().nonnegative().safe().nullable(),
    providerResource: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type GitHubControllerResource = z.infer<typeof githubControllerResourceSchema>;

export const githubResourceAuthoritySchema = z
  .object({
    requestId: controllerRequestIdSchema,
    resourceGeneration: generation,
    authorizationGeneration: generation,
    providerResourceName: z.string().min(1).nullable(),
    retirement: z.enum(["uncreated", "unknown", "owned", "retired"]),
    rebindPurpose: z.enum(["adopt", "retire"]).optional(),
  })
  .strict();
export type GitHubResourceAuthority = z.infer<typeof githubResourceAuthoritySchema>;

export const workspaceBootstrapCredentialSchema = z
  .object({
    version: z.literal(1),
    origin: z.string().url(),
    publicOrigin: z.string().url(),
    resourceId: z.string().uuid(),
    resourceGeneration: generation,
    authorizationGeneration: generation,
    environmentIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    renewal: z
      .object({ credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .optional(),
  })
  .strict();
export type WorkspaceBootstrapCredential = z.infer<typeof workspaceBootstrapCredentialSchema>;
export const githubRenewEnrollmentSchema = githubProvisionProofSchema
  .pick({
    requestId: true,
    environmentIdentity: true,
    root: true,
    rootDevice: true,
    rootInode: true,
    release: true,
  })
  .strict();
export type GitHubRenewEnrollment = z.infer<typeof githubRenewEnrollmentSchema>;
