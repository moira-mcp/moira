/**
 * Supervision of one extension's handler process.
 *
 * The service holds these; they own the child process, the deadline and the concurrency limit. The
 * rules that make failure containable live here:
 *  - a call that outlives its deadline kills the process rather than merely stopping the wait, so a
 *    handler that ignores its abort signal cannot keep running invisibly;
 *  - a process that dies for any reason (crash, kill, exit) fails only its own in-flight calls, and
 *    the next call starts a fresh one;
 *  - more calls than the limit wait instead of running, so one extension cannot exhaust the host.
 */

import { fork, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";
import { randomUUID } from "crypto";
import type { ExtensionManifest } from "@mcp-moira/workflow-engine/extensions/contract";
import {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_BYTES_PER_CALL,
  type HostResponse,
  type RunnerArtifact,
  type RunnerInvokeRequest,
  type RunnerInvokeResponse,
} from "./protocol.js";
import type { LoadedBundle } from "./bundle-loader.js";

const HANDLER_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), "handler-host.ts");

export interface ExtensionHostOptions {
  /** How many invocations may run at once for this extension. */
  maxConcurrent?: number;
  /** Maximum calls waiting for a concurrency slot before new work is refused. */
  maxQueued?: number;
  /** Node executable arguments; tests use this to run the host under the same loader. */
  execArgv?: string[];
  /**
   * How long a handler is given to wind down after it is told the call was cancelled, before the
   * process is killed. It exists so a handler can observe its abort signal, not so it can bargain:
   * the process dies at the end of it whatever the handler does.
   */
  cancelGraceMs?: number;
  onLog?: (message: string, fields?: Record<string, unknown>) => void;
}

interface PendingCall {
  resolve: (response: RunnerInvokeResponse) => void;
  timer: NodeJS.Timeout;
  /** The process this call was sent to, so a dying process fails only its own calls. */
  child: ChildProcess;
  artifacts: RunnerArtifact[];
  artifactBytes: number;
  detachAbort: () => void;
}

type AdmissionResult = "acquired" | "timeout" | "cancelled" | "full";

class StartWaitFailure extends Error {
  constructor(
    readonly kind: "timeout" | "runner-unavailable",
    message: string,
  ) {
    super(message);
  }
}

class StartInterruptedFailure extends Error {}

interface QueuedCall {
  resolve: (result: AdmissionResult) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ExtensionHost {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<string, PendingCall>();
  private queue: QueuedCall[] = [];
  /** Processes taken out of service, waiting for their remaining calls to finish. */
  private condemned = new Set<ChildProcess>();
  private interruptedStarts = new Set<ChildProcess>();
  private startupWaiters = new Map<Promise<void>, number>();
  private running = 0;
  private loadFailure: string | null = null;
  private stopped = false;

  readonly manifest: ExtensionManifest;

  constructor(
    private readonly bundle: LoadedBundle,
    private readonly options: ExtensionHostOptions = {},
  ) {
    this.manifest = bundle.manifest;
  }

  get name(): string {
    return this.manifest.name;
  }

  get nodeTypes(): string[] {
    return this.manifest.nodes.map((node) => node.type);
  }

  get communicationChannelIds(): string[] {
    return (this.manifest.communicationChannels ?? []).map((channel) => channel.id);
  }

  /** True while the extension is usable: it loaded and has not been left in a failed state. */
  get healthy(): boolean {
    return this.loadFailure === null;
  }

  get lastFailure(): string | null {
    return this.loadFailure;
  }

  async invoke(request: RunnerInvokeRequest, signal?: AbortSignal): Promise<RunnerInvokeResponse> {
    if (this.stopped) {
      return { ok: false, kind: "runner-unavailable", message: "extension host is stopping" };
    }
    const startedAt = Date.now();
    const admission = await this.acquire(request.timeoutMs, signal);
    if (admission === "timeout") {
      return {
        ok: false,
        kind: "timeout",
        message: `call exceeded its deadline of ${request.timeoutMs} ms while waiting to run`,
      };
    }
    if (admission === "cancelled") {
      return {
        ok: false,
        kind: "runner-unavailable",
        message: "caller disconnected before the extension invocation began",
      };
    }
    if (admission === "full") {
      return {
        ok: false,
        kind: "runner-unavailable",
        message: "extension invocation queue is full",
      };
    }

    try {
      const remainingMs = request.timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        return {
          ok: false,
          kind: "timeout",
          message: `call exceeded its deadline of ${request.timeoutMs} ms while waiting to run`,
        };
      }
      return await this.invokeNow(request, startedAt + request.timeoutMs, signal);
    } finally {
      this.release();
    }
  }

  private acquire(timeoutMs: number, signal?: AbortSignal): Promise<AdmissionResult> {
    const limit = Math.max(1, this.options.maxConcurrent ?? 4);
    if (signal?.aborted) return Promise.resolve("cancelled");
    if (this.running < limit) {
      this.running += 1;
      return Promise.resolve("acquired");
    }

    const maxQueued = Math.max(0, this.options.maxQueued ?? 100);
    if (this.queue.length >= maxQueued) return Promise.resolve("full");

    return new Promise<AdmissionResult>((resolve) => {
      const waiter: QueuedCall = {
        resolve,
        timer: setTimeout(() => this.settleQueued(waiter, "timeout", true), timeoutMs),
        signal,
      };
      if (signal) {
        waiter.onAbort = () => this.settleQueued(waiter, "cancelled", true);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private settleQueued(
    waiter: QueuedCall,
    result: AdmissionResult,
    removeFromQueue: boolean,
  ): void {
    if (removeFromQueue) {
      const index = this.queue.indexOf(waiter);
      if (index === -1) return;
      this.queue.splice(index, 1);
    }
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(result);
  }

  private release(): void {
    this.running -= 1;
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.signal?.aborted) {
        this.settleQueued(waiter, "cancelled", false);
        continue;
      }
      this.running += 1;
      this.settleQueued(waiter, "acquired", false);
      return;
    }
  }

  private async invokeNow(
    request: RunnerInvokeRequest,
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<RunnerInvokeResponse> {
    try {
      await this.ensureStartedWithin(deadlineAt, request.timeoutMs, signal);
    } catch (error) {
      return {
        ok: false,
        kind: error instanceof StartWaitFailure ? error.kind : "handler-error",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return {
        ok: false,
        kind: "timeout",
        message: `call exceeded its deadline of ${request.timeoutMs} ms during handler startup`,
      };
    }

    const child = this.child;
    if (!child || !child.connected) {
      return { ok: false, kind: "runner-unavailable", message: "handler process is not running" };
    }

    const id = randomUUID();
    return new Promise<RunnerInvokeResponse>((resolve) => {
      const timer = setTimeout(() => {
        // The handler is told first and killed afterwards. Telling it is what lets a well-behaved
        // handler stop its own work and release what it holds; killing it is what makes the
        // deadline true for a handler that ignores the signal.
        this.finishCall(
          id,
          {
            ok: false,
            kind: "timeout",
            message: `call exceeded its deadline of ${request.timeoutMs} ms`,
          },
          true,
        );
      }, remainingMs);

      const onAbort = () => {
        this.finishCall(
          id,
          {
            ok: false,
            kind: "runner-unavailable",
            message: "caller disconnected during the extension invocation",
          },
          true,
        );
      };
      const detachAbort = () => signal?.removeEventListener("abort", onAbort);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve,
        timer,
        child,
        artifacts: [],
        artifactBytes: 0,
        detachAbort,
      });
      child.send({ kind: "invoke", id, request });
    });
  }

  private finishCall(id: string, response: RunnerInvokeResponse, retire: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.detachAbort();
    this.pending.delete(id);
    if (retire) this.retire(pending.child, id);
    pending.resolve(response);
    if (!retire) this.killIfDrained(pending.child);
  }

  private ensureStarted(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(
        new StartWaitFailure("runner-unavailable", "extension host is stopping"),
      );
    }
    if (this.starting) return this.starting;
    if (this.child && this.child.connected) return Promise.resolve();

    this.starting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = fork(HANDLER_HOST, [], {
        cwd: this.bundle.directory,
        execArgv: this.options.execArgv ?? process.execArgv,
        env: {
          // A deliberately narrow environment: the handler process does not inherit the service's
          // configuration, database path or secrets.
          PATH: process.env.PATH,
          NODE_ENV: process.env.NODE_ENV,
          MOIRA_EXTENSION_ENTRYPOINT: this.bundle.entrypoint,
          MOIRA_EXTENSION_MANIFEST: JSON.stringify(this.manifest),
        },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });

      const onReady = (raw: unknown) => {
        const message = raw as HostResponse;
        if (
          message &&
          message.kind === "ready" &&
          Array.isArray(message.nodeTypes) &&
          message.nodeTypes.every((type) => typeof type === "string") &&
          Array.isArray(message.communicationChannelIds) &&
          message.communicationChannelIds.every((id) => typeof id === "string")
        ) {
          settled = true;
          this.loadFailure = null;
          child.off("message", onReady);
          child.on("message", (next: unknown) => this.onMessage(child, next));
          resolve();
        } else if (
          message &&
          message.kind === "load-failed" &&
          typeof message.message === "string"
        ) {
          settled = true;
          this.loadFailure = message.message;
          child.off("message", onReady);
          child.kill("SIGKILL");
          reject(new Error(message.message));
        } else {
          settled = true;
          this.loadFailure = "handler process sent an invalid startup message";
          child.off("message", onReady);
          child.kill("SIGKILL");
          reject(new Error(this.loadFailure));
        }
      };

      child.on("message", onReady);
      // The exit handler is bound to this exact child: a late exit event from a process we already
      // replaced must not clear the reference to its successor.
      child.on("exit", (code, signal) => {
        // A process that dies before it ever says "ready" reports nothing at all: the bundle's
        // module graph may fail to resolve, or its top level may exit the process. Without this
        // the start promise would neither resolve nor reject, and the call would wait forever.
        if (!settled) {
          settled = true;
          if (this.interruptedStarts.delete(child)) {
            reject(new StartInterruptedFailure("shared handler startup was interrupted"));
          } else {
            this.loadFailure = `handler process exited before it was ready (code ${code ?? "none"}, signal ${signal ?? "none"})`;
            reject(new Error(this.loadFailure));
          }
        }
        this.interruptedStarts.delete(child);
        this.onExit(child, code, signal);
      });
      child.on("error", (error) => {
        settled = true;
        this.loadFailure = error.message;
        reject(error);
      });

      this.child = child;
    }).finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  private async ensureStartedWithin(
    deadlineAt: number,
    originalTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    for (;;) {
      try {
        await this.waitForStartAttempt(deadlineAt, originalTimeoutMs, signal);
        return;
      } catch (error) {
        if (this.stopped) {
          throw new StartWaitFailure("runner-unavailable", "extension host is stopping");
        }
        if (
          error instanceof StartInterruptedFailure &&
          !this.stopped &&
          !signal?.aborted &&
          deadlineAt > Date.now()
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  private waitForStartAttempt(
    deadlineAt: number,
    originalTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return Promise.reject(
        new StartWaitFailure(
          "timeout",
          `call exceeded its deadline of ${originalTimeoutMs} ms during handler startup`,
        ),
      );
    }

    const starting = this.ensureStarted();
    this.startupWaiters.set(starting, (this.startupWaiters.get(starting) ?? 0) + 1);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const remainingWaiters = (this.startupWaiters.get(starting) ?? 1) - 1;
        if (remainingWaiters > 0) this.startupWaiters.set(starting, remainingWaiters);
        else this.startupWaiters.delete(starting);
        if (error === undefined) resolve();
        else reject(error);
      };
      const terminateStartingChild = () => {
        if ((this.startupWaiters.get(starting) ?? 0) > 0 || this.starting !== starting) return;
        const child = this.child;
        if (child) {
          this.interruptedStarts.add(child);
          if (this.child === child) this.child = null;
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        finish(
          new StartWaitFailure(
            "timeout",
            `call exceeded its deadline of ${originalTimeoutMs} ms during handler startup`,
          ),
        );
        terminateStartingChild();
      }, remainingMs);
      const onAbort = () => {
        finish(
          new StartWaitFailure(
            "runner-unavailable",
            "caller disconnected during extension handler startup",
          ),
        );
        terminateStartingChild();
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      starting.then(
        () => finish(),
        (error) => finish(error),
      );
    });
  }

  private onMessage(child: ChildProcess, raw: unknown): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.rejectProtocol(child, "handler process sent a non-object IPC message");
      return;
    }
    const message = raw as HostResponse;
    if (message.kind === "log") {
      if (
        typeof message.id !== "string" ||
        typeof message.message !== "string" ||
        (message.fields !== undefined &&
          (!message.fields || typeof message.fields !== "object" || Array.isArray(message.fields)))
      ) {
        this.rejectProtocol(child, "handler process sent an invalid log message");
        return;
      }
      this.options.onLog?.(message.message, message.fields);
      return;
    }
    if (message.kind === "artifact") {
      if (
        typeof message.id !== "string" ||
        typeof message.name !== "string" ||
        typeof message.content !== "string"
      ) {
        this.rejectProtocol(child, "handler process sent an invalid artifact message");
        return;
      }
      const pendingCall = this.pending.get(message.id);
      if (!pendingCall) return;
      if (pendingCall.child !== child) {
        this.rejectProtocol(child, "handler process addressed another process's call");
        return;
      }

      // This is the only place the limit is enforced, deliberately. The handler process runs
      // extension code and can send this message itself, so a check made there would bind only
      // well-behaved extensions; here is where the service's memory and Moira's response are.
      const size = Buffer.byteLength(message.content, "utf-8");
      if (
        size > MAX_ARTIFACT_BYTES ||
        pendingCall.artifactBytes + size > MAX_ARTIFACT_BYTES_PER_CALL
      ) {
        this.finishCall(
          message.id,
          {
            ok: false,
            kind: "handler-error",
            message: `artifact '${message.name}' exceeds the artifact size limit of this runner`,
          },
          true,
        );
        return;
      }

      // Held until the call finishes: an artifact belongs to a result, and a call that fails
      // afterwards must not leave one behind.
      pendingCall.artifactBytes += size;
      pendingCall.artifacts.push({ name: message.name, content: message.content });
      return;
    }
    if (message.kind !== "result") {
      this.rejectProtocol(child, "handler process sent an unknown IPC message");
      return;
    }

    if (typeof message.id !== "string" || !this.isRunnerResponse(message.response)) {
      this.rejectProtocol(child, "handler process sent an invalid result message");
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (pending.child !== child) {
      this.rejectProtocol(child, "handler process addressed another process's call");
      return;
    }
    let response = message.response;
    if (message.response.ok && pending.artifacts.length > 0) {
      response = { ...message.response, artifacts: pending.artifacts };
    }
    this.finishCall(message.id, response, false);
  }

  private isRunnerResponse(value: unknown): value is RunnerInvokeResponse {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const response = value as Record<string, unknown>;
    if (response.ok === true) {
      return Boolean(
        response.output && typeof response.output === "object" && !Array.isArray(response.output),
      );
    }
    return (
      response.ok === false &&
      ["handler-error", "timeout", "runner-unavailable", "invalid-output"].includes(
        String(response.kind),
      ) &&
      typeof response.message === "string"
    );
  }

  private rejectProtocol(child: ChildProcess, message: string): void {
    this.loadFailure = message;
    if (this.child === child) this.child = null;
    this.failCallsOf(child, message);
    child.kill("SIGKILL");
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child === child) this.child = null;
    this.condemned.delete(child);
    // Only the calls that were sent to this process fail; a call already running on its successor
    // is untouched, and the next call starts a new process.
    this.failCallsOf(
      child,
      `handler process exited (code ${code ?? "none"}, signal ${signal ?? "none"})`,
    );
  }

  /** Fail every in-flight call that belongs to one process. */
  private failCallsOf(child: ChildProcess, message: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.child !== child) continue;
      clearTimeout(pending.timer);
      pending.detachAbort();
      this.pending.delete(id);
      pending.resolve({ ok: false, kind: "runner-unavailable", message });
    }
  }

  /**
   * Take a process out of service: the next call forks a fresh one, this one is told the call was
   * cancelled and is killed once nothing healthy is left running in it.
   *
   * The wait matters. With several calls sharing a process, killing on the spot would fail calls
   * that are within their own deadline for a reason belonging to a different call. So the process
   * is detached immediately — no new call goes to it — the cancelled call is told, and the kill
   * happens once the process has no other calls, or at the latest when their own deadlines have
   * retired them in turn.
   */
  private retire(child: ChildProcess, cancelledId: string): void {
    if (this.child === child) this.child = null;
    if (child.connected) {
      try {
        child.send({ kind: "cancel", id: cancelledId });
      } catch {
        // A process that already went away needs no cancellation.
      }
    }
    this.condemned.add(child);
    const grace = this.options.cancelGraceMs ?? 250;
    setTimeout(() => this.killIfDrained(child), grace).unref();
  }

  /** Kill a retired process once no call is still running in it. */
  private killIfDrained(child: ChildProcess): void {
    if (!this.condemned.has(child)) return;
    for (const pending of this.pending.values()) {
      // Someone else is still within their deadline in this process; their own timeout will bring
      // us back here.
      if (pending.child === child) return;
    }
    this.condemned.delete(child);
    child.kill("SIGKILL");
  }

  /** Permanently stop this host and refuse queued or future work during service shutdown. */
  stop(reason?: string): void {
    this.stopped = true;
    for (const waiter of [...this.queue]) this.settleQueued(waiter, "cancelled", true);

    const children = new Set(this.condemned);
    if (this.child) children.add(this.child);
    this.child = null;
    this.condemned.clear();
    for (const child of children) {
      this.failCallsOf(child, reason ?? "handler process stopped");
      child.kill("SIGKILL");
    }
  }
}
