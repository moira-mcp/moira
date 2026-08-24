"use strict";

const policy = require("./pr-policy.cjs");

const PAGE_SIZE = 100;
const MAX_REFERENCE_PAGES = 10;

async function listCommits(github, coordinates, expectedCount) {
  if (expectedCount > policy.MAX_COMMITS) return { commits: [], overflow: true };
  const commits = [];
  for (let page = 1; page <= Math.ceil(policy.MAX_COMMITS / PAGE_SIZE); page += 1) {
    const response = await github.rest.pulls.listCommits({
      ...coordinates,
      per_page: PAGE_SIZE,
      page,
    });
    const rows = response.data || [];
    commits.push(...rows);
    if (commits.length > policy.MAX_COMMITS) {
      return { commits: commits.slice(0, policy.MAX_COMMITS), overflow: true };
    }
    if (rows.length < PAGE_SIZE) {
      if (Number.isInteger(expectedCount) && commits.length !== expectedCount) {
        throw new Error("pull-request commit count changed during collection");
      }
      return { commits, overflow: false };
    }
  }
  if (Number.isInteger(expectedCount) && commits.length !== expectedCount) {
    throw new Error("pull-request commit count changed during collection");
  }
  return { commits, overflow: false };
}

async function listClosingIssues(github, coordinates) {
  const query = `
    query PullRequestClosingIssues($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 100, after: $cursor) {
            nodes { number repository { nameWithOwner } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const issues = [];
  let cursor = null;
  for (let page = 0; page < MAX_REFERENCE_PAGES; page += 1) {
    const result = await github.graphql(query, { ...coordinates, cursor });
    const references = result.repository?.pullRequest?.closingIssuesReferences;
    if (!references) throw new Error("GitHub did not return pull-request closing references");
    issues.push(...(references.nodes || []));
    if (!references.pageInfo?.hasNextPage) return { issues, overflow: false };
    cursor = references.pageInfo.endCursor;
    if (!cursor) throw new Error("GitHub returned an invalid closing-reference cursor");
  }
  return { issues, overflow: true };
}

async function getPermission(github, coordinates, username) {
  try {
    const response = await github.rest.repos.getCollaboratorPermissionLevel({
      owner: coordinates.owner,
      repo: coordinates.repo,
      username,
    });
    const roleName = response.data?.role_name;
    if (roleName === "admin" || roleName === "maintain" || roleName === "write") return roleName;
    return response.data?.permission || null;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function commitFact(commit) {
  const message = commit.commit?.message;
  const author = commit.commit?.author;
  const messageOverflow =
    typeof message === "string" && message.length > policy.MAX_COMMIT_MESSAGE_LENGTH;
  const gitAuthorOverflow =
    (typeof author?.name === "string" && author.name.length > policy.MAX_GIT_IDENTITY_LENGTH) ||
    (typeof author?.email === "string" && author.email.length > policy.MAX_GIT_IDENTITY_LENGTH);
  return {
    sha: commit.sha,
    message: messageOverflow ? null : message,
    messageOverflow,
    gitAuthor: gitAuthorOverflow ? null : author,
    gitAuthorOverflow,
    githubAuthor: commit.author,
    verified: commit.commit?.verification?.verified === true,
  };
}

async function collectFacts({ github, context }) {
  const pull = context.payload.pull_request;
  if (!pull) throw new Error("pull_request payload is required");
  const coordinates = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pull.number,
  };
  const [commitResult, closingResult, authorPermission] = await Promise.all([
    listCommits(github, coordinates, pull.commits),
    listClosingIssues(github, {
      owner: coordinates.owner,
      repo: coordinates.repo,
      number: pull.number,
    }),
    policy.isExactDependabotUser(pull.user)
      ? Promise.resolve(null)
      : getPermission(
          github,
          { owner: coordinates.owner, repo: coordinates.repo },
          pull.user.login,
        ),
  ]);
  const body = pull.body || "";
  const bodyOverflow = body.length > policy.MAX_BODY_LENGTH;
  return {
    repository: { owner: coordinates.owner, repo: coordinates.repo },
    title: pull.title,
    body: bodyOverflow ? "" : body,
    bodyOverflow,
    author: { login: pull.user.login, id: pull.user.id, type: pull.user.type },
    authorPermission,
    commits: commitResult.commits.map(commitFact),
    commitsOverflow: commitResult.overflow,
    closingIssues: closingResult.issues,
    closingIssuesOverflow: closingResult.overflow,
  };
}

async function run({ github, context, core }) {
  const result = policy.validatePullRequest(await collectFacts({ github, context }));
  if (!result.ok) {
    core.setFailed(
      ["Pull-request policy failed:", ...result.findings.map((item) => `- ${item.message}`)].join(
        "\n",
      ),
    );
  }
  return result;
}

module.exports = {
  collectFacts,
  commitFact,
  getPermission,
  listClosingIssues,
  listCommits,
  run,
};
