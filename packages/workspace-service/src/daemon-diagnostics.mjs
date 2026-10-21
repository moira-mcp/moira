import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readSync,
  writeSync,
  ftruncateSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import process from "node:process";
import { Buffer } from "node:buffer";
import { descriptorPath } from "./file-primitives.mjs";

export const DAEMON_DIAGNOSTIC_FILE_BYTES = 1024 * 1024;
export const DAEMON_DIAGNOSTIC_FILE_COUNT = 3;

const unsafe = () => new Error("Workspace diagnostic storage is unsafe");
const same = (left, right) => !!left && !!right && left.dev === right.dev && left.ino === right.ino;

/** The daemon owns its actual writer; command stdout/stderr never pass through this sink. */
export function openDaemonDiagnostics(directory) {
  const parent = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const handle = { fd: parent, moiraPath: directory };
  const identity = fstatSync(parent);
  const names = Array.from({ length: DAEMON_DIAGNOSTIC_FILE_COUNT }, (_, index) =>
    index ? `daemon.log.${index}` : "daemon.log",
  );
  let writer;
  let closed = false;
  const syncDirectory = () => {
    try {
      fsyncSync(parent);
    } catch (error) {
      if (process.platform === "linux" || !["EINVAL", "ENOTSUP"].includes(error.code)) throw error;
    }
  };
  const verifyDirectory = () => {
    const named = lstatSync(directory);
    if (
      !identity.isDirectory() ||
      identity.uid !== process.getuid() ||
      (identity.mode & 0o777) !== 0o700 ||
      named.uid !== process.getuid() ||
      (named.mode & 0o777) !== 0o700 ||
      !same(identity, named) ||
      realpathSync(directory) !== directory
    )
      throw unsafe();
  };
  const inspect = (name) => {
    try {
      const value = lstatSync(descriptorPath(handle, name));
      if (
        !value.isFile() ||
        value.nlink !== 1 ||
        value.uid !== process.getuid() ||
        (value.mode & 0o777) !== 0o600
      )
        throw unsafe();
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const openFile = (name) => {
    const previous = inspect(name);
    const fd = openSync(
      descriptorPath(handle, name),
      constants.O_RDWR |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (previous ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    try {
      const opened = fstatSync(fd);
      if (!same(opened, inspect(name)) || (previous && !same(opened, previous))) throw unsafe();
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  };
  const writeAll = (fd, bytes, position) => {
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, position + offset);
      if (!written) throw new Error("Workspace diagnostic write did not progress");
      offset += written;
    }
  };
  const verifyWriter = () => {
    verifyDirectory();
    if (closed || writer === undefined || !same(fstatSync(writer), inspect(names[0])))
      throw unsafe();
  };
  const rotate = () => {
    verifyWriter();
    // Validate every destination before changing any retained diagnostic entry.
    const retained = names.map(inspect);
    fsyncSync(writer);
    closeSync(writer);
    writer = undefined;
    if (retained.at(-1)) {
      if (!same(retained.at(-1), inspect(names.at(-1)))) throw unsafe();
      unlinkSync(descriptorPath(handle, names.at(-1)));
    }
    for (let index = names.length - 2; index >= 0; index -= 1) {
      if (retained[index]) {
        if (!same(retained[index], inspect(names[index])) || inspect(names[index + 1]))
          throw unsafe();
        renameSync(descriptorPath(handle, names[index]), descriptorPath(handle, names[index + 1]));
      }
    }
    syncDirectory();
    writer = openFile(names[0]);
    fsyncSync(writer);
    syncDirectory();
  };
  try {
    verifyDirectory();
    // Restart cannot preserve an oversized append inode as an oversized archive.
    const retained = names.map(inspect);
    for (let index = 0; index < names.length; index += 1) {
      if (!retained[index] || retained[index].size <= DAEMON_DIAGNOSTIC_FILE_BYTES) continue;
      const fd = openFile(names[index]);
      try {
        const tail = Buffer.alloc(DAEMON_DIAGNOSTIC_FILE_BYTES);
        let offset = 0;
        while (offset < tail.length) {
          const read = readSync(
            fd,
            tail,
            offset,
            tail.length - offset,
            retained[index].size - tail.length + offset,
          );
          if (!read) throw new Error("Workspace diagnostic tail changed");
          offset += read;
        }
        ftruncateSync(fd, 0);
        writeAll(fd, tail, 0);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    writer = openFile(names[0]);
    fsyncSync(writer);
    syncDirectory();
  } catch (error) {
    if (writer !== undefined) closeSync(writer);
    closeSync(parent);
    throw error;
  }
  return {
    write(input) {
      verifyWriter();
      const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
      for (let offset = 0; offset < bytes.length;) {
        let size = fstatSync(writer).size;
        if (size >= DAEMON_DIAGNOSTIC_FILE_BYTES) {
          rotate();
          size = 0;
        }
        const chunk = bytes.subarray(offset, offset + DAEMON_DIAGNOSTIC_FILE_BYTES - size);
        writeAll(writer, chunk, size);
        fsyncSync(writer);
        offset += chunk.length;
      }
    },
    redirectStandardStreams() {
      const previous = [process.stdout.write, process.stderr.write];
      const write = (chunk, encoding, callback) => {
        try {
          this.write(
            typeof chunk === "string"
              ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
              : chunk,
          );
        } catch {
          // Never fall back to an inherited, unbounded descriptor after sink failure.
          process.exit(1);
        }
        const done = typeof encoding === "function" ? encoding : callback;
        if (done) done();
        return true;
      };
      process.stdout.write = write;
      process.stderr.write = write;
      return () => {
        [process.stdout.write, process.stderr.write] = previous;
      };
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        if (writer !== undefined) closeSync(writer);
      } finally {
        closeSync(parent);
      }
    },
  };
}
