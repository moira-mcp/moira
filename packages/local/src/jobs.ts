import { createHash } from "node:crypto";
import { z } from "zod";
import { LocalManager } from "./manager.js";
import {
  LocalRefusal,
  MAX_MESSAGE_BYTES,
  requireLocalGrant,
  requireOperationOutputBudget,
  requireOperationExecutionBudget,
} from "./policy.js";

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
    deadlineAt: z.number().int(),
    terminal: z.boolean(),
    kind: z.enum(["exec", "file"]),
  })
  .strip();

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

  async dispatch(spaceId: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
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
    if (space.desiredState !== "running" || space.phase !== "usable") {
      throw new LocalRefusal(
        "LOCAL_NOT_RUNNING",
        "Start this local sandbox before requesting work.",
      );
    }
    const key = `job-${space.id}-${request.remoteMarker.slice(9)}.json`;
    const creates = request.action === "execute" || request.action === "file-execute";
    let ownsDispatch = false;
    let job = await this.manager.records.state.read(key, ledgerSchema.parse);
    if (creates) {
      if (request.action === "execute") {
        request.timeoutMs = requireOperationExecutionBudget(
          request.timeoutMs,
          request.maxRetainedBytes,
          policy.leaseUntil - this.manager.now(),
        );
        requireOperationOutputBudget(request.maxStdoutBytes, request.maxStderrBytes);
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
        job = {
          marker: request.remoteMarker,
          digest,
          deadlineAt: Math.min(
            policy.leaseUntil,
            this.manager.now() +
              (typeof request.timeoutMs === "number" ? request.timeoutMs : 60_000),
          ),
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
      const accepted = job;
      const output = await this.manager.dispatchGuest(
        spaceId,
        async (current, latest) => {
          const repository = requireLocalGrant(latest, current.repositoryId, this.manager.now());
          if (request.repositoryFullName !== repository.fullName)
            throw new LocalRefusal("LOCAL_REPOSITORY_DENIED", "The approved repository changed.");
          if (ownsDispatch) {
            const remaining = Math.min(
              accepted.deadlineAt - this.manager.now(),
              latest.leaseUntil - this.manager.now(),
            );
            if (remaining <= 0)
              throw new LocalRefusal("LOCAL_LEASE_EXPIRED", "The accepted work deadline expired.");
            if (request.action === "execute") {
              request.timeoutMs = requireOperationExecutionBudget(
                request.timeoutMs,
                request.maxRetainedBytes,
                remaining,
              );
            }
            accepted.deadlineAt = this.manager.now() + remaining;
          }
          return this.manager.operation(spaceId, request, signal);
        },
        signal,
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
      if (request.action === "finalize" && resultState === "absent") {
        await this.manager.records.state.remove(key);
        return response.result;
      }
      if (resultState !== "running" && resultState !== "session_limit") {
        job.terminal = true;
      }
      await this.manager.records.state.write(key, job);
      return response.result;
    } finally {
      if (ownsDispatch) this.preparing.delete(key);
    }
  }
}
