"use strict";

const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { describe, expect, test } = require("@jest/globals");
const yaml = require("js-yaml");

const WORKFLOW_DIR = ".github/workflows";

function workflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => `${WORKFLOW_DIR}/${name}`);
}

function externalUsesLines() {
  return workflowFiles().flatMap((path) =>
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line, index) => ({ path, line: index + 1, text: line.trim() }))
      .filter(({ text }) => /^-?\s*uses:\s*/.test(text))
      .filter(({ text }) => !/uses:\s+\.\//.test(text)),
  );
}

describe("security automation contract", () => {
  test("keeps npm resolution at the workspace root", () => {
    expect(existsSync("package-lock.json")).toBe(true);
    expect(existsSync("packages/web-backend/package-lock.json")).toBe(false);
  });

  test("groups root npm and GitHub Actions updates with PR Policy-compatible prefixes", () => {
    const config = yaml.load(readFileSync(".github/dependabot.yml", "utf8"));
    expect(config.version).toBe(2);
    expect(config.updates).toHaveLength(2);

    const npm = config.updates.find((entry) => entry["package-ecosystem"] === "npm");
    const actions = config.updates.find((entry) => entry["package-ecosystem"] === "github-actions");
    expect(Object.keys(npm)).toEqual([
      "package-ecosystem",
      "directory",
      "target-branch",
      "schedule",
      "open-pull-requests-limit",
      "labels",
      "rebase-strategy",
      "commit-message",
      "groups",
    ]);
    expect(npm).toMatchObject({
      directory: "/",
      "target-branch": "master",
      schedule: { interval: "weekly", day: "monday", time: "04:00", timezone: "Etc/UTC" },
      "open-pull-requests-limit": 3,
      labels: ["type:chore", "component:infrastructure"],
      "rebase-strategy": "auto",
      "commit-message": { prefix: "build", "prefix-development": "build", include: "scope" },
    });
    expect(npm.groups).toEqual({
      "production-dependencies": {
        "applies-to": "version-updates",
        "dependency-type": "production",
        patterns: ["*"],
      },
      "development-dependencies": {
        "applies-to": "version-updates",
        "dependency-type": "development",
        patterns: ["*"],
      },
      "security-production-dependencies": {
        "applies-to": "security-updates",
        "dependency-type": "production",
        patterns: ["*"],
      },
      "security-development-dependencies": {
        "applies-to": "security-updates",
        "dependency-type": "development",
        patterns: ["*"],
      },
    });
    expect(actions).toEqual({
      "package-ecosystem": "github-actions",
      directory: "/",
      "target-branch": "master",
      schedule: { interval: "weekly", day: "monday", time: "04:30", timezone: "Etc/UTC" },
      "open-pull-requests-limit": 1,
      labels: ["type:chore", "component:infrastructure"],
      "rebase-strategy": "auto",
      "commit-message": { prefix: "build", include: "scope" },
      groups: { "github-actions": { patterns: ["*"] } },
    });
  });

  test("pins every external Action in the complete workflow corpus", () => {
    const files = workflowFiles();
    expect(files).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/e2e.yml",
      ".github/workflows/issue-claims.yml",
      ".github/workflows/pr-policy.yml",
      ".github/workflows/publish-image.yml",
      ".github/workflows/release.yml",
      ".github/workflows/security.yml",
    ]);
    const uses = externalUsesLines();
    expect(uses.length).toBeGreaterThan(0);
    for (const item of uses) {
      const location = `${item.path}:${item.line} ${item.text}`;
      const repositoryAction =
        /uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}\s+#\s+v\S+$/;
      const dockerAction = /uses:\s+docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}\s+#\s+v\S+$/;
      expect(repositoryAction.test(location) || dockerAction.test(location)).toBe(true);
    }
  });

  test("uses a base-owned read-only gate and treats PR files only as static data", () => {
    const document = yaml.load(readFileSync(".github/workflows/security.yml", "utf8"));
    expect(Object.keys(document)).toEqual(["name", "on", "permissions", "jobs"]);
    expect(document.name).toBe("Security Checks");
    expect(Object.keys(document.on)).toEqual(["pull_request_target"]);
    expect(document.on.pull_request_target).toEqual({
      branches: ["master"],
      types: ["opened", "edited", "reopened", "synchronize"],
    });
    expect(document.permissions).toEqual({});
    expect(Object.keys(document.jobs)).toEqual(["security"]);
    const job = document.jobs.security;
    expect(Object.keys(job)).toEqual([
      "name",
      "runs-on",
      "timeout-minutes",
      "permissions",
      "steps",
    ]);
    expect(job).toMatchObject({
      name: "Security Checks",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      permissions: { contents: "read" },
    });
    expect(job.steps.map((step) => step.name)).toEqual([
      "Review dependency changes",
      "Check out pull request as untrusted data",
      "Remove pull-request actionlint policy",
      "Validate workflow syntax and expressions",
      "Require immutable external Actions",
    ]);
    expect(job.steps[0]).toEqual({
      name: "Review dependency changes",
      uses: "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294",
      with: {
        "vulnerability-check": true,
        "license-check": false,
        "warn-only": false,
        "fail-on-severity": "moderate",
        "fail-on-scopes": "runtime, development, unknown",
      },
    });
    expect(job.steps[1]).toEqual({
      name: "Check out pull request as untrusted data",
      uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      with: {
        ref: "${{ github.event.pull_request.merge_commit_sha }}",
        "persist-credentials": false,
      },
    });
    expect(job.steps[2]).toEqual({
      name: "Remove pull-request actionlint policy",
      run: "rm -f .github/actionlint.yml .github/actionlint.yaml",
    });
    expect(job.steps[3]).toEqual({
      name: "Validate workflow syntax and expressions",
      uses: "devops-actions/actionlint@ec02b36684b2f574f1d219ad0a43b082e46bf3e4",
      with: { "fail-on-errors": true },
    });
    expect(job.steps[4]).toEqual({
      name: "Require immutable external Actions",
      uses: "zgosalvez/github-actions-ensure-sha-pinned-actions@c5fc58bd0be7a4b94b73ce40250322d5b838a108",
    });
    const raw = readFileSync(".github/workflows/security.yml", "utf8");
    expect(raw).not.toContain("secrets.");
    expect(raw).not.toMatch(/npm\s+(?:ci|install)|yarn|pnpm|pull_request:\s/);
  });

  test("keeps contributor and security documentation aligned", () => {
    const contributing = readFileSync("CONTRIBUTING.md", "utf8");
    const security = readFileSync("SECURITY.md", "utf8");
    for (const value of [
      "Security Checks",
      "moderate-or-higher",
      "runtime, development, and unknown",
      "actionlint",
      "immutable commit SHA or image digest",
    ]) {
      expect(contributing).toContain(value);
      expect(security).toContain(value);
    }
    expect(security).toContain("do not mean that all existing");
    for (const document of [contributing, security]) {
      expect(document).toMatch(/version\s+updates weekly/);
      expect(document).toMatch(/do not wait for the weekly version-update\s+schedule/);
      expect(document).toContain("`type:chore`");
      expect(document).not.toContain("5 business days");
    }
  });
});
