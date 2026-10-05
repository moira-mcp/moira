import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { LocalRefusal } from "./policy.js";
import { PassThrough } from "node:stream";
import { runProcess } from "./process.js";
import { runtimeControlAsset } from "./assets.js";

const KEY = /^[a-z][a-z0-9-]{0,127}\.json$/;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const busy = () =>
  new LocalRefusal(
    "LOCAL_ALREADY_RUNNING",
    "Another companion owns this state; stop it before starting again.",
  );

/** Fixed native gate only: no runtime executable, credentials or work commands. */
async function acquireGate(root: string): Promise<() => Promise<void>> {
  const input = new PassThrough();
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let frame = "";
  const completion = runProcess({
    binary: runtimeControlAsset(),
    argv: ["--state-lock", root],
    cwd: root,
    env: {},
    input,
    timeoutMs: null,
    maxBytes: 1024,
    onStdout: (chunk) => {
      frame += chunk.toString("utf8");
      if (frame.startsWith('{"ready":true}\n')) ready();
    },
  });
  try {
    await Promise.race([
      readiness,
      completion.then((result) => {
        if (result.exitCode === 5) throw busy();
        throw new LocalRefusal("LOCAL_STATE_UNSAFE", "The private kernel lock was refused.");
      }),
    ]);
  } catch (error) {
    input.end();
    await completion.catch(() => undefined);
    throw error;
  }
  let release: Promise<void> | undefined;
  return () =>
    (release ??= (async () => {
      input.end("stop\n");
      const result = await completion;
      if (result.exitCode !== 0 || !result.stdout.toString("utf8").endsWith('{"settled":true}\n'))
        throw new LocalRefusal("LOCAL_STATE_UNSAFE", "The private kernel lock did not settle.");
    })());
}

/** Only locally selected state lives here; callers never supply cloud-controlled paths. */
export class PrivateState {
  private constructor(readonly root: string) {}

  static async open(path: string): Promise<PrivateState> {
    const resolved = resolve(path);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    const canonical = await realpath(resolved);
    const metadata = await lstat(resolved);
    if (
      canonical !== resolved ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0 ||
      (process.getuid && metadata.uid !== process.getuid())
    ) {
      throw new LocalRefusal(
        "LOCAL_STATE_UNSAFE",
        "State must be a private, owned directory without symlinks.",
      );
    }
    return new PrivateState(canonical);
  }

  private path(key: string): string {
    if (!KEY.test(key))
      throw new LocalRefusal("LOCAL_STATE_KEY_INVALID", "Invalid local state key.");
    return join(this.root, key);
  }

  async read<T>(key: string, parse: (value: unknown) => T): Promise<T | null> {
    let handle;
    try {
      handle = await open(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size > MAX_STATE_BYTES ||
        (process.getuid && metadata.uid !== process.getuid())
      ) {
        throw new LocalRefusal("LOCAL_STATE_UNSAFE", "Unsafe local state file.");
      }
      const bytes = Buffer.alloc(metadata.size + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total !== metadata.size)
        throw new LocalRefusal("LOCAL_STATE_CHANGED", "Local state changed while reading.");
      return parse(JSON.parse(bytes.subarray(0, total).toString("utf8")));
    } finally {
      await handle.close();
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    const target = this.path(key);
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_STATE_BYTES)
      throw new LocalRefusal("LOCAL_STATE_FULL", "Local state limit reached.");
    const temporary = join(this.root, `.write-${randomBytes(16).toString("hex")}`);
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
        throw new LocalRefusal("LOCAL_STATE_UNSAFE", "Unsafe local state replacement.");
      }
      await rename(temporary, target);
      const directory = await open(dirname(target), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async remove(key: string): Promise<void> {
    await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async keys(prefix: string): Promise<string[]> {
    return (await readdir(this.root)).filter((name) => KEY.test(name) && name.startsWith(prefix));
  }

  /** Ordinary callers never steal markers; explicit recovery requires a proven absent PID. */
  async lock(options?: { recoverStale: boolean }): Promise<() => Promise<void>> {
    const releaseGate = await acquireGate(this.root);
    const path = join(this.root, "runner.lock");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (options?.recoverStale) {
        const old = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw new LocalRefusal("LOCAL_STATE_UNSAFE", "Unsafe runner lock marker.");
        });
        if (old) {
          try {
            const metadata = await old.stat();
            if (
              !metadata.isFile() ||
              metadata.nlink !== 1 ||
              (metadata.mode & 0o077) !== 0 ||
              metadata.size < 1 ||
              metadata.size > 10 ||
              (process.getuid && metadata.uid !== process.getuid())
            )
              throw new LocalRefusal("LOCAL_STATE_UNSAFE", "Unsafe runner lock marker.");
            const buffer = Buffer.alloc(11);
            const read = await old.read(buffer, 0, buffer.length, 0);
            const bytes = buffer.subarray(0, read.bytesRead);
            const value = bytes.toString("utf8");
            if (
              !/^[1-9][0-9]{0,9}$/.test(value) ||
              Number(value) > 2147483647 ||
              bytes.length !== metadata.size
            )
              throw new LocalRefusal("LOCAL_STATE_UNSAFE", "Unknown runner lock owner.");
            try {
              process.kill(Number(value), 0);
              throw busy();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw busy();
            }
            const current = await lstat(path);
            const again = Buffer.alloc(bytes.length + 1);
            const reread = await old.read(again, 0, again.length, 0);
            if (
              current.dev !== metadata.dev ||
              current.ino !== metadata.ino ||
              current.size !== metadata.size ||
              reread.bytesRead !== bytes.length ||
              !again.subarray(0, bytes.length).equals(bytes)
            )
              throw new LocalRefusal("LOCAL_STATE_CHANGED", "Runner lock changed during recovery.");
            await unlink(path);
          } finally {
            await old.close();
          }
        }
      }
      handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(String(process.pid));
      await handle.sync();
      const own = await handle.stat();
      await handle.close();
      handle = undefined;
      let released: Promise<void> | undefined;
      return () =>
        (released ??= (async () => {
          try {
            const marker = await open(
              path,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              const current = await marker.stat();
              const bytes = Buffer.alloc(11);
              const read = await marker.read(bytes, 0, bytes.length, 0);
              if (
                current.dev !== own.dev ||
                current.ino !== own.ino ||
                current.nlink !== 1 ||
                !current.isFile() ||
                (current.mode & 0o077) !== 0 ||
                bytes.subarray(0, read.bytesRead).toString("utf8") !== String(process.pid)
              )
                throw new LocalRefusal("LOCAL_STATE_CHANGED", "The runner lock owner changed.");
              const named = await lstat(path);
              if (named.dev !== own.dev || named.ino !== own.ino)
                throw new LocalRefusal("LOCAL_STATE_CHANGED", "The runner lock owner changed.");
            } finally {
              await marker.close();
            }
            await unlink(path);
          } finally {
            await releaseGate();
          }
        })());
    } catch (error) {
      const cleanup = await Promise.allSettled([handle?.close(), releaseGate()]);
      const failures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          "Runner lock acquisition and cleanup failed",
          { cause: error },
        );
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw busy();
      throw error;
    }
  }
}
