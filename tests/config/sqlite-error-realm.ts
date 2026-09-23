/**
 * Makes SQLite errors real `Error`s in every test file, whichever file ran first in the worker.
 *
 * better-sqlite3 hands its native addon the `SqliteError` class once per process: the first
 * `new Database()` registers the class and marks the addon initialized. Jest gives every test file
 * its own module registry and global realm but loads a native addon only once per worker, so every
 * later file receives errors built from the first file's class. Such an error is not
 * `instanceof Error` in the later file, and `expect(...).rejects.toThrow()` reports "did not throw"
 * for a promise that did reject. Which files are hit depends on the order Jest runs them in.
 *
 * Registering this file's own `SqliteError` with the addon before its tests run gives each file
 * errors of its own realm.
 */
import { createRequire } from "node:module";
import { jest } from "@jest/globals";

const nodeRequire = createRequire(import.meta.url);

// The class as this test file's realm sees it (through Jest's registry, not Node's).
const SqliteError = jest.requireActual<new (message: string, code: string) => Error>(
  "better-sqlite3/lib/sqlite-error.js",
);
// The native addon is one object per worker process, shared by every file's better-sqlite3.
const addon = nodeRequire(
  nodeRequire.resolve("better-sqlite3/build/Release/better_sqlite3.node"),
) as {
  setErrorConstructor(constructor: unknown): void;
  isInitialized?: boolean;
};
addon.setErrorConstructor(SqliteError);
addon.isInitialized = true;
