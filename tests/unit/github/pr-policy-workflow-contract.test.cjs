"use strict";

const { readFileSync } = require("node:fs");
const { describe, expect, test } = require("@jest/globals");
const yaml = require("js-yaml");
const policy = require("../../../.github/scripts/pr-policy.cjs");

describe("PR Policy workflow and contributor contract", () => {
  const workflow = readFileSync(".github/workflows/pr-policy.yml", "utf8");
  const workflowDocument = yaml.load(workflow);
  const contributing = readFileSync("CONTRIBUTING.md", "utf8");
  const template = readFileSync(".github/PULL_REQUEST_TEMPLATE.md", "utf8");
  const codeowners = readFileSync(".github/CODEOWNERS", "utf8");

  test("uses a stable read-only check and trusted default-branch code for every repair trigger", () => {
    expect(workflowDocument.name).toBe("PR Policy");
    expect(Object.keys(workflowDocument.on)).toEqual(["pull_request"]);
    expect(workflowDocument.on.pull_request).toEqual({
      branches: ["master"],
      types: ["opened", "edited", "reopened", "synchronize"],
    });
    expect(workflowDocument.permissions).toEqual({});
    expect(Object.keys(workflowDocument.jobs)).toEqual(["policy"]);
    const job = workflowDocument.jobs.policy;
    expect(job.name).toBe("PR Policy");
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(job.steps).toHaveLength(2);
    expect(job.steps[0]).toEqual({
      name: "Check out trusted default-branch policy",
      uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      with: {
        ref: "${{ github.event.repository.default_branch }}",
        "persist-credentials": false,
      },
    });
    expect(job.steps[1]).toEqual({
      name: "Validate pull request",
      uses: "actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b",
      with: {
        script:
          "const adapter = require('./.github/scripts/pr-policy-adapter.cjs');\n" +
          "await adapter.run({ github, context, core });\n",
      },
    });
    expect(job.steps.every((step) => step.run === undefined)).toBe(true);
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toMatch(
      /github\.(?:head_ref|event\.pull_request\.(?:head|merge_commit_sha))/,
    );
    expect(workflow).not.toMatch(/uses: actions\/(checkout|github-script)@v\d/);
  });

  test("keeps title, issue, Testing and bot markers aligned", () => {
    for (const type of policy.ALLOWED_TYPES) expect(contributing).toContain(`\`${type}\``);
    for (const scope of policy.NO_ISSUE_SCOPES) expect(contributing).toContain(`\`${scope}\``);
    for (const permission of policy.NO_ISSUE_PERMISSIONS) {
      expect(contributing).toContain(`\`${permission}\``);
    }
    expect(contributing).toContain("type(scope)[!]: subject");
    expect(contributing).toContain("No issue: refresh repository policy metadata");
    expect(contributing).toContain("- Command:");
    expect(contributing).toContain("- Outcome:");
    expect(contributing).toContain(policy.DEPENDABOT.login);
    expect(contributing).toContain("name exactly matches that");
    expect(contributing).toContain("email matches the Git author email");
    expect(template).toContain("## Related issues");
    expect(template).toContain("Closes #");
    expect(template).toContain("No issue: concrete reason");
    expect(template).toContain("## Testing");
    expect(template).toContain("- Command:");
    expect(template).toContain("- Outcome:");
    expect(template).toContain("matching its Git author name/email");
    expect(policy.validateTesting(template)).toBeTruthy();
  });

  test("assigns the documented owner to actual governance and supply-chain boundaries", () => {
    const activeRules = codeowners
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    for (const rule of activeRules) {
      expect(rule.split(/\s+/).slice(1)).toEqual(["@witqq"]);
    }
    for (const path of [
      "/.github/workflows/",
      "/.github/scripts/",
      "/.releaserc.json",
      "/SECURITY.md",
      "/config/Dockerfile",
      "/docker-compose*.yml",
      "/package.json",
      "/package-lock.json",
      "/packages/*/package.json",
      "/packages/*/package-lock.json",
    ]) {
      expect(codeowners).toContain(`${path} @witqq`);
    }
  });
});
