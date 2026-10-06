import { setTimeout as pause } from "node:timers/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { LocalRefusal, type LocalPolicy } from "./policy.js";
import { LocalRecords } from "./space-record.js";
import { SbxRuntime } from "./sbx-runtime.js";
import { runProcess, type RunProcess, type ProcessRequest } from "./process.js";
import { DeviceRuntimeControl, RuntimeControl, type RuntimeCoverage } from "./runtime-control.js";
import { runtimeApiAsset } from "./assets.js";

/** Local device ownership; bootstrap is selected only by the fixed local CLI entry. */
export class RuntimeDeviceOwner {
  readonly runtime: SbxRuntime;
  private control: DeviceRuntimeControl;
  private launch?: RuntimeControl;
  private readonly controller = new AbortController();
  private readonly children = new Set<Promise<unknown>>();
  private opening = true;
  private stopping?: Promise<void>;
  private startup?: Promise<void>;
  private unknownStartup = false;
  private opened = false;

  constructor(
    private readonly records: LocalRecords,
    private readonly initial: LocalPolicy,
    private readonly bootstrap = false,
  ) {
    this.control = this.createControl();
    this.runtime = new SbxRuntime(initial, this.run);
  }

  private createControl(): DeviceRuntimeControl {
    return new DeviceRuntimeControl(this.initial, (control) => this.coverage(control));
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.children.add(work);
    void work.then(
      () => this.children.delete(work),
      () => this.children.delete(work),
    );
    return work;
  }

  private inventoryRead(
    control: DeviceRuntimeControl,
    request: ProcessRequest,
    names: Set<string>,
  ) {
    return this.track(
      (async () => {
        await this.current();
        await control.assertDockerHeld();
        const sdkRead =
          request.binary === this.initial.runtime.binary &&
          request.argv.length === 2 &&
          request.argv[0] === "ls" &&
          request.argv[1] === "--json";
        const containerRead =
          request.binary === process.execPath &&
          request.argv.length === 5 &&
          request.argv[0] === runtimeApiAsset() &&
          request.argv[1] === this.runtime.home &&
          request.argv[2] === this.runtime.environment.DOCKER_SANDBOXES_APP_NAME &&
          request.argv[3] === "container-identity" &&
          names.has(request.argv[4]);
        if ((!sdkRead && !containerRead) || request.stdin || request.input)
          throw new LocalRefusal(
            "LOCAL_CONTROL_WORKER_UNVERIFIED",
            "Only the fixed owned inventory read is admitted.",
          );
        const result = await runProcess({
          ...request,
          signal: request.signal
            ? AbortSignal.any([request.signal, this.controller.signal])
            : this.controller.signal,
        });
        await this.current();
        await control.assertDockerHeld();
        return result;
      })(),
    );
  }

  private async coverage(control: DeviceRuntimeControl): Promise<RuntimeCoverage[]> {
    await this.current();
    await control.assertDockerHeld();
    const names = new Set<string>();
    const observer = new SbxRuntime(
      this.initial,
      (request) => this.inventoryRead(control, request, names),
      () => this.runtime.prepareCredentials(),
    );
    try {
      const rows = await observer.list();
      if (
        rows.some(
          (row) =>
            !z.string().uuid().safeParse(row.id).success ||
            !/^moira-[a-f0-9]{32}$/.test(row.name) ||
            (row.status !== "running" && row.status !== "stopped"),
        ) ||
        new Set(rows.map((row) => row.id)).size !== rows.length ||
        new Set(rows.map((row) => row.name)).size !== rows.length
      )
        throw new LocalRefusal(
          "LOCAL_CONTROL_WORKER_UNVERIFIED",
          "The SDK inventory is not a unique stable VM snapshot.",
        );
      for (const row of rows) names.add(row.name);
      const records = await this.records.list();
      const result: RuntimeCoverage[] = [];
      for (const row of rows) {
        const container = await observer.containerIdentity(row.name);
        if (
          (row.status === "running" && container.state !== "running") ||
          (row.status === "stopped" && container.state !== "exited")
        )
          throw new LocalRefusal(
            "LOCAL_CONTROL_WORKER_UNVERIFIED",
            "SDK and Engine container states do not agree.",
          );
        const matching = records.filter(
          (record) => record.runtimeId === row.id && record.name === row.name,
        );
        if (matching.length > 1)
          throw new LocalRefusal(
            "LOCAL_CONTROL_WORKER_UNVERIFIED",
            "The SDK identity maps to ambiguous durable records.",
          );
        const record = matching[0];
        result.push({
          runtimeId: row.id,
          name: row.name,
          containerId: container.containerId,
          state: row.status as "running" | "stopped",
          generation: record?.generation,
          expectedStopGeneration:
            record && (record.desiredState === "stopped" || record.desiredState === "deleted")
              ? record.generation
              : undefined,
        });
      }
      await this.current();
      await control.assertDockerHeld();
      return result;
    } catch (error) {
      if (error instanceof LocalRefusal && error.code !== "LOCAL_CONTAINER_UNKNOWN") throw error;
      throw new LocalRefusal(
        "LOCAL_CONTROL_WORKER_UNVERIFIED",
        "The fixed SDK container identity could not be verified.",
      );
    }
  }

  private async current(): Promise<void> {
    const policy = await this.records.policy();
    if (
      policy.deviceId !== this.initial.deviceId ||
      JSON.stringify(policy.runtime) !== JSON.stringify(this.initial.runtime)
    )
      throw new LocalRefusal("LOCAL_RUNTIME_CHANGED", "The local runtime profile changed.");
    if (!this.bootstrap && (!policy.enabled || policy.leaseUntil <= Date.now()))
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "Local work is disabled or its lease expired.");
    if (this.stopping || this.controller.signal.aborted)
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "The local device is stopping.");
  }

  private readonly run: RunProcess = (request) => {
    const work = (async () => {
      await this.current();
      if (request.binary === process.execPath && request.argv[0] === runtimeApiAsset())
        await this.protect();
      if (request.binary === this.initial.runtime.binary) {
        const argv = request.argv;
        if (this.bootstrap && argv[0] === "daemon" && argv[1] === "start") {
          if (!this.launch?.active && !this.control.captured) await this.startDaemon(true);
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
        }
        if (this.bootstrap && argv.length === 2 && argv[0] === "daemon" && argv[1] === "restart") {
          await this.restart();
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
        }
        const startupRead =
          this.opening &&
          ((argv.length === 1 && argv[0] === "version") ||
            (argv.length === 3 &&
              argv[0] === "daemon" &&
              argv[1] === "status" &&
              argv[2] === "--json"));
        if (!startupRead) await this.protect();
      }
      return runProcess({
        ...request,
        signal: request.signal
          ? AbortSignal.any([request.signal, this.controller.signal])
          : this.controller.signal,
      });
    })();
    return this.track(work);
  };

  open(): Promise<void> {
    this.startup ??= (async () => {
      await this.current();
      if (process.platform !== "darwin")
        throw new LocalRefusal(
          "LOCAL_RUNTIME_WORKER_UNSUPPORTED",
          "This host lacks a verified kernel-identity capture contract for Docker Sandboxes VM workers.",
        );
      this.opened = true;
      try {
        await this.control.protect();
      } catch (error) {
        if (!(error instanceof LocalRefusal) || error.code !== "LOCAL_CONTROL_ABSENT") throw error;
        this.control = this.createControl();
        await this.startDaemon(this.bootstrap);
      }
      this.opening = false;
      await this.current();
      if (!this.bootstrap) {
        await this.runtime.verifySettings();
        await this.runtime.verifyGlobalNetworkPolicy();
      }
    })();
    return this.startup;
  }

  private async startDaemon(initialize: boolean): Promise<void> {
    await this.current();
    await mkdir(this.runtime.home, { recursive: true, mode: 0o700 });
    await mkdir(join(this.runtime.home, "tmp"), { recursive: true, mode: 0o700 });
    await this.runtime.prepareCredentials();
    await this.runtime.validateExecutable();
    await this.runtime.verifyDaemonOwnership(true);
    await this.current();
    try {
      this.launch = await RuntimeControl.launch({
        root: this.runtime.home,
        executable: this.initial.runtime.binary,
        environment: this.runtime.environment,
        initialize,
      });
    } catch (error) {
      if (error instanceof LocalRefusal && error.code === "LOCAL_STOP_PENDING")
        this.unknownStartup = true;
      throw error;
    }
    const deadline = Date.now() + 30_000;
    for (;;) {
      await this.current();
      if (!this.launch.active)
        throw new LocalRefusal("LOCAL_RUNTIME_FAILED", "The owned daemon exited during startup.");
      const status = z
        .object({ status: z.enum(["running", "stopped"]) })
        .passthrough()
        .parse(
          JSON.parse((await this.runtime.call(["daemon", "status", "--json"])).toString("utf8")),
        );
      if (status.status === "running") break;
      if (Date.now() >= deadline)
        throw new LocalRefusal("LOCAL_COMMAND_TIMEOUT", "Owned daemon startup did not settle.");
      await pause(25, undefined, { signal: this.controller.signal });
    }
    await this.control.protect();
  }

  private async restart(): Promise<void> {
    // No sibling SDK operation may overlap a deliberate local initializer restart.
    await this.control.stop();
    await this.launch?.stop();
    this.control = this.createControl();
    this.launch = undefined;
    this.opening = true;
    try {
      await this.startDaemon(false);
    } finally {
      this.opening = false;
    }
  }

  async protect(): Promise<void> {
    await this.current();
    if (this.launch && !this.launch.active)
      throw new LocalRefusal("LOCAL_CONTROL_RETIRED", "The owned SDK incarnation retired.");
    await this.control.protect();
    await this.current();
  }

  async observe() {
    await this.protect();
    await this.runtime.verifySettings();
    await this.runtime.verifyGlobalNetworkPolicy();
    return this.runtime.list();
  }

  prepareCredentials(): Promise<void> {
    return this.runtime.prepareCredentials();
  }

  revoke(): void {
    this.controller.abort();
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.revoke();
      await Promise.allSettled([...this.children]);
      await this.startup?.catch(() => undefined);
      let unknown = false;
      if (this.opened) {
        try {
          await this.control.captureForShutdown();
        } catch (error) {
          if (!(error instanceof LocalRefusal) || error.code !== "LOCAL_CONTROL_ABSENT")
            unknown = true;
        }
      }
      const results = await Promise.allSettled([
        ...(this.control.captured ? [this.control.stop()] : []),
        ...(this.launch ? [this.launch.stop()] : []),
      ]);
      if (this.opened) {
        const remaining = new DeviceRuntimeControl(this.initial);
        try {
          await remaining.captureForShutdown();
          await remaining.stop();
        } catch (error) {
          if (!(error instanceof LocalRefusal) || error.code !== "LOCAL_CONTROL_ABSENT")
            unknown = true;
        }
      }
      if (unknown || this.unknownStartup || results.some((result) => result.status === "rejected"))
        throw new LocalRefusal("LOCAL_STOP_PENDING", "Owned kernel processes did not settle.");
    })();
    return this.stopping;
  }
}
