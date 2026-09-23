/**
 * `scripts/git-tree-identity.mjs` names the tree an image is built from: the commit for a clean
 * checkout, `<commit>-dirty-<hash>` otherwise. The build script falls back to `unknown` when it
 * fails, so a failure is silent — which is why a large uncommitted binary change (regenerated
 * screenshot baselines, for example) must still produce an identity.
 */

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

const script = path.resolve("scripts/git-tree-identity.mjs");

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function identity() {
  return spawnSync(process.execPath, [script, repo], { encoding: "utf8" });
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "moira-tree-identity-"));
  git("init", "-q");
  git("config", "user.email", "probe@example.com");
  git("config", "user.name", "probe");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "baseline.bin"), crypto.randomBytes(1024));
  git("add", ".");
  git("commit", "-q", "-m", "baseline");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("git tree identity", () => {
  test("a clean checkout is named by its commit", () => {
    const result = identity();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(git("rev-parse", "HEAD"));
  });

  test("an uncommitted binary change larger than a process pipe buffer still yields a dirty identity", () => {
    // Random bytes do not compress, so the binary diff is several MiB — past execFileSync's
    // default 1 MiB buffer that once turned every such build into `commit: unknown`.
    fs.writeFileSync(path.join(repo, "baseline.bin"), crypto.randomBytes(3 * 1024 * 1024));
    const result = identity();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^${git("rev-parse", "HEAD")}-dirty-[0-9a-f]{16}$`));
  });

  test("the dirty identity changes with the content of the change", () => {
    fs.writeFileSync(path.join(repo, "baseline.bin"), Buffer.alloc(2048, 1));
    const first = identity().stdout;
    fs.writeFileSync(path.join(repo, "baseline.bin"), Buffer.alloc(2048, 2));
    const second = identity().stdout;
    expect(first).toMatch(/-dirty-[0-9a-f]{16}$/);
    expect(second).toMatch(/-dirty-[0-9a-f]{16}$/);
    expect(second).not.toBe(first);
  });
});
