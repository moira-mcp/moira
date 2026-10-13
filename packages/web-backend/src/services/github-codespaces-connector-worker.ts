import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE_INSTALL_SCRIPT,
  WORKSPACE_PROBE_SCRIPT,
  WORKSPACE_CONFIGURE_SCRIPT,
  WORKSPACE_START_SCRIPT,
  WORKSPACE_HEALTH_SCRIPT,
  WORKSPACE_PAYLOAD_DIRECTORY,
  loadWorkspacePayload,
  workspaceInstallInput,
} from "../../../workspace-service/src/bootstrap.mjs";
import { join } from "node:path";
import {
  CONNECTOR_MAX_CONTROL_OUTPUT_BYTES,
  CONNECTOR_MAX_REQUEST_BYTES,
  decodeConnectorRequest,
  validGitHubUserCredential,
  validateCodespaceSshConfig,
} from "./github-codespaces-connector-protocol.mjs";

const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIAGNOSTIC_EXCERPT_BYTES = 300;

// Diagnostics never leave this sidecar's own stderr, and never carry the credential.
let redactionToken: string | null = null;

function diagnostic(text: string): string {
  const redacted = redactionToken ? text.split(redactionToken).join("[redacted]") : text;
  return redacted.replace(/\s+/g, " ").trim().slice(0, DIAGNOSTIC_EXCERPT_BYTES);
}

interface WorkerInput {
  token: string;
  home: string;
  configuration?: Record<string, unknown>;
}

async function readInput(): Promise<WorkerInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > CONNECTOR_MAX_REQUEST_BYTES) throw new Error("Connector input exceeded its bound");
    chunks.push(value);
  }
  const value = decodeConnectorRequest(Buffer.concat(chunks)) as Partial<WorkerInput>;
  if (!validGitHubUserCredential(value.token)) {
    throw new Error("Invalid GitHub App user credential");
  }
  redactionToken = value.token as string;
  if (
    typeof value.home !== "string" ||
    !/^\/tmp\/moira-codespaces-connector-[A-Za-z0-9]+$/.test(value.home)
  ) {
    throw new Error("Invalid connector HOME");
  }
  return value as WorkerInput;
}

function run(
  executable: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  stdin: Buffer | string | AsyncIterable<Uint8Array> = "",
  timeoutMs = 90_000,
  outputLimitBytes = CONNECTOR_MAX_CONTROL_OUTPUT_BYTES,
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, exitCode?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else
        resolve({
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
    };
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > outputLimitBytes) {
        killGroup();
        finish(new Error("Connector output exceeded its bound"));
      } else target.push(Buffer.from(chunk));
    };
    const timeout = setTimeout(() => {
      killGroup();
      finish(new Error("Connector command timed out"));
    }, timeoutMs);
    timeout.unref();
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code ?? -1));
    child.stdin.on("error", () => {
      killGroup();
      finish(new Error("Bootstrap input delivery failed"));
    });
    if (typeof stdin !== "string" && Symbol.asyncIterator in stdin) {
      void (async () => {
        try {
          for await (const chunk of stdin)
            await new Promise<void>((done, failed) =>
              child.stdin.write(chunk, (error) => (error ? failed(error) : done())),
            );
          child.stdin.end();
        } catch {
          killGroup();
          finish(new Error("Bootstrap input delivery failed"));
        }
      })();
    } else child.stdin.end(stdin);
  });
}

function environment(input: WorkerInput, includeToken: boolean): NodeJS.ProcessEnv {
  return {
    HOME: input.home,
    GH_CONFIG_DIR: join(input.home, ".config", "gh"),
    ...(includeToken ? { GH_TOKEN: input.token } : {}),
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    HTTPS_PROXY: "http://127.0.0.1:18080",
    HTTP_PROXY: "http://127.0.0.1:18080",
    NO_PROXY: "",
  };
}

async function generateSshConfig(resourceName: string, input: WorkerInput): Promise<string> {
  const result = await run(
    "/usr/bin/gh",
    ["codespace", "ssh", "--codespace", resourceName, "--config"],
    environment(input, true),
    "",
    30_000,
  );
  const config = result.stdout.toString("utf8");
  if (result.exitCode !== 0) {
    throw new Error(
      `Codespace SSH capability is unavailable (gh exit ${result.exitCode}: ${diagnostic(
        result.stderr.toString("utf8"),
      )})`,
    );
  }
  if (
    config.includes(input.token) ||
    !validateCodespaceSshConfig(config, { home: input.home, resourceName })
  ) {
    throw new Error("Codespace SSH capability is unavailable (unexpected ssh configuration)");
  }
  return config;
}

function sshHost(config: string): string {
  const match = config.match(/^Host\s+([A-Za-z0-9][A-Za-z0-9_.-]{0,255})\s*$/m);
  if (!match) throw new Error("Codespace SSH host is unavailable");
  return match[1];
}

async function runBootstrap(
  resourceName: string,
  input: WorkerInput,
  action: "probe" | "install",
): Promise<string> {
  const config = await generateSshConfig(resourceName, input);
  const configPath = join(input.home, "ssh_config");
  await writeFile(configPath, config, { mode: 0o600 });
  const fixed = async (
    script: string,
    bytes: Buffer | AsyncIterable<Uint8Array> = Buffer.alloc(0),
  ) => {
    const quoted =
      String.fromCharCode(39) +
      script.split(String.fromCharCode(39)).join(String.fromCharCode(39, 34, 39, 34, 39)) +
      String.fromCharCode(39);
    const result = await run(
      "/usr/bin/ssh",
      [
        "-F",
        configPath,
        "-o",
        "BatchMode=yes",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ConnectTimeout=20",
        sshHost(config),
        `/bin/sh -c ${quoted}`,
      ],
      environment(input, true),
      bytes,
      300_000,
      CONNECTOR_MAX_CONTROL_OUTPUT_BYTES,
    );
    if (result.exitCode !== 0) throw new Error("Codespace fixed bootstrap failed");
    return result.stdout.toString("utf8");
  };
  const measured = JSON.parse(await fixed(WORKSPACE_PROBE_SCRIPT)) as {
    environmentIdentity: string;
    architecture: string;
  };
  const rootBase64 = (
    await fixed("set -eu; git rev-parse --show-toplevel | tr -d '\\n' | base64 -w0")
  ).trim();
  if (action === "probe") return JSON.stringify({ ...measured, rootBase64 });
  const configuration = input.configuration;
  if (
    !configuration ||
    typeof configuration.remote !== "object" ||
    configuration.remote === null ||
    (configuration.remote as { environmentIdentity?: unknown }).environmentIdentity !==
      measured.environmentIdentity ||
    configuration.root !== Buffer.from(rootBase64, "base64").toString("utf8")
  )
    throw new Error("Workspace bootstrap identity changed");
  const architecture =
    measured.architecture === "x86_64"
      ? "x64"
      : measured.architecture === "aarch64"
        ? "arm64"
        : "unsupported";
  const payload = await loadWorkspacePayload(
    fileURLToPath(WORKSPACE_PAYLOAD_DIRECTORY),
    architecture,
  );
  await fixed(WORKSPACE_INSTALL_SCRIPT, workspaceInstallInput(payload));
  await fixed(WORKSPACE_CONFIGURE_SCRIPT, Buffer.from(JSON.stringify(configuration)));
  await fixed(WORKSPACE_START_SCRIPT);
  const ready = JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT)) as {
    environmentIdentity?: string;
    releaseIdentity?: string;
  };
  if (
    ready.environmentIdentity !== measured.environmentIdentity ||
    ready.releaseIdentity !== payload.release
  )
    throw new Error("Workspace bootstrap readiness identity changed");
  return JSON.stringify(ready);
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "health") {
    process.stdout.write(
      `connector-worker-ok uid=${process.getuid?.()} gid=${process.getgid?.()}\n`,
    );
    return;
  }
  const resourceName = process.argv[3];
  if (!RESOURCE.test(resourceName ?? "")) throw new Error("Invalid connector operation");
  const input = await readInput();
  try {
    if (action === "ssh-config") {
      process.stdout.write(await generateSshConfig(resourceName!, input));
      return;
    }
    if (action !== "probe" && action !== "install") throw new Error("Invalid connector bootstrap");
    process.stdout.write(await runBootstrap(resourceName!, input, action));
  } finally {
    await rm(input.home, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Codespaces connector worker failed: ${diagnostic(message)}\n`);
  process.exitCode = 1;
});
