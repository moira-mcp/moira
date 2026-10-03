import { z } from "zod";
import { LocalManager } from "./manager.js";
import { LocalJobs } from "./jobs.js";
import { RequestJournal } from "./journal.js";
import { LocalRefusal, LOCAL_PROTOCOL_VERSION } from "./policy.js";

const spaceId = z.string().uuid();
export const localRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("snapshot") }).strict(),
  z
    .object({
      action: z.literal("create"),
      repositoryId: z.string().uuid(),
      ref: z.string().max(255),
      operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
    })
    .strict(),
  z.object({ action: z.literal("start"), spaceId }).strict(),
  z.object({ action: z.literal("stop"), spaceId }).strict(),
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
  { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

export class LocalRpc {
  readonly journal: RequestJournal;
  readonly jobs: LocalJobs;
  constructor(readonly manager: LocalManager) {
    this.journal = new RequestJournal(manager.records.state, manager.now);
    this.jobs = new LocalJobs(manager);
  }

  async handle(value: unknown): Promise<LocalReply> {
    try {
      const message = localEnvelopeSchema.parse(value);
      return (await this.journal.run(message.id, message.expiresAt, message.request, async () => {
        try {
          return { ok: true, result: await this.dispatch(message.request) };
        } catch (error) {
          return this.failure(error);
        }
      })) as LocalReply;
    } catch (error) {
      return this.failure(error);
    }
  }

  private failure(error: unknown): LocalReply {
    return {
      ok: false,
      error:
        error instanceof LocalRefusal
          ? { code: error.code, message: error.message }
          : {
              code: error instanceof z.ZodError ? "LOCAL_REQUEST_INVALID" : "LOCAL_INTERNAL_ERROR",
              message: "Local request was refused; inspect the companion on this computer.",
            },
    };
  }

  private async dispatch(request: LocalRequest): Promise<unknown> {
    switch (request.action) {
      case "snapshot":
        return this.manager.snapshot();
      case "create": {
        const space = await this.manager.create(
          request.repositoryId,
          request.ref,
          request.operationMarker,
        );
        return { spaceId: space.id };
      }
      case "start":
        await this.manager.start(request.spaceId);
        return { accepted: true };
      case "stop":
        await this.manager.stop(request.spaceId);
        return { accepted: true };
      case "delete":
        await this.manager.remove(request.spaceId, request.generation);
        return { accepted: true };
      case "operation":
        return this.jobs.dispatch(request.spaceId, request.job);
    }
  }
}
