"use strict";

const { describe, expect, test } = require("@jest/globals");
const coordinator = require("../../../.github/scripts/issue-claim.cjs");

const coordinates = { owner: "moira-mcp", repo: "moira", issue_number: 42 };

function user(login, bot = false) {
  return bot
    ? { id: coordinator.TRUSTED_BOT_ID, login: coordinator.TRUSTED_BOT_LOGIN, type: "Bot" }
    : { id: 10, login, type: "User" };
}

function createHarness({
  lastActivityAt = "2026-08-01T10:00:00.000Z",
  githubNow = "2026-08-08T10:00:00.000Z",
} = {}) {
  const state = {
    githubNow,
    issue: {
      number: 42,
      state: "open",
      labels: [{ name: "type:bug" }, { name: "status:in-progress" }],
      assignees: [{ login: "alice" }],
    },
    comments: { 42: [] },
    pulls: {},
    nextCommentId: 100,
    etag: 1,
    calls: {},
    faults: {},
  };
  const lease = {
    version: 1,
    generation: "42-7",
    claimant: "alice",
    status: "active",
    claimedAt: "2026-08-01T10:00:00.000Z",
    lastActivityAt,
    activityDeadlineAt: coordinator.addDays(lastActivityAt, coordinator.ACTIVE_LEASE_DAYS),
    remindedAt: null,
    reminderCleanup: null,
    lastCompletedCommandId: 7,
  };
  state.comments[42].push({
    id: 1,
    body: coordinator.renderActiveState(lease),
    created_at: lease.claimedAt,
    updated_at: lease.claimedAt,
    user: user(coordinator.TRUSTED_BOT_LOGIN, true),
  });

  const core = {
    failures: [],
    warnings: [],
    setFailed(message) {
      this.failures.push(message);
    },
    warning(message) {
      this.warnings.push(message);
    },
  };
  const issueResponse = () => ({
    data: structuredClone(state.issue),
    headers: { etag: `"${state.etag}"` },
  });
  const hit = (name) => {
    state.calls[name] = (state.calls[name] || 0) + 1;
    const fault = state.faults[`${name}:${state.calls[name]}`];
    if (fault === "throw") throw new Error(`injected ${name}:${state.calls[name]}`);
    return fault;
  };
  const issues = {
    get: async () => issueResponse(),
    listComments: async ({ issue_number }) => ({
      data: structuredClone(state.comments[issue_number] || []),
    }),
    createComment: async ({ issue_number, body }) => {
      const comment = {
        id: state.nextCommentId++,
        body,
        created_at: state.githubNow,
        updated_at: state.githubNow,
        user: user(coordinator.TRUSTED_BOT_LOGIN, true),
      };
      (state.comments[issue_number] ||= []).push(comment);
      return { data: structuredClone(comment) };
    },
    updateComment: async ({ comment_id, body }) => {
      hit("updateComment");
      const comment = Object.values(state.comments)
        .flat()
        .find((candidate) => candidate.id === comment_id);
      if (!comment) throw new Error(`comment ${comment_id} does not exist`);
      comment.body = body;
      comment.updated_at = state.githubNow;
      return { data: structuredClone(comment) };
    },
    addLabels: async ({ labels }) => {
      for (const name of labels) {
        if (!state.issue.labels.some((label) => label.name === name)) {
          state.issue.labels.push({ name });
        }
      }
      state.etag += 1;
      return { data: structuredClone(state.issue.labels) };
    },
    removeLabel: async ({ name }) => {
      state.issue.labels = state.issue.labels.filter((label) => label.name !== name);
      state.etag += 1;
      return { data: structuredClone(state.issue.labels) };
    },
    removeAssignees: async ({ assignees }) => {
      state.issue.assignees = state.issue.assignees.filter(
        (assignee) => !assignees.includes(assignee.login),
      );
      state.etag += 1;
      return issueResponse();
    },
    addAssignees: async ({ assignees }) => {
      state.issue.assignees = assignees.map((login) => ({ login }));
      state.etag += 1;
      return issueResponse();
    },
    listForRepo: async () => ({ data: [structuredClone(state.issue)] }),
  };
  const github = {
    rest: { issues },
    paginate: async (method, options) => (await method(options)).data,
    graphql: async (query, variables) => {
      if (query.includes("CrossReferencedPullRequests")) {
        return {
          repository: {
            issue: {
              timelineItems: {
                nodes: Object.values(state.pulls).map((pull) => ({
                  source: {
                    number: pull.number,
                    repository: { nameWithOwner: pull.repository || "moira-mcp/moira" },
                  },
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      }
      if (query.includes("ClosingReferences")) {
        const pull = state.pulls[variables.pullNumber];
        return {
          repository: {
            pullRequest: pull
              ? {
                  number: pull.number,
                  createdAt: pull.createdAt,
                  author: { login: pull.author },
                  closingIssuesReferences: {
                    nodes: pull.closes
                      ? [{ number: 42, repository: { nameWithOwner: "moira-mcp/moira" } }]
                      : [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                }
              : null,
          },
        };
      }
      throw new Error("unexpected GraphQL query");
    },
  };

  return {
    state,
    core,
    github,
    addIssueComment(login, createdAt, body = "Progress update") {
      state.comments[42].push({
        id: state.nextCommentId++,
        body,
        created_at: createdAt,
        updated_at: createdAt,
        user: user(login),
      });
    },
    addPull({ number = 50, author = "alice", createdAt, closes = true, repository }) {
      state.pulls[number] = { number, author, createdAt, closes, repository };
      state.comments[number] = [];
      return number;
    },
    addPullComment(number, login, createdAt) {
      state.comments[number].push({
        id: state.nextCommentId++,
        body: "PR progress",
        created_at: createdAt,
        updated_at: createdAt,
        user: user(login),
      });
    },
    leaseState() {
      return coordinator.parseStateComment(state.comments[42][0]).state;
    },
    reminderComments() {
      return state.comments[42].filter((comment) =>
        comment.body.includes(coordinator.REMINDER_MARKER),
      );
    },
  };
}

async function reconcile(harness, now = harness.state.githubNow) {
  harness.state.githubNow = now;
  return coordinator.reconcileIssue({
    github: harness.github,
    core: harness.core,
    coordinates,
    now,
  });
}

describe("managed issue claim leases", () => {
  test("uses the actual delayed reminder time and preserves the full grace period", async () => {
    const harness = createHarness({ githubNow: "2026-08-10T10:00:00.000Z" });

    expect((await reconcile(harness)).outcome).toBe("reminded");
    expect(harness.leaseState().remindedAt).toBe("2026-08-10T10:00:00.000Z");
    expect(harness.reminderComments()[0].body).toContain("2026-08-13T10:00:00.000Z");
    expect((await reconcile(harness, "2026-08-12T10:00:00.000Z")).outcome).toBe("grace");
    expect(harness.reminderComments()).toHaveLength(1);

    expect((await reconcile(harness, "2026-08-13T10:00:00.000Z")).outcome).toBe("released");
    expect(harness.state.issue.assignees).toEqual([]);
    expect(harness.state.issue.labels.map((label) => label.name)).toContain("status:ready");
  });

  test("does nothing before the activity deadline", async () => {
    const harness = createHarness({ githubNow: "2026-08-07T09:59:59.000Z" });
    expect((await reconcile(harness)).outcome).toBe("active");
    expect(harness.reminderComments()).toHaveLength(0);
  });

  test("renews from an attributable issue comment and clears an earlier reminder", async () => {
    const harness = createHarness({ githubNow: "2026-08-10T10:00:00.000Z" });
    expect((await reconcile(harness)).outcome).toBe("reminded");
    harness.addIssueComment("alice", "2026-08-11T12:00:00.000Z");

    expect((await reconcile(harness, "2026-08-13T10:00:00.000Z")).outcome).toBe("renewed");
    expect(harness.leaseState()).toMatchObject({
      lastActivityAt: "2026-08-11T12:00:00.000Z",
      activityDeadlineAt: "2026-08-18T12:00:00.000Z",
      remindedAt: null,
    });
    expect(harness.reminderComments()[0].body).toContain("was cleared by qualifying activity");

    expect((await reconcile(harness, "2026-08-18T12:00:00.000Z")).outcome).toBe("reminded");
    expect(harness.reminderComments()).toHaveLength(2);
    expect(harness.leaseState().remindedAt).toBe("2026-08-18T12:00:00.000Z");
  });

  test("retries reminder cleanup after its comment update fails", async () => {
    const harness = createHarness({ githubNow: "2026-08-10T10:00:00.000Z" });
    expect((await reconcile(harness)).outcome).toBe("reminded");
    harness.addIssueComment("alice", "2026-08-11T12:00:00.000Z");
    harness.state.faults["updateComment:4"] = "throw";

    expect((await reconcile(harness, "2026-08-13T10:00:00.000Z")).outcome).toBe(
      "renewed_cleanup_pending",
    );
    expect(harness.leaseState().reminderCleanup).toMatchObject({
      generation: "42-7",
      lastActivityAt: "2026-08-01T10:00:00.000Z",
    });
    expect(harness.reminderComments()[0].body).not.toContain("was cleared by qualifying activity");

    delete harness.state.faults["updateComment:4"];
    expect((await reconcile(harness, "2026-08-14T10:00:00.000Z")).outcome).toBe("active");
    expect(harness.leaseState().reminderCleanup).toBeNull();
    expect(harness.reminderComments()[0].body).toContain("was cleared by qualifying activity");
    expect(harness.core.warnings).toHaveLength(1);
  });

  test("finishes pending reminder cleanup before releasing the claim", async () => {
    const harness = createHarness({ githubNow: "2026-08-10T10:00:00.000Z" });
    expect((await reconcile(harness)).outcome).toBe("reminded");
    harness.addIssueComment("alice", "2026-08-11T12:00:00.000Z");
    harness.state.faults["updateComment:4"] = "throw";
    expect((await reconcile(harness, "2026-08-13T10:00:00.000Z")).outcome).toBe(
      "renewed_cleanup_pending",
    );
    delete harness.state.faults["updateComment:4"];

    const released = await coordinator.releaseIssue({
      github: harness.github,
      core: harness.core,
      coordinates,
      claimant: "alice",
      releaseCommandId: 777,
    });

    expect(released.outcome).toBe("released");
    expect(harness.state.issue.assignees).toEqual([]);
    expect(harness.reminderComments()[0].body).toContain("was cleared by qualifying activity");
    expect(harness.leaseState()).toMatchObject({
      status: "released",
      reminderCleanup: null,
      lastCompletedCommandId: 777,
    });
  });

  test("renews immediately when the current assignee comments on the issue", async () => {
    const harness = createHarness();
    const result = await coordinator.renewLease({
      github: harness.github,
      core: harness.core,
      coordinates,
      actor: "alice",
      activityAt: "2026-08-04T10:00:00.000Z",
    });
    expect(result.outcome).toBe("renewed");
    expect(harness.leaseState().activityDeadlineAt).toBe("2026-08-11T10:00:00.000Z");
  });

  test("renews from owner-attributable opening and comments on a closing-linked PR", async () => {
    const opened = createHarness();
    opened.addPull({ createdAt: "2026-08-05T10:00:00.000Z" });
    expect((await reconcile(opened)).outcome).toBe("renewed");
    expect(opened.leaseState().lastActivityAt).toBe("2026-08-05T10:00:00.000Z");

    const commented = createHarness({ lastActivityAt: "2026-08-05T10:00:00.000Z" });
    const pull = commented.addPull({ createdAt: "2026-08-01T09:00:00.000Z" });
    commented.addPullComment(pull, "alice", "2026-08-06T10:00:00.000Z");
    expect((await reconcile(commented)).outcome).toBe("renewed");
    expect(commented.leaseState().lastActivityAt).toBe("2026-08-06T10:00:00.000Z");
  });

  test.each([
    [
      "bot issue comment",
      (harness) => harness.addIssueComment("github-actions[bot]", "2026-08-07T10:00:00.000Z"),
    ],
    [
      "maintainer issue comment",
      (harness) => harness.addIssueComment("maintainer", "2026-08-07T10:00:00.000Z"),
    ],
    [
      "release command",
      (harness) => harness.addIssueComment("alice", "2026-08-07T10:00:00.000Z", "/release"),
    ],
    [
      "mention-only PR",
      (harness) => harness.addPull({ createdAt: "2026-08-07T10:00:00.000Z", closes: false }),
    ],
    [
      "other author's PR",
      (harness) => harness.addPull({ createdAt: "2026-08-07T10:00:00.000Z", author: "reviewer" }),
    ],
    [
      "reviewer PR comment",
      (harness) => {
        const number = harness.addPull({ createdAt: "2026-07-01T10:00:00.000Z" });
        harness.addPullComment(number, "reviewer", "2026-08-07T10:00:00.000Z");
      },
    ],
    [
      "foreign-repository PR",
      (harness) =>
        harness.addPull({
          createdAt: "2026-08-07T10:00:00.000Z",
          repository: "someone/fork",
        }),
    ],
  ])("does not renew from %s", async (_name, configure) => {
    const harness = createHarness();
    configure(harness);
    expect((await reconcile(harness)).outcome).toBe("reminded");
    expect(harness.leaseState().lastActivityAt).toBe("2026-08-01T10:00:00.000Z");
  });

  test("recovers an interrupted reminder update without creating a second reminder", async () => {
    const harness = createHarness({ githubNow: "2026-08-10T10:00:00.000Z" });
    const state = harness.leaseState();
    harness.state.comments[42].push({
      id: 555,
      body: `Interrupted reminder\n\n${coordinator.reminderMarker(state)}`,
      created_at: "2026-08-10T10:00:00.000Z",
      updated_at: "2026-08-10T10:00:00.000Z",
      user: user(coordinator.TRUSTED_BOT_LOGIN, true),
    });
    expect((await reconcile(harness)).outcome).toBe("reminded");
    expect(harness.reminderComments()).toHaveLength(1);
  });

  test("fails closed for duplicate reminders and malformed state", async () => {
    const duplicate = createHarness();
    expect((await reconcile(duplicate)).outcome).toBe("reminded");
    duplicate.state.comments[42].push({
      ...structuredClone(duplicate.reminderComments()[0]),
      id: 999,
    });
    expect((await reconcile(duplicate, "2026-08-12T10:00:00.000Z")).outcome).toBe(
      "recovery_required",
    );
    expect(duplicate.core.failures).toHaveLength(1);

    const malformed = createHarness();
    malformed.state.comments[42][0].body = `<!-- ${coordinator.STATE_MARKER} {broken} -->`;
    expect((await reconcile(malformed)).outcome).toBe("recovery_required");
    expect(malformed.state.issue.assignees).toEqual([{ login: "alice" }]);
  });

  test("preserves manual ownership and unmanaged in-progress issues", async () => {
    const changed = createHarness();
    changed.state.issue.assignees = [{ login: "maintainer-choice" }];
    expect((await reconcile(changed)).outcome).toBe("manual_override");
    expect(changed.state.issue.assignees).toEqual([{ login: "maintainer-choice" }]);

    const unmanaged = createHarness();
    unmanaged.state.comments[42] = [];
    expect((await reconcile(unmanaged)).outcome).toBe("manual");
    expect(unmanaged.state.issue.assignees).toEqual([{ login: "alice" }]);
  });

  test("discovers all in-progress issues or one validated manual target", async () => {
    const harness = createHarness();
    await expect(
      coordinator.listClaimedIssueNumbers({
        github: harness.github,
        context: { repo: { owner: "moira-mcp", repo: "moira" }, payload: {} },
      }),
    ).resolves.toEqual([42]);
    await expect(
      coordinator.listClaimedIssueNumbers({
        github: harness.github,
        context: {
          repo: { owner: "moira-mcp", repo: "moira" },
          payload: { inputs: { issue_number: "91" } },
        },
      }),
    ).resolves.toEqual([91]);
    await expect(
      coordinator.listClaimedIssueNumbers({
        github: harness.github,
        context: {
          repo: { owner: "moira-mcp", repo: "moira" },
          payload: { inputs: { issue_number: "invalid" } },
        },
      }),
    ).rejects.toThrow("positive integer");
  });
});
