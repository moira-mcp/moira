import { configureGuestDocker } from "./guest-docker.js";
import { mkdir, readFile, writeFile, access, lstat, realpath, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import type { SupervisorRepositoryBinding } from "../../web-backend/src/services/github-codespaces-remote-supervisor.mjs";
import {
  localGitAuthorSchema,
  type LocalGitAuthor,
} from "../../shared/src/codespaces/local-management-types.js";

const execute = promisify(execFile);
export interface GuestBootstrap {
  proxySource: string;
  hostPort: number;
  spaceId: string;
  brokerToken: string;
  repository: string;
  ref: string;
  clone: boolean;
  gitAuthor?: LocalGitAuthor | null;
}

export async function configureGuestGitIdentity(
  root: string,
  author: LocalGitAuthor,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const validated = localGitAuthorSchema.parse(author);
  for (const [key, value] of [
    ["user.name", validated.name],
    ["user.email", validated.email],
  ])
    await execute("git", ["-C", root, "config", "--local", "--", key, value], {
      env: environment,
      timeout: 10000,
      maxBuffer: 65536,
    });
}

/** A successful empty advertisement differs from an unavailable or missing requested ref. */
export async function checkoutGuestRepository(
  root: string,
  ref: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const options = { env: environment, timeout: 120_000, maxBuffer: 1024 * 1024 };
  const refs = await execute("git", ["-C", root, "ls-remote", "--refs", "origin"], options);
  if (refs.stdout.trim() === "") {
    const branch = ref.replace(/^refs\/heads\//, "");
    if (ref.startsWith("refs/tags/") || /^[a-f0-9]{40}$/.test(ref))
      throw new Error("An empty repository requires an initial branch name");
    await execute("git", ["check-ref-format", "--branch", branch], options);
    await execute("git", ["-C", root, "symbolic-ref", "HEAD", `refs/heads/${branch}`], options);
    return;
  }
  await execute(
    "git",
    ["-C", root, "-c", "core.hooksPath=/dev/null", "fetch", "origin", ref],
    options,
  );
  const checkout =
    ref.startsWith("refs/tags/") || /^[a-f0-9]{40}$/.test(ref)
      ? ["checkout", "--detach", "FETCH_HEAD"]
      : ["checkout", "-B", ref.replace(/^refs\/heads\//, ""), "FETCH_HEAD"];
  await execute("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...checkout], options);
}

/** Records the repository the local bootstrap owns; job messages cannot select this binding. */
export async function bindGuestRepository(
  input: Pick<GuestBootstrap, "repository" | "spaceId" | "brokerToken">,
): Promise<SupervisorRepositoryBinding> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.repository) ||
    !/^[a-f0-9-]{36}$/.test(input.spaceId) ||
    !/^[a-f0-9]{64}$/.test(input.brokerToken)
  ) {
    throw new Error("Invalid local repository binding");
  }
  const root = `/workspaces/${input.repository.split("/")[1]}`;
  const metadata = await lstat(root);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid === 0 ||
    (await realpath(root)) !== root
  )
    throw new Error("Invalid local repository root");
  const origin = `http://${input.spaceId}:${input.brokerToken}@127.0.0.1:3437/git/${input.repository}.git`;
  const observed = await execute("git", ["-C", root, "remote", "get-url", "origin"], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (observed.stdout.trim() !== origin) throw new Error("Local repository origin changed");
  const binding = {
    repositoryFullName: input.repository,
    root,
    origin,
    dev: metadata.dev,
    ino: metadata.ino,
  };
  const directory = join(homedir(), ".local", "share", "moira-local");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.repository-${randomBytes(16).toString("hex")}.json`);
  await writeFile(temporary, JSON.stringify(binding), { mode: 0o600, flag: "wx" });
  await rename(temporary, join(directory, "repository.json"));
  return binding;
}

/** This module is shipped as data and evaluated only by node inside the owned VM. */
export async function bootstrap(input: GuestBootstrap) {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("The sandbox template must contain Node.js 22 or newer.");
  const directory = join(homedir(), ".local", "share", "moira-local");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const proxyPath = join(directory, "proxy.mjs");
  const pidPath = join(directory, "proxy.pid");
  try {
    const pid = Number(await readFile(pidPath, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 1) {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (command.split("\0").includes(proxyPath)) {
        process.kill(pid, "SIGTERM");
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            await access(`/proc/${pid}/cmdline`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
            throw error;
          }
          if (attempt === 39) throw new Error("Previous guest proxy did not stop");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  await writeFile(proxyPath, input.proxySource, { mode: 0o600 });
  const proxy = spawn(process.execPath, [proxyPath, String(input.hostPort)], {
    env: {
      ...process.env,
      MOIRA_LOCAL_PROXY_AUTHORIZATION: `Basic ${Buffer.from(`${input.spaceId}:${input.brokerToken}`).toString("base64")}`,
    },
    detached: true,
    stdio: "ignore",
  });
  let proxyFailed = false;
  proxy.once("error", () => {
    proxyFailed = true;
  });
  proxy.once("exit", () => {
    proxyFailed = true;
  });
  proxy.unref();
  if (!proxy.pid) throw new Error("Guest network proxy could not start");
  await writeFile(pidPath, String(proxy.pid), { mode: 0o600 });
  let connected = false;
  for (let attempt = 0; attempt < 40 && !proxyFailed; attempt++) {
    connected = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: 3437 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!connected || proxyFailed) throw new Error("Guest network proxy is unavailable");
  const proxyUrl = `http://${input.spaceId}:${input.brokerToken}@127.0.0.1:3437`;
  const environment = {
    ...process.env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  await writeFile(
    join(directory, "environment.json"),
    JSON.stringify({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    }),
    { mode: 0o600 },
  );
  await configureGuestDocker(proxyUrl, input.spaceId, input.brokerToken);
  const root = `/workspaces/${input.repository.split("/")[1]}`;
  if (input.clone) {
    await execute("sudo", ["-n", "mkdir", "-p", "/workspaces"], { timeout: 10_000 });
    await execute(
      "sudo",
      ["-n", "chown", `${process.getuid!()}:${process.getgid!()}`, "/workspaces"],
      { timeout: 10_000 },
    );
    const url = `http://${input.spaceId}:${input.brokerToken}@127.0.0.1:3437/git/${input.repository}.git`;
    await execute(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--no-checkout",
        "--",
        url,
        root,
      ],
      { env: environment, timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    await checkoutGuestRepository(root, input.ref, environment);
  }
  if (input.gitAuthor) {
    await configureGuestGitIdentity(root, input.gitAuthor, environment);
  }
  await access(root);
  await bindGuestRepository(input);
  return { repositoryRoot: root, proxyReady: true };
}
