"use strict";

const { readFileSync } = require("node:fs");
const { describe, expect, test } = require("@jest/globals");

describe("release policy persistent contract", () => {
  const config = JSON.parse(readFileSync(".releaserc.json", "utf8"));
  const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
  const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const verifier = readFileSync("scripts/verify-release-policy.js", "utf8");
  const contributing = readFileSync("CONTRIBUTING.md", "utf8");

  test("uses one conventionalcommits parser contract and exact no-release scopes", () => {
    const analyzer = config.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/commit-analyzer",
    );
    const notes = config.plugins.find(
      (plugin) =>
        Array.isArray(plugin) && plugin[0] === "@semantic-release/release-notes-generator",
    );
    expect(analyzer[1].preset).toBe("conventionalcommits");
    expect(notes[1].preset).toBe("conventionalcommits");
    expect(analyzer[1].parserOpts).toEqual(notes[1].parserOpts);
    expect(analyzer[1].releaseRules).toEqual([
      { scope: "github", release: false },
      { scope: "repo", release: false },
      { scope: "contributing", release: false },
    ]);
  });

  test("pins the deployed and isolated official analyzer toolchains identically", () => {
    for (const version of [
      "24.2.9",
      "@semantic-release/commit-analyzer@13.0.1",
      "@semantic-release/release-notes-generator@14.1.1",
      "conventional-changelog-conventionalcommits@9.3.1",
    ]) {
      expect(releaseWorkflow).toContain(version);
      expect(verifier).toContain(version);
    }
    expect(packageJson.scripts["test:release-policy"]).toBe(
      "node scripts/verify-release-policy.js",
    );
    expect(ciWorkflow).toContain("npm run test:release-policy");
  });

  test("keeps release tooling outside the persistent dependency graph", () => {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      expect(packageJson[field] || {}).not.toHaveProperty("semantic-release");
      expect(packageJson[field] || {}).not.toHaveProperty("@semantic-release/commit-analyzer");
      expect(packageJson[field] || {}).not.toHaveProperty(
        "@semantic-release/release-notes-generator",
      );
      expect(packageJson[field] || {}).not.toHaveProperty(
        "conventional-changelog-conventionalcommits",
      );
    }
    expect(verifier).toContain("mkdtemp");
    expect(verifier).toContain("--ignore-scripts");
    expect(verifier).toContain("--no-package-lock");
    expect(verifier).toContain("await rm(workspace, { recursive: true, force: true })");
    const persistentPackages = Object.keys(packageLock.packages || {});
    for (const name of [
      "semantic-release",
      "@semantic-release/commit-analyzer",
      "@semantic-release/release-notes-generator",
      "conventional-changelog-conventionalcommits",
    ]) {
      expect(persistentPackages.some((path) => path.endsWith(`/node_modules/${name}`))).toBe(false);
      expect(persistentPackages).not.toContain(`node_modules/${name}`);
    }
  });

  test("documents product and repository-only release behavior", () => {
    expect(contributing).toContain("Scopes `github`, `repo`, and `contributing`");
    expect(contributing).toContain("`feat(scope)!: …`");
    expect(contributing).toContain("`BREAKING CHANGE:`");
  });
});
