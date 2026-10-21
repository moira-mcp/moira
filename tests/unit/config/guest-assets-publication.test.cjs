"use strict";

const { mkdtemp, mkdir, writeFile, readFile, rm } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { describe, expect, test } = require("@jest/globals");

const entryPoints = {
  daemon: "packages/workspace-service/src/daemon.mjs",
  cli: "packages/workspace-service/src/cli.mjs",
  "local-bootstrap": "packages/workspace-service/src/local-bootstrap.mjs",
  "guest-proxy": "packages/local/src/guest-proxy.ts",
  "owner-renderer": "packages/workspace-service/src/owner-renderer.mjs",
  "extension-handler-host": "packages/extension-runner/src/binary-handler-host.mjs",
  "request-retirement": "packages/workspace-service/src/request-retirement.mjs",
};

describe("canonical guest asset publication", () => {
  test("rebuilding publishes complete new files while held readers retain their original generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "moira-guest-publication-"));
    try {
      const source = join(root, "packages/local/src");
      await mkdir(source, { recursive: true });
      await mkdir(join(root, "packages/workspace-service/src"), { recursive: true });
      await mkdir(join(root, "packages/extension-runner/src"), { recursive: true });
      const driver = join(root, "publication.mjs");
      const outcome = join(root, "outcome.json");
      await writeFile(
        driver,
        `const { buildWorkspaceService } = await import(process.argv[2]);
import { open, readFile, writeFile, stat } from "node:fs/promises";
process.umask(0);
const entryPoints = ${JSON.stringify(entryPoints)};
const entries = Object.keys(entryPoints);
for (const source of Object.values(entryPoints)) await writeFile(source, "export const generation = 'generation-A';\\n");
await buildWorkspaceService("output");
const readers = await Promise.all(entries.map(async entry => {
  const path = "output/" + entry + ".mjs";
  return { path, handle: await open(path, "r"), bytes: (await readFile(path)).toString("base64"), inode: (await stat(path)).ino, mode: (await stat(path)).mode & 0o777 };
}));
try {
  for (const source of Object.values(entryPoints)) await writeFile(source, "export const generation = 'generation-B';\\n");
  await buildWorkspaceService("output");
  const observed = await Promise.all(readers.map(async reader => ({
    original: reader.bytes,
    retained: (await reader.handle.readFile()).toString("base64"),
    current: (await readFile(reader.path)).toString("base64"),
    originalInode: reader.inode,
    currentInode: (await stat(reader.path)).ino,
    originalMode: reader.mode,
    currentMode: (await stat(reader.path)).mode & 0o777,
  })));
  await writeFile(process.argv[3], JSON.stringify(observed));
} finally {
  await Promise.all(readers.map(reader => reader.handle.close()));
}
`,
      );
      const child = spawnSync(
        process.execPath,
        [driver, pathToFileURL(resolve("scripts/build-workspace-service.js")).href, outcome],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 64 * 1024,
        },
      );
      if (child.error) throw child.error;
      expect({ exit: child.status, stderr: child.stderr }).toEqual({ exit: 0, stderr: "" });
      const assets = JSON.parse(await readFile(outcome, "utf8"));
      expect(assets).toHaveLength(Object.keys(entryPoints).length);
      for (const asset of assets) {
        expect(asset.retained).toBe(asset.original);
        expect(asset.currentInode).not.toBe(asset.originalInode);
        expect(Buffer.from(asset.original, "base64").toString()).toContain("generation-A");
        expect(Buffer.from(asset.current, "base64").toString()).toContain("generation-B");
        expect(asset.currentMode).toBe(asset.originalMode);
        expect(asset.currentMode).toBe(0o644);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failed compilation and publication retain complete prior programs and remove only owned temporary output", async () => {
    const root = await mkdtemp(join(tmpdir(), "moira-guest-publication-failure-"));
    try {
      await mkdir(join(root, "packages/local/src"), { recursive: true });
      await mkdir(join(root, "packages/workspace-service/src"), { recursive: true });
      await mkdir(join(root, "packages/extension-runner/src"), { recursive: true });
      const driver = join(root, "failure.mjs");
      const outcome = join(root, "outcome.json");
      await writeFile(
        driver,
        `const { buildWorkspaceService } = await import(process.argv[2]);
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
const entryPoints = ${JSON.stringify(entryPoints)};
for (const source of Object.values(entryPoints)) await writeFile(source, "export const generation = 'complete';\\n");
await buildWorkspaceService("output");
const original = (await readFile("output/daemon.mjs")).toString("base64");
await writeFile("packages/workspace-service/src/daemon.mjs", "export const = ;");
let compileFailed = false;
try { await buildWorkspaceService("output"); } catch { compileFailed = true; }
const afterCompile = (await readFile("output/daemon.mjs")).toString("base64");
const compileEntries = await readdir("output");
await writeFile("packages/workspace-service/src/daemon.mjs", "export const generation = 'replacement';\\n");
await rename("output/daemon.mjs", "output/previous-daemon.mjs");
await mkdir("output/daemon.mjs");
await writeFile("output/daemon.mjs/foreign.txt", "foreign bytes");
const foreignInode = (await stat("output/daemon.mjs")).ino;
let publishFailed = false;
try { await buildWorkspaceService("output"); } catch { publishFailed = true; }
await writeFile(process.argv[3], JSON.stringify({
  compileFailed, publishFailed, original, afterCompile, compileEntries,
  previous: (await readFile("output/previous-daemon.mjs")).toString("base64"),
  entries: await readdir("output"), foreignInode,
  currentForeignInode: (await stat("output/daemon.mjs")).ino,
  foreign: await readFile("output/daemon.mjs/foreign.txt", "utf8"),
}));
`,
      );
      const child = spawnSync(
        process.execPath,
        [driver, pathToFileURL(resolve("scripts/build-workspace-service.js")).href, outcome],
        { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 },
      );
      if (child.error) throw child.error;
      expect(child.status).toBe(0);
      const observed = JSON.parse(await readFile(outcome, "utf8"));
      expect(observed.compileFailed).toBe(true);
      expect(observed.publishFailed).toBe(true);
      expect(observed.afterCompile).toBe(observed.original);
      expect(observed.previous).toBe(observed.original);
      expect(observed.compileEntries.sort()).toEqual([
        "cli.mjs",
        "daemon.mjs",
        "extension-handler-host.mjs",
        "guest-proxy.mjs",
        "local-bootstrap.mjs",
        "owner-renderer.mjs",
        "request-retirement.mjs",
      ]);
      expect(observed.entries.sort()).toEqual([
        "cli.mjs",
        "daemon.mjs",
        "extension-handler-host.mjs",
        "guest-proxy.mjs",
        "local-bootstrap.mjs",
        "owner-renderer.mjs",
        "previous-daemon.mjs",
        "request-retirement.mjs",
      ]);
      expect(observed.currentForeignInode).toBe(observed.foreignInode);
      expect(observed.foreign).toBe("foreign bytes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
