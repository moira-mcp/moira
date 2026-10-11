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
    admissionDeadlineAt: z.number().int().positive().optional(),
    requestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .passthrough();
const ledgerSchema = z
  .object({
    marker: z.string(),
    digest: z.string(),
    deadlineAt: z.number().int(),
    terminal: z.boolean(),
    kind: z.enum(["exec", "file"]),
    notStarted: z.boolean().optional(),
    cancelRequested: z.boolean().optional(),
    cancelledBeforeStart: z.boolean().optional(),
    admissionDeadlineAt: z.number().int().positive().optional(),
    requestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
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
          if (job.cancelRequested) {
            if (
              job.requestDigest !== request.requestDigest ||
              (request.admissionDeadlineAt !== undefined &&
                job.admissionDeadlineAt !== undefined &&
                request.admissionDeadlineAt !== job.admissionDeadlineAt)
            )
              throw new LocalRefusal(
                "LOCAL_REPLAY_CONFLICT",
                "A cancelled marker cannot change its accepted request.",
              );
            request.action = job.kind === "exec" ? "inspect" : "file-inspect";
            return;
          }
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
          ...(request.admissionDeadlineAt === undefined
            ? {}
            : { admissionDeadlineAt: request.admissionDeadlineAt }),
          ...(request.requestDigest === undefined ? {} : { requestDigest: request.requestDigest }),
          ...(request.action === "execute" &&
          request.admissionDeadlineAt !== undefined &&
          request.admissionDeadlineAt <= this.manager.now()
            ? { notStarted: true, terminal: true }
            : {}),
        };
        await this.manager.records.state.write(key, job);
        this.preparing.add(key);
        ownsDispatch = true;
      });
    }
    if (request.action === "cancel") {
      await this.serial(async () => {
        const current = await this.manager.records.state.read(key, ledgerSchema.parse);
        if (
          current?.requestDigest !== undefined &&
          request.requestDigest !== undefined &&
          current.requestDigest !== request.requestDigest
        )
          throw new LocalRefusal(
            "LOCAL_REPLAY_CONFLICT",
            "Cancellation differs from the accepted request.",
          );
        if (
          current?.admissionDeadlineAt !== undefined &&
          request.admissionDeadlineAt !== undefined &&
          current.admissionDeadlineAt !== request.admissionDeadlineAt
        )
          throw new LocalRefusal("LOCAL_REPLAY_CONFLICT", "Cancellation cannot extend admission.");
        job = {
          ...(current ?? {
            marker: request.remoteMarker,
            digest: createHash("sha256").update(serialized).digest("hex"),
            deadlineAt: policy.leaseUntil,
            terminal: false,
            kind: "exec" as const,
            ...(request.requestDigest === undefined
              ? {}
              : { requestDigest: request.requestDigest }),
          }),
          cancelRequested: true,
          ...((current?.admissionDeadlineAt ?? request.admissionDeadlineAt) === undefined
            ? {}
            : { admissionDeadlineAt: current?.admissionDeadlineAt ?? request.admissionDeadlineAt }),
        };
        await this.manager.records.state.write(key, job);
      });
    }
    if (
      job?.requestDigest !== undefined &&
      request.requestDigest !== undefined &&
      job.requestDigest !== request.requestDigest
    )
      throw new LocalRefusal(
        "LOCAL_REPLAY_CONFLICT",
        "Operation collection differs from the accepted request.",
      );
    if (!ownsDispatch && request.action !== "cancel" && this.preparing.has(key))
      return request.requestDigest === undefined
        ? { state: "running" }
        : { state: "outcome_unknown", requestDigest: request.requestDigest };
    if (!job) return { state: "absent" };
    const notStarted = () => ({
      state: "not_started",
      ...(job?.requestDigest === undefined ? {} : { requestDigest: job.requestDigest }),
    });
    if (job.notStarted) {
      if (ownsDispatch) this.preparing.delete(key);
      if (request.action === "finalize") {
        if (job.cancelledBeforeStart) {
          if (job.admissionDeadlineAt === undefined || job.admissionDeadlineAt > this.manager.now())
            return notStarted();
          // Once launch authority has closed, the guest can remove the retained fence.
        } else {
          await this.manager.records.state.remove(key);
          return { state: "absent" };
        }
      } else {
        return notStarted();
      }
    }
    try {
      const accepted = job;
      const output = await this.manager.dispatchGuest(
        spaceId,
        async (current, latest) => {
          const repository = requireLocalGrant(latest, current.repositoryId, this.manager.now());
          if (request.repositoryFullName !== repository.fullName)
            throw new LocalRefusal("LOCAL_REPOSITORY_DENIED", "The approved repository changed.");
          if (ownsDispatch) {
            const latestJob = await this.manager.records.state.read(key, ledgerSchema.parse);
            if (latestJob?.cancelRequested) {
              Object.assign(accepted, latestJob);
              if (latestJob.notStarted)
                return Buffer.from(JSON.stringify({ ok: true, result: notStarted() }));
              request.action = "cancel";
              request.requestDigest = latestJob.requestDigest;
              request.admissionDeadlineAt = latestJob.admissionDeadlineAt;
            }
            if (
              request.action === "execute" &&
              request.admissionDeadlineAt !== undefined &&
              request.admissionDeadlineAt <= this.manager.now()
            ) {
              accepted.notStarted = true;
              accepted.terminal = true;
              await this.manager.records.state.write(key, accepted);
              return Buffer.from(JSON.stringify({ ok: true, result: notStarted() }));
            }
            const remaining = Math.min(
              request.admissionDeadlineAt === undefined
                ? accepted.deadlineAt - this.manager.now()
                : Number.MAX_SAFE_INTEGER,
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
      if (
        resultState === "not_started" &&
        typeof response.result === "object" &&
        response.result !== null &&
        ("startedAt" in response.result ||
          (job.requestDigest !== undefined &&
            (!("requestDigest" in response.result) ||
              response.result.requestDigest !== job.requestDigest)))
      )
        throw new LocalRefusal(
          "LOCAL_REPLAY_CONFLICT",
          "A negative receipt does not prove this request was fenced before launch.",
        );
      if (request.action === "finalize" && resultState === "absent") {
        await this.manager.records.state.remove(key);
        return response.result;
      }
      await this.serial(async () => {
        const current =
          (await this.manager.records.state.read(key, ledgerSchema.parse)) ?? accepted;
        if (ownsDispatch) current.deadlineAt = accepted.deadlineAt;
        if (resultState === "not_started") {
          current.notStarted = true;
          if (current.cancelRequested) current.cancelledBeforeStart = true;
        }
        if (
          resultState !== "running" &&
          resultState !== "outcome_unknown" &&
          resultState !== "session_limit"
        )
          current.terminal = true;
        await this.manager.records.state.write(key, current);
      });
      return response.result;
    } finally {
      if (ownsDispatch) this.preparing.delete(key);
    }
  }
}
