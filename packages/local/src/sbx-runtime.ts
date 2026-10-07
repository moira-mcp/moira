import { lstat, mkdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { z } from "zod";
import { LocalRefusal, SUPPORTED_SBX_VERSION, type LocalPolicy } from "./policy.js";
import { runProcess, type RunProcess, type ProcessResult } from "./process.js";
import {
  keychainAsset,
  runtimeApiAsset,
  GUEST_INSTALL_COMMAND,
  GUEST_WORKER_COMMAND,
  VERIFIED_GUEST_FAILURE_EXIT,
} from "./assets.js";
import { prepareKeychain } from "./keychain.js";

const sandboxSchema = z
  .object({
    id: z.string().min(1).max(255),
    name: z.string().min(1).max(128),
    agent: z.string(),
    status: z.enum(["running", "stopped", "starting", "stopping", "created", "error"]),
  })
  .passthrough();
const inventorySchema = z.object({ sandboxes: z.array(sandboxSchema).max(128) }).passthrough();
export type SandboxObservation = z.infer<typeof sandboxSchema>;
import type { LocalVmIdentity as SandboxIdentity } from "./local-vm-runtime.js";
import type { FixedGuestEntrypoint, LocalVmDispatchAdmission } from "./local-vm-runtime.js";
export const containerIdentitySchema = z
  .object({
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().regex(/^moira-[a-f0-9]{32}$/),
    state: z.enum(["created", "running", "paused", "restarting", "removing", "exited", "dead"]),
  })
  .strict();
export type ContainerIdentity = z.infer<typeof containerIdentitySchema>;
const NAME = /^moira-[a-f0-9]{32}$/;
const NETWORK_PROMPTS_DISABLED = { enabled: false, variant: "", variantPayload: "" } as const;
const networkPromptsSchema = z
  .object({ enabled: z.literal(false), variant: z.literal(""), variantPayload: z.literal("") })
  .strict();
const REQUIRED_SETTINGS: Readonly<
  Record<string, string | boolean | typeof NETWORK_PROMPTS_DISABLED>
> = {
  "feature.network-user-prompts": NETWORK_PROMPTS_DISABLED,
  "env.rememberHostCommands": false,
  "ssh.autoCreate": false,
  "ssh.workspaceRoot": "",
  "clipboard.imagePaste": false,
  "ssh.agentForwardingEnabled": false,
  "ssh.agentSocketPath": "",
  "skills.defaultMode": "off",
  "diagnostics.autoUpload": "no",
  "proxy.integratedAuth": false,
  "proxy.sandbox": "direct",
  "no_proxy.sandbox": "",
};

/** Every invocation is fixed locally; this object is never constructed from a relay message. */
export class SbxRuntime {
  private credentials: Promise<void> | undefined;
  readonly home: string;
  readonly environment: Readonly<Record<string, string>>;
  constructor(
    readonly policy: LocalPolicy,
    private readonly run: RunProcess = runProcess,
    private readonly credentialPreparation?: () => Promise<void>,
  ) {
    this.home = join(policy.runtime.storageRoot, "runtime");
    this.environment = {
      HOME: this.home,
      PATH: `${dirname(policy.runtime.binary)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: join(this.home, "tmp"),
      XDG_CONFIG_HOME: join(this.home, ".config"),
      XDG_CACHE_HOME: join(this.home, ".cache"),
      XDG_STATE_HOME: join(this.home, ".local", "state"),
      XDG_DATA_HOME: join(this.home, ".local", "share"),
      DOCKER_CONFIG: join(this.home, ".docker"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      DOCKER_SANDBOXES_DOCKER_SIZE: `${policy.runtime.dockerBytes / 1024 ** 2}m`,
      DOCKER_SANDBOXES_CLIPBOARD_IMAGE_PASTE: "false",
      DOCKER_SANDBOXES_APP_NAME: `moira-${policy.deviceId.replaceAll("-", "").slice(0, 14)}`,
      SBX_NO_TELEMETRY: "1",
    };
  }

  async call(
    argv: readonly string[],
    stdin?: Uint8Array,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    await this.prepareCredentials();
    if (
      argv[0] === "settings" ||
      argv[0] === "policy" ||
      (argv[0] === "daemon" && ["start", "restart"].includes(argv[1]))
    ) {
      await this.verifyDaemonOwnership(argv[0] === "daemon" && argv[1] === "start");
    }
    const result = await this.run({
      binary: this.policy.runtime.binary,
      argv,
      cwd: this.home,
      env: this.environment,
      stdin,
      timeoutMs,
      maxBytes: 8 * 1024 * 1024,
      signal,
    });
    if (result.exitCode !== 0) {
      if (/sun_path limit|no usable network socket dir/.test(result.stderr.toString("utf8"))) {
        throw new LocalRefusal(
          "LOCAL_RUNTIME_PATH_TOO_LONG",
          "Mount the locally owned bounded storage at a shorter canonical path before starting Docker Sandboxes.",
        );
      }
      const authentication =
        /not authenticated|not signed in|no valid user session|401 Unauthorized/.test(
          result.stderr.toString("utf8"),
        );
      throw new LocalRefusal(
        authentication ? "LOCAL_DOCKER_LOGIN_REQUIRED" : "LOCAL_RUNTIME_FAILED",
        authentication
          ? "Sign in to Docker using moira-local login."
          : "Docker Sandboxes refused the operation; run moira-local doctor locally.",
      );
    }
    return result.stdout;
  }

  async prepareCredentials(options: { newStore?: boolean } = {}): Promise<void> {
    if (this.credentialPreparation) return this.credentialPreparation();
    if (process.platform !== "darwin") {
      if (options.newStore)
        throw new LocalRefusal(
          "LOCAL_KEYCHAIN_PLATFORM",
          "A separate macOS SDK Keychain is available only on macOS.",
        );
      return;
    }
    if (options.newStore && this.credentials)
      throw new LocalRefusal(
        "LOCAL_KEYCHAIN_BUSY",
        "Wait for credential preparation before explicitly creating a new store.",
      );
    this.credentials ??= prepareKeychain(
      this.home,
      this.policy.deviceId,
      keychainAsset(),
      this.run,
      this.environment,
      options,
    ).finally(() => {
      this.credentials = undefined;
    });
    await this.credentials;
  }

  /** Native control aliases are shared by UID; never adopt an alias outside our private HOME. */
  async verifyDaemonOwnership(allowStopped = false): Promise<void> {
    const refusal = () =>
      new LocalRefusal(
        "LOCAL_DAEMON_UNOWNED",
        "The sandbox daemon control path does not belong to this local device.",
      );
    const home = await realpath(this.home);
    const homeMetadata = await lstat(home);
    if (
      home !== this.home ||
      !homeMetadata.isDirectory() ||
      (homeMetadata.mode & 0o077) !== 0 ||
      (process.getuid && homeMetadata.uid !== process.getuid())
    )
      throw refusal();
    let observation: unknown;
    try {
      observation = JSON.parse((await this.call(["daemon", "status", "--json"])).toString("utf8"));
    } catch (error) {
      if (error instanceof LocalRefusal) throw error;
      throw refusal();
    }
    const status = z
      .object({
        status: z.enum(["running", "stopped"]),
        socket: z.string().min(1),
      })
      .safeParse(observation);
    if (
      !status.success ||
      !isAbsolute(status.data.socket) ||
      basename(status.data.socket) !== "sandboxd.sock"
    )
      throw refusal();
    const namespace = this.environment.DOCKER_SANDBOXES_APP_NAME;
    const direct = join(home, ".sbx", `run_${namespace}`, "d", "sandboxd.sock");
    const aliasName = `sboxd-${process.getuid?.()}-sandboxes-${namespace}`;
    if (
      status.data.socket !== direct &&
      status.data.socket !== join("/tmp", aliasName, "sandboxd.sock") &&
      status.data.socket !== join("/private/tmp", aliasName, "sandboxd.sock")
    )
      throw refusal();
    let control: string;
    try {
      control = await realpath(dirname(status.data.socket));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        allowStopped &&
        status.data.status === "stopped"
      ) {
        // An absent alias can be created; a dangling pre-existing alias must not be adopted.
        const alias = await lstat(dirname(status.data.socket)).catch(
          (failure: NodeJS.ErrnoException) => {
            if (failure.code !== "ENOENT") throw refusal();
            return null;
          },
        );
        if (!alias) return;
      }
      throw refusal();
    }
    const metadata = await lstat(control);
    if (
      !control.startsWith(`${home}${sep}`) ||
      !metadata.isDirectory() ||
      (process.getuid && metadata.uid !== process.getuid()) ||
      (!allowStopped && status.data.status !== "running")
    )
      throw refusal();
  }

  async validateExecutable(): Promise<void> {
    const binary = this.policy.runtime.binary;
    const metadata = await lstat(binary);
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o022) !== 0 ||
      (await realpath(binary)) !== binary
    ) {
      throw new LocalRefusal(
        "LOCAL_BINARY_UNSAFE",
        "Use a canonical, non-writable-by-others sbx executable.",
      );
    }
    const version = (await this.call(["version"])).toString("utf8");
    if (
      !new RegExp(`^sbx version: v${SUPPORTED_SBX_VERSION.replaceAll(".", "\\.")}\\s`).test(version)
    ) {
      throw new LocalRefusal(
        "LOCAL_RUNTIME_VERSION",
        `This adapter supports sbx ${SUPPORTED_SBX_VERSION}; validate a new version before upgrading.`,
      );
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await mkdir(join(this.home, "tmp"), { mode: 0o700, recursive: true });
    await this.validateExecutable();
    await this.prepareCredentials();
    await this.call(["daemon", "start", "--detach", "--policy", "deny-all"]);
    await this.verifyDaemonOwnership();
    if ((await this.list()).length !== 0)
      throw new LocalRefusal(
        "LOCAL_RUNTIME_NOT_EMPTY",
        "Refusing to reset a runtime containing sandboxes.",
      );
    const udpPresent = await this.verifyNetworkDenial(false, true);
    for (const [key, value] of Object.entries(REQUIRED_SETTINGS))
      await this.call([
        "settings",
        "set",
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      ]);
    if (!udpPresent) await this.call(["policy", "deny", "network", "--protocol", "udp", "**"]);
    await this.call(["daemon", "restart"]);
    await this.verifyInitialNetworkPolicy();
    await this.verifySettings();
  }

  /** The pinned deny-all preset supplies implicit TCP denial; only UDP needs a global rule. */
  private async verifyInitialNetworkPolicy(): Promise<void> {
    await this.verifyNetworkDenial(false);
  }

  /** Existing sandboxes may retain their broker grants; global policy must remain deny-all. */
  async verifyGlobalNetworkPolicy(): Promise<void> {
    await this.verifyNetworkDenial(true);
  }

  private async verifyNetworkDenial(globalOnly: boolean, allowEmpty = false): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse((await this.call(["policy", "ls", "--json"])).toString("utf8"));
    } catch (error) {
      if (error instanceof LocalRefusal) throw error;
      throw new LocalRefusal(
        "LOCAL_NETWORK_UNSAFE",
        "The global network denial could not be verified.",
      );
    }
    const observation = z
      .object({ rules: z.array(z.object({ resource_type: z.string() }).passthrough()) })
      .safeParse(parsed);
    const rules = observation.success
      ? observation.data.rules.filter(
          (rule) =>
            !rule.resource_type.startsWith("filesystem:") &&
            (!globalOnly || rule.scope === "global"),
        )
      : [];
    if (observation.success && rules.length === 0 && allowEmpty) return false;
    const networkScopesKnown =
      observation.success &&
      observation.data.rules.every(
        (rule) =>
          rule.resource_type.startsWith("filesystem:") ||
          (rule.resource_type === "network" &&
            ((rule.scope === "global" && rule.applies_to === "all") ||
              (rule.scope === "sandbox" &&
                typeof rule.applies_to === "string" &&
                NAME.test(rule.applies_to)) ||
              (typeof rule.scope === "string" &&
                /^sandbox:moira-[a-f0-9]{32}$/.test(rule.scope) &&
                rule.applies_to === rule.scope))),
      );
    // SDK 0.46.0 reports a readonly virtual default until an explicit rule is persisted.
    // Only initialization, after its empty inventory check, can treat it as no stored policy.
    const virtualDefault = z
      .object({
        id: z.literal("default-deny-all"),
        resource_type: z.literal("network"),
        scope: z.literal("global"),
        applies_to: z.literal("all"),
        decision: z.literal("deny"),
        status: z.literal("active"),
        resources: z.tuple([z.literal("**")]),
        actions: z.tuple([z.literal("net:connect:tcp"), z.literal("net:connect:udp")]),
        origin: z.literal("local"),
        editable: z.literal(false),
      })
      .strict();
    if (
      allowEmpty &&
      networkScopesKnown &&
      rules.length === 1 &&
      virtualDefault.safeParse(rules[0]).success
    )
      return false;
    const denial = z
      .object({
        resource_type: z.literal("network"),
        scope: z.literal("global"),
        applies_to: z.literal("all"),
        decision: z.literal("deny"),
        status: z.literal("active"),
        resources: z.tuple([z.literal("**")]),
        actions: z.tuple([z.literal("net:connect:udp")]),
      })
      .passthrough()
      .safeParse(rules[0]);
    if (!networkScopesKnown || rules.length !== 1 || !denial.success) {
      throw new LocalRefusal(
        "LOCAL_NETWORK_UNSAFE",
        "The pinned implicit TCP denial and sole global UDP denial are required; existing conflicting rules are not reset.",
      );
    }
    return true;
  }

  async verifySettings(): Promise<void> {
    await this.validateExecutable();
    await this.prepareCredentials();
    const entries = z
      .array(z.object({ key: z.string(), value: z.unknown() }).passthrough())
      .parse(JSON.parse((await this.call(["settings", "list", "--json"])).toString("utf8")));
    for (const [key, value] of Object.entries(REQUIRED_SETTINGS)) {
      // Feature flags are omitted from the pinned SDK's ordinary settings inventory.
      // Read the fixed flag separately; its typed disabled value remains mandatory.
      if (key === "feature.network-user-prompts") {
        let flag: unknown;
        try {
          flag = JSON.parse((await this.call(["settings", "get", key, "--json"])).toString("utf8"));
        } catch (error) {
          if (error instanceof LocalRefusal) throw error;
        }
        if (
          entries.filter((entry) => entry.key === key).length > 1 ||
          !z
            .object({ key: z.literal(key).optional(), value: networkPromptsSchema })
            .passthrough()
            .safeParse(flag).success
        )
          throw new LocalRefusal(
            "LOCAL_RUNTIME_UNSAFE",
            "Sandbox network user prompts are not verified as disabled.",
          );
        continue;
      }
      if (
        entries.filter((entry) => entry.key === key).length !== 1 ||
        entries.find((entry) => entry.key === key)?.value !== value
      ) {
        throw new LocalRefusal(
          "LOCAL_RUNTIME_UNSAFE",
          "Sandbox host integrations or proxy settings differ from local policy.",
        );
      }
    }
  }

  async list(): Promise<SandboxObservation[]> {
    return inventorySchema.parse(JSON.parse((await this.call(["ls", "--json"])).toString("utf8")))
      .sandboxes;
  }

  /** The independent owner captures daemon and SDK Docker peers before admitting this fixed read. */
  async containerIdentity(name: string): Promise<ContainerIdentity> {
    if (!NAME.test(name))
      throw new LocalRefusal("LOCAL_IDENTITY_INVALID", "Invalid owned sandbox name.");
    await this.prepareCredentials();
    const result = await this.run({
      binary: process.execPath,
      argv: [
        runtimeApiAsset(),
        this.home,
        this.environment.DOCKER_SANDBOXES_APP_NAME,
        "container-identity",
        name,
      ],
      cwd: this.home,
      env: this.environment,
      timeoutMs: 30_000,
      maxBytes: 8192,
    });
    if (result.exitCode !== 0)
      throw new LocalRefusal(
        "LOCAL_CONTAINER_UNKNOWN",
        "The owned SDK container identity is unconfirmed.",
      );
    return containerIdentitySchema
      .extend({ name: z.literal(name) })
      .parse(JSON.parse(result.stdout.toString("utf8")));
  }

  async exact(identity: SandboxIdentity): Promise<SandboxObservation | null> {
    if (!NAME.test(identity.name))
      throw new LocalRefusal("LOCAL_IDENTITY_INVALID", "Invalid owned sandbox name.");
    const observations = (await this.list()).filter((item) => item.name === identity.name);
    if (observations.length === 0) return null;
    if (observations.length !== 1 || observations[0].id !== identity.runtimeId) {
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The sandbox identity changed; no lifecycle action was performed.",
      );
    }
    return observations[0];
  }

  async create(name: string): Promise<SandboxIdentity> {
    if (!NAME.test(name)) throw new LocalRefusal("LOCAL_IDENTITY_INVALID", "Invalid sandbox name.");
    await this.verifySettings();
    if ((await this.list()).some((item) => item.name === name)) {
      throw new LocalRefusal(
        "LOCAL_NAME_EXISTS",
        "A sandbox already uses this name; it was not adopted.",
      );
    }
    await this.verifyDaemonOwnership();
    const created = await this.run({
      binary: process.execPath,
      argv: [runtimeApiAsset(), this.home, this.environment.DOCKER_SANDBOXES_APP_NAME, "create"],
      cwd: this.home,
      env: this.environment,
      stdin: Buffer.from(
        JSON.stringify({
          name,
          template: this.policy.runtime.template,
          cpuCores: this.policy.runtime.cpuCores,
          memoryBytes: this.policy.runtime.memoryBytes,
          dockerBytes: this.policy.runtime.dockerBytes,
        }),
      ),
      timeoutMs: 10 * 60_000,
      maxBytes: 8192,
    });
    if (created.exitCode !== 0)
      throw new LocalRefusal("LOCAL_CREATE_UNKNOWN", "Safe sandbox creation was not confirmed.");
    const response = z
      .object({ name: z.literal(name), agent: z.literal("shell"), workspace: z.literal("") })
      .strict()
      .parse(JSON.parse(created.stdout.toString("utf8")));
    const observations = (await this.list()).filter((item) => item.name === response.name);
    const observed = observations[0];
    if (
      observations.length !== 1 ||
      !observed ||
      !z.string().uuid().safeParse(observed.id).success ||
      observed.agent !== response.agent ||
      !["stopped", "running", "created"].includes(observed.status)
    )
      throw new LocalRefusal(
        "LOCAL_CREATE_UNKNOWN",
        "Creation was not observed; inspect the pending local record.",
      );
    const identity = { name, runtimeId: observed.id };
    if (observed.status === "created") await this.verifyCreatedContainer(identity);
    await this.verifyBoundary(identity);
    return identity;
  }

  async start(identity: SandboxIdentity): Promise<void> {
    const observed = await this.exact(identity);
    if (!observed)
      throw new LocalRefusal("LOCAL_SANDBOX_ABSENT", "The owned sandbox no longer exists.");
    if (observed.status === "running") {
      await this.verifyBoundary(identity);
      return;
    }
    if (observed.status !== "stopped" && observed.status !== "created")
      throw new LocalRefusal("LOCAL_START_FAILED", "The owned sandbox is not ready for startup.");
    await this.prepareCredentials();
    await this.verifyDaemonOwnership();
    const gatewayPresent = await this.inspectBoundary(identity, true);
    const startup = await this.run({
      binary: process.execPath,
      argv: [
        runtimeApiAsset(),
        this.home,
        this.environment.DOCKER_SANDBOXES_APP_NAME,
        identity.name,
        gatewayPresent ? "present" : "absent",
      ],
      cwd: this.home,
      env: this.environment,
      timeoutMs: 120_000,
      maxBytes: 8192,
    });
    if (startup.exitCode !== 0)
      throw new LocalRefusal(
        "LOCAL_START_FAILED",
        "The SDK refused startup without its MCP gateway.",
      );
    for (let attempt = 0; attempt < 80; attempt++) {
      const current = await this.exact(identity);
      if (current?.status === "running") {
        await this.verifyBoundary(identity);
        return;
      }
      if (current?.status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new LocalRefusal(
      "LOCAL_START_FAILED",
      "Docker Sandboxes did not confirm the owned sandbox as running.",
    );
  }

  async verifyBoundary(identity: SandboxIdentity): Promise<void> {
    await this.inspectBoundary(identity);
  }

  /** Created is actionable inventory, never a certificate that the VM has stopped. */
  private async verifyCreatedContainer(identity: SandboxIdentity): Promise<void> {
    const container = await this.containerIdentity(identity.name);
    if (container.state !== "created" && container.state !== "exited")
      throw new LocalRefusal(
        "LOCAL_CONTAINER_UNKNOWN",
        "The created SDK snapshot disagrees with its exact Engine container.",
      );
  }

  private async inspectBoundary(
    identity: SandboxIdentity,
    beforeStart = false,
    observation?: SandboxObservation,
  ): Promise<boolean> {
    const observed = observation ?? (await this.exact(identity));
    if (
      !observed ||
      observed.agent !== "shell" ||
      (beforeStart && observed.status !== "stopped" && observed.status !== "created")
    ) {
      throw new LocalRefusal(
        "LOCAL_SANDBOX_UNSAFE",
        "The sandbox has unexpected host mounts, ports or agent configuration.",
      );
    }
    if (beforeStart && observed.status === "created") await this.verifyCreatedContainer(identity);
    const parsed = z
      .object({
        name: z.string(),
        agent: z.literal("shell"),
        image: z.string(),
        image_digest: z.string(),
        cpus: z.number().int().positive(),
        memory: z.string(),
        network: z.string(),
        runtime_mounts: z.array(z.unknown()),
        daemon_version: z.literal(`v${SUPPORTED_SBX_VERSION}`),
        kits: z.array(z.unknown()),
        // The pinned CLI's nonpointer omitempty fields omit their Go zero values.
        // Pointer observations above/below remain required, including false/empty values.
        secrets: z.array(z.unknown()).default([]),
        ports: z.array(z.unknown()).default([]),
        mcp_gateway: z.boolean(),
        auth_mode: z.string().default(""),
        network_policy: z
          .object({
            organization: z.string().optional(),
            organization_unavailable: z.boolean().optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .safeParse(
        JSON.parse((await this.call(["inspect", "--json", identity.name])).toString("utf8")),
      );
    if (!parsed.success)
      throw new LocalRefusal(
        "LOCAL_SANDBOX_UNSAFE",
        "The sandbox inspection does not expose the required isolation fields.",
      );
    const summary = parsed.data;
    if (
      summary.name !== identity.name ||
      summary.daemon_version !== `v${SUPPORTED_SBX_VERSION}` ||
      summary.image !== this.policy.runtime.template ||
      summary.image_digest !== this.policy.runtime.template.split("@")[1] ||
      summary.cpus !== this.policy.runtime.cpuCores ||
      summary.memory !== `${this.policy.runtime.memoryBytes / 1024 ** 2}m` ||
      summary.network !== identity.name ||
      summary.runtime_mounts.length !== 0 ||
      summary.kits?.length ||
      summary.secrets?.length ||
      summary.ports?.length ||
      (summary.mcp_gateway && !beforeStart) ||
      summary.auth_mode ||
      summary.network_policy?.organization ||
      summary.network_policy?.organization_unavailable
    ) {
      throw new LocalRefusal(
        "LOCAL_SANDBOX_UNSAFE",
        "Unapproved sandbox integrations or governance are active.",
      );
    }
    return summary.mcp_gateway;
  }

  async configureBroker(identity: SandboxIdentity, port: number): Promise<Buffer> {
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
      throw new LocalRefusal("LOCAL_PORT_INVALID", "Invalid local broker port.");
    await this.verifyBoundary(identity);
    await this.verifySettings();
    await this.verifyGlobalNetworkPolicy();
    await this.call([
      "policy",
      "allow",
      "network",
      "--protocol",
      "tcp",
      "--sandbox",
      identity.name,
      `localhost:${port}`,
    ]);
    // Wildcard denial is inherited from the required global UDP policy.
    // Grant only the TCP broker; do not attempt to remove an inherited global rule.
    for (const [target, allowed] of [
      [`localhost:${port}`, true],
      ["localhost:22", false],
      ["127.0.0.1:80", false],
      ["[::1]:80", false],
      ["10.0.0.1:443", false],
      ["169.254.169.254:80", false],
      ["192.168.1.1:443", false],
      ["github.com:443", false],
      ["example.org:443", false],
    ] as const) {
      if ((await this.checkNetwork(identity, "tcp", target)) !== allowed)
        throw new LocalRefusal(
          "LOCAL_NETWORK_UNSAFE",
          "The sandbox network boundary did not match local policy.",
        );
    }
    for (const target of [`localhost:${port}`, "example.org:443"])
      if (await this.checkNetwork(identity, "udp", target))
        throw new LocalRefusal("LOCAL_NETWORK_UNSAFE", "UDP access is not admitted.");
    return this.networkPolicy(identity);
  }

  /** A denied policy check is the one SDK command whose validated result legitimately exits 1. */
  private async checkNetwork(
    identity: SandboxIdentity,
    protocol: "tcp" | "udp",
    target: string,
  ): Promise<boolean> {
    await this.prepareCredentials();
    await this.verifyDaemonOwnership();
    const result = await this.run({
      binary: this.policy.runtime.binary,
      argv: [
        "policy",
        "check",
        "network",
        "--json",
        "--protocol",
        protocol,
        "--sandbox",
        identity.name,
        target,
      ],
      cwd: this.home,
      env: this.environment,
      timeoutMs: 30_000,
      maxBytes: 64 * 1024,
    });
    let answer: unknown;
    try {
      answer = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      /* Refuse malformed SDK output below. */
    }
    const checked = z
      .object({
        type: z.literal("network"),
        action: z.literal(`net:connect:${protocol}`),
        target: z.literal(target),
        context: z.literal(`sandbox:${identity.name}`),
        allowed: z.boolean(),
        governance: z.object({ active: z.literal(false) }).passthrough(),
      })
      .passthrough()
      .safeParse(answer);
    if (
      !checked.success ||
      result.stderr.length !== 0 ||
      result.exitCode !== (checked.data.allowed ? 0 : 1)
    )
      throw new LocalRefusal(
        "LOCAL_NETWORK_UNSAFE",
        "The SDK policy check did not verify the exact local network boundary.",
      );
    return checked.data.allowed;
  }

  async networkPolicy(identity: SandboxIdentity): Promise<Buffer> {
    await this.exact(identity);
    return this.call(["policy", "ls", identity.name, "--json"]);
  }

  async guest(
    identity: SandboxIdentity,
    argv: readonly string[],
    stdin?: Uint8Array,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const mode =
      argv.length === GUEST_INSTALL_COMMAND.length &&
      argv.every((value, index) => value === GUEST_INSTALL_COMMAND[index])
        ? "installer"
        : argv.length === GUEST_WORKER_COMMAND.length &&
            argv.every((value, index) => value === GUEST_WORKER_COMMAND[index])
          ? "worker"
          : undefined;
    if (!mode)
      throw new LocalRefusal(
        "LOCAL_GUEST_COMMAND_INVALID",
        "Only the installed guest entrypoints are admitted.",
      );
    const observed = await this.exact(identity);
    if (!observed)
      throw new LocalRefusal("LOCAL_SANDBOX_ABSENT", "The owned sandbox no longer exists.");
    if (observed.status !== "running")
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "The owned sandbox is not running.");
    await this.verifyBoundary(identity);
    await this.prepareCredentials();
    if (signal?.aborted)
      throw new LocalRefusal("LOCAL_CANCELLED", "Guest work was canceled before dispatch.");
    return this.attachGuest(identity, mode, stdin, timeoutMs, signal);
  }

  /** One final backend proof for an owned portable dispatch, with fresh caller authority before I/O. */
  async runFixedGuest(
    identity: SandboxIdentity,
    entrypoint: FixedGuestEntrypoint,
    stdin?: Uint8Array,
    timeoutMs = 30_000,
    signal?: AbortSignal,
    admission?: LocalVmDispatchAdmission,
  ): Promise<Buffer> {
    if (entrypoint !== "installer" && entrypoint !== "worker")
      throw new LocalRefusal("LOCAL_GUEST_COMMAND_INVALID", "Unknown fixed guest entrypoint.");
    await this.verifySettings();
    const observed = await this.exact(identity);
    if (!observed)
      throw new LocalRefusal("LOCAL_SANDBOX_ABSENT", "The owned sandbox no longer exists.");
    if (observed.status !== "running")
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "The owned sandbox is not running.");
    await this.inspectBoundary(identity, false, observed);
    if (admission) {
      const digest = createHash("sha256")
        .update(await this.call(["policy", "ls", identity.name, "--json"]))
        .digest("hex");
      if (digest !== admission.expectedNetworkDigest)
        throw new LocalRefusal("LOCAL_NETWORK_CHANGED", "The sandbox network policy changed.");
    }
    await this.prepareCredentials();
    await admission?.confirm();
    if (signal?.aborted)
      throw new LocalRefusal("LOCAL_CANCELLED", "Guest work was canceled before dispatch.");
    return this.attachGuest(identity, entrypoint, stdin, timeoutMs, signal);
  }

  private async attachGuest(
    identity: SandboxIdentity,
    mode: "installer" | "worker",
    stdin: Uint8Array | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    let result: ProcessResult;
    try {
      result = await this.run({
        binary: process.execPath,
        argv: [
          runtimeApiAsset(),
          this.home,
          this.environment.DOCKER_SANDBOXES_APP_NAME,
          mode,
          identity.name,
        ],
        cwd: this.home,
        env: this.environment,
        stdin,
        timeoutMs,
        maxBytes: 8 * 1024 * 1024,
        signal,
      });
    } catch {
      throw new LocalRefusal(
        "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
        "Guest execution must be settled by its independent VM owner.",
      );
    }
    if (result.exitCode === VERIFIED_GUEST_FAILURE_EXIT)
      throw new LocalRefusal(
        "LOCAL_GUEST_FAILED",
        "The SDK confirmed that the guest entrypoint exited unsuccessfully.",
      );
    if (result.exitCode !== 0)
      throw new LocalRefusal(
        "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
        "Guest execution must be settled by its independent VM owner.",
      );
    return result.stdout;
  }

  async stop(identity: SandboxIdentity): Promise<void> {
    const observed = await this.exact(identity);
    if (observed?.status === "created") await this.verifyCreatedContainer(identity);
    if (observed) await this.call(["stop", identity.name]);
  }

  async remove(identity: SandboxIdentity): Promise<void> {
    if (await this.exact(identity)) await this.call(["rm", "--force", identity.name]);
  }
}
