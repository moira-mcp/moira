"use strict";

const { describe, expect, test } = require("@jest/globals");
const adapter = require("../../../.github/scripts/pr-policy-adapter.cjs");
const policy = require("../../../.github/scripts/pr-policy.cjs");

function pullPayload() {
  return {
    repo: { owner: "moira-mcp", repo: "moira" },
    payload: {
      pull_request: {
        number: 7,
        commits: 101,
        title: "feat(cli): add command",
        body: "## Testing\n\n- Command: `npm test`\n- Outcome: passed",
        user: { login: "alice", id: 10, type: "User" },
      },
    },
  };
}

function githubHarness({ commits = [], closingIssues = [], permission = "read" } = {}) {
  return {
    rest: {
      pulls: { listCommits: async () => ({ data: commits }) },
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
      },
    },
    graphql: async () => ({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: closingIssues,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }),
  };
}

describe("PR Policy GitHub adapter", () => {
  test("maps oversized commit text to bounded overflow facts without retaining it", () => {
    const marker = "UNTRUSTED-MARKER";
    const fact = adapter.commitFact({
      sha: "0123456789abcdef",
      commit: {
        message: `${marker}${"x".repeat(policy.MAX_COMMIT_MESSAGE_LENGTH)}`,
        author: {
          name: `${marker}${"x".repeat(policy.MAX_GIT_IDENTITY_LENGTH)}`,
          email: "alice@example.com",
        },
        verification: { verified: false },
      },
      author: { login: "alice", id: 10, type: "User" },
    });
    expect(fact).toMatchObject({
      message: null,
      messageOverflow: true,
      gitAuthor: null,
      gitAuthorOverflow: true,
    });
    expect(JSON.stringify(fact)).not.toContain(marker);

    const boundaryMessage = "x".repeat(policy.MAX_COMMIT_MESSAGE_LENGTH);
    const boundaryName = "李".repeat(policy.MAX_GIT_IDENTITY_LENGTH);
    const boundaryFact = adapter.commitFact({
      commit: {
        message: boundaryMessage,
        author: { name: boundaryName, email: "li@example.com" },
      },
    });
    expect(boundaryFact).toMatchObject({
      message: boundaryMessage,
      messageOverflow: false,
      gitAuthor: { name: boundaryName, email: "li@example.com" },
      gitAuthorOverflow: false,
    });
  });

  test("maps an oversized pull-request body to a bounded overflow fact", async () => {
    const marker = "UNTRUSTED-BODY";
    const context = pullPayload();
    context.payload.pull_request = {
      ...context.payload.pull_request,
      body: `${marker}${"x".repeat(policy.MAX_BODY_LENGTH)}`,
      commits: 0,
    };
    const facts = await adapter.collectFacts({ github: githubHarness(), context });
    expect(facts).toMatchObject({ body: "", bodyOverflow: true });
    expect(JSON.stringify(facts)).not.toContain(marker);
    expect(policy.validatePullRequest(facts).findings.map((item) => item.code)).toContain(
      "body-too-large",
    );
  });

  test("projects every policy finding into one failed GitHub check message", async () => {
    const context = pullPayload();
    context.payload.pull_request = {
      ...context.payload.pull_request,
      title: "bad title",
      body: "",
      commits: 0,
    };
    const failures = [];
    const result = await adapter.run({
      github: githubHarness(),
      context,
      core: { setFailed: (message) => failures.push(message) },
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((item) => item.code)).toEqual([
      "title",
      "testing",
      "issue-linkage",
      "commits",
    ]);
    expect(failures).toHaveLength(1);
    for (const item of result.findings) expect(failures[0]).toContain(`- ${item.message}`);
  });

  test("does not fail the GitHub check when collected facts satisfy policy", async () => {
    const context = pullPayload();
    context.payload.pull_request.commits = 1;
    const commit = {
      sha: "0123456789abcdef",
      commit: {
        message: "feat(cli): add command\n\nSigned-off-by: Alice <alice@example.com>",
        author: { name: "Alice", email: "alice@example.com" },
        verification: { verified: false },
      },
      author: { login: "alice", id: 10, type: "User" },
    };
    const setFailed = jest.fn();
    const result = await adapter.run({
      github: githubHarness({
        commits: [commit],
        closingIssues: [{ number: 42, repository: { nameWithOwner: "moira-mcp/moira" } }],
      }),
      context,
      core: { setFailed },
    });
    expect(result).toEqual({ ok: true, findings: [] });
    expect(setFailed).not.toHaveBeenCalled();
  });

  test("collects every commit and closing-reference page and maps GitHub facts", async () => {
    const commitPages = [
      Array.from({ length: 100 }, (_, index) => ({
        sha: `a${index}`,
        commit: {
          message: "feat(cli): work",
          author: { name: "Alice", email: "alice@example.com" },
          verification: { verified: true },
        },
        author: { login: "alice", id: 10, type: "User" },
      })),
      [
        {
          sha: "last",
          commit: {
            message: "fix(cli): finish",
            author: { name: "Alice", email: "alice@example.com" },
            verification: { verified: true },
          },
          author: { login: "alice", id: 10, type: "User" },
        },
      ],
    ];
    let graphPage = 0;
    const github = {
      rest: {
        pulls: { listCommits: async ({ page }) => ({ data: commitPages[page - 1] || [] }) },
        repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: "write" } }) },
      },
      graphql: async (_query, variables) => {
        const current = graphPage++;
        return {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{ number: current + 1, repository: { nameWithOwner: "moira-mcp/moira" } }],
                pageInfo: { hasNextPage: current === 0, endCursor: current === 0 ? "next" : null },
              },
            },
          },
          variables,
        };
      },
    };
    const facts = await adapter.collectFacts({ github, context: pullPayload() });
    expect(facts.commits).toHaveLength(101);
    expect(facts.commits[100]).toMatchObject({ sha: "last", verified: true });
    expect(facts.closingIssues.map((issue) => issue.number)).toEqual([1, 2]);
    expect(facts.authorPermission).toBe("write");
    expect(facts.commitsOverflow).toBe(false);
    expect(facts.closingIssuesOverflow).toBe(false);
  });

  test("treats a missing collaborator as no permission and propagates other API failures", async () => {
    await expect(
      adapter.getPermission(
        {
          rest: {
            repos: {
              getCollaboratorPermissionLevel: async () => ({
                data: { permission: "write", role_name: "maintain" },
              }),
            },
          },
        },
        { owner: "moira-mcp", repo: "moira" },
        "maintainer",
      ),
    ).resolves.toBe("maintain");
    await expect(
      adapter.getPermission(
        {
          rest: {
            repos: { getCollaboratorPermissionLevel: async () => Promise.reject({ status: 404 }) },
          },
        },
        { owner: "moira-mcp", repo: "moira" },
        "alice",
      ),
    ).resolves.toBeNull();
    await expect(
      adapter.getPermission(
        {
          rest: {
            repos: {
              getCollaboratorPermissionLevel: async () => Promise.reject(new Error("API down")),
            },
          },
        },
        { owner: "moira-mcp", repo: "moira" },
        "alice",
      ),
    ).rejects.toThrow("API down");
  });

  test("marks an API-sized commit overflow instead of accepting truncated data", async () => {
    let calls = 0;
    const result = await adapter.listCommits(
      {
        rest: {
          pulls: {
            listCommits: async () => {
              calls += 1;
              return { data: [] };
            },
          },
        },
      },
      { owner: "moira-mcp", repo: "moira", pull_number: 7 },
      251,
    );
    expect(result.commits).toHaveLength(0);
    expect(result.overflow).toBe(true);
    expect(calls).toBe(0);
  });

  test("fails closed when commit collection races with a changed pull request", async () => {
    await expect(
      adapter.listCommits(
        { rest: { pulls: { listCommits: async () => ({ data: [{ sha: "only-one" }] }) } } },
        { owner: "moira-mcp", repo: "moira", pull_number: 7 },
        2,
      ),
    ).rejects.toThrow("commit count changed");
  });

  test("fails closed when GitHub omits the closing-reference contract", async () => {
    await expect(
      adapter.listClosingIssues(
        { graphql: async () => ({ repository: { pullRequest: null } }) },
        { owner: "moira-mcp", repo: "moira", number: 7 },
      ),
    ).rejects.toThrow("did not return pull-request closing references");
  });

  test("does not require collaborator permission for the exact Dependabot identity", async () => {
    const context = pullPayload();
    context.payload.pull_request = {
      ...context.payload.pull_request,
      commits: 1,
      user: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
    };
    const github = {
      rest: {
        pulls: {
          listCommits: async () => ({
            data: [
              {
                sha: "dependabot",
                commit: { message: "build(deps): bump package", verification: { verified: true } },
                author: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
              },
            ],
          }),
        },
        repos: {
          getCollaboratorPermissionLevel: async () => {
            throw new Error("must not run");
          },
        },
      },
      graphql: async () => ({
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    };
    await expect(adapter.collectFacts({ github, context })).resolves.toMatchObject({
      authorPermission: null,
    });
  });
});
