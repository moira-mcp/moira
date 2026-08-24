"use strict";

const { describe, expect, test } = require("@jest/globals");
const coordinator = require("../../../.github/scripts/issue-claim.cjs");

const coordinates = { owner: "moira-mcp", repo: "moira", issue_number: 42 };

function createHarness() {
  const state = {
    issue: {
      number: 42,
      state: "open",
      labels: [{ name: "type:bug" }, { name: "status:ready" }, { name: "component:cli" }],
      assignees: [],
    },
    comments: [],
    reactions: {},
    nextCommentId: 100,
    etag: 1,
  };
  const calls = {};
  const faults = {};
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
  const hit = (name) => {
    calls[name] = (calls[name] || 0) + 1;
    const fault = faults[`${name}:${calls[name]}`];
    if (fault === "throw") throw new Error(`injected ${name}:${calls[name]}`);
    return fault;
  };
  const issueResponse = () => ({
    data: structuredClone(state.issue),
    headers: { etag: `"${state.etag}"` },
  });
  const botComment = (body, trusted = true) => ({
    id: state.nextCommentId++,
    body,
    created_at: "2026-08-24T10:00:00.000Z",
    updated_at: "2026-08-24T10:00:00.000Z",
    user: trusted
      ? {
          id: coordinator.TRUSTED_BOT_ID,
          login: coordinator.TRUSTED_BOT_LOGIN,
          type: "Bot",
        }
      : { id: 999, login: "other-bot[bot]", type: "Bot" },
  });
  const issues = {
    get: async () => {
      const fault = hit("get");
      if (fault === "extra-label") state.issue.labels.push({ name: "component:external" });
      if (fault === "add-maintainer") {
        state.issue.assignees.push({ login: "maintainer-choice" });
      }
      if (fault === "replace-with-maintainer") {
        state.issue.assignees = [{ login: "maintainer-choice" }];
      }
      return issueResponse();
    },
    addAssignees: async ({ assignees }) => {
      const fault = hit("addAssignees");
      if (fault !== "silent") state.issue.assignees = assignees.map((login) => ({ login }));
      state.etag += 1;
      return issueResponse();
    },
    removeAssignees: async ({ assignees }) => {
      const fault = hit("removeAssignees");
      if (fault !== "silent") {
        state.issue.assignees = state.issue.assignees.filter(
          (assignee) => !assignees.includes(assignee.login),
        );
      }
      if (fault === "add-maintainer-after") {
        state.issue.assignees.push({ login: "maintainer-choice" });
      }
      state.etag += 1;
      return issueResponse();
    },
    addLabels: async ({ labels }) => {
      const fault = hit("addLabels");
      if (fault === "component-before") state.issue.labels.push({ name: "component:external" });
      if (fault === "status-blocked-before") {
        state.issue.labels = state.issue.labels
          .filter((label) => !label.name.startsWith("status:"))
          .concat({ name: "status:blocked" });
      }
      if (fault !== "silent") {
        for (const name of labels) {
          if (!state.issue.labels.some((label) => label.name === name)) {
            state.issue.labels.push({ name });
          }
        }
      }
      state.etag += 1;
      return { data: structuredClone(state.issue.labels) };
    },
    removeLabel: async ({ name }) => {
      const fault = hit("removeLabel");
      if (fault !== "silent") {
        state.issue.labels = state.issue.labels.filter((label) => label.name !== name);
      }
      state.etag += 1;
      return { data: structuredClone(state.issue.labels) };
    },
    listComments: async () => {
      hit("listComments");
      return { data: structuredClone(state.comments) };
    },
    createComment: async ({ body }) => {
      const fault = hit("createComment");
      const comment = botComment(body, fault !== "untrusted");
      state.comments.push(comment);
      return { data: structuredClone(comment) };
    },
    updateComment: async ({ comment_id, body }) => {
      const fault = hit("updateComment");
      const comment = state.comments.find((candidate) => candidate.id === comment_id);
      if (!comment) throw new Error(`comment ${comment_id} does not exist`);
      if (fault !== "silent") comment.body = body;
      if (fault === "untrusted") comment.user = { id: 999, login: "other-bot[bot]", type: "Bot" };
      return { data: structuredClone(comment) };
    },
  };
  const reactions = {
    listForIssueComment: async ({ comment_id }) => {
      hit("listReactions");
      return { data: structuredClone(state.reactions[comment_id] || []) };
    },
    createForIssueComment: async ({ comment_id, content }) => {
      const fault = hit("createReaction");
      const reaction = {
        id: comment_id + 1000,
        content,
        user:
          fault === "untrusted"
            ? { id: 999, login: "other-bot[bot]", type: "Bot" }
            : {
                id: coordinator.TRUSTED_BOT_ID,
                login: coordinator.TRUSTED_BOT_LOGIN,
                type: "Bot",
              },
      };
      (state.reactions[comment_id] ||= []).push(reaction);
      return { data: structuredClone(reaction) };
    },
  };
  return {
    state,
    calls,
    faults,
    core,
    resetCalls() {
      Object.keys(calls).forEach((key) => delete calls[key]);
    },
    addUserComment(login, body, createdAt) {
      const comment = {
        id: state.nextCommentId++,
        body,
        created_at: createdAt,
        updated_at: createdAt,
        user: { id: state.nextCommentId + 2000, login, type: "User" },
      };
      state.comments.push(comment);
      return comment;
    },
    github: {
      rest: { issues, reactions },
      paginate: async (method, options) => (await method(options)).data,
    },
  };
}

function claimInput(harness) {
  return {
    github: harness.github,
    core: harness.core,
    coordinates,
    claimant: "contributor",
    activityAt: "2026-08-24T10:00:00.000Z",
    triggerCommentId: 7,
  };
}

function hasSuccess(harness) {
  return harness.state.comments.some((comment) => /is now assigned/.test(comment.body));
}

async function expectClaimRollback(faultKey, faultValue = "throw") {
  const harness = createHarness();
  harness.faults[faultKey] = faultValue;
  const result = await coordinator.claimIssue(claimInput(harness));
  expect(result.outcome).toBe("rolled_back");
  expect(harness.state.issue.assignees).toEqual([]);
  expect(harness.state.issue.labels.map((label) => label.name)).toContain("status:ready");
  expect(hasSuccess(harness)).toBe(false);
  expect(harness.core.failures).toEqual([]);
}

async function claimedHarness() {
  const harness = createHarness();
  await expect(coordinator.claimIssue(claimInput(harness))).resolves.toMatchObject({
    outcome: "claimed",
  });
  harness.resetCalls();
  return harness;
}

describe("issue claim command parsing and eligibility", () => {
  test.each([
    ["/claim", "/claim"],
    ["  /release\n", "/release"],
    ["/claim extra", "invalid"],
    ["ordinary progress", null],
  ])("parses %p as %p", (input, expected) => {
    expect(coordinator.parseCommand(input)).toBe(expected);
  });

  test.each([
    ["closed issue", { state: "closed" }],
    ["pull request", { isPullRequest: true }],
    ["assigned issue", { assignees: ["owner"] }],
    ["missing status", { labels: ["type:bug"] }],
    ["duplicate status", { labels: ["type:bug", "status:ready", "status:blocked"] }],
    ["unknown status", { labels: ["type:bug", "status:invented"] }],
    ["non-ready status", { labels: ["type:bug", "status:needs-design"] }],
    ["epic", { labels: ["type:epic", "status:ready"] }],
    ["question", { labels: ["type:question", "status:ready"] }],
    ["missing type", { labels: ["status:ready"] }],
    ["duplicate type", { labels: ["type:bug", "type:feature", "status:ready"] }],
    ["unknown type", { labels: ["type:invented", "status:ready"] }],
  ])("fails closed for %s", (_name, override) => {
    const snapshot = {
      state: "open",
      isPullRequest: false,
      labels: ["type:bug", "status:ready"],
      assignees: [],
      ...override,
    };
    expect(coordinator.validateClaimable(snapshot).ok).toBe(false);
  });

  test("accepts an open, unassigned, non-epic implementation issue with one ready status", () => {
    expect(
      coordinator.validateClaimable({
        state: "open",
        isPullRequest: false,
        labels: ["type:feature", "status:ready", "component:cli"],
        assignees: [],
      }),
    ).toEqual({ ok: true });
  });
});

describe("guarded issue ownership transitions", () => {
  test("claims and releases with one trusted human-readable state record", async () => {
    const harness = createHarness();
    const claim = await coordinator.claimIssue(claimInput(harness));

    expect(claim).toMatchObject({ outcome: "claimed", claimant: "contributor" });
    expect(harness.state.issue.assignees).toEqual([{ login: "contributor" }]);
    expect(harness.state.issue.labels.map((label) => label.name)).toEqual(
      expect.arrayContaining(["type:bug", "component:cli", "status:in-progress"]),
    );
    expect(harness.state.comments).toHaveLength(1);
    expect(harness.state.comments[0].body).toContain("2026-08-31T10:00:00.000Z");
    expect(coordinator.parseStateComment(harness.state.comments[0]).state.status).toBe("active");

    harness.resetCalls();
    const release = await coordinator.releaseIssue({
      github: harness.github,
      core: harness.core,
      coordinates,
      claimant: "contributor",
    });
    expect(release.outcome).toBe("released");
    expect(harness.state.issue.assignees).toEqual([]);
    expect(harness.state.issue.labels.map((label) => label.name)).toContain("status:ready");
    expect(coordinator.parseStateComment(harness.state.comments[0]).state.status).toBe("released");
  });

  test.each([
    ["assignment API failure", "addAssignees:1", "throw"],
    ["silently ignored assignment", "addAssignees:1", "silent"],
    ["status-add API failure", "addLabels:1", "throw"],
    ["silently ignored status add", "addLabels:1", "silent"],
    ["status-remove API failure", "removeLabel:1", "throw"],
    ["silently ignored status remove", "removeLabel:1", "silent"],
    ["state-comment failure", "createComment:1", "throw"],
    ["untrusted state author", "createComment:1", "untrusted"],
    ["confirmation failure", "updateComment:1", "throw"],
    ["silently ignored confirmation", "updateComment:1", "silent"],
  ])("rolls back %s without publishing success", async (_name, faultKey, faultValue) => {
    await expectClaimRollback(faultKey, faultValue);
  });

  test("preserves an unrelated label added immediately before the claim status write", async () => {
    const harness = createHarness();
    harness.faults["addLabels:1"] = "component-before";

    const result = await coordinator.claimIssue(claimInput(harness));

    expect(result.outcome).toBe("claimed");
    expect(harness.state.issue.assignees).toEqual([{ login: "contributor" }]);
    expect(harness.state.issue.labels.map((label) => label.name)).toContain("component:external");
    expect(hasSuccess(harness)).toBe(true);
  });

  test("reports an unrecoverable partial transition without false success", async () => {
    const harness = createHarness();
    harness.faults["createComment:1"] = "throw";
    harness.faults["addLabels:2"] = "throw";

    const result = await coordinator.claimIssue(claimInput(harness));

    expect(result.outcome).toBe("recovery_required");
    expect(hasSuccess(harness)).toBe(false);
    expect(harness.core.failures).toHaveLength(1);
  });

  test.each([
    ["before provisional removal", "get:8", "add-maintainer"],
    ["by replacing provisional ownership", "get:8", "replace-with-maintainer"],
    ["between removal and label restoration", "removeAssignees:1", "add-maintainer-after"],
  ])("preserves maintainer ownership added %s", async (_name, faultKey, faultValue) => {
    const harness = createHarness();
    harness.faults["updateComment:1"] = "throw";
    harness.faults[faultKey] = faultValue;

    const result = await coordinator.claimIssue(claimInput(harness));

    expect(result.outcome).toBe("recovery_required");
    expect(harness.state.issue.assignees).toEqual([{ login: "maintainer-choice" }]);
    expect(harness.state.issue.labels.map((label) => label.name)).toContain("status:in-progress");
    expect(harness.state.issue.labels.map((label) => label.name)).not.toContain("status:ready");
    expect(hasSuccess(harness)).toBe(false);
  });

  test.each([
    ["lease record", "updateComment:1"],
    ["ready status add", "addLabels:1"],
    ["in-progress status removal", "removeLabel:1"],
    ["assignee removal", "removeAssignees:1"],
    ["released record", "updateComment:2"],
  ])("rolls back a failed release at the %s boundary", async (_name, faultKey) => {
    const harness = await claimedHarness();
    harness.faults[faultKey] = "throw";

    const result = await coordinator.releaseIssue({
      github: harness.github,
      core: harness.core,
      coordinates,
      claimant: "contributor",
    });

    expect(result.outcome).toBe("rolled_back");
    expect(harness.state.issue.assignees).toEqual([{ login: "contributor" }]);
    expect(harness.state.issue.labels.map((label) => label.name)).toContain("status:in-progress");
    expect(coordinator.parseStateComment(harness.state.comments[0]).state.status).toBe("active");
    expect(harness.core.failures).toEqual([]);
  });

  test.each([
    [
      "claim",
      async () => {
        const harness = createHarness();
        harness.faults["addLabels:1"] = "status-blocked-before";
        return { harness, result: await coordinator.claimIssue(claimInput(harness)) };
      },
    ],
    [
      "release",
      async () => {
        const harness = await claimedHarness();
        harness.faults["addLabels:1"] = "status-blocked-before";
        const result = await coordinator.releaseIssue({
          github: harness.github,
          core: harness.core,
          coordinates,
          claimant: "contributor",
        });
        return { harness, result };
      },
    ],
    [
      "rollback",
      async () => {
        const harness = createHarness();
        harness.faults["updateComment:1"] = "throw";
        harness.faults["addLabels:2"] = "status-blocked-before";
        return { harness, result: await coordinator.claimIssue(claimInput(harness)) };
      },
    ],
  ])("preserves a competing status immediately before the %s status write", async (_name, run) => {
    const { harness, result } = await run();
    expect(result.outcome).toBe("recovery_required");
    expect(harness.state.issue.labels.map((label) => label.name)).toContain("status:blocked");
    expect(harness.state.issue.labels.map((label) => label.name)).not.toContain("status:ready");
  });

  test("preserves unrelated labels during release and rollback status writes", async () => {
    const released = await claimedHarness();
    released.faults["addLabels:1"] = "component-before";
    await expect(
      coordinator.releaseIssue({
        github: released.github,
        core: released.core,
        coordinates,
        claimant: "contributor",
      }),
    ).resolves.toMatchObject({ outcome: "released" });
    expect(released.state.issue.labels.map((label) => label.name)).toContain("component:external");

    const rolledBack = createHarness();
    rolledBack.faults["updateComment:1"] = "throw";
    rolledBack.faults["addLabels:2"] = "component-before";
    await expect(coordinator.claimIssue(claimInput(rolledBack))).resolves.toMatchObject({
      outcome: "rolled_back",
    });
    expect(rolledBack.state.issue.labels.map((label) => label.name)).toContain(
      "component:external",
    );
  });

  test("allows only the current sole assignee to release", async () => {
    const harness = await claimedHarness();
    const result = await coordinator.releaseIssue({
      github: harness.github,
      core: harness.core,
      coordinates,
      claimant: "someone-else",
    });
    expect(result.outcome).toBe("rejected");
    expect(harness.state.issue.assignees).toEqual([{ login: "contributor" }]);
  });

  test("drains competing commands in creation order and marks each exactly once", async () => {
    const harness = createHarness();
    const first = harness.addUserComment("first-contributor", "/claim", "2026-08-24T10:00:00Z");
    const second = harness.addUserComment("second-contributor", "/claim", "2026-08-24T10:00:01Z");
    const context = { repo: { owner: "moira-mcp", repo: "moira" }, payload: {} };

    const outcomes = await coordinator.drainIssueCommands({
      github: harness.github,
      context,
      core: harness.core,
      coordinates,
    });

    expect(outcomes.map((outcome) => outcome.result.outcome)).toEqual(["claimed", "rejected"]);
    expect(harness.state.issue.assignees).toEqual([{ login: "first-contributor" }]);
    expect(harness.state.reactions[first.id]).toHaveLength(1);
    expect(harness.state.reactions[second.id]).toHaveLength(1);
    await expect(
      coordinator.drainIssueCommands({
        github: harness.github,
        context,
        core: harness.core,
        coordinates,
      }),
    ).resolves.toEqual([]);
  });

  test("a later progress-event run drains an earlier pending release", async () => {
    const harness = await claimedHarness();
    harness.addUserComment("contributor", "/release", "2026-08-25T10:00:00Z");
    const progress = harness.addUserComment(
      "contributor",
      "Progress after the queued command",
      "2026-08-25T10:00:01Z",
    );

    const result = await coordinator.handleIssueEvent({
      github: harness.github,
      core: harness.core,
      context: {
        repo: { owner: "moira-mcp", repo: "moira" },
        payload: { issue: { number: 42 }, comment: progress },
      },
    });

    expect(result.commands.map((command) => command.result.outcome)).toEqual(["released"]);
    expect(result.renewal.outcome).toBe("ignored");
    expect(harness.state.issue.assignees).toEqual([]);
    expect(harness.state.issue.labels.map((label) => label.name)).toContain("status:ready");
  });

  test("retries a rolled-back command when its required response was not published", async () => {
    const harness = createHarness();
    const command = harness.addUserComment("contributor", "/claim", "2026-08-24T10:00:00Z");
    const context = { repo: { owner: "moira-mcp", repo: "moira" }, payload: {} };
    harness.faults["updateComment:1"] = "throw";
    harness.faults["createComment:2"] = "throw";

    await expect(
      coordinator.drainIssueCommands({
        github: harness.github,
        context,
        core: harness.core,
        coordinates,
      }),
    ).rejects.toThrow("injected createComment:2");
    expect(harness.state.issue.assignees).toEqual([]);
    expect(harness.state.issue.labels.map((label) => label.name)).toContain("status:ready");
    expect(coordinator.parseStateComment(harness.state.comments[1]).state.status).toBe("aborted");
    expect(harness.state.reactions[command.id]).toBeUndefined();

    harness.resetCalls();
    delete harness.faults["updateComment:1"];
    delete harness.faults["createComment:2"];
    const replay = await coordinator.drainIssueCommands({
      github: harness.github,
      context,
      core: harness.core,
      coordinates,
    });
    expect(replay.map((outcome) => outcome.result.outcome)).toEqual(["claimed"]);
    expect(harness.state.issue.assignees).toEqual([{ login: "contributor" }]);
    expect(harness.state.reactions[command.id]).toHaveLength(1);
    expect(
      harness.state.comments.filter((comment) =>
        Boolean(coordinator.parseStateComment(comment)?.state),
      ),
    ).toHaveLength(1);
  });

  test.each(["throw", "untrusted"])(
    "replays safely when the processed reaction initially %s",
    async (fault) => {
      const harness = createHarness();
      const command = harness.addUserComment("contributor", "/claim", "2026-08-24T10:00:00Z");
      const context = { repo: { owner: "moira-mcp", repo: "moira" }, payload: {} };
      harness.faults["createReaction:1"] = fault;

      await expect(
        coordinator.drainIssueCommands({
          github: harness.github,
          context,
          core: harness.core,
          coordinates,
        }),
      ).rejects.toThrow();
      expect(harness.state.issue.assignees).toEqual([{ login: "contributor" }]);
      await expect(
        coordinator.commandWasProcessed(harness.github, coordinates, command.id),
      ).resolves.toBe(false);

      harness.resetCalls();
      delete harness.faults["createReaction:1"];
      const replay = await coordinator.drainIssueCommands({
        github: harness.github,
        context,
        core: harness.core,
        coordinates,
      });
      expect(replay.map((outcome) => outcome.result.outcome)).toEqual([
        "processed_marker_recovered",
      ]);
      expect(harness.state.issue.assignees).toEqual([{ login: "contributor" }]);
      await expect(
        coordinator.commandWasProcessed(harness.github, coordinates, command.id),
      ).resolves.toBe(true);
    },
  );

  test("recovers a missing processed reaction after an already applied release", async () => {
    const harness = await claimedHarness();
    const command = harness.addUserComment("contributor", "/release", "2026-08-25T10:00:00Z");
    const context = { repo: { owner: "moira-mcp", repo: "moira" }, payload: {} };
    harness.faults["createReaction:1"] = "throw";

    await expect(
      coordinator.drainIssueCommands({
        github: harness.github,
        context,
        core: harness.core,
        coordinates,
      }),
    ).rejects.toThrow();
    expect(harness.state.issue.assignees).toEqual([]);
    expect(coordinator.parseStateComment(harness.state.comments[0]).state).toMatchObject({
      status: "released",
      lastCompletedCommandId: command.id,
    });

    harness.resetCalls();
    delete harness.faults["createReaction:1"];
    const replay = await coordinator.drainIssueCommands({
      github: harness.github,
      context,
      core: harness.core,
      coordinates,
    });
    expect(replay.map((outcome) => outcome.result.outcome)).toEqual(["processed_marker_recovered"]);
    await expect(
      coordinator.commandWasProcessed(harness.github, coordinates, command.id),
    ).resolves.toBe(true);
  });

  test.each([
    [
      "claim rejection",
      () => {
        const harness = createHarness();
        harness.state.issue.labels = [{ name: "type:bug" }, { name: "status:needs-design" }];
        const comment = harness.addUserComment("contributor", "/claim", "2026-08-24T10:00:00Z");
        return { harness, comment };
      },
    ],
    [
      "release rejection",
      async () => {
        const harness = await claimedHarness();
        const comment = harness.addUserComment("someone-else", "/release", "2026-08-25T10:00:00Z");
        return { harness, comment };
      },
    ],
  ])("replays %s when the required explanation initially fails", async (_name, setup) => {
    const prepared = await setup();
    const { harness, comment } = prepared;
    const context = { repo: { owner: "moira-mcp", repo: "moira" }, payload: {} };
    harness.faults["createComment:1"] = "throw";

    await expect(
      coordinator.drainIssueCommands({
        github: harness.github,
        context,
        core: harness.core,
        coordinates,
      }),
    ).rejects.toThrow("injected createComment:1");
    expect(harness.state.reactions[comment.id]).toBeUndefined();

    harness.resetCalls();
    delete harness.faults["createComment:1"];
    const replay = await coordinator.drainIssueCommands({
      github: harness.github,
      context,
      core: harness.core,
      coordinates,
    });
    expect(replay.map((outcome) => outcome.result.outcome)).toEqual(["rejected"]);
    expect(harness.state.reactions[comment.id]).toHaveLength(1);
  });
});
