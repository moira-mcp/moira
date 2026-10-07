import { z } from "zod";
import { LocalManager } from "./manager.js";
import { LocalJobs } from "./jobs.js";
import { RequestJournal } from "./journal.js";
import { LocalRefusal, LOCAL_PROTOCOL_VERSION } from "./policy.js";
import {
  localManagementOutcomeSchema,
  type LocalManagementOutcome,
} from "../../shared/src/codespaces/local-protocol.js";

const spaceId = z.string().uuid();
export const localRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("snapshot"), spaceId: spaceId.optional() }).strict(),
  z
    .object({
      action: z.literal("create"),
      repositoryId: z.string().uuid(),
      ref: z.string().max(255),
      operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
    })
    .strict(),
  z.object({ action: z.literal("start"), spaceId }).strict(),
  z
    .object({
      action: z.literal("stop"),
      spaceId,
      generation: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("delete"), spaceId, generation: z.number().int().positive() })
    .strict(),
  z.object({ action: z.literal("operation"), spaceId, job: z.unknown() }).strict(),
]);
export const localEnvelopeSchema = z
  .object({
    version: z.literal(LOCAL_PROTOCOL_VERSION),
    id: z.string().uuid(),
    expiresAt: z.number().int().positive(),
    request: localRequestSchema,
  })
  .strict();
export type LocalRequest = z.infer<typeof localRequestSchema>;
export type LocalReply =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; management?: LocalManagementOutcome } };

export class LocalRpc {
  readonly journal: RequestJournal;
  readonly jobs: LocalJobs;
  constructor(readonly manager: LocalManager) {
    this.journal = new RequestJournal(manager.records.state, manager.now);
    this.jobs = new LocalJobs(manager);
  }

  async handle(value: unknown, onAdmitted?: () => void): Promise<LocalReply> {
    try {
      const message = localEnvelopeSchema.parse(value);
      return (await this.journal.run(message.id, message.expiresAt, message.request, async () => {
        try {
          return { ok: true, result: await this.dispatch(message.request, onAdmitted) };
        } catch (error) {
          return this.failure(error);
        }
      })) as LocalReply;
    } catch (error) {
      return this.failure(error);
    }
  }

  /** Only a retained journal outcome can answer this path; it never dispatches an effect. */
  async replay(value: unknown): Promise<LocalReply> {
    try {
      const message = localEnvelopeSchema.parse(value);
      return (await this.journal.run(message.id, message.expiresAt, message.request, async () => {
        throw new LocalRefusal(
          "LOCAL_OUTCOME_UNKNOWN",
          "The retained request cannot dispatch new work.",
        );
      })) as LocalReply;
    } catch (error) {
      return this.failure(error);
    }
  }

  failure(error: unknown): LocalReply {
    return {
      ok: false,
      error:
        error instanceof LocalRefusal
          ? {
              code: error.code,
              message: error.message,
              ...(error.management ? { management: error.management } : {}),
            }
          : {
              code: error instanceof z.ZodError ? "LOCAL_REQUEST_INVALID" : "LOCAL_INTERNAL_ERROR",
              message: "Local request was refused; inspect the companion on this computer.",
            },
    };
  }

  private async dispatch(request: LocalRequest, onAdmitted?: () => void): Promise<unknown> {
    switch (request.action) {
      case "snapshot":
        return this.manager.snapshot(request.spaceId);
      case "create": {
        const space = await this.manager.create(
          request.repositoryId,
          request.ref,
          request.operationMarker,
          onAdmitted,
        );
        return { spaceId: space.id };
      }
      case "start":
        await this.manager.start(request.spaceId, onAdmitted);
        return { accepted: true };
      case "stop":
      case "delete": {
        const before = await this.manager.records.get(request.spaceId);
        if (
          request.action === "stop" &&
          request.generation !== undefined &&
          before?.generation !== request.generation
        )
          throw new LocalRefusal(
            "LOCAL_GENERATION_CONFLICT",
            "The exact local stop generation changed.",
          );
        let stopped;
        if (request.action === "stop")
          stopped = await this.manager.stop(request.spaceId, request.generation);
        else {
          await this.manager.remove(request.spaceId, request.generation);
          stopped = await this.manager.records.get(request.spaceId);
        }
        const management =
          before &&
          stopped &&
          stopped.generation > before.generation &&
          stopped.id === before.id &&
          stopped.repositoryId === before.repositoryId &&
          stopped.operationMarker === before.operationMarker &&
          stopped.name === before.name &&
          stopped.runtimeId === before.runtimeId &&
          stopped.desiredState === (request.action === "stop" ? "stopped" : "deleted") &&
          (request.action === "stop"
            ? ["stopped", "failed"].includes(stopped.phase)
            : stopped.phase === "deleted")
            ? localManagementOutcomeSchema.parse({
                spaceId: stopped.id,
                repositoryId: stopped.repositoryId,
                operationMarker: stopped.operationMarker,
                originGeneration: before.generation,
                generation: stopped.generation,
                action: request.action,
              })
            : undefined;
        return { accepted: true, ...(management ? { management } : {}) };
      }
      case "operation":
        return this.jobs.dispatch(request.spaceId, request.job);
    }
  }
}
