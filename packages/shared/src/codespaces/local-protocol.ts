import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "../utils/canonical-json.js";

/** The existing durable dispatch identity, shared by enqueue and pending-intent recovery. */
export function localRelayMutationId(
  resource: { id: string; generation: number },
  request: Record<string, unknown>,
  authority?: "owner-delete",
): string {
  const hex = createHash("sha256")
    .update(
      canonicalJson({
        protocol: "workspace-lifecycle/2",
        resourceId: resource.id,
        generation: resource.generation,
        request,
        ...(authority ? { authority } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export const LOCAL_WORKER_REQUEST_TIMEOUT_MS = 30_000;
export const LOCAL_REQUEST_MAX_WINDOW_MS = 15 * 60_000;
/** Result-only replay does not extend an envelope's permission to launch work. */
export const LOCAL_RESULT_SETTLEMENT_RETENTION_MS = 60 * 60_000;

const uuid = z.string().uuid();
const generation = z.number().int().positive();
const marker = z.string().regex(/^moira-[a-f0-9]{24}$/);

/** Management can close admission while the physical outcome remains unknown. */
export const localManagementOutcomeSchema = z
  .object({
    spaceId: uuid,
    repositoryId: uuid,
    operationMarker: marker,
    originGeneration: generation,
    generation,
    action: z.enum(["stop", "delete"]),
  })
  .strict()
  .refine((outcome) => outcome.generation > outcome.originGeneration);
export type LocalManagementOutcome = z.infer<typeof localManagementOutcomeSchema>;

export const localLifecycleRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("snapshot"), spaceId: uuid.optional() }).strict(),
  z
    .object({
      action: z.literal("create"),
      repositoryId: uuid,
      ref: z.string().max(255),
      operationMarker: marker,
    })
    .strict(),
  z
    .object({
      action: z.literal("start"),
      spaceId: uuid,
      workspaceReleases: z
        .object({
          x64: z.string().regex(/^[a-f0-9]{64}$/),
          arm64: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("stop"), spaceId: uuid, generation: generation.optional() })
    .strict(),
  z.object({ action: z.literal("delete"), spaceId: uuid, generation }).strict(),
]);
export const localLifecycleEnvelopeSchema = z
  .object({
    version: z.literal(1),
    id: uuid,
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    authority: z.literal("owner-delete").optional(),
    request: localLifecycleRequestSchema,
  })
  .strict()
  .refine((value) => !value.authority || ["snapshot", "delete"].includes(value.request.action));
export const localLifecycleReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.string().regex(/^LOCAL_[A-Z0-9_]{1,80}$/),
          message: z.string().max(500),
          management: localManagementOutcomeSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type LocalLifecycleEnvelope = z.infer<typeof localLifecycleEnvelopeSchema>;
export type LocalLifecycleReply = z.infer<typeof localLifecycleReplySchema>;

export const localResourceSnapshotSchema = z
  .object({
    deviceId: uuid,
    creation: z.discriminatedUnion("state", [
      z.object({ state: z.literal("manifest"), spaceId: uuid }).strict(),
      z.object({ state: z.literal("absent") }).strict(),
    ]),
    spaces: z.array(
      z
        .object({
          id: uuid,
          repositoryId: uuid,
          operationMarker: marker,
          generation,
          createdAt: z.number().int().nonnegative(),
          lastStartedAt: z.number().int().nonnegative().nullable(),
          state: z.enum([
            "running",
            "stopped",
            "starting",
            "stopping",
            "created",
            "error",
            "unknown",
            "absent",
          ]),
          phase: z.string().max(80),
          failure: z.string().max(160).nullable(),
          nativeStopConfirmed: z.boolean(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
