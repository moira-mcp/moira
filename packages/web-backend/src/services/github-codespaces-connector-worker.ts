import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const MAX_INPUT_BYTES = 2048;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000;

interface WorkerInput {
  token: string;
  home: string;
}

async function readInput(): Promise<WorkerInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > MAX_INPUT_BYTES) throw new Error("Connector input exceeded its bound");
    chunks.push(value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<WorkerInput>;
  if (typeof value.token !== "string" || !/^gh[uis]_[A-Za-z0-9_]+$/.test(value.token)) {
    throw new Error("Invalid GitHub App user credential");
  }
  if (
    typeof value.home !== "string" ||
    !/\/moira-codespaces-connector-[A-Za-z0-9]+$/.test(value.home)
  ) {
    throw new Error("Invalid connector HOME");
  }
  return { token: value.token, home: value.home };
}

async function generateSshConfig(resourceName: string, input: WorkerInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/gh",
      ["codespace", "ssh", "--codespace", resourceName, "--config"],
      {
        env: {
          HOME: input.home,
          GH_CONFIG_DIR: `${input.home}/.config/gh`,
          GH_TOKEN: input.token,
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Connector command timed out"));
    }, TIMEOUT_MS);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("Connector output exceeded its bound"));
      } else {
        output.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("Connector output exceeded its bound"));
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) finish(new Error("Codespace SSH capability is unavailable"));
      else finish(undefined, Buffer.concat(output).toString("utf8"));
    });
  });
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "health") {
    process.stdout.write("connector-worker-ok\n");
    return;
  }
  const resourceName = process.argv[3];
  if (action !== "ssh-config" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(resourceName ?? "")) {
    throw new Error("Invalid connector operation");
  }
  const input = await readInput();
  try {
    const config = await generateSshConfig(resourceName!, input);
    if (!config.includes("ProxyCommand") || config.includes(input.token)) {
      throw new Error("Codespace SSH capability is unavailable");
    }
    process.stdout.write(config);
  } finally {
    await rm(input.home, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.stderr.write("Codespaces connector worker failed\n");
  process.exitCode = 1;
});
