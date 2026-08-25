"use strict";

const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { describe, expect, test } = require("@jest/globals");
const coordinator = require("../../../.github/scripts/issue-claim.cjs");

describe("issue claim GitHub Actions contract", () => {
  const workflow = readFileSync(resolve(".github/workflows/issue-claims.yml"), "utf8");
  const contributing = readFileSync(resolve("CONTRIBUTING.md"), "utf8");
  const agents = readFileSync(resolve("AGENTS.md"), "utf8");
  const triage = readFileSync(resolve(".github/ISSUE_TRIAGE.md"), "utf8");
  const bugTemplate = readFileSync(resolve(".github/ISSUE_TEMPLATE/bug_report.md"), "utf8");
  const featureTemplate = readFileSync(
    resolve(".github/ISSUE_TEMPLATE/feature_request.md"),
    "utf8",
  );

  test("uses trusted default-branch code, least privilege and no contributor-code trigger", () => {
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(
      workflow.match(/actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/g),
    ).toHaveLength(3);
    expect(
      workflow.match(/actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3/g),
    ).toHaveLength(3);
    expect(workflow).not.toMatch(/uses: actions\/(checkout|github-script)@v\d/);
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).not.toContain("pull_request_target");
  });

  test("serializes commands and scheduled reconciliation with the same per-issue key", () => {
    expect(workflow.match(/group: issue-claim-\$\{\{ github\.repository \}\}-/g)).toHaveLength(2);
    expect(workflow).toContain("github.event.issue.number");
    expect(workflow).toContain("matrix.issue_number");
    expect(workflow.match(/cancel-in-progress: false/g)).toHaveLength(2);
  });

  test("provides command, daily, manual-target and per-issue reconciliation paths", () => {
    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("issue_number:");
    expect(workflow).toContain("fromJSON(needs.lease_discovery.outputs.issue_numbers)");
    expect(workflow).toContain("coordinator.handleIssueEvent");
    expect(workflow).toContain("coordinator.drainIssueCommands");
    expect(workflow).toContain("coordinator.reconcileIssue");
  });

  test("keeps contributor, maintainer, agent and issue-template contracts aligned", () => {
    for (const value of [
      coordinator.CLAIM_COMMAND,
      coordinator.RELEASE_COMMAND,
      coordinator.READY_STATUS,
      coordinator.IN_PROGRESS_STATUS,
      coordinator.STATE_MARKER,
      coordinator.REMINDER_MARKER,
    ]) {
      expect(contributing).toContain(value);
    }
    expect(contributing).toContain("seven days");
    expect(contributing).toContain("three-day grace period");
    expect(contributing).toContain("closing keyword");
    expect(contributing).toContain("first successful reconciliation");
    expect(agents).toContain("read `CONTRIBUTING.md` completely");
    expect(triage).toContain("assignee");
    expect(triage).toContain("`/claim`");
    expect(triage).toContain("`/release`");
    expect(bugTemplate).toContain('labels: "type:bug, status:needs-triage"');
    expect(featureTemplate).toContain('labels: "type:feature, status:needs-triage"');
  });
});
