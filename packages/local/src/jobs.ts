import { createHash } from "node:crypto";
import { z } from "zod";
import { LocalManager } from "./manager.js";
import { LocalRefusal, MAX_MESSAGE_BYTES, requireLocalGrant } from "./policy.js";

const requestSchema = z
  .object({
    version: z.literal(1),
    action: z.enum([
      "execute",
      "inspect",
      "cancel",
      "finalize",
      "output",
      "file-execute",
      "file-inspect",
    ]),
    remoteMarker: z.string().regex(/^moira-op-[a-f0-9]{32}$/),
    repositoryFullName: z.string().optional(),
  })
  .passthrough();
const ledgerSchema = z
  .object({
    marker: z.string(),
    digest: z.string(),
    generation: z.number().int(),
    deadlineAt: z.number().int(),
    terminal: z.boolean(),
    kind: z.enum(["exec", "file"]),
  })
  .strict();

/** The shared guest protocol is data. Local authority bounds it before it reaches sbx. */
export class LocalJobs {
  private tail: Promise<unknown> = Promise.resolve();
  private preparing = new Set<string>();
  constructor(private readonly manager: LocalManager) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async dispatch(spaceId: string, value: unknown): Promise<unknown> {
    const serialized = JSON.stringify(value);
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES - 1024
    ) {
      throw new LocalRefusal("LOCAL_REQUEST_TOO_LARGE", "Guest operation input exceeds its bound.");
    }
    const request = requestSchema.parse(value);
    const policy = await this.manager.records.policy();
    const space = await this.manager.require(spaceId);
    const repository = requireLocalGrant(policy, space.repositoryId, this.manager.now());
    if (request.repositoryFullName && request.repositoryFullName !== repository.fullName) {
      throw new LocalRefusal(
        "LOCAL_REPOSITORY_DENIED",
        "Operation repository does not match this sandbox.",
      );
    }
    request.repositoryFullName = repository.fullName;
    const runtime = this.manager.runtime(policy);
    if (
      space.desiredState !== "running" ||
      space.phase !== "usable" ||
      (await runtime.exact(this.manager.identity(space)))?.status !== "running"
    ) {
      throw new LocalRefusal(
        "LOCAL_NOT_RUNNING",
        "Start this local sandbox before requesting work.",
      );
    }
    await this.manager.boundary(space, runtime);
    const key = `job-${space.id}-${request.remoteMarker.slice(9)}.json`;
    const creates = request.action === "execute" || request.action === "file-execute";
    let ownsDispatch = false;
    let job = await this.manager.records.state.read(key, ledgerSchema.parse);
    if (creates) {
      if (request.action === "execute") {
        const timeout = z
          .number()
          .int()
          .min(1)
          .max(policy.limits.maxOperationMs)
          .parse(request.timeoutMs);
        request.timeoutMs = Math.min(timeout, policy.leaseUntil - this.manager.now());
        z.number().int().min(1).max(policy.limits.maxOutputBytes).parse(request.maxRetainedBytes);
        z.number()
          .int()
          .min(1)
          .max(MAX_MESSAGE_BYTES / 2)
          .parse(request.maxStdoutBytes);
        z.number()
          .int()
          .min(1)
          .max(MAX_MESSAGE_BYTES / 2)
          .parse(request.maxStderrBytes);
      }
      const digest = createHash("sha256").update(serialized).digest("hex");
      await this.serial(async () => {
        job = await this.manager.records.state.read(key, ledgerSchema.parse);
        if (job) {
          if (job.digest !== digest)
            throw new LocalRefusal(
              "LOCAL_REPLAY_CONFLICT",
              "An operation marker cannot change its request.",
            );
          request.action = job.kind === "exec" ? "inspect" : "file-inspect";
          return;
        }
        const keys = await this.manager.records.state.keys("job-");
        if (keys.length >= 4096)
          throw new LocalRefusal(
            "LOCAL_JOB_CAPACITY",
            "Local retained operation capacity is exhausted.",
          );
        let active = 0;
        for (const item of keys) {
          const entry = await this.manager.records.state.read(item, ledgerSchema.parse);
          if (entry && !entry.terminal && entry.deadlineAt > this.manager.now()) active++;
        }
        if (active >= policy.limits.maxConcurrent)
          throw new LocalRefusal(
            "LOCAL_JOB_CAPACITY",
            "The local operation concurrency limit is reached.",
          );
        job = {
          marker: request.remoteMarker,
          digest,
          generation: space.generation,
          deadlineAt:
            this.manager.now() +
            (typeof request.timeoutMs === "number" ? request.timeoutMs : 60_000),
          terminal: false,
          kind: request.action === "execute" ? "exec" : "file",
        };
        await this.manager.records.state.write(key, job);
        this.preparing.add(key);
        ownsDispatch = true;
      });
    }
    if (!ownsDispatch && this.preparing.has(key)) return { state: "running" };
    if (!job) return { state: "absent" };
    try {
      if (job.generation !== space.generation && job.kind === "exec" && !job.terminal)
        return { state: "interrupted" };
      const output = await runtime.guest(
        this.manager.identity(space),
        ["node", "/tmp/moira-local-runtime/worker.mjs"],
        Buffer.from(JSON.stringify({ kind: "operation", request })),
        30_000,
      );
      const response = z
        .object({ ok: z.literal(true), result: z.unknown() })
        .strict()
        .parse(JSON.parse(output.toString("utf8")));
      const resultState =
        typeof response.result === "object" &&
        response.result !== null &&
        "state" in response.result
          ? response.result.state
          : null;
      if (
        request.action === "finalize" ||
        (resultState !== "running" && resultState !== "session_limit")
      ) {
        job.terminal = true;
        await this.manager.records.state.write(key, job);
      }
      return response.result;
    } finally {
      if (ownsDispatch) this.preparing.delete(key);
    }
  }
}
