#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TOOLCHAIN = Object.freeze([
  "semantic-release@24.2.9",
  "@semantic-release/commit-analyzer@13.0.1",
  "@semantic-release/release-notes-generator@14.1.1",
  "conventional-changelog-conventionalcommits@9.3.1",
]);

const FIXTURES = Object.freeze([
  ["feat(github): add automation", null],
  ["fix(repo): repair repository metadata", null],
  ["perf(contributing): simplify contributor checks", null],
  ["feat(github)!: replace automation contract", null],
  ["feat(repo): replace metadata\n\nBREAKING CHANGE: repository-only format", null],
  ["feat(contributing): replace guidance\n\nBREAKING-CHANGE: repository-only format", null],
  ["feat(github-api): add webhook", "minor"],
  ["fix(contributing-tools): repair helper", "patch"],
  ["feat(api): add endpoint", "minor"],
  ["fix(api): reject invalid input", "patch"],
  ["perf(api): reduce latency", "patch"],
  ["feat(api)!: replace endpoint contract", "major"],
  ["feat(api): replace endpoint\n\nBREAKING CHANGE: incompatible response", "major"],
  ["feat(api): replace endpoint\n\nBREAKING-CHANGE: incompatible response", "major"],
  ["not a conventional commit", null],
]);

function fail(message, details = "") {
  const suffix = details ? `\n${details}` : "";
  throw new Error(`${message}${suffix}`);
}

async function loadPluginConfig(name) {
  const config = JSON.parse(await readFile(new URL("../.releaserc.json", import.meta.url), "utf8"));
  const entry = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === name);
  if (!entry || typeof entry[1] !== "object") {
    fail(`Release config does not expose options for ${name}`);
  }
  return entry[1];
}

async function main() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) fail("Run this verifier through npm run test:release-policy");

  const workspace = await mkdtemp(join(tmpdir(), "moira-release-policy-"));
  try {
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
      "utf8",
    );
    const install = spawnSync(
      process.execPath,
      [
        npmCli,
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--save=false",
        ...TOOLCHAIN,
      ],
      { cwd: workspace, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    if (install.status !== 0) {
      fail("Unable to install isolated release-policy toolchain", install.stderr || install.stdout);
    }

    const analyzerUrl = pathToFileURL(
      join(workspace, "node_modules/@semantic-release/commit-analyzer/index.js"),
    );
    const notesUrl = pathToFileURL(
      join(workspace, "node_modules/@semantic-release/release-notes-generator/index.js"),
    );
    const { analyzeCommits } = await import(analyzerUrl.href);
    const { generateNotes } = await import(notesUrl.href);
    const pluginConfig = await loadPluginConfig("@semantic-release/commit-analyzer");
    const notesConfig = await loadPluginConfig("@semantic-release/release-notes-generator");
    const context = { logger: { log() {} } };

    for (const [message, expected] of FIXTURES) {
      const actual =
        (await analyzeCommits(pluginConfig, { ...context, commits: [{ message }] })) ?? null;
      if (actual !== expected) {
        fail(
          `Release policy mismatch for ${JSON.stringify(message)}`,
          `expected=${String(expected)} actual=${String(actual)}`,
        );
      }
    }
    const notes = await generateNotes(notesConfig, {
      ...context,
      commits: [
        {
          hash: "0123456789abcdef",
          message: "feat(api): replace endpoint\n\nBREAKING CHANGE: incompatible response",
        },
      ],
      lastRelease: { version: "1.0.0", gitTag: "v1.0.0" },
      nextRelease: { version: "2.0.0", gitTag: "v2.0.0", type: "major" },
      options: { repositoryUrl: "https://github.com/moira-mcp/moira" },
    });
    if (
      !notes.includes("replace endpoint") ||
      !notes.includes("incompatible response") ||
      !notes.includes("BREAKING CHANGES")
    ) {
      fail("Release-notes generator did not render the configured breaking fixture", notes);
    }
    process.stdout.write("release policy: official analyzer fixtures passed\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
