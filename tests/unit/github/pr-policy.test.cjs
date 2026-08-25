"use strict";

const { describe, expect, test } = require("@jest/globals");
const policy = require("../../../.github/scripts/pr-policy.cjs");

function humanCommit(override = {}) {
  return {
    sha: "0123456789abcdef",
    message: "feat(cli): add command\n\nSigned-off-by: Alice Example <alice@example.com>",
    gitAuthor: { name: "Alice Example", email: "alice@example.com" },
    githubAuthor: { login: "alice", id: 10, type: "User" },
    verified: false,
    ...override,
  };
}

function validInput(override = {}) {
  return {
    repository: { owner: "moira-mcp", repo: "moira" },
    title: "feat(cli): add command",
    body: [
      "## Summary",
      "Add a command.",
      "",
      "## Testing",
      "",
      "- Command: `npm run test:unit -- --file tests/unit/example.test.ts`",
      "- Outcome: tests passed",
    ].join("\n"),
    author: { login: "alice", id: 10, type: "User" },
    authorPermission: "read",
    closingIssues: [{ number: 42, repository: { nameWithOwner: "moira-mcp/moira" } }],
    commits: [humanCommit()],
    ...override,
  };
}

function codes(result) {
  return result.findings.map((item) => item.code);
}

describe("pull-request title policy", () => {
  test.each([
    ["feat(cli): add command", { type: "feat", scope: "cli", breaking: false }],
    [
      "fix(workflow-engine)!: replace contract",
      { type: "fix", scope: "workflow-engine", breaking: true },
    ],
    ["build(deps-dev): bump package", { type: "build", scope: "deps-dev", breaking: false }],
  ])("accepts %s", (title, expected) => {
    expect(policy.parseTitle(title)).toMatchObject({ ok: true, ...expected });
  });

  test.each([
    "feat: missing scope",
    "unknown(cli): subject",
    "feat(Scope): uppercase scope",
    "feat(scope): subject",
    "feat(cli): subject",
    "feat(cli): tbd",
    "feat(cli) add command",
    `feat(cli): ${"x".repeat(policy.MAX_TITLE_LENGTH)}`,
  ])("rejects invalid or placeholder title %p", (title) => {
    expect(policy.parseTitle(title).ok).toBe(false);
  });
});

describe("issue and Testing contracts", () => {
  test("accepts a same-repository closing issue and ignores body mentions as evidence", () => {
    expect(policy.validatePullRequest(validInput()).ok).toBe(true);
    const mentionOnly = validInput({ closingIssues: [], body: `${validInput().body}\n\nSee #42` });
    expect(codes(policy.validatePullRequest(mentionOnly))).toContain("issue-linkage");
    const foreign = validInput({
      closingIssues: [{ number: 42, repository: { nameWithOwner: "other/project" } }],
    });
    expect(codes(policy.validatePullRequest(foreign))).toContain("issue-linkage");
  });

  test.each(["write", "maintain", "admin"])(
    "allows concrete repository housekeeping without an issue for %s permission",
    (authorPermission) => {
      const input = validInput({
        title: "ci(github): enforce policy",
        body: `${validInput().body}\n\nNo issue: maintain repository policy`,
        closingIssues: [],
        authorPermission,
      });
      expect(policy.validatePullRequest(input).ok).toBe(true);
    },
  );

  test.each([
    ["read permission", { authorPermission: "read" }],
    ["triage permission", { authorPermission: "triage" }],
    ["missing permission", { authorPermission: null }],
    ["product scope", { authorPermission: "admin", title: "feat(cli): add command" }],
    ["placeholder reason", { authorPermission: "admin", bodyReason: "reason" }],
  ])("denies the no-issue exception for %s", (_name, change) => {
    const input = validInput({
      title: change.title || "ci(github): enforce policy",
      body: `${validInput().body}\n\nNo issue: ${change.bodyReason || "maintain policy"}`,
      closingIssues: [],
      authorPermission: change.authorPermission,
    });
    expect(codes(policy.validatePullRequest(input))).toContain("issue-linkage");
  });

  test.each(["MEMBER", "COLLABORATOR"])(
    "does not treat %s author association as no-issue authority",
    (authorAssociation) => {
      const input = validInput({
        title: "ci(github): enforce policy",
        body: `${validInput().body}\n\nNo issue: maintain policy`,
        closingIssues: [],
        authorPermission: "read",
        authorAssociation,
      });
      expect(codes(policy.validatePullRequest(input))).toContain("issue-linkage");
    },
  );

  test("requires a concrete verification and outcome while accepting a named manual observation", () => {
    for (const body of [
      "## Summary\nChange",
      "## Testing\n\n- Command: <command>\n- Outcome: <outcome>",
      "## Testing\n\n- [ ] Tests pass locally",
      "## Testing\n\n- Command: `npm test`",
    ]) {
      expect(codes(policy.validatePullRequest(validInput({ body })))).toContain("testing");
    }
    const manual = validInput({
      body: "## Testing\n\n- Manual: opened the issue claim form\n- Outcome: form submitted successfully",
    });
    expect(policy.validatePullRequest(manual).ok).toBe(true);
  });
});

describe("DCO and bot boundaries", () => {
  test("requires a matching sign-off for every ordinary commit and reports each mismatch", () => {
    const input = validInput({
      commits: [
        humanCommit({ sha: "aaaaaaaaaaaa", message: "feat(cli): unsigned" }),
        humanCommit({
          sha: "bbbbbbbbbbbb",
          message: "fix(cli): wrong\n\nSigned-off-by: Bob <bob@example.com>",
        }),
        humanCommit({ sha: "cccccccccccc", gitAuthor: { name: null, email: null } }),
      ],
    });
    const result = policy.validatePullRequest(input);
    expect(
      result.findings.filter((item) => item.code === "dco").map((item) => item.message),
    ).toEqual([
      expect.stringContaining("aaaaaaaaaaaa"),
      expect.stringContaining("bbbbbbbbbbbb"),
      expect.stringContaining("cccccccccccc"),
    ]);
  });

  test("accepts email case normalization but not a different Git author name", () => {
    expect(
      policy.dcoMatches(
        humanCommit({ gitAuthor: { name: "Alice Example", email: "ALICE@EXAMPLE.COM" } }),
      ),
    ).toBe(true);
    expect(
      policy.dcoMatches(
        humanCommit({ gitAuthor: { name: "Alice Other", email: "alice@example.com" } }),
      ),
    ).toBe(false);
  });

  test("matches a non-empty one-character Git author without applying body placeholders", () => {
    expect(
      policy.dcoMatches(
        humanCommit({
          message: "fix(cli): repair\n\nSigned-off-by: 李 <li@example.com>",
          gitAuthor: { name: "李", email: "li@example.com" },
        }),
      ),
    ).toBe(true);
    expect(policy.dcoMatches(humanCommit({ gitAuthor: { name: "", email: "" } }))).toBe(false);
  });

  test("allows only exact verified Dependabot dependency pull requests to bypass human fields", () => {
    const bot = policy.DEPENDABOT;
    const exact = validInput({
      title: "build(deps): bump package",
      body: "",
      author: bot,
      authorPermission: null,
      closingIssues: [],
      commits: [
        {
          sha: "dddddddddddd",
          message: "build(deps): bump package",
          gitAuthor: {
            name: "dependabot[bot]",
            email: "49699333+dependabot[bot]@users.noreply.github.com",
          },
          githubAuthor: bot,
          verified: true,
        },
      ],
    });
    expect(policy.validatePullRequest(exact)).toEqual({ ok: true, findings: [] });
    expect(
      policy.validatePullRequest({
        ...exact,
        body: "",
        bodyOverflow: true,
      }),
    ).toEqual({ ok: true, findings: [] });

    for (const override of [
      { author: { ...bot, id: 999 } },
      { author: { ...bot, login: "dependabot" } },
      { author: { ...bot, type: "User" } },
      { title: "build(tooling): bump package" },
      { title: "build(deps)!: bump package" },
      { commits: [{ ...exact.commits[0], verified: false }] },
      { commits: [{ ...exact.commits[0], githubAuthor: { ...bot, id: 999 } }] },
      { commits: [{ ...exact.commits[0], message: null, messageOverflow: true }] },
    ]) {
      expect(policy.validatePullRequest({ ...exact, ...override }).ok).toBe(false);
    }
  });
});

describe("bounded complete findings", () => {
  test("returns all independent current findings in one result", () => {
    const result = policy.validatePullRequest({
      repository: { owner: "moira-mcp", repo: "moira" },
      title: "bad title",
      body: "",
      author: { login: "alice", id: 10, type: "User" },
      authorPermission: "read",
      closingIssues: [],
      commits: [],
    });
    expect(codes(result)).toEqual(["title", "testing", "issue-linkage", "commits"]);
  });

  test("fails closed on body, commit, and closing-reference bounds", () => {
    const result = policy.validatePullRequest(
      validInput({
        body: "x".repeat(policy.MAX_BODY_LENGTH + 1),
        commitsOverflow: true,
        closingIssuesOverflow: true,
      }),
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining(["body-too-large", "commits-too-many", "closing-issues-too-many"]),
    );
  });

  test("does not parse oversized body fields and accepts valid content at the boundary", () => {
    const oversized = validInput({
      title: "ci(github): maintain policy",
      authorPermission: "admin",
      closingIssues: [],
      body:
        "x".repeat(policy.MAX_BODY_LENGTH + 1) +
        "\n## Testing\n- Command: npm test\n- Outcome: passed\nNo issue: maintain policy",
    });
    const result = policy.validatePullRequest(oversized);
    expect(codes(result)).toEqual(
      expect.arrayContaining(["body-too-large", "testing", "issue-linkage"]),
    );

    const suffix = "\n## Testing\n\n- Command: npm test\n- Outcome: passed";
    const boundaryBody = `${"x".repeat(policy.MAX_BODY_LENGTH - suffix.length)}${suffix}`;
    expect(boundaryBody).toHaveLength(policy.MAX_BODY_LENGTH);
    expect(policy.validatePullRequest(validInput({ body: boundaryBody })).ok).toBe(true);
  });

  test("rejects oversized commit text before DCO parsing and accepts the exact boundary", () => {
    const marker = "UNTRUSTED-MARKER";
    const oversized = validInput({
      commits: [
        humanCommit({
          message: `${marker}${"x".repeat(policy.MAX_COMMIT_MESSAGE_LENGTH)}`,
          gitAuthor: {
            name: `${marker}${"x".repeat(policy.MAX_GIT_IDENTITY_LENGTH)}`,
            email: "alice@example.com",
          },
        }),
      ],
    });
    const result = policy.validatePullRequest(oversized);
    expect(codes(result)).toEqual(
      expect.arrayContaining(["commit-message-too-large", "commit-identity-too-large"]),
    );
    expect(JSON.stringify(result.findings)).not.toContain(marker);
    expect(codes(result)).not.toContain("dco");

    const trailer = "\nSigned-off-by: Alice Example <alice@example.com>";
    const boundaryMessage = `${"x".repeat(
      policy.MAX_COMMIT_MESSAGE_LENGTH - trailer.length,
    )}${trailer}`;
    expect(boundaryMessage).toHaveLength(policy.MAX_COMMIT_MESSAGE_LENGTH);
    expect(
      policy.validatePullRequest(
        validInput({ commits: [humanCommit({ message: boundaryMessage })] }),
      ).ok,
    ).toBe(true);

    const boundaryName = "李".repeat(policy.MAX_GIT_IDENTITY_LENGTH);
    expect(boundaryName).toHaveLength(policy.MAX_GIT_IDENTITY_LENGTH);
    expect(
      policy.validatePullRequest(
        validInput({
          commits: [
            humanCommit({
              message: `fix(cli): repair\n\nSigned-off-by: ${boundaryName} <li@example.com>`,
              gitAuthor: { name: boundaryName, email: "li@example.com" },
            }),
          ],
        }),
      ).ok,
    ).toBe(true);
  });
});
