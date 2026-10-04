import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";

const execute = promisify(execFile);
export interface GuestBootstrap {
  proxySource: string;
  hostPort: number;
  spaceId: string;
  brokerToken: string;
  repository: string;
  ref: string;
  clone: boolean;
}

/** This module is shipped as data and evaluated only by node inside the owned VM. */
export async function bootstrap(input: GuestBootstrap) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("The sandbox template must contain Node.js 24 or newer.");
  const directory = join(homedir(), ".local", "share", "moira-local");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const proxyPath = join(directory, "proxy.mjs");
  const pidPath = join(directory, "proxy.pid");
  try {
    const pid = Number(await readFile(pidPath, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 1) {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (command.split("\0").includes(proxyPath)) process.kill(pid, "SIGTERM");
    }
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  await writeFile(proxyPath, input.proxySource, { mode: 0o600 });
  const proxy = spawn(process.execPath, [proxyPath, String(input.hostPort)], { detached: true, stdio: "ignore" });
  let proxyFailed = false;
  proxy.once("error", () => { proxyFailed = true; });
  proxy.once("exit", () => { proxyFailed = true; });
  proxy.unref();
  if (!proxy.pid) throw new Error("Guest network proxy could not start");
  await writeFile(pidPath, String(proxy.pid), { mode: 0o600 });
  let connected = false;
  for (let attempt = 0; attempt < 40 && !proxyFailed; attempt++) {
    connected = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: 3437 });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (connected) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!connected || proxyFailed) throw new Error("Guest network proxy is unavailable");
  const proxyUrl = `http://${input.spaceId}:${input.brokerToken}@127.0.0.1:3437`;
  const environment = {
    ...process.env,
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  };
  await writeFile(join(directory, "environment.json"), JSON.stringify({
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
  }), { mode: 0o600 });
  const root = `/workspaces/${input.repository.split("/")[1]}`;
  if (input.clone) {
    await execute("sudo", ["-n", "mkdir", "-p", "/workspaces"], { timeout: 10_000 });
    await execute("sudo", ["-n", "chown", `${process.getuid!()}:${process.getgid!()}`, "/workspaces"], { timeout: 10_000 });
    const url = `http://${input.spaceId}:${input.brokerToken}@127.0.0.1:3437/git/${input.repository}.git`;
    await execute("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "clone", "--no-checkout", "--", url, root], { env: environment, timeout: 120_000, maxBuffer: 1024 * 1024 });
    await execute("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "fetch", "origin", input.ref], { env: environment, timeout: 120_000, maxBuffer: 1024 * 1024 });
    const checkout = input.ref.startsWith("refs/tags/") || /^[a-f0-9]{40}$/.test(input.ref)
      ? ["checkout", "--detach", "FETCH_HEAD"]
      : ["checkout", "-B", input.ref.replace(/^refs\/heads\//, ""), "FETCH_HEAD"];
    await execute("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...checkout], { env: environment, timeout: 30_000, maxBuffer: 1024 * 1024 });
  }
  await access(root);
  return { repositoryRoot: root, proxyReady: true };
}
