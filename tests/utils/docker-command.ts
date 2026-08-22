/**
 * Docker command utilities for test execution
 *
 * Handles both local and remote Docker execution:
 * - Local: `docker exec <container> ...`
 * - Remote: `docker --context <ctx> exec <container> ...`
 *
 * When REMOTE_DOCKER_CONTEXT is set in environment, all docker commands
 * are routed through the specified Docker context (SSH to remote host).
 */

import { execSync } from "child_process";
import { exec, execFile } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Get the docker command prefix, including --context if remote
 */
function getDockerPrefix(): string {
  const context = process.env.REMOTE_DOCKER_CONTEXT;
  return context ? `docker --context ${context}` : "docker";
}

/**
 * Get the Docker container name from environment
 */
export function getContainerName(): string {
  const name = process.env.DOCKER_CONTAINER_NAME;
  if (!name) {
    throw new Error("DOCKER_CONTAINER_NAME environment variable is required");
  }
  return name;
}

/**
 * Execute a command inside the Docker container (sync)
 * Equivalent to: docker [--context ctx] exec <container> <command>
 */
export function dockerExecSync(command: string, container?: string): string {
  const containerName = container || getContainerName();
  const prefix = getDockerPrefix();
  return execSync(`${prefix} exec ${containerName} ${command}`, {
    encoding: "utf-8",
  }).trim();
}

/**
 * Execute sqlite3 command inside Docker container (sync)
 * Equivalent to: docker [--context ctx] exec <container> sqlite3 -cmd ".timeout 5000" <db> "<sql>"
 *
 * Uses busy_timeout pragma to handle concurrent access (5 second timeout).
 * This prevents "database is locked" errors during parallel test execution.
 */
export function execSqliteInDocker(
  sql: string,
  dbPath: string = "/app/data/moira.db",
  container?: string,
): string {
  const escapedSql = sql.replace(/"/g, '\\"');
  // Use -cmd option to set busy_timeout before executing SQL
  return dockerExecSync(`sqlite3 -cmd ".timeout 5000" ${dbPath} "${escapedSql}"`, container);
}

/**
 * Get Docker container logs (async)
 * Reads from Winston file logs inside the container for reliability.
 * supervisord's stdout pipe capture has buffering issues in Docker that cause
 * logs to be delayed or lost. Winston writes directly to /var/log/app/*.log
 * via its File transport, bypassing supervisord entirely.
 *
 * @param pipeline - Shell pipeline to process log output (e.g., grep pattern)
 * @param container - Container name override
 * @param timeout - Command timeout in ms
 */
export async function dockerLogsAsync(
  pipeline: string,
  container?: string,
  timeout: number = 10000,
): Promise<string> {
  const containerName = container || getContainerName();
  const prefix = getDockerPrefix();
  // Escape single quotes in pipeline for safe embedding in sh -c '...'
  // The '"'"' pattern: end single-quote, add literal ' via double-quoting, start single-quote
  const escapedPipeline = pipeline.replace(/'/g, `'"'"'`);
  // Read from Winston file logs (written directly by the app, not via supervisord pipe).
  // Winston with maxFiles creates numbered files: backend-api1.log, backend-api2.log
  const { stdout } = await execAsync(
    `${prefix} exec ${containerName} sh -c 'cat /var/log/app/backend-api*.log /var/log/app/mcp-server*.log 2>/dev/null | ${escapedPipeline}'`,
    { timeout },
  );
  return stdout;
}

/**
 * Get Docker container logs with error suppression (async)
 * Returns empty string on failure (e.g., grep finds no matches)
 */
export async function dockerLogsSafe(
  pipeline: string,
  container?: string,
  timeout: number = 10000,
): Promise<string> {
  try {
    return await dockerLogsAsync(pipeline, container, timeout);
  } catch {
    return "";
  }
}

/**
 * Wait for a matching line in the container's durable Winston logs.
 * Existing lines are inspected first; tail then follows new writes until the
 * caller's pipeline produces a result or the bounded timeout expires.
 */
export async function waitForDockerLog(
  pipeline: string,
  container?: string,
  timeout: number = 10000,
): Promise<string> {
  const containerName = container || getContainerName();
  const context = process.env.REMOTE_DOCKER_CONTEXT;
  const timeoutSeconds = Math.max(1, Math.ceil(timeout / 1000));
  const script = [
    'fifo="/tmp/moira-log-wait-$$"',
    'mkfifo "$fifo"',
    'tail -n 2000 -F /var/log/app/backend-api*.log /var/log/app/mcp-server*.log >"$fifo" 2>/dev/null &',
    "tail_pid=$!",
    'trap \'kill "$tail_pid" 2>/dev/null || true; rm -f "$fifo"\' EXIT',
    `${pipeline} <"$fifo"`,
  ].join("\n");
  const args = [
    ...(context ? ["--context", context] : []),
    "exec",
    containerName,
    "timeout",
    String(timeoutSeconds),
    "sh",
    "-c",
    script,
  ];
  const { stdout } = await execFileAsync("docker", args, { timeout: timeout + 2000 });
  return stdout;
}

/**
 * Get recent Docker container logs using tail (inside container).
 * Reads from Winston file logs for reliability. Uses tail for
 * efficient processing of large log files.
 *
 * @param pipeline - Shell pipeline to process log output
 * @param tailLines - Number of recent lines to read (default 2000)
 * @param container - Container name override
 * @param timeout - Command timeout in ms
 */
export async function dockerLogsRecent(
  pipeline: string,
  tailLines: number = 2000,
  container?: string,
  timeout: number = 15000,
): Promise<string> {
  const containerName = container || getContainerName();
  const prefix = getDockerPrefix();
  // Escape single quotes in pipeline for safe embedding in sh -c '...'
  const escapedPipeline = pipeline.replace(/'/g, `'"'"'`);
  // Read recent lines from Winston file logs inside the container.
  // Search ALL rotated log files to avoid missing entries after rotation.
  // Winston rotates backend-api.log → backend-api1.log, backend-api2.log, etc.
  // A log entry may be in the old file if rotation happened after the request.
  const { stdout } = await execAsync(
    `${prefix} exec ${containerName} sh -c 'for f in /var/log/app/backend-api*.log; do tail -n ${tailLines} "$f" 2>/dev/null; done | ${escapedPipeline}'`,
    { timeout },
  );
  return stdout;
}
