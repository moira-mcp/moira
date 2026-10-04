import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { LocalRefusal, SUPPORTED_SBX_VERSION, type LocalPolicy } from "./policy.js";
import { runProcess, type RunProcess } from "./process.js";

const sandboxSchema = z.object({
  id: z.string().min(1).max(255),
  name: z.string().min(1).max(128),
  agent: z.string(),
  status: z.enum(["running", "stopped", "starting", "stopping", "created", "error"]),
  workspaces: z.array(z.string()).nullish().transform((value) => value ?? []),
  ports: z.array(z.unknown()).nullish().transform((value) => value ?? []),
}).passthrough();
const inventorySchema = z.object({ sandboxes: z.array(sandboxSchema).max(128) }).passthrough();
export type SandboxObservation = z.infer<typeof sandboxSchema>;
export interface SandboxIdentity { name: string; runtimeId: string }
const NAME = /^moira-[a-f0-9]{32}$/;
const REQUIRED_SETTINGS: Readonly<Record<string, string | boolean>> = {
  "clipboard.imagePaste": false,
  "ssh.agentForwardingEnabled": false,
  "ssh.autoCreate": false,
  "ssh.agentSocketPath": "",
  "skills.defaultMode": "off",
  "diagnostics.autoUpload": "no",
  "proxy.integratedAuth": false,
  "proxy.sandbox": "direct",
  "no_proxy.sandbox": "",
};

/** Every invocation is fixed locally; this object is never constructed from a relay message. */
export class SbxRuntime {
  readonly home: string;
  readonly environment: Readonly<Record<string, string>>;
  constructor(readonly policy: LocalPolicy, private readonly run: RunProcess = runProcess) {
    this.home = join(policy.runtime.storageRoot, "runtime");
    this.environment = {
      HOME: this.home,
      PATH: `${dirname(policy.runtime.binary)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: join(this.home, "tmp"),
      DOCKER_CONFIG: join(this.home, ".docker"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      DOCKER_SANDBOXES_DOCKER_SIZE: `${policy.runtime.dockerBytes / (1024 ** 2)}m`,
      DOCKER_SANDBOXES_CLIPBOARD_IMAGE_PASTE: "false",
    };
  }

  async call(argv: readonly string[], stdin?: Uint8Array, timeoutMs = 30_000, signal?: AbortSignal): Promise<Buffer> {
    const result = await this.run({
      binary: this.policy.runtime.binary, argv, cwd: this.home, env: this.environment,
      stdin, timeoutMs, maxBytes: 8 * 1024 * 1024, signal,
    });
    if (result.exitCode !== 0) {
      const authentication = /not authenticated|not signed in|no valid user session|401 Unauthorized/.test(result.stderr.toString("utf8"));
      throw new LocalRefusal(authentication ? "LOCAL_DOCKER_LOGIN_REQUIRED" : "LOCAL_RUNTIME_FAILED",
        authentication ? "Sign in to Docker using moira-local login." : "Docker Sandboxes refused the operation; run moira-local doctor locally.");
    }
    return result.stdout;
  }

  async validateExecutable(): Promise<void> {
    const binary = this.policy.runtime.binary;
    const metadata = await lstat(binary);
    if (!metadata.isFile() || (metadata.mode & 0o022) !== 0 || await realpath(binary) !== binary) {
      throw new LocalRefusal("LOCAL_BINARY_UNSAFE", "Use a canonical, non-writable-by-others sbx executable.");
    }
    const version = (await this.call(["version"])).toString("utf8");
    if (!new RegExp(`^sbx version: v${SUPPORTED_SBX_VERSION.replaceAll(".", "\\.")}\\s`).test(version)) {
      throw new LocalRefusal("LOCAL_RUNTIME_VERSION", `This adapter supports sbx ${SUPPORTED_SBX_VERSION}; validate a new version before upgrading.`);
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await mkdir(join(this.home, "tmp"), { mode: 0o700, recursive: true });
    await this.validateExecutable();
    await this.call(["daemon", "start", "--detach", "--policy", "deny-all"]);
    for (const [key, value] of Object.entries(REQUIRED_SETTINGS)) await this.call(["settings", "set", key, String(value)]);
    await this.call(["daemon", "restart"]);
    if ((await this.list()).length !== 0) throw new LocalRefusal("LOCAL_RUNTIME_NOT_EMPTY", "Refusing to reset a runtime containing sandboxes.");
    await this.call(["policy", "init", "deny-all"]);
    await this.verifySettings();
  }

  async verifySettings(): Promise<void> {
    await this.validateExecutable();
    const entries = z.array(z.object({ key: z.string(), value: z.unknown() }).passthrough())
      .parse(JSON.parse((await this.call(["settings", "list", "--json"])).toString("utf8")));
    for (const [key, value] of Object.entries(REQUIRED_SETTINGS)) {
      if (entries.filter((entry) => entry.key === key).length !== 1 || entries.find((entry) => entry.key === key)?.value !== value) {
        throw new LocalRefusal("LOCAL_RUNTIME_UNSAFE", "Sandbox host integrations or proxy settings differ from local policy.");
      }
    }
  }

  async list(): Promise<SandboxObservation[]> {
    return inventorySchema.parse(JSON.parse((await this.call(["ls", "--json"])).toString("utf8"))).sandboxes;
  }

  async exact(identity: SandboxIdentity): Promise<SandboxObservation | null> {
    if (!NAME.test(identity.name)) throw new LocalRefusal("LOCAL_IDENTITY_INVALID", "Invalid owned sandbox name.");
    const observations = (await this.list()).filter((item) => item.name === identity.name);
    if (observations.length === 0) return null;
    if (observations.length !== 1 || observations[0].id !== identity.runtimeId) {
      throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "The sandbox identity changed; no lifecycle action was performed.");
    }
    return observations[0];
  }

  async create(name: string): Promise<SandboxIdentity> {
    if (!NAME.test(name)) throw new LocalRefusal("LOCAL_IDENTITY_INVALID", "Invalid sandbox name.");
    await this.verifySettings();
    if ((await this.list()).some((item) => item.name === name)) {
      throw new LocalRefusal("LOCAL_NAME_EXISTS", "A sandbox already uses this name; it was not adopted.");
    }
    await this.call([
      "create", "--name", name, "--cpus", String(this.policy.runtime.cpuCores),
      "--memory", `${this.policy.runtime.memoryBytes / (1024 ** 2)}m`,
      "--skills", "off", "--template", this.policy.runtime.template,
      "--deny-network", "**", "shell",
    ], undefined, 10 * 60_000);
    const observed = (await this.list()).find((item) => item.name === name);
    if (!observed) throw new LocalRefusal("LOCAL_CREATE_UNKNOWN", "Creation was not observed; inspect the pending local record.");
    const identity = { name, runtimeId: observed.id };
    await this.verifyBoundary(identity);
    return identity;
  }

  async verifyBoundary(identity: SandboxIdentity): Promise<void> {
    const observed = await this.exact(identity);
    if (!observed || observed.agent !== "shell" || observed.workspaces.length !== 0 || observed.ports.length !== 0) {
      throw new LocalRefusal("LOCAL_SANDBOX_UNSAFE", "The sandbox has unexpected host mounts, ports or agent configuration.");
    }
    const summary = z.object({
      name: z.string(), daemon_version: z.string(),
      kits: z.array(z.unknown()).nullish(), secrets: z.array(z.unknown()).nullish(),
      ports: z.array(z.unknown()).nullish(), mcp_gateway: z.boolean().optional(),
      auth_mode: z.string().optional(),
      network_policy: z.object({ organization: z.string().optional(), organization_unavailable: z.boolean().optional() }).passthrough().optional(),
    }).passthrough().parse(JSON.parse((await this.call(["inspect", "--json", identity.name])).toString("utf8")));
    if (summary.name !== identity.name || summary.daemon_version !== `v${SUPPORTED_SBX_VERSION}` ||
      summary.kits?.length || summary.secrets?.length || summary.ports?.length ||
      summary.mcp_gateway || summary.auth_mode || summary.network_policy?.organization ||
      summary.network_policy?.organization_unavailable) {
      throw new LocalRefusal("LOCAL_SANDBOX_UNSAFE", "Unapproved sandbox integrations or governance are active.");
    }
  }

  async configureBroker(identity: SandboxIdentity, port: number): Promise<Buffer> {
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new LocalRefusal("LOCAL_PORT_INVALID", "Invalid local broker port.");
    await this.verifyBoundary(identity);
    await this.call(["policy", "allow", "network", "--sandbox", identity.name, `localhost:${port}`]);
    await this.call(["policy", "rm", "network", "--sandbox", identity.name, "--resource", "**", "--force"]);
    for (const [target, allowed] of [
      [`localhost:${port}`, true], ["localhost:22", false], ["127.0.0.1:80", false],
      ["[::1]:80", false], ["10.0.0.1:443", false], ["169.254.169.254:80", false],
      ["192.168.1.1:443", false], ["github.com:443", false], ["example.org:443", false],
    ] as const) {
      const answer = z.object({ allowed: z.boolean() }).passthrough().parse(JSON.parse(
        (await this.call(["policy", "check", "network", "--json", "--sandbox", identity.name, target])).toString("utf8"),
      ));
      if (answer.allowed !== allowed) throw new LocalRefusal("LOCAL_NETWORK_UNSAFE", "The sandbox network boundary did not match local policy.");
    }
    return this.networkPolicy(identity);
  }

  async networkPolicy(identity: SandboxIdentity): Promise<Buffer> {
    await this.exact(identity);
    return this.call(["policy", "ls", identity.name, "--json"]);
  }

  async guest(identity: SandboxIdentity, argv: readonly string[], stdin?: Uint8Array, timeoutMs = 30_000, signal?: AbortSignal): Promise<Buffer> {
    if (!await this.exact(identity)) throw new LocalRefusal("LOCAL_SANDBOX_ABSENT", "The owned sandbox no longer exists.");
    return this.call(["exec", "--interactive", identity.name, ...argv], stdin, timeoutMs, signal);
  }

  async stop(identity: SandboxIdentity): Promise<void> {
    if (await this.exact(identity)) await this.call(["stop", identity.name]);
  }

  async remove(identity: SandboxIdentity): Promise<void> {
    if (await this.exact(identity)) await this.call(["rm", "--force", identity.name]);
  }
}
