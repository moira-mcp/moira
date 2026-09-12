import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONNECTOR_MAX_CONTROL_OUTPUT_BYTES,
  CONNECTOR_MAX_REQUEST_BYTES,
  CONNECTOR_MAX_RESPONSE_BYTES,
  decodeConnectorRequest,
  encodeConnectorResponse,
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
  supervisorPath?: string;
  job?: Record<string, unknown>;
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
  stdin: Buffer | string = "",
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
    child.stdin.end(stdin);
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

async function runSupervisor(resourceName: string, input: WorkerInput): Promise<unknown> {
  if (!input.job || typeof input.supervisorPath !== "string") {
    throw new Error("Invalid connector operation job");
  }
  const config = await generateSshConfig(resourceName, input);
  const configPath = join(input.home, "ssh_config");
  await writeFile(configPath, config, { mode: 0o600 });
  const supervisor = await readFile(input.supervisorPath, "utf8");
  const encoded = Buffer.from(JSON.stringify(input.job), "utf8").toString("base64");
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
      "node",
      "--input-type=module",
    ],
    environment(input, true),
    `${supervisor}\nawait runEncoded("${encoded}");\n`,
    Number(input.job.timeoutMs ?? 30_000) + 90_000,
    CONNECTOR_MAX_RESPONSE_BYTES,
  );
  if (result.exitCode !== 0) throw new Error("Codespace operation failed");
  const envelope = JSON.parse(result.stdout.toString("utf8")) as { ok?: boolean; result?: unknown };
  if (envelope.ok !== true) throw new Error("Codespace supervisor rejected the operation");
  return envelope.result;
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
    if (action !== "operation") throw new Error("Invalid connector operation");
    process.stdout.write(encodeConnectorResponse(await runSupervisor(resourceName!, input)));
  } finally {
    await rm(input.home, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Codespaces connector worker failed: ${diagnostic(message)}\n`);
  process.exitCode = 1;
});
