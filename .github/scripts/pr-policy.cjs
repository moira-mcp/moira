"use strict";

const ALLOWED_TYPES = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
]);
const NO_ISSUE_SCOPES = new Set(["github", "repo", "contributing"]);
const NO_ISSUE_PERMISSIONS = new Set(["write", "maintain", "admin"]);
const PLACEHOLDERS = new Set([
  "...",
  "area",
  "brief description",
  "component",
  "description",
  "n/a",
  "none",
  "reason",
  "scope",
  "subject",
  "tbd",
  "todo",
]);
const MAX_TITLE_LENGTH = 160;
const MAX_BODY_LENGTH = 65536;
const MAX_COMMITS = 250;
const MAX_COMMIT_MESSAGE_LENGTH = 65536;
const MAX_GIT_IDENTITY_LENGTH = 512;
const DEPENDABOT = Object.freeze({ login: "dependabot[bot]", id: 49699333, type: "Bot" });

function finding(code, message) {
  return { code, message };
}

function concrete(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized.length >= 2 && !PLACEHOLDERS.has(normalized) && !/^<.*>$/.test(normalized);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseTitle(title) {
  if (typeof title !== "string" || title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    return { ok: false, reason: `title must contain 1-${MAX_TITLE_LENGTH} characters` };
  }
  const match = title.match(/^([a-z]+)\(([a-z0-9]+(?:-[a-z0-9]+)*)\)(!)?: (.+)$/);
  if (!match) {
    return { ok: false, reason: "title must match type(scope)[!]: subject" };
  }
  const [, type, scope, bang, subject] = match;
  if (!ALLOWED_TYPES.has(type)) {
    return { ok: false, reason: `title type ${JSON.stringify(type)} is not allowed` };
  }
  if (!concrete(scope)) return { ok: false, reason: "title scope is a placeholder" };
  if (!concrete(subject)) return { ok: false, reason: "title subject is a placeholder" };
  return { ok: true, type, scope, breaking: Boolean(bang), subject };
}

function section(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase(),
  );
  if (start < 0) return null;
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line.trim()));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

function fieldValue(content, names) {
  const alternatives = names.join("|");
  const match = content.match(new RegExp(`^-\\s*(?:${alternatives}):\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || null;
}

function validateTesting(body) {
  const testing = section(body, "Testing");
  if (testing === null) return "body must contain a ## Testing section";
  const verification = fieldValue(testing, ["Command", "Manual"]);
  const outcome = fieldValue(testing, ["Outcome"]);
  if (!concrete(verification)) {
    return "Testing must name a concrete Command or Manual observation";
  }
  if (!concrete(outcome)) return "Testing must state a concrete Outcome";
  return null;
}

function noIssueReason(body) {
  const matches = [...body.matchAll(/^No issue:\s*(.*)$/gim)];
  if (matches.length !== 1 || !concrete(matches[0][1])) return null;
  return matches[0][1].trim();
}

function sameRepositoryClosingIssue(closingIssues, repository) {
  const expected = `${repository.owner}/${repository.repo}`.toLowerCase();
  return closingIssues.some(
    (issue) => issue?.repository?.nameWithOwner?.toLowerCase() === expected,
  );
}

function dcoMatches(commit) {
  const author = commit?.gitAuthor;
  if (!nonEmpty(author?.name) || !nonEmpty(author?.email) || typeof commit?.message !== "string") {
    return false;
  }
  const trailers = [...commit.message.matchAll(/^Signed-off-by:\s*(.+?)\s*<([^<>\s]+)>\s*$/gim)];
  return trailers.some(
    ([, name, email]) =>
      name.trim() === author.name.trim() && email.toLowerCase() === author.email.toLowerCase(),
  );
}

function commitTextFindings(commit) {
  const findings = [];
  const shortSha = typeof commit?.sha === "string" ? commit.sha.slice(0, 12) : "unknown";
  if (
    commit?.messageOverflow ||
    (typeof commit?.message === "string" && commit.message.length > MAX_COMMIT_MESSAGE_LENGTH)
  ) {
    findings.push(
      finding(
        "commit-message-too-large",
        `commit ${shortSha} message exceeds ${MAX_COMMIT_MESSAGE_LENGTH} characters`,
      ),
    );
  }
  if (
    commit?.gitAuthorOverflow ||
    (typeof commit?.gitAuthor?.name === "string" &&
      commit.gitAuthor.name.length > MAX_GIT_IDENTITY_LENGTH) ||
    (typeof commit?.gitAuthor?.email === "string" &&
      commit.gitAuthor.email.length > MAX_GIT_IDENTITY_LENGTH)
  ) {
    findings.push(
      finding(
        "commit-identity-too-large",
        `commit ${shortSha} Git author identity exceeds ${MAX_GIT_IDENTITY_LENGTH} characters`,
      ),
    );
  }
  return findings;
}

function exactUser(actual, expected) {
  return (
    actual?.login === expected.login && actual?.id === expected.id && actual?.type === expected.type
  );
}

function isExactDependabotUser(user) {
  return exactUser(user, DEPENDABOT);
}

function isExactDependabot(input, title) {
  return (
    isExactDependabotUser(input.author) &&
    title.ok &&
    title.type === "build" &&
    !title.breaking &&
    (title.scope === "deps" || title.scope === "deps-dev") &&
    input.commits.length > 0 &&
    input.commits.every(
      (commit) => commit?.verified === true && isExactDependabotUser(commit?.githubAuthor),
    )
  );
}

function validatePullRequest(input) {
  const findings = [];
  const title = parseTitle(input?.title);
  if (!title.ok) findings.push(finding("title", title.reason));

  const body = typeof input?.body === "string" ? input.body : "";
  const commits = Array.isArray(input?.commits) ? input.commits : [];
  if (input?.commitsOverflow || commits.length > MAX_COMMITS) {
    findings.push(finding("commits-too-many", `pull request exceeds ${MAX_COMMITS} commits`));
  }
  if (input?.closingIssuesOverflow) {
    findings.push(
      finding("closing-issues-too-many", "closing issue references exceed the supported bound"),
    );
  }
  const commitTextFindingsByIndex = commits
    .slice(0, MAX_COMMITS)
    .map((commit) => commitTextFindings(commit));
  findings.push(...commitTextFindingsByIndex.flat());

  if (isExactDependabot({ ...input, commits }, title)) {
    return { ok: findings.length === 0, findings };
  }

  if (input?.bodyOverflow || body.length > MAX_BODY_LENGTH) {
    findings.push(finding("body-too-large", `body exceeds ${MAX_BODY_LENGTH} characters`));
  }

  const boundedBody = !input?.bodyOverflow && body.length <= MAX_BODY_LENGTH ? body : "";
  const testingProblem = validateTesting(boundedBody);
  if (testingProblem) findings.push(finding("testing", testingProblem));

  const repository = input?.repository || {};
  const closingIssues = Array.isArray(input?.closingIssues) ? input.closingIssues : [];
  const hasClosingIssue = sameRepositoryClosingIssue(closingIssues, repository);
  if (!hasClosingIssue) {
    const reason = noIssueReason(boundedBody);
    const noIssueAllowed =
      reason &&
      title.ok &&
      NO_ISSUE_SCOPES.has(title.scope) &&
      NO_ISSUE_PERMISSIONS.has(input?.authorPermission);
    if (!noIssueAllowed) {
      findings.push(
        finding(
          "issue-linkage",
          "add a same-repository closing issue, or use an authorized repository-scope No issue: reason",
        ),
      );
    }
  }

  if (commits.length === 0) {
    findings.push(finding("commits", "pull request contains no inspectable commits"));
  } else {
    for (const [index, commit] of commits.slice(0, MAX_COMMITS).entries()) {
      const textFindings = commitTextFindingsByIndex[index];
      if (textFindings.length === 0 && !dcoMatches(commit)) {
        const shortSha = typeof commit?.sha === "string" ? commit.sha.slice(0, 12) : "unknown";
        findings.push(
          finding("dco", `commit ${shortSha} lacks a Signed-off-by matching its Git author`),
        );
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

module.exports = {
  ALLOWED_TYPES,
  DEPENDABOT,
  MAX_BODY_LENGTH,
  MAX_COMMIT_MESSAGE_LENGTH,
  MAX_COMMITS,
  MAX_GIT_IDENTITY_LENGTH,
  MAX_TITLE_LENGTH,
  NO_ISSUE_PERMISSIONS,
  NO_ISSUE_SCOPES,
  dcoMatches,
  commitTextFindings,
  isExactDependabotUser,
  parseTitle,
  validatePullRequest,
  validateTesting,
};
