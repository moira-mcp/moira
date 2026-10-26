import { z } from "zod";
import { localMachineSchema } from "./local-device-types.js";
import { localSetupContextSchema } from "./local-setup-types.js";
export { localSetupContextSchema, type LocalSetupContext } from "./local-setup-types.js";

const uuid = z.string().uuid();
const generation = z.number().int().positive();
const marker = z.string().regex(/^moira-[a-f0-9]{24}$/);

/** Last observed guest transport health; independent of local Unix readiness. */
export const workspaceRemoteObservationSchema = z
  .object({
    state: z.enum([
      "unconfigured",
      "enrollment_unavailable",
      "connecting",
      "connected",
      "unavailable",
      "refused",
    ]),
  })
  .strict();
export type WorkspaceRemoteObservation = z.infer<typeof workspaceRemoteObservationSchema>;

export const workspaceSetupFailureSchema = z.enum([
  "repository_unproven",
  "prerequisite_unavailable",
  "repository_checkout_failed",
  "configuration_failed",
]);
export type WorkspaceSetupFailure = z.infer<typeof workspaceSetupFailureSchema>;

export const localSetupDiagnosticSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/),
    outcome: z.enum(["unavailable", "refused", "unconfirmed"]),
  })
  .strict();
export type LocalSetupDiagnostic = z.infer<typeof localSetupDiagnosticSchema>;
export const localSetupAttemptSchema = localSetupContextSchema
  .extend({
    requestId: z
      .string()
      .regex(/^ws1-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    state: z.enum(["preparing", "completed", "unknown"]),
    diagnostic: localSetupDiagnosticSchema.optional(),
  })
  .strict();
export type LocalSetupAttempt = z.infer<typeof localSetupAttemptSchema>;
export const LOCAL_SETUP_HEADER = "x-moira-setup-attempt";

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
          remote: workspaceRemoteObservationSchema.optional(),
          setupFailure: workspaceSetupFailureSchema.optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
