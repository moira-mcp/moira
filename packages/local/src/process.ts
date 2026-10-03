import { spawn } from "node:child_process";
import { LocalRefusal } from "./policy.js";

export interface ProcessRequest {
  binary: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin?: Uint8Array;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}
export interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}
export type RunProcess = (request: ProcessRequest) => Promise<ProcessResult>;

/** The caller chooses a fixed local executable; guest argv is always behind sbx exec. */
export const runProcess: RunProcess = (request) =>
  new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      reject(new LocalRefusal("LOCAL_CANCELLED", "Local operation was cancelled."));
      return;
    }
    const child = spawn(request.binary, [...request.argv], {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let refusal: LocalRefusal | null = null;
    const stop = (code: string, message: string) => {
      refusal ??= new LocalRefusal(code, message);
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(
      () => stop("LOCAL_COMMAND_TIMEOUT", "Local runtime did not answer in time."),
      request.timeoutMs,
    );
    const cancel = () => stop("LOCAL_CANCELLED", "Local operation was cancelled.");
    request.signal?.addEventListener("abort", cancel, { once: true });
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > request.maxBytes) {
        stop("LOCAL_OUTPUT_LIMIT", "Local runtime output exceeded its bound.");
      } else chunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop("LOCAL_INPUT_FAILED", "Could not deliver runtime input.");
    });
    child.once("error", () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
      reject(
        new LocalRefusal(
          "LOCAL_RUNTIME_UNAVAILABLE",
          "The configured local executable could not start.",
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
      if (refusal) reject(refusal);
      else
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: code ?? 1,
        });
    });
    child.stdin.end(request.stdin);
  });
