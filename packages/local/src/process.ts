import { spawn } from "node:child_process";
import { LocalRefusal } from "./policy.js";

export interface ProcessRequest {
  binary: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin?: Uint8Array;
  /** Owner-bound companions use EOF instead of a command deadline. SDK calls remain finite. */
  input?: AsyncIterable<Uint8Array>;
  onStdout?: (chunk: Buffer) => void;
  /** Persistent fixed companions retain a bounded tail per stream instead of a lifetime budget. */
  retainOutput?: boolean;
  timeoutMs: number | null;
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
    const timer =
      request.timeoutMs === null
        ? undefined
        : setTimeout(
            () => stop("LOCAL_COMMAND_TIMEOUT", "Local runtime did not answer in time."),
            request.timeoutMs,
          );
    const cancel = () => stop("LOCAL_CANCELLED", "Local operation was cancelled.");
    request.signal?.addEventListener("abort", cancel, { once: true });
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (!request.retainOutput && bytes > request.maxBytes) {
        stop("LOCAL_OUTPUT_LIMIT", "Local runtime output exceeded its bound.");
      } else {
        chunks.push(Buffer.from(chunk));
        if (request.retainOutput) {
          let retained = chunks.reduce((total, bytes) => total + bytes.length, 0);
          while (retained > request.maxBytes) {
            const first = chunks[0];
            const drop = Math.min(first.length, retained - request.maxBytes);
            if (drop === first.length) chunks.shift();
            else chunks[0] = first.subarray(drop);
            retained -= drop;
          }
        }
        if (chunks === stdout && request.onStdout) {
          try {
            request.onStdout(Buffer.from(chunk));
          } catch {
            stop("LOCAL_OUTPUT_INVALID", "The local companion returned invalid output.");
          }
        }
      }
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
    if (request.input) {
      const input = request.input;
      void (async () => {
        try {
          if (request.stdin) throw new Error("Conflicting input modes");
          for await (const chunk of input) {
            if (child.stdin.destroyed) break;
            if (!child.stdin.write(chunk))
              await new Promise<void>((done) => {
                child.stdin.once("drain", done);
                child.stdin.once("close", done);
              });
          }
          child.stdin.end();
        } catch {
          stop("LOCAL_INPUT_FAILED", "Could not deliver companion input.");
        }
      })();
    } else child.stdin.end(request.stdin);
  });
