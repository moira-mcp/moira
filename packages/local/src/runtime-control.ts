import { PassThrough } from "node:stream";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { LocalRefusal, type LocalPolicy } from "./policy.js";
import { runProcess, type ProcessResult } from "./process.js";
import { SbxRuntime } from "./sbx-runtime.js";
import { runtimeControlAsset } from "./assets.js";

/** Locally selected kernel peers. This contract is never deserialized from a cloud request. */
export interface RuntimeControlIdentity {
  root: string;
  executable: string;
  sockets: readonly string[];
  /** Fixed Darwin SDK worker mode; its executable is derived in the native helper. */
  transport?: "vm";
}
interface RuntimeLaunchIdentity {
  root: string;
  executable: string;
  environment: Readonly<Record<string, string>>;
  initialize: boolean;
}

export interface RuntimeCoverage {
  runtimeId: string;
  name: string;
  containerId: string;
  state: "running" | "stopped";
  generation?: number;
  expectedStopGeneration?: number;
}
interface CapturedBinding {
  runtimeId: string;
  name: string;
  generation?: number;
}

/** Fixed private SDK control paths; unknown executables are refused by the native capture. */
export class DeviceRuntimeControl {
  private readonly controls = new Map<string, RuntimeControl>();
  private tail: Promise<void> = Promise.resolve();
  private stopping?: Promise<void>;
  private retired = false;
  private readonly bindings = new Map<string, CapturedBinding>();
  constructor(
    private readonly policy: LocalPolicy,
    private readonly readCoverage?: (control: DeviceRuntimeControl) => Promise<RuntimeCoverage[]>,
  ) {}

  async assertDaemonHeld(): Promise<void> {
    const context = new SbxRuntime(this.policy);
    const socket = join(
      context.home,
      ".sbx",
      `run_${context.environment.DOCKER_SANDBOXES_APP_NAME}`,
      "d",
      "sandboxd.sock",
    );
    if (this.stopping || this.retired || !this.controls.get(socket)?.active)
      throw new LocalRefusal(
        "LOCAL_CONTROL_RETIRED",
        "The captured daemon incarnation is no longer held.",
      );
    await this.controls.get(socket)!.check();
  }

  async assertDockerHeld(): Promise<void> {
    await this.assertDaemonHeld();
    const context = new SbxRuntime(this.policy);
    const socket = join(
      context.home,
      ".sbx",
      `run_${context.environment.DOCKER_SANDBOXES_APP_NAME}`,
      "d",
      "docker.sock",
    );
    const control = this.controls.get(socket);
    if (!control?.active)
      throw new LocalRefusal(
        "LOCAL_CONTROL_RETIRED",
        "The captured SDK Engine incarnation is no longer held.",
      );
    await control.check();
  }

  get captured(): boolean {
    return this.controls.size > 0;
  }

  private capture(shutdown: boolean): Promise<void> {
    const work = this.tail.then(async () => {
      if (this.stopping || (!shutdown && this.retired))
        throw new LocalRefusal("LOCAL_CONTROL_RETIRED", "The owned runtime incarnation changed.");
      const context = new SbxRuntime(this.policy);
      const root = context.home;
      const namespace = context.environment.DOCKER_SANDBOXES_APP_NAME;
      const directory = join(root, ".sbx", `run_${namespace}`);
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT")
            throw new LocalRefusal(
              "LOCAL_CONTROL_ABSENT",
              "The private runtime control directory is absent.",
            );
          throw error;
        },
      );
      const daemonSocket = join(directory, "d", "sandboxd.sock");
      const dockerSocket = join(directory, "d", "docker.sock");
      const sockets = [
        daemonSocket,
        dockerSocket,
        ...entries
          .filter((entry) => entry.isSocket() && /^[a-f0-9]{12}-vm\.sock$/.test(entry.name))
          .map((entry) => join(directory, entry.name)),
      ];
      for (const socket of sockets) {
        const existing = this.controls.get(socket);
        if (existing) {
          if (!shutdown || existing.active) continue;
          await existing.stop();
          this.controls.delete(socket);
        }
        const control = await RuntimeControl.capture({
          root,
          executable: this.policy.runtime.binary,
          sockets: [socket],
          transport: socket === daemonSocket || socket === dockerSocket ? undefined : "vm",
        }).catch(async (error: unknown) => {
          if (error instanceof LocalRefusal && error.code === "LOCAL_CONTROL_ABSENT") {
            if (socket === daemonSocket && !shutdown) throw error;
            if (socket === dockerSocket && !shutdown)
              throw new LocalRefusal(
                "LOCAL_CONTROL_WORKER_UNVERIFIED",
                "The SDK Engine endpoint is absent.",
              );
            return undefined;
          }
          throw error;
        });
        if (!control) continue;
        this.controls.set(socket, control);
        if (this.stopping) {
          await control.stop();
          throw new LocalRefusal("LOCAL_NOT_RUNNING", "Runtime work was revoked during capture.");
        }
      }
      if (shutdown) {
        this.retired = true;
        if (!this.controls.size)
          throw new LocalRefusal(
            "LOCAL_CONTROL_ABSENT",
            "The complete private kernel endpoint set is absent.",
          );
        return;
      }
      await this.assertDockerHeld();
      if (!this.readCoverage)
        throw new LocalRefusal(
          "LOCAL_CONTROL_WORKER_UNVERIFIED",
          "No provider-owned coverage reader.",
        );
      const rows = await this.readCoverage(this);
      await this.assertDockerHeld();
      if (
        new Set(rows.map((row) => row.runtimeId)).size !== rows.length ||
        new Set(rows.map((row) => row.name)).size !== rows.length ||
        new Set(rows.map((row) => row.containerId)).size !== rows.length
      )
        throw new LocalRefusal(
          "LOCAL_CONTROL_WORKER_UNVERIFIED",
          "Ambiguous SDK container identity.",
        );
      const byContainer = new Map(rows.map((row) => [row.containerId, row]));
      const active = new Set<string>();
      for (const [socket, control] of this.controls) {
        if (socket === daemonSocket || socket === dockerSocket) continue;
        const id = control.containerId;
        const row = id ? byContainer.get(id) : undefined;
        const binding = id ? this.bindings.get(id) : undefined;
        if (
          !id ||
          !row ||
          (binding && (binding.runtimeId !== row.runtimeId || binding.name !== row.name))
        )
          throw new LocalRefusal(
            "LOCAL_CONTROL_WORKER_UNVERIFIED",
            "A captured worker has no exact SDK container binding.",
          );
        if (row.state === "stopped") {
          if (
            !binding ||
            binding.generation === undefined ||
            row.expectedStopGeneration === undefined ||
            row.expectedStopGeneration <= binding.generation
          )
            throw new LocalRefusal(
              "LOCAL_CONTROL_RETIRED",
              "A VM worker retired without a durable matching stop intent.",
            );
          await control.stop();
          this.controls.delete(socket);
          this.bindings.delete(id);
          continue;
        }
        await control.check();
        if (active.has(id))
          throw new LocalRefusal(
            "LOCAL_CONTROL_WORKER_UNVERIFIED",
            "Duplicate captured container identity.",
          );
        active.add(id);
        if (!binding)
          this.bindings.set(id, {
            runtimeId: row.runtimeId,
            name: row.name,
            generation: row.generation,
          });
        else if (binding.generation === undefined && row.generation !== undefined)
          binding.generation = row.generation;
      }
      const running = rows.filter((row) => row.state === "running");
      if (running.length !== active.size || running.some((row) => !active.has(row.containerId)))
        throw new LocalRefusal(
          "LOCAL_CONTROL_WORKER_UNVERIFIED",
          "Running SDK containers do not match the held worker incarnations.",
        );
    });
    const settled = work.catch(async (error: unknown) => {
      this.retired = true;
      const cleanup = await Promise.allSettled(
        [...this.controls.values()].map((control) => control.stop()),
      );
      if (cleanup.some((result) => result.status === "rejected"))
        throw new LocalRefusal(
          "LOCAL_STOP_PENDING",
          "Partially captured runtime shutdown is unconfirmed.",
        );
      throw error;
    });
    this.tail = settled.catch(() => undefined);
    return settled;
  }

  protect(): Promise<void> {
    return this.capture(false);
  }

  /** Closure only: captures fixed kernel peers without SDK credentials or work admission. */
  captureForShutdown(): Promise<void> {
    return this.capture(true);
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      await this.tail;
      const results = await Promise.allSettled([...this.controls.values()].map((c) => c.stop()));
      if (!this.controls.size || results.some((result) => result.status === "rejected"))
        throw new LocalRefusal("LOCAL_STOP_PENDING", "Kernel runtime shutdown is unconfirmed.");
    })();
    return this.stopping;
  }
}

/** The companion holds audit tokens/pidfds until fixed stop or parent pipe loss. */
export class RuntimeControl {
  private readonly input = new PassThrough();
  private completion: Promise<ProcessResult>;
  private stopping?: Promise<void>;
  private alive = true;
  private checkTail: Promise<void> = Promise.resolve();
  private acknowledge?: () => void;
  private container?: string;
  private constructor(
    identity: RuntimeControlIdentity | RuntimeLaunchIdentity,
    ready: (value: void) => void,
  ) {
    let frame = "";
    this.completion = runProcess({
      binary: runtimeControlAsset(),
      argv:
        "sockets" in identity
          ? [
              ...(identity.transport === "vm" ? ["--vm"] : []),
              identity.root,
              identity.executable,
              ...identity.sockets,
            ]
          : [identity.initialize ? "--initialize" : "--launch", identity.root, identity.executable],
      cwd: identity.root,
      env: "environment" in identity ? identity.environment : {},
      input: this.input,
      timeoutMs: null,
      maxBytes: 1024,
      retainOutput: true,
      onStdout: (chunk) => {
        frame += chunk.toString("utf8");
        for (;;) {
          const newline = frame.indexOf("\n");
          if (newline < 0) break;
          const line = frame.slice(0, newline);
          frame = frame.slice(newline + 1);
          if (line === '{"ready":true}') ready();
          else if (/^\{"ready":true,"containerId":"[a-f0-9]{64}"\}$/.test(line)) {
            this.container = JSON.parse(line).containerId;
            ready();
          } else if (line === '{"held":true}') this.acknowledge?.();
          else if (line === '{"retired":true}') this.alive = false;
          else if (line !== '{"settled":true}') throw new Error("Invalid fixed control response");
        }
        if (frame.length > 1024) throw new Error("Control response exceeds its bound");
      },
    });
    void this.completion.then(
      () => {
        this.alive = false;
      },
      () => {
        this.alive = false;
      },
    );
  }

  get active(): boolean {
    return this.alive && !this.stopping;
  }

  get containerId(): string | undefined {
    return this.container;
  }

  check(): Promise<void> {
    const work = this.checkTail.then(async () => {
      if (!this.active)
        throw new LocalRefusal("LOCAL_CONTROL_RETIRED", "The captured incarnation retired.");
      const acknowledgement = new Promise<void>((done) => {
        this.acknowledge = done;
      });
      this.input.write("check\n");
      try {
        await Promise.race([
          acknowledgement,
          this.completion.then(() => {
            throw new LocalRefusal(
              "LOCAL_CONTROL_RETIRED",
              "The captured incarnation retired before confirmation.",
            );
          }),
        ]);
        if (!this.active)
          throw new LocalRefusal("LOCAL_CONTROL_RETIRED", "The captured incarnation retired.");
      } finally {
        this.acknowledge = undefined;
      }
    });
    this.checkTail = work.catch(() => undefined);
    return work;
  }

  static async capture(identity: RuntimeControlIdentity): Promise<RuntimeControl> {
    if (!identity.sockets.length || identity.sockets.length > 32)
      throw new LocalRefusal("LOCAL_CONTROL_UNOWNED", "No bounded owned runtime peer set.");
    if (identity.transport === "vm" && identity.sockets.length !== 1)
      throw new LocalRefusal(
        "LOCAL_CONTROL_UNOWNED",
        "One VM incarnation is required per watcher.",
      );
    return this.start(identity);
  }

  static launch(identity: RuntimeLaunchIdentity): Promise<RuntimeControl> {
    return this.start(identity);
  }

  private static async start(
    identity: RuntimeControlIdentity | RuntimeLaunchIdentity,
  ): Promise<RuntimeControl> {
    let ready!: () => void;
    const readiness = new Promise<void>((done) => {
      ready = done;
    });
    const owner = new RuntimeControl(identity, ready);
    // The native helper owns bounded capture and refusal cleanup. A parallel JS
    // timer can expire before its valid deadline plus spawn/IPC delivery.
    try {
      await Promise.race([
        readiness,
        owner.completion.then((result) => {
          throw new LocalRefusal(
            result.exitCode === 3
              ? "LOCAL_STOP_PENDING"
              : result.exitCode === 4
                ? "LOCAL_CONTROL_ABSENT"
                : "LOCAL_CONTROL_UNOWNED",
            "Kernel runtime ownership was refused.",
          );
        }),
      ]);
      return owner;
    } catch (error) {
      owner.input.end();
      await owner.completion.catch(() => undefined);
      throw error;
    }
  }

  /** Call only after all SDK work children have been cancelled and reaped. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.input.end("stop\n");
      const result = await this.completion;
      if (result.exitCode !== 0 || !result.stdout.toString("utf8").endsWith('{"settled":true}\n'))
        throw new LocalRefusal("LOCAL_STOP_PENDING", "Captured runtime processes did not exit.");
    })();
    return this.stopping;
  }
}
