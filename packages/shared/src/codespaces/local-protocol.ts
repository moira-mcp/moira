import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "../utils/canonical-json.js";

/** The existing durable dispatch identity, shared by enqueue and pending-intent recovery. */
export function localRelayMutationId(
  resource: { id: string; generation: number },
  request: Record<string, unknown>,
  authority?: "owner-delete",
): string {
  const job =
    request.action === "operation" && typeof request.job === "object" && request.job !== null
      ? (request.job as Record<string, unknown>)
      : null;
  const identity = job
    ? {
        action: "operation",
        spaceId: request.spaceId,
        job: { action: job.action, remoteMarker: job.remoteMarker },
      }
    : request;
  const hex = createHash("sha256")
    .update(
      canonicalJson({
        resourceId: resource.id,
        ...(request.action === "operation" ? {} : { generation: resource.generation }),
        request: identity,
        ...(authority ? { authority } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export const LOCAL_WORKER_REQUEST_TIMEOUT_MS = 30_000;
export const LOCAL_REQUEST_MAX_WINDOW_MS = 15 * 60_000;

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
