import { createServer, request as httpRequest } from "node:http";
import { lstat, chmod, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { LocalRecords } from "./space-record.js";
import { PrivateState } from "./private-state.js";
import { LocalManager } from "./manager.js";
import { LocalRelay } from "./relay.js";
import { LocalDaemon } from "./daemon.js";
import { ControllerState } from "./controller-state.js";
import { LocalRefusal } from "./policy.js";
import {
  settlePrivateRuntime,
  readRuntimeSettlement,
  requireRecoveredRuntimeSettlement,
} from "./guard.js";
import {
  controllerRequestIdSchema,
  controllerIdentitySchema,
} from "../../shared/src/codespaces/local-controller-protocol.js";
import {
  LOCAL_SERVICE_PROTOCOL,
  serviceInstallation,
  promoteLocalService,
  serviceSocketPath,
} from "./service-install.js";

const intentSchema = z
  .object({
    id: z.string().uuid(),
    runtimeId: z.string().nullable(),
    operationMarker: z.string(),
    generation: z.number().int().positive(),
  })
  .strict();
const maintenanceSchema = z
  .object({
    requestId: controllerRequestIdSchema,
    release: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum([
      "accepted",
      "settling",
      "settled",
      "paused",
      "resuming",
      "selected",
      "completed",
      "unconfirmed",
    ]),
    pause: z.literal(true).optional(),
    running: z.array(intentSchema),
    interruption: z.literal(true),
    priorCommandsReplayed: z.literal(false),
    settlementBefore: z
      .object({ owner: z.string().uuid(), profile: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .nullable()
      .optional(),
    error: z.string().optional(),
    recovery: z
      .object({
        restored: z.array(z.string().uuid()),
        unavailable: z.array(z.object({ spaceId: z.string().uuid(), code: z.string() }).strict()),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ServiceMaintenance = z.infer<typeof maintenanceSchema>;
const maintenanceKey = (requestId: string) =>
  `service-maintenance-${controllerRequestIdSchema.parse(requestId)}.json`;

/** A transport error is not evidence that the existing physical owner is absent. */
export function serviceRequest(
  state: PrivateState,
  method = "GET",
  path = "/v1/service",
  body?: unknown,
): Promise<unknown> {
  return serviceSocketPath(state).then(
    (socketPath) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            socketPath,
            method,
            path,
            agent: false,
            headers: body === undefined ? undefined : { "content-type": "application/json" },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.once("error", reject);
            response.once("end", () => {
              try {
                const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (response.statusCode !== 200)
                  throw new LocalRefusal(
                    value.error?.code ?? "LOCAL_SERVICE_UNAVAILABLE",
                    value.error?.message ?? "The host owner request was refused.",
                  );
                resolve(value);
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        request.once("error", reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      }),
  );
}

export async function collectServiceMaintenance(state: PrivateState, requestId: string) {
  return state.read(maintenanceKey(requestId), maintenanceSchema.parse);
}
export async function serviceFailure(state: PrivateState) {
  return state.read(
    "service-failure.json",
    z
      .object({
        release: z.string().regex(/^[a-f0-9]{64}$/),
        code: z.string().regex(/^LOCAL_[A-Z_]+$/),
        at: z.number().int().nonnegative(),
      })
      .strict().parse,
  );
}

interface ServiceDependencies {
  manager?: LocalManager;
  daemon?: LocalDaemon;
  promote?: typeof promoteLocalService;
  signal?: AbortSignal;
  installation?: typeof serviceInstallation;
  settle?: typeof settlePrivateRuntime;
}

/** The one host owner contains native custody, controller journals and VM egress. */
export async function runLocalService(
  records: LocalRecords,
  release: string,
  dependencies: ServiceDependencies = {},
): Promise<void> {
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(release);
  const gate = await PrivateState.open(join(records.state.root, "service-control"));
  const releaseGate = await gate.lock({ recoverStale: true });
  const controller = new AbortController();
  const physicalController = new AbortController();
  const manager =
    dependencies.manager ?? new LocalManager(records, { signal: physicalController.signal });
  const daemon = dependencies.daemon ?? new LocalDaemon(manager, new LocalRelay(records));
  const socketPath = await serviceSocketPath(records.state);
  let maintenance: Promise<void> | undefined;
  let admission: Promise<unknown> = Promise.resolve();
  let daemonStarted = false;
  let physicalStop = false;
  let work: Promise<void> | undefined;
  let failure: unknown;
  let startupFailed = false;
  let ready = false;
  let own: Awaited<ReturnType<typeof lstat>> | undefined;
  const abort = () => {
    controller.abort();
    physicalController.abort();
  };
  const installation = () => (dependencies.installation ?? serviceInstallation)(records.state);
  const restoreIntent = async (receipt: ServiceMaintenance) => {
    for (const saved of receipt.running) {
      const current = await records.get(saved.id);
      if (
        !current ||
        current.runtimeId !== saved.runtimeId ||
        current.operationMarker !== saved.operationMarker ||
        current.desiredState === "deleted" ||
        current.phase === "deleting" ||
        current.phase === "deleted" ||
        !(
          (current.desiredState === "running" &&
            (current.generation === saved.generation ||
              current.generation === saved.generation + 2)) ||
          (current.desiredState === "stopped" &&
            (current.generation === saved.generation + 1 ||
              (receipt.pause &&
                current.recoveryGeneration === current.generation &&
                current.generation > saved.generation)))
        )
      )
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "A maintenance environment changed identity; replacement remains blocked.",
        );
      if (current.desiredState !== "running")
        await records.put({
          ...current,
          desiredState: "running",
          generation: current.generation + 1,
        });
      const restored = (await records.get(saved.id))!;
      const identity = await records.state.read("connection.json", controllerIdentitySchema.parse);
      if (identity) {
        const bindings = new ControllerState(records);
        for (const binding of await bindings.bindings(identity))
          if (
            binding.localSpaceId === restored.id &&
            binding.operationMarker === restored.operationMarker &&
            binding.repositoryId === restored.repositoryId
          )
            await bindings.putBinding({ ...binding, localGeneration: restored.generation });
      }
    }
  };
  const accept = async (
    requestId: string,
    target: string,
    action: "update" | "pause" | "resume",
  ) => {
    let acquiredRecoveryGate = false;
    try {
      if (controller.signal.aborted)
        throw new LocalRefusal(
          "LOCAL_SERVICE_STOPPING",
          "The current owner is exiting; collect the original maintenance before retrying.",
        );
      const key = maintenanceKey(requestId);
      const retained = await collectServiceMaintenance(records.state, requestId);
      if (action === "resume" && !retained?.pause)
        throw new LocalRefusal(
          "LOCAL_MAINTENANCE_PENDING",
          "Resume requires the original paused maintenance receipt.",
        );
      if (retained) {
        if (
          retained.release !== target ||
          (action !== "resume" && Boolean(retained.pause) !== (action === "pause"))
        )
          throw new LocalRefusal(
            "LOCAL_REPLAY_CONFLICT",
            "Maintenance identity names another release or interruption intent.",
          );
        if (retained.phase === "selected" && retained.release === release && startupFailed) {
          // Explicitly retry this selected owner's startup after local prerequisite
          // repair. The prior physical stop and selection are not repeated.
          abort();
          return retained;
        }
        if (["unconfirmed", "settling", "resuming"].includes(retained.phase)) {
          // Only a blocked owner can finish a previously unknown interruption.
          // A read never runs recovery and this path never repeats physical stop.
          if (maintenance || daemonStarted) return retained;
          if (action === "update" && (await installation()).staged !== target)
            throw new LocalRefusal(
              "LOCAL_SERVICE_UPDATE_MISSING",
              "Stage the requested owner release before recovered maintenance.",
            );
          if (retained.settlementBefore === undefined) {
            // Older receipts have no pre-stop witness. Read their baseline under
            // exclusion without adopting the unknown former physical owner.
            const releaseBaseline = await records.state.lock({ recoverStale: true });
            try {
              const current = await readRuntimeSettlement(records);
              retained.settlementBefore = current
                ? { owner: current.owner, profile: current.profile }
                : null;
              retained.phase = "unconfirmed";
              await records.state.write(key, retained);
            } finally {
              await releaseBaseline();
            }
            return retained;
          }
          try {
            await manager.holdRunnerLock();
            acquiredRecoveryGate = true;
            await requireRecoveredRuntimeSettlement(records, retained.settlementBefore);
            retained.phase = "settled";
            delete retained.error;
            await records.state.write(key, retained);
          } catch (error) {
            await manager.release();
            acquiredRecoveryGate = false;
            if (
              error instanceof LocalRefusal &&
              ["LOCAL_DISABLED_REQUIRED", "LOCAL_STOP_PENDING", "LOCAL_OWNER_ACTIVE"].includes(
                error.code,
              )
            ) {
              retained.phase = "unconfirmed";
              await records.state.write(key, retained);
              return retained;
            }
            throw error;
          }
        }
        if (
          maintenance ||
          (action === "resume" && retained.phase === "accepted") ||
          retained.phase === "selected" ||
          retained.phase === "completed" ||
          (retained.phase === "paused" && action !== "resume")
        )
          return retained;
      }
      if (maintenance)
        throw new LocalRefusal(
          "LOCAL_MAINTENANCE_PENDING",
          "Collect the original maintenance before another update.",
        );
      for (const pendingKey of await records.state.keys("service-maintenance-")) {
        const pending = await records.state.read(pendingKey, maintenanceSchema.parse);
        if (pending && pending.requestId !== requestId && pending.phase !== "completed")
          throw new LocalRefusal(
            "LOCAL_MAINTENANCE_PENDING",
            "Resume or collect the original maintenance identity first.",
          );
      }
      const installed = await installation();
      if (action === "pause" && target !== release)
        throw new LocalRefusal(
          "LOCAL_REPLAY_CONFLICT",
          "Pause must name the actual running release.",
        );
      if (
        action === "update" &&
        installed.staged !== target &&
        !(retained?.phase === "settled" && installed.active === target)
      )
        throw new LocalRefusal(
          "LOCAL_SERVICE_UPDATE_MISSING",
          "Stage the requested owner release before maintenance.",
        );
      if (retained?.phase === "settled") {
        await manager.holdRunnerLock();
        acquiredRecoveryGate = true;
      }
      const receipt: ServiceMaintenance = retained ?? {
        requestId,
        release: target,
        phase: "accepted",
        running: [],
        interruption: true,
        priorCommandsReplayed: false,
        ...(action === "pause" ? { pause: true as const } : {}),
      };
      await records.state.write(key, receipt);
      maintenance = (async () => {
        try {
          if (action === "resume" && receipt.phase !== "settled") {
            await manager.holdRunnerLock();
            const previousOwner = await readRuntimeSettlement(records);
            receipt.settlementBefore = previousOwner
              ? { owner: previousOwner.owner, profile: previousOwner.profile }
              : null;
            receipt.phase = "resuming";
            await records.state.write(key, receipt);
            const policy = await records.policyOrNull();
            if (policy) await (dependencies.settle ?? settlePrivateRuntime)(policy);
            receipt.phase = "settled";
            await records.state.write(key, receipt);
          } else if (receipt.phase !== "settled") {
            await daemon.prepareMaintenance();
            if (controller.signal.aborted)
              throw new LocalRefusal(
                "LOCAL_SERVICE_STOPPING",
                "Owner observation ended before maintenance could begin physical settlement.",
              );
            receipt.running = (await records.list())
              .filter((space) => space.desiredState === "running")
              .map(({ id, runtimeId, operationMarker, generation }) => ({
                id,
                runtimeId,
                operationMarker,
                generation,
              }));
            const previousOwner = await readRuntimeSettlement(records);
            receipt.settlementBefore = previousOwner
              ? { owner: previousOwner.owner, profile: previousOwner.profile }
              : null;
            receipt.phase = "settling";
            await records.state.write(key, receipt);
            ready = false;
            physicalStop = true;
            physicalController.abort();
            await work;
            if (!daemonStarted) {
              await manager.holdRunnerLock();
              await manager.close(true);
              const policy = await records.policyOrNull();
              if (policy) await (dependencies.settle ?? settlePrivateRuntime)(policy);
            }
            receipt.phase = "settled";
            await records.state.write(key, receipt);
          }
          if (receipt.pause && action !== "resume") {
            await manager.release();
            receipt.phase = "paused";
            await records.state.write(key, receipt);
            return;
          }
          await restoreIntent(receipt);
          await (dependencies.promote ?? promoteLocalService)(records.state, target);
          receipt.phase = "selected";
          delete receipt.error;
          await records.state.write(key, receipt);
          controller.abort();
        } catch (error) {
          if (receipt.phase === "settling" || receipt.phase === "resuming")
            receipt.phase = "unconfirmed";
          receipt.error =
            error instanceof LocalRefusal ? error.code : "LOCAL_MAINTENANCE_UNCONFIRMED";
          await records.state.write(key, receipt);
          failure = error;
          controller.abort();
        }
      })().finally(() => {
        maintenance = undefined;
      });
      return receipt;
    } catch (error) {
      // Admission failure must not strand the standalone repair operation's
      // gate before asynchronous maintenance has taken responsibility for it.
      if (acquiredRecoveryGate && !maintenance) await manager.release();
      throw error;
    }
  };
  const perform = (requestId: string, target: string, action: "update" | "pause" | "resume") => {
    const result = admission.catch(() => undefined).then(() => accept(requestId, target, action));
    admission = result;
    return result;
  };
  const server = createServer((request, response) => {
    void (async () => {
      let result: unknown;
      if (request.method === "GET" && request.url === "/v1/service") {
        result = {
          protocol: LOCAL_SERVICE_PROTOCOL,
          release,
          processId: process.pid,
          ready,
          failure: await serviceFailure(records.state),
          installation: await installation(),
          controlPlane: daemon.status,
        };
      } else if (request.method === "GET" && request.url?.startsWith("/v1/service/operations/")) {
        const requestId = controllerRequestIdSchema.parse(
          request.url.slice("/v1/service/operations/".length),
        );
        result = (await collectServiceMaintenance(records.state, requestId)) ?? {
          requestId,
          state: "absent",
        };
      } else if (request.method === "POST" && request.url === "/v1/service/maintenance") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 4096)
            throw new LocalRefusal("LOCAL_REQUEST_INVALID", "Invalid maintenance control frame.");
          chunks.push(Buffer.from(chunk));
        }
        const input = z
          .object({
            requestId: controllerRequestIdSchema,
            release: z.string().regex(/^[a-f0-9]{64}$/),
            action: z.enum(["update", "pause", "resume"]).default("update"),
          })
          .strict()
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        result = await perform(input.requestId, input.release, input.action);
      } else {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify(result));
    })().catch((error) => {
      if (!response.headersSent)
        response.writeHead(409, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: {
              code: error instanceof LocalRefusal ? error.code : "LOCAL_REQUEST_INVALID",
              message:
                error instanceof LocalRefusal
                  ? error.message
                  : "The local service request was refused.",
            },
          }),
        );
    });
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  try {
    const old = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (old) {
      if (!old.isSocket() || old.uid !== process.getuid?.() || old.mode & 0o077)
        throw new LocalRefusal("LOCAL_STATE_UNSAFE", "Unsafe host service endpoint.");
      await new Promise<void>((resolve, reject) => {
        const probe = connect(socketPath);
        probe.once("connect", () => {
          probe.destroy();
          reject(new LocalRefusal("LOCAL_ALREADY_RUNNING", "The host owner is already running."));
        });
        probe.once("error", (error: NodeJS.ErrnoException) => {
          probe.destroy();
          if (error.code === "ECONNREFUSED") resolve();
          else reject(error);
        });
      });
      const current = await lstat(socketPath);
      if (current.dev !== old.dev || current.ino !== old.ino)
        throw new LocalRefusal("LOCAL_STATE_CHANGED", "Host service endpoint changed.");
      await unlink(socketPath);
    }
    // A blocked maintenance endpoint must leave the physical gate available to
    // the existing explicitly confirmed local recovery operation.
    let blocked = false;
    const selected: ServiceMaintenance[] = [];
    for (const key of await records.state.keys("service-maintenance-")) {
      const retained = await records.state.read(key, maintenanceSchema.parse);
      if (retained?.phase === "selected" && retained.release === release) selected.push(retained);
      else if (retained && retained.phase !== "completed") blocked = true;
    }
    if (!blocked) await manager.holdRunnerLock();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    own = await lstat(socketPath);
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    process.once("SIGTERM", abort);
    process.once("SIGINT", abort);
    if (dependencies.signal?.aborted) abort();
    // Keep the recovery endpoint available; never auto-repeat interrupted maintenance.
    work = (async () => {
      if (blocked) {
        const stopped = AbortSignal.any([controller.signal, physicalController.signal]);
        await new Promise<void>((resolve) => {
          stopped.addEventListener("abort", () => resolve(), { once: true });
          if (stopped.aborted) resolve();
        });
        return;
      }
      const policy = await records.policyOrNull();
      let recovery: Awaited<ReturnType<LocalManager["restoreIntendedWork"]>> = {
        restored: [],
        unavailable: [],
      };
      if (
        policy?.enabled &&
        policy.leaseUntil > Date.now() &&
        (await records.list()).some((space) => space.desiredState === "running" && space.runtimeId)
      ) {
        await manager.open();
        recovery = await manager.restoreIntendedWork();
      } else {
        recovery.unavailable = (await records.list())
          .filter((space) => space.desiredState === "running")
          .map((space) => ({ spaceId: space.id, code: "LOCAL_NOT_RUNNING" }));
      }
      ready = true;
      await records.state.remove("service-failure.json");
      for (const receipt of selected) {
        await records.state.write(maintenanceKey(receipt.requestId), {
          ...receipt,
          phase: "completed",
          recovery,
        });
      }
      daemonStarted = true;
      await daemon.run(physicalController.signal, () => physicalStop, true);
    })().catch(async (error) => {
      if (physicalStop) throw error;
      ready = false;
      const refusal =
        error instanceof LocalRefusal
          ? error
          : error instanceof Error && error.cause instanceof LocalRefusal
            ? error.cause
            : undefined;
      await manager.release();
      await records.state.write("service-failure.json", {
        release,
        code: refusal?.code ?? "LOCAL_SERVICE_FAILED",
        at: Date.now(),
      });
      startupFailed = true;
      // A failed Local prerequisite must leave local recovery reachable, rather
      // than repeatedly competing with login for the native mutation gate.
      await new Promise<void>((resolve) => {
        physicalController.signal.addEventListener("abort", () => resolve(), { once: true });
        if (physicalController.signal.aborted) resolve();
      });
    });
    await work.catch((error) => {
      failure = error;
    });
    await maintenance;
    if (!controller.signal.aborted && !failure)
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
        if (controller.signal.aborted) resolve();
      });
    if (failure) throw failure;
  } catch (error) {
    await records.state.write("service-failure.json", {
      release,
      code: error instanceof LocalRefusal ? error.code : "LOCAL_SERVICE_FAILED",
      at: Date.now(),
    });
    throw error;
  } finally {
    dependencies.signal?.removeEventListener("abort", abort);
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
    controller.abort();
    await manager.release();
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    if (own) {
      const current = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (current?.dev === own.dev && current.ino === own.ino) await unlink(socketPath);
    }
    await releaseGate();
  }
}
