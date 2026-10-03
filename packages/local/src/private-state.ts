import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { LocalRefusal } from "./policy.js";

const KEY = /^[a-z][a-z0-9-]{0,127}\.json$/;
const MAX_STATE_BYTES = 16 * 1024 * 1024;

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

  /** No automatic lock stealing: after a crash, a local command verifies the old PID is gone. */
  async lock(): Promise<() => Promise<void>> {
    const path = join(this.root, "runner.lock");
    let handle;
    try {
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new LocalRefusal(
          "LOCAL_ALREADY_RUNNING",
          "Another companion owns this state; stop it before starting again.",
        );
      }
      throw error;
    }
    await handle.writeFile(String(process.pid));
    await handle.sync();
    await handle.close();
    return async () => {
      await unlink(path);
    };
  }
}
