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
  private remote?: ReturnType<typeof startWorkspaceRemote>;
  private authorityRefused = false;
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
  private update(controlPlane: LocalDaemonStatus["controlPlane"], code: string | null) {
    const next = { controlPlane, code };
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    if (this.dependencies.report) this.dependencies.report(next);
    else process.stderr.write(`${JSON.stringify({ localDaemon: next })}\n`);
  }
  async cycle(signal?: AbortSignal): Promise<boolean> {
    try {
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
        this.authorityRefused = false;
        this.controller = await (this.dependencies.startController ?? startLocalController)(
          new LocalController(this.manager, connection),
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
          /* Native shutdown remains mandatory even when storage is unavailable. */
        }
        await this.remote?.close();
        this.remote = undefined;
        if (this.controller) await this.controller.retire();
        else await this.manager.stopWork();
        await this.controller?.close();
        this.controller = undefined;
        this.update("disabled", error.code);
      } else
        this.update(
          this.relay.isUnavailable(error) ? "offline" : "faulted",
          error instanceof LocalRefusal ? error.code : "LOCAL_PROTOCOL_INVALID",
        );
      return false;
    }
  }
  async run(signal: AbortSignal): Promise<void> {
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
    try {
      await this.controller?.retire();
      retired = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.controller?.close();
      endpointClosed = true;
    } catch (error) {
      failures.push(error);
    }
    // Keep the existing native runner gate until the old IPC namespace has
    // settled. Unknown physical retirement must not admit a replacement owner.
    if (retired && endpointClosed)
      try {
        await this.manager.close();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Controller shutdown remains unconfirmed.");
  }
}
