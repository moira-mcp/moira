import { LocalManager } from "./manager.js";
import { LocalRelay, LocalDeviceAuthorityFailure } from "./relay.js";
import { LocalCompanion } from "./web-control.js";
import { LocalRefusal } from "./policy.js";

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

/** Reconnection and device confirmation are separate from the VM's finite local admission. */
export class LocalDaemon {
  private current: LocalDaemonStatus = { controlPlane: "offline", code: null };
  readonly companion: LocalCompanion;
  constructor(
    readonly manager: LocalManager,
    readonly relay: LocalRelay,
    private readonly dependencies: {
      companion?: LocalCompanion;
      wait?: typeof wait;
      report?: (status: LocalDaemonStatus) => void;
    } = {},
  ) {
    this.companion = dependencies.companion ?? new LocalCompanion(manager, relay);
  }

  get status(): Readonly<LocalDaemonStatus> {
    return { ...this.current };
  }

  private update(controlPlane: LocalDaemonStatus["controlPlane"], code: string | null): void {
    const next = { controlPlane, code };
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    if (this.dependencies.report) this.dependencies.report(next);
    else process.stderr.write(`${JSON.stringify({ localDaemon: next })}\n`);
  }

  async cycle(signal?: AbortSignal): Promise<boolean> {
    try {
      const active = await this.companion.cycle(signal);
      this.update(active ? "connected" : "disabled", null);
      return active;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof LocalDeviceAuthorityFailure) {
        await this.companion.pause();
        this.update("disabled", error.code);
      } else if (this.relay.isUnavailable(error)) {
        this.update("offline", "LOCAL_RELAY_UNAVAILABLE");
      } else {
        // Invalid protocol is visible and admits no new work; it is not a VM stop intent.
        const code =
          error instanceof LocalRefusal && /^LOCAL_[A-Z_]{1,122}$/.test(error.code)
            ? error.code
            : "LOCAL_PROTOCOL_INVALID";
        this.update("faulted", code);
      }
      return false;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const active = await this.cycle(signal);
        if (!active)
          await (this.dependencies.wait ?? wait)(
            this.current.controlPlane === "faulted" ? 30_000 : 1000,
            signal,
          );
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      // Only the explicit owner shutdown aborts this daemon, not a relay request scope.
      if (signal.aborted) {
        await this.manager.close();
        await this.relay.drain();
      }
    }
  }
}
