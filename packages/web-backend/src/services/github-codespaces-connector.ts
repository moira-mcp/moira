import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

type Spawn = (
  executable: string,
  argv: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GitHubCodespacesConnector {
  constructor(
    private readonly spawnImpl: Spawn = spawn,
    private readonly ghPath = "/usr/bin/gh",
    private readonly sshPath = "/usr/bin/ssh",
    private readonly workerRuntimePath = "/usr/local/bin/tsx",
    private readonly workerPath = "/app/packages/web-backend/src/services/github-codespaces-connector-worker.ts",
    private readonly commandTimeoutMs = COMMAND_TIMEOUT_MS,
  ) {}

  private run(
    executable: string,
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
    stdin = "",
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(executable, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
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
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
      };
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_DIAGNOSTIC_BYTES) {
          child.kill("SIGKILL");
          finish(new Error("Connector output exceeded its bound"));
          return;
        }
        target.push(chunk);
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("Connector command timed out"));
      }, this.commandTimeoutMs);
      timeout.unref();
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", (error) => finish(error));
      child.once("close", (code) => finish(undefined, code ?? -1));
      child.stdin.end(stdin);
    });
  }

  private environment(home: string): NodeJS.ProcessEnv {
    return {
      HOME: home,
      GH_CONFIG_DIR: join(home, ".config", "gh"),
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    };
  }

  async health(): Promise<{ ok: boolean; reason: string | null }> {
    const home = await mkdtemp(join(tmpdir(), "moira-codespaces-health-"));
    try {
      const env = this.environment(home);
      const [gh, ssh, worker] = await Promise.all([
        this.run(this.ghPath, ["--version"], env),
        this.run(this.sshPath, ["-V"], env),
        this.run(this.workerRuntimePath, [this.workerPath, "health"], env),
      ]);
      if (gh.exitCode !== 0 || !/gh version 2\.97\./.test(gh.stdout)) {
        return { ok: false, reason: "GitHub CLI 2.97 is unavailable" };
      }
      if (ssh.exitCode !== 0 || !/OpenSSH_10\.3/.test(`${ssh.stdout}\n${ssh.stderr}`)) {
        return { ok: false, reason: "OpenSSH 10.3 is unavailable" };
      }
      if (worker.exitCode !== 0 || !worker.stdout.includes("connector-worker-ok")) {
        return { ok: false, reason: "Codespaces connector worker is unavailable" };
      }
      return { ok: true, reason: null };
    } catch {
      return { ok: false, reason: "Codespaces connector tooling is unavailable" };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  async probeSshConfiguration(accessToken: string, resourceName: string): Promise<void> {
    if (!/^gh[uis]_[A-Za-z0-9_]+$/.test(accessToken)) {
      throw new Error("Invalid GitHub App user credential");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(resourceName)) {
      throw new Error("Invalid Codespace name");
    }
    const home = await mkdtemp(join(tmpdir(), "moira-codespaces-connector-"));
    try {
      const env = this.environment(home);
      const config = await this.run(
        this.workerRuntimePath,
        [this.workerPath, "ssh-config", resourceName],
        env,
        JSON.stringify({ token: accessToken, home }),
      );
      if (
        config.exitCode !== 0 ||
        !config.stdout.includes("ProxyCommand") ||
        config.stdout.includes(accessToken)
      ) {
        throw new Error("Codespace SSH capability is unavailable");
      }
    } catch {
      throw new Error("Codespace SSH capability is unavailable");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
