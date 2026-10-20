import { LocalManager } from "./manager.js";
import { LocalRelay, LocalDeviceAuthorityFailure, localConnectionSchema } from "./relay.js";
import { LocalRefusal } from "./policy.js";
import { LocalController, startLocalController } from "./controller.js";
import { startWorkspaceRemote } from "../../workspace-service/src/remote.js";
import { controllerIdentitySchema } from "../../shared/src/codespaces/local-controller-protocol.js";

export interface LocalDaemonStatus {
  controlPlane: "connected" | "offline" | "faulted" | "disabled";
  code: string | null;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
/** Controller lifetime is independent of guest work and remote observation. */
export class LocalDaemon {
  private current: LocalDaemonStatus = { controlPlane: "offline", code: null };
  private controller?: Awaited<ReturnType<typeof startLocalController>>;
  private controllerOwner?: LocalController;
  private detached?: {
    owner: LocalController;
    endpoint: Awaited<ReturnType<typeof startLocalController>>;
    settled: boolean;
    failure?: unknown;
    work: Promise<void>;
  };
  private remote?: ReturnType<typeof startWorkspaceRemote>;
  private authorityRefused = false;
  private maintaining = false;
  private cycling?: Promise<boolean>;
  constructor(
    readonly manager: LocalManager,
    readonly relay: LocalRelay,
    private readonly dependencies: {
      wait?: typeof wait;
      report?: (status: LocalDaemonStatus) => void;
      startController?: typeof startLocalController;
      startRemote?: typeof startWorkspaceRemote;
    } = {},
  ) {}
  get status(): Readonly<LocalDaemonStatus> {
    return { ...this.current };
  }
  async prepareMaintenance(): Promise<void> {
    this.maintaining = true;
    await this.cycling;
    await this.controllerOwner?.prepareMaintenance();
    await this.detached?.owner.prepareMaintenance();
  }
  private update(controlPlane: LocalDaemonStatus["controlPlane"], code: string | null) {
    const next = { controlPlane, code };
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    if (this.dependencies.report) this.dependencies.report(next);
    else process.stderr.write(`${JSON.stringify({ localDaemon: next })}\n`);
  }
  async cycle(signal?: AbortSignal): Promise<boolean> {
    if (this.maintaining) return false;
    const work = this.observe(signal);
    this.cycling = work;
    try {
      return await work;
    } finally {
      if (this.cycling === work) this.cycling = undefined;
    }
  }
  private async observe(signal?: AbortSignal): Promise<boolean> {
    try {
      if (this.detached) {
        if (this.detached.failure) throw this.detached.failure;
        if (!this.detached.settled) return false;
        this.detached = undefined;
      }
      if (!this.controller) {
        const saved = await this.manager.records.state.read(
          "connection.json",
          localConnectionSchema.parse,
        );
        const connection =
          !this.authorityRefused &&
          saved &&
          !saved.authorityRefused &&
          saved.userId &&
          saved.deviceGeneration &&
          saved.connectionId
            ? { ...saved, ...controllerIdentitySchema.parse(saved) }
            : await this.relay.confirmed(signal);
        if (connection.deviceId !== (await this.manager.records.deviceIdentity())?.deviceId)
          throw new LocalDeviceAuthorityFailure("LOCAL_IDENTITY_CHANGED");
        if (this.maintaining) return false;
        this.authorityRefused = false;
        this.controllerOwner = new LocalController(this.manager, connection);
        this.controller = await (this.dependencies.startController ?? startLocalController)(
          this.controllerOwner,
        );
        this.remote = (this.dependencies.startRemote ?? startWorkspaceRemote)({
          kind: "controller",
          socketPath: this.controller.socketPath,
          origin: connection.origin,
          credential: connection.credential,
          connectionId: connection.connectionId,
        });
      }
      await this.relay.confirmed(signal);
      const policy = await this.manager.records.policyOrNull();
      if (policy && (!policy.enabled || policy.leaseUntil <= Date.now()))
        await this.manager.stopWork();
      this.update("connected", null);
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof LocalDeviceAuthorityFailure) {
        this.authorityRefused = true;
        // Preserve the known refusal across daemon restarts. An offline observation
        // must not silently revive a previously revoked cloud authority.
        try {
          const saved = await this.manager.records.state.read(
            "connection.json",
            localConnectionSchema.parse,
          );
          if (saved)
            await this.manager.records.state.write("connection.json", {
              ...saved,
              authorityRefused: true,
            });
        } catch {
          /* Authority remains refused even if its diagnostic cannot be persisted. */
        }
        await this.remote?.close();
        this.remote = undefined;
        // Cloud authority fences the remote route, not locally owned physical intent.
        if (this.controller && this.controllerOwner) {
          await this.controller.detach();
          const old = {
            owner: this.controllerOwner,
            endpoint: this.controller,
            settled: false,
            failure: undefined as unknown,
            work: Promise.resolve(),
          };
          this.detached = old;
          this.controller = undefined;
          this.controllerOwner = undefined;
          // Retain the original writer until it finishes. A new authority cannot
          // race its late binding writes, and no accepted work is replayed.
          old.work = old.owner.state
            .drain()
            .then(() => old.endpoint.close())
            .then(
              () => {
                old.settled = true;
              },
              (error) => {
                old.failure = error;
                this.update(
                  "faulted",
                  error instanceof LocalRefusal ? error.code : "LOCAL_CONTROLLER_FAILED",
                );
              },
            );
        }
        this.update("disabled", error.code);
      } else
        this.update(
          this.relay.isUnavailable(error) ? "offline" : "faulted",
          error instanceof LocalRefusal ? error.code : "LOCAL_PROTOCOL_INVALID",
        );
      return false;
    }
  }
  async run(
    signal: AbortSignal,
    physicalStop: () => boolean = () => true,
    retainGate = false,
  ): Promise<void> {
    const failures: unknown[] = [];
    try {
      while (!signal.aborted) {
        await this.cycle(signal);
        await (this.dependencies.wait ?? wait)(
          this.current.controlPlane === "faulted" ? 30_000 : 1000,
          signal,
        );
      }
    } catch (error) {
      if (!signal.aborted) failures.push(error);
    }
    try {
      await this.remote?.close();
    } catch (error) {
      failures.push(error);
    }
    let retired = false,
      endpointClosed = false;
    const endpoints = [this.controller, this.detached?.endpoint].filter(
      (endpoint): endpoint is NonNullable<typeof endpoint> => endpoint !== undefined,
    );
    try {
      if (physicalStop()) {
        for (const endpoint of endpoints) await endpoint.retire();
      } else {
        // Fence routes before dropping native observation. Draining the endpoint
        // first would wait forever on a guest attachment whose owner is still held.
        await this.controllerOwner?.prepareMaintenance();
        await this.detached?.owner.prepareMaintenance();
        await this.manager.release();
      }
      retired = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      for (const endpoint of endpoints) await endpoint.close();
      await this.detached?.work;
      if (this.detached?.failure) throw this.detached.failure;
      endpointClosed = true;
    } catch (error) {
      failures.push(error);
    }
    // Keep the existing native runner gate until the old IPC namespace has
    // settled. Unknown physical retirement must not admit a replacement owner.
    if (retired && endpointClosed)
      try {
        if (physicalStop()) await this.manager.close(retainGate);
        else await this.manager.release();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Controller shutdown remains unconfirmed.");
  }
}
