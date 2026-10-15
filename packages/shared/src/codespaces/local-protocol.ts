import { z } from "zod";
import { localMachineSchema } from "./local-device-types.js";

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
          machine: localMachineSchema,
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
