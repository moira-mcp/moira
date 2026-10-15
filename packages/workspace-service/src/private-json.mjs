import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import process from "node:process";

/** Existing owner private JSON guard, shared by operation and security receipt readers. */
export async function readPrivateOwnerJson(path) {
  let acquired = false;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    acquired = true;
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0 ||
        info.uid !== process.getuid?.()
      )
        throw new Error();
      const value = JSON.parse(await handle.readFile("utf8"));
      const named = await lstat(path);
      const final = await handle.stat();
      if (
        named.dev !== info.dev ||
        named.ino !== info.ino ||
        final.size !== info.size ||
        final.mtimeMs !== info.mtimeMs ||
        final.ctimeMs !== info.ctimeMs
      )
        throw new Error();
      return value;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT" && !acquired) return null;
    throw Object.assign(new Error("UNSAFE_STATE"), { publicCode: "UNSAFE_STATE", status: 409 });
  }
}
