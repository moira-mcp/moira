"use strict";

const CLAIM_COMMAND = "/claim";
const RELEASE_COMMAND = "/release";
const READY_STATUS = "status:ready";
const IN_PROGRESS_STATUS = "status:in-progress";
const STATUS_PREFIX = "status:";
const TYPE_PREFIX = "type:";
const KNOWN_STATUSES = new Set([
  "status:needs-triage",
  "status:waiting-for-author",
  "status:needs-design",
  "status:needs-investigation",
  "status:ready",
  "status:in-progress",
  "status:blocked",
]);
const KNOWN_TYPES = new Set([
  "type:bug",
  "type:feature",
  "type:chore",
  "type:docs",
  "type:question",
  "type:epic",
]);
const ALLOWED_TYPES = new Set(["type:bug", "type:feature", "type:chore", "type:docs"]);
const STATE_MARKER = "moira-issue-claim-state:v1";
const REMINDER_MARKER = "moira-issue-claim-reminder:v1";
const PROCESSED_REACTION = "eyes";
const TRUSTED_BOT_ID = 41898282;
const TRUSTED_BOT_LOGIN = "github-actions[bot]";
const ACTIVE_LEASE_DAYS = 7;
const REMINDER_GRACE_DAYS = 3;

class TransitionError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "TransitionError";
    this.code = code;
    this.details = details;
  }
}

function normalizeLabels(labels = []) {
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((label) => typeof label === "string" && label.length > 0);
}

function parseCommand(body) {
  const command = typeof body === "string" ? body.trim() : "";
  if (command === CLAIM_COMMAND || command === RELEASE_COMMAND) return command;
  if (/^\/(claim|release)(?:\s|$)/.test(command)) return "invalid";
  return null;
}

function issueSnapshot(response) {
  const issue = response.data;
  return {
    number: issue.number,
    state: issue.state,
    isPullRequest: Boolean(issue.pull_request),
    labels: normalizeLabels(issue.labels),
    assignees: (issue.assignees || []).map((assignee) => assignee.login),
  };
}

function statusLabels(snapshot) {
  return snapshot.labels.filter((label) => label.startsWith(STATUS_PREFIX));
}

function hasExactAssignees(snapshot, expectedAssignees) {
  return (
    !expectedAssignees ||
    (snapshot.assignees.length === expectedAssignees.length &&
      snapshot.assignees.every((login, index) => login === expectedAssignees[index]))
  );
}

function validateClaimable(snapshot) {
  if (snapshot.state !== "open") return { ok: false, reason: "The issue is not open." };
  if (snapshot.isPullRequest) return { ok: false, reason: "Pull requests cannot be claimed." };

  const statuses = snapshot.labels.filter((label) => label.startsWith(STATUS_PREFIX));
  if (statuses.length !== 1) {
    return {
      ok: false,
      reason: "The issue has an inconsistent status and needs maintainer recovery.",
    };
  }
  if (!KNOWN_STATUSES.has(statuses[0])) {
    return {
      ok: false,
      reason: "The issue has an unknown status and needs maintainer recovery.",
    };
  }
  if (statuses[0] !== READY_STATUS) {
    return { ok: false, reason: `The issue is not ready for implementation (${statuses[0]}).` };
  }
  if (snapshot.assignees.length !== 0) {
    return { ok: false, reason: `The issue is already assigned to @${snapshot.assignees[0]}.` };
  }

  const types = snapshot.labels.filter((label) => label.startsWith(TYPE_PREFIX));
  if (types.length !== 1) {
    return {
      ok: false,
      reason: "The issue has an inconsistent type and needs maintainer recovery.",
    };
  }
  if (!KNOWN_TYPES.has(types[0])) {
    return {
      ok: false,
      reason: "The issue has an unknown type and needs maintainer recovery.",
    };
  }
  if (!ALLOWED_TYPES.has(types[0])) {
    return {
      ok: false,
      reason: `Issues with ${types[0]} are not independently claimable.`,
    };
  }

  return { ok: true };
}

function validateClaimed(snapshot, claimant) {
  const statuses = statusLabels(snapshot);
  return (
    snapshot.state === "open" &&
    !snapshot.isPullRequest &&
    snapshot.assignees.length === 1 &&
    snapshot.assignees[0] === claimant &&
    statuses.length === 1 &&
    statuses[0] === IN_PROGRESS_STATUS
  );
}

function validateOwnedReady(snapshot, claimant) {
  const statuses = statusLabels(snapshot);
  return (
    snapshot.state === "open" &&
    snapshot.assignees.length === 1 &&
    snapshot.assignees[0] === claimant &&
    statuses.length === 1 &&
    statuses[0] === READY_STATUS
  );
}

function addDays(isoTimestamp, days) {
  const value = new Date(isoTimestamp);
  if (Number.isNaN(value.getTime())) {
    throw new TransitionError(
      "GitHub supplied an invalid activity timestamp.",
      "invalid_timestamp",
    );
  }
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString();
}

function isTrustedBot(comment) {
  return comment?.user?.id === TRUSTED_BOT_ID && comment?.user?.login === TRUSTED_BOT_LOGIN;
}

function stateMarker(state) {
  return `<!-- ${STATE_MARKER} ${JSON.stringify(state)} -->`;
}

function renderPendingState(state) {
  return `Claim transition is being verified.\n\n${stateMarker(state)}`;
}

function renderActiveState(state) {
  return [
    `@${state.claimant} is now assigned to this issue.`,
    "",
    `Activity deadline: **${state.activityDeadlineAt}**. Add a progress comment here, open a pull request that closes this issue, or comment on that linked pull request before the deadline. Use \`${RELEASE_COMMAND}\` here if you stop working on it.`,
    "",
    stateMarker(state),
  ].join("\n");
}

function renderReleasedState(state, reason = "released by the assignee") {
  return [
    `The claim by @${state.claimant} was ${reason}. This issue is available again when it has \`${READY_STATUS}\` and no assignee.`,
    "",
    stateMarker(state),
  ].join("\n");
}

function reminderMarker(state) {
  return `<!-- ${REMINDER_MARKER} ${JSON.stringify({
    generation: state.generation,
    lastActivityAt: state.lastActivityAt,
  })} -->`;
}

function renderReminder(state, releaseEligibleAt) {
  return [
    `@${state.claimant}, this claim has had no qualifying activity since **${state.lastActivityAt}**.`,
    "",
    `Add a progress comment, open a pull request that closes this issue, or comment on that linked pull request. Otherwise the claim becomes eligible for release after **${releaseEligibleAt}** and will be released by the next successful scheduled check.`,
    "",
    reminderMarker(state),
  ].join("\n");
}

function renderRemindedState(state) {
  const releaseEligibleAt = addDays(state.remindedAt, REMINDER_GRACE_DAYS);
  return [
    `@${state.claimant} remains assigned, but the inactivity reminder was sent at **${state.remindedAt}**.`,
    "",
    `The claim becomes eligible for release after **${releaseEligibleAt}**. Qualifying activity renews the seven-day activity deadline; \`${RELEASE_COMMAND}\` releases it immediately.`,
    "",
    stateMarker(state),
  ].join("\n");
}

function renderClearedReminder(cleanup, renewedAt) {
  return [
    `The inactivity reminder for @${cleanup.claimant} was cleared by qualifying activity at **${renewedAt}**.`,
    "",
    "The current activity deadline is shown in the trusted claim-state comment.",
    "",
    reminderMarker(cleanup),
  ].join("\n");
}

function parseStateComment(comment) {
  if (!isTrustedBot(comment) || typeof comment.body !== "string") return null;
  const escapedMarker = STATE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = comment.body.match(new RegExp(`<!--\\s*${escapedMarker}\\s+({[^]*?})\\s*-->`));
  if (!match) return null;

  let state;
  try {
    state = JSON.parse(match[1]);
  } catch {
    return { invalid: true, comment };
  }

  const validStatus = ["pending", "active", "releasing", "released", "aborted"].includes(
    state.status,
  );
  const valid =
    state.version === 1 &&
    typeof state.generation === "string" &&
    state.generation.length > 0 &&
    typeof state.claimant === "string" &&
    /^[A-Za-z0-9-]+$/.test(state.claimant) &&
    validStatus &&
    typeof state.claimedAt === "string" &&
    typeof state.lastActivityAt === "string" &&
    typeof state.activityDeadlineAt === "string" &&
    !Number.isNaN(Date.parse(state.claimedAt)) &&
    !Number.isNaN(Date.parse(state.lastActivityAt)) &&
    !Number.isNaN(Date.parse(state.activityDeadlineAt)) &&
    (state.lastCompletedCommandId === null || Number.isSafeInteger(state.lastCompletedCommandId)) &&
    (state.remindedAt === null ||
      (typeof state.remindedAt === "string" && !Number.isNaN(Date.parse(state.remindedAt)))) &&
    (state.reminderCleanup === null ||
      (typeof state.reminderCleanup === "object" &&
        state.reminderCleanup !== null &&
        typeof state.reminderCleanup.generation === "string" &&
        typeof state.reminderCleanup.claimant === "string" &&
        typeof state.reminderCleanup.lastActivityAt === "string" &&
        !Number.isNaN(Date.parse(state.reminderCleanup.lastActivityAt))));

  return valid ? { state, comment } : { invalid: true, comment };
}

async function listStateRecords(github, coordinates) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...coordinates,
    per_page: 100,
  });
  const markerComments = comments.filter(
    (comment) => isTrustedBot(comment) && comment.body?.includes(STATE_MARKER),
  );
  return markerComments.map(parseStateComment);
}

async function listReminderRecords(github, coordinates, state) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...coordinates,
    per_page: 100,
  });
  const expectedMarker = reminderMarker(state);
  return comments.filter(
    (comment) => isTrustedBot(comment) && comment.body?.includes(expectedMarker),
  );
}

async function clearReminderRecords(github, core, coordinates, cleanup, renewedAt) {
  const reminders = await listReminderRecords(github, coordinates, cleanup);
  let complete = true;
  for (const reminder of reminders) {
    try {
      await github.rest.issues.updateComment({
        ...coordinates,
        comment_id: reminder.id,
        body: renderClearedReminder(cleanup, renewedAt),
      });
    } catch (error) {
      complete = false;
      core.warning(
        `Lease renewed for #${coordinates.issue_number}, but reminder ${reminder.id} could not be marked cleared: ${error.message}`,
      );
    }
  }
  return complete;
}

async function getIssue(github, coordinates) {
  return issueSnapshot(await github.rest.issues.get(coordinates));
}

async function removeTransitionLabel(github, coordinates, name) {
  try {
    await github.rest.issues.removeLabel({ ...coordinates, name });
  } catch (error) {
    const current = await getIssue(github, coordinates);
    if (current.labels.includes(name)) throw error;
  }
}

async function transitionStatus({ github, coordinates, from, to, expectedAssignees }) {
  let current = await getIssue(github, coordinates);
  let statuses = statusLabels(current);
  if (
    statuses.length === 1 &&
    statuses[0] === to &&
    hasExactAssignees(current, expectedAssignees)
  ) {
    return current;
  }
  if (
    statuses.length !== 1 ||
    statuses[0] !== from ||
    !hasExactAssignees(current, expectedAssignees)
  ) {
    throw new TransitionError(
      `Status transition ${from} → ${to} lost its precondition.`,
      "status_precondition",
    );
  }

  let addError = null;
  try {
    await github.rest.issues.addLabels({ ...coordinates, labels: [to] });
  } catch (error) {
    addError = error;
  }
  current = await getIssue(github, coordinates);
  statuses = statusLabels(current);
  if (
    statuses.length === 1 &&
    statuses[0] === to &&
    hasExactAssignees(current, expectedAssignees)
  ) {
    return current;
  }
  if (
    statuses.length !== 2 ||
    !statuses.includes(from) ||
    !statuses.includes(to) ||
    !hasExactAssignees(current, expectedAssignees)
  ) {
    if (statuses.includes(to) && (statuses.includes(from) || statuses.length > 1)) {
      await removeTransitionLabel(github, coordinates, to);
    }
    throw (
      addError ||
      new TransitionError(
        `Status transition ${from} → ${to} encountered a competing change.`,
        "status_competing_change",
      )
    );
  }

  let removeError = null;
  try {
    await github.rest.issues.removeLabel({ ...coordinates, name: from });
  } catch (error) {
    removeError = error;
  }
  current = await getIssue(github, coordinates);
  statuses = statusLabels(current);
  if (
    statuses.length === 1 &&
    statuses[0] === to &&
    hasExactAssignees(current, expectedAssignees)
  ) {
    return current;
  }
  if (statuses.includes(to) && (statuses.includes(from) || statuses.length > 1)) {
    await removeTransitionLabel(github, coordinates, to);
  }
  throw (
    removeError ||
    new TransitionError(
      `Status transition ${from} → ${to} did not reach its invariant.`,
      "status_invariant",
    )
  );
}

async function createRequiredComment(github, coordinates, body) {
  const response = await github.rest.issues.createComment({ ...coordinates, body });
  if (!isTrustedBot(response.data)) {
    throw new TransitionError(
      "GitHub did not persist the required bot response.",
      "required_comment_failed",
    );
  }
  return response.data;
}

async function bestEffortComment(github, coordinates, body) {
  try {
    await github.rest.issues.createComment({ ...coordinates, body });
  } catch {
    // The workflow failure remains visible even when GitHub also rejects the explanatory comment.
  }
}

async function restoreClaimableState({ github, coordinates, claimant }) {
  const failures = [];
  let current = await getIssue(github, coordinates);

  // Remove only automation's provisional ownership first. A newer maintainer assignee
  // makes status restoration unsafe and must be preserved for explicit recovery.
  if (current.assignees.includes(claimant)) {
    try {
      await github.rest.issues.removeAssignees({ ...coordinates, assignees: [claimant] });
    } catch (error) {
      failures.push(`assignee: ${error.message}`);
    }
  }

  current = await getIssue(github, coordinates);
  if (
    current.assignees.length === 0 &&
    statusLabels(current).length === 1 &&
    statusLabels(current)[0] === IN_PROGRESS_STATUS
  ) {
    try {
      await transitionStatus({
        github,
        coordinates,
        from: IN_PROGRESS_STATUS,
        to: READY_STATUS,
        expectedAssignees: [],
      });
    } catch (error) {
      failures.push(`labels: ${error.message}`);
    }
  }

  const finalState = await getIssue(github, coordinates);
  const finalStatuses = statusLabels(finalState);
  const restored =
    finalState.assignees.length === 0 &&
    finalStatuses.length === 1 &&
    finalStatuses[0] === READY_STATUS;
  return { restored, failures, finalState };
}

async function claimIssue({ github, core, coordinates, claimant, activityAt, triggerCommentId }) {
  const initial = await getIssue(github, coordinates);
  const eligibility = validateClaimable(initial);
  if (!eligibility.ok) {
    await createRequiredComment(
      github,
      coordinates,
      `@${claimant}, claim rejected: ${eligibility.reason}`,
    );
    return { outcome: "rejected", reason: eligibility.reason };
  }

  const records = await listStateRecords(github, coordinates);
  if (records.some((record) => !record || record.invalid) || records.length > 1) {
    const reason = "The trusted claim record is ambiguous and needs maintainer recovery.";
    await createRequiredComment(github, coordinates, `@${claimant}, claim rejected: ${reason}`);
    return { outcome: "rejected", reason };
  }
  const existingRecord = records[0] || null;
  if (existingRecord && !["released", "aborted"].includes(existingRecord.state.status)) {
    const reason =
      "The issue state and its trusted claim record disagree; a maintainer must recover it.";
    await createRequiredComment(github, coordinates, `@${claimant}, claim rejected: ${reason}`);
    return { outcome: "rejected", reason };
  }

  let stateComment = existingRecord?.comment || null;
  const previousStateBody = stateComment?.body;
  let state = {
    version: 1,
    generation: `${coordinates.issue_number}-${triggerCommentId}`,
    claimant,
    status: "pending",
    claimedAt: activityAt,
    lastActivityAt: activityAt,
    activityDeadlineAt: addDays(activityAt, ACTIVE_LEASE_DAYS),
    remindedAt: null,
    reminderCleanup: null,
    lastCompletedCommandId: triggerCommentId,
  };

  try {
    await github.rest.issues.addAssignees({ ...coordinates, assignees: [claimant] });
    let current = await getIssue(github, coordinates);
    if (
      current.assignees.length !== 1 ||
      current.assignees[0] !== claimant ||
      validateClaimable({ ...current, assignees: [] }).ok !== true
    ) {
      throw new TransitionError(
        "GitHub did not establish sole ownership.",
        "assignment_not_applied",
      );
    }

    await transitionStatus({
      github,
      coordinates,
      from: READY_STATUS,
      to: IN_PROGRESS_STATUS,
      expectedAssignees: [claimant],
    });
    current = await getIssue(github, coordinates);
    if (!validateClaimed(current, claimant)) {
      throw new TransitionError(
        "The issue did not reach the claimed invariant.",
        "claim_invariant",
      );
    }

    const pendingBody = renderPendingState(state);
    const stateResponse = stateComment
      ? await github.rest.issues.updateComment({
          ...coordinates,
          comment_id: stateComment.id,
          body: pendingBody,
        })
      : await github.rest.issues.createComment({ ...coordinates, body: pendingBody });
    stateComment = stateResponse.data;
    const parsedPending = parseStateComment(stateComment);
    if (
      !parsedPending ||
      parsedPending.invalid ||
      parsedPending.state.generation !== state.generation
    ) {
      throw new TransitionError(
        "GitHub did not persist a trusted claim record.",
        "state_not_applied",
      );
    }

    current = await getIssue(github, coordinates);
    if (!validateClaimed(current, claimant)) {
      throw new TransitionError("The issue changed before claim confirmation.", "claim_changed");
    }

    state = { ...state, status: "active" };
    const confirmation = await github.rest.issues.updateComment({
      ...coordinates,
      comment_id: stateComment.id,
      body: renderActiveState(state),
    });
    const parsedActive = parseStateComment(confirmation.data);
    if (!parsedActive || parsedActive.invalid || parsedActive.state.status !== "active") {
      throw new TransitionError(
        "GitHub did not persist claim confirmation.",
        "confirmation_failed",
      );
    }

    return { outcome: "claimed", claimant, state, commentId: confirmation.data.id };
  } catch (error) {
    if (stateComment) {
      const abortedState = { ...state, status: "aborted" };
      const body =
        previousStateBody || `Claim transition was aborted.\n\n${stateMarker(abortedState)}`;
      try {
        await github.rest.issues.updateComment({
          ...coordinates,
          comment_id: stateComment.id,
          body,
        });
      } catch {
        // The issue transition is compensated below; an ambiguous record fails closed later.
      }
    }

    const recovery = await restoreClaimableState({
      github,
      coordinates,
      claimant,
    });
    const message = recovery.restored
      ? `@${claimant}, the claim could not be completed and was rolled back. Please try again later.`
      : `@${claimant}, the claim transition needs maintainer recovery; no success was recorded.`;
    await createRequiredComment(github, coordinates, message);
    if (!recovery.restored) core.setFailed(`Claim recovery incomplete: ${error.message}`);
    return {
      outcome: recovery.restored ? "rolled_back" : "recovery_required",
      error: error.message,
      recovery,
    };
  }
}

async function releaseIssue({
  github,
  core,
  coordinates,
  claimant,
  releaseReason = "released by the assignee",
  releaseCommandId = null,
}) {
  const initial = await getIssue(github, coordinates);
  const statuses = initial.labels.filter((label) => label.startsWith(STATUS_PREFIX));
  if (
    initial.state !== "open" ||
    initial.isPullRequest ||
    initial.assignees.length !== 1 ||
    initial.assignees[0] !== claimant ||
    statuses.length !== 1 ||
    statuses[0] !== IN_PROGRESS_STATUS
  ) {
    const owner = initial.assignees[0];
    const reason = owner
      ? `only the current sole assignee (@${owner}) can release this issue.`
      : "the issue does not have one active claim to release.";
    await createRequiredComment(github, coordinates, `@${claimant}, release rejected: ${reason}`);
    return { outcome: "rejected", reason };
  }

  const records = await listStateRecords(github, coordinates);
  if (
    records.length !== 1 ||
    !records[0] ||
    records[0].invalid ||
    records[0].state.status !== "active" ||
    records[0].state.claimant !== claimant
  ) {
    const reason =
      "The trusted claim record is missing or inconsistent; a maintainer must recover it.";
    await createRequiredComment(github, coordinates, `@${claimant}, release rejected: ${reason}`);
    return { outcome: "rejected", reason };
  }

  let record = records[0];
  if (record.state.reminderCleanup) {
    const cleanup = await finishReminderCleanup({
      github,
      core,
      coordinates,
      record,
      state: record.state,
      renewedAt: record.state.lastActivityAt,
    });
    if (!cleanup.complete) {
      throw new TransitionError(
        "The visible inactivity reminder could not be cleared before release.",
        "release_cleanup_pending",
      );
    }
    record = cleanup.record;
  }
  const originalBody = record.comment.body;
  const releasingState = { ...record.state, status: "releasing" };

  try {
    await github.rest.issues.updateComment({
      ...coordinates,
      comment_id: record.comment.id,
      body: `Release transition is being verified.\n\n${stateMarker(releasingState)}`,
    });
    let current = await getIssue(github, coordinates);
    if (!validateClaimed(current, claimant)) {
      throw new TransitionError("The issue changed before release mutation.", "release_changed");
    }
    await transitionStatus({
      github,
      coordinates,
      from: IN_PROGRESS_STATUS,
      to: READY_STATUS,
      expectedAssignees: [claimant],
    });
    current = await getIssue(github, coordinates);
    if (!validateOwnedReady(current, claimant)) {
      throw new TransitionError(
        "The issue did not reach the release intermediate state.",
        "release_labels",
      );
    }

    await github.rest.issues.removeAssignees({ ...coordinates, assignees: [claimant] });
    current = await getIssue(github, coordinates);
    const currentStatuses = statusLabels(current);
    if (
      current.assignees.length !== 0 ||
      currentStatuses.length !== 1 ||
      currentStatuses[0] !== READY_STATUS
    ) {
      throw new TransitionError(
        "The issue did not reach the released invariant.",
        "release_invariant",
      );
    }

    const releasedState = {
      ...record.state,
      status: "released",
      lastCompletedCommandId: releaseCommandId ?? record.state.lastCompletedCommandId,
    };
    const updated = await github.rest.issues.updateComment({
      ...coordinates,
      comment_id: record.comment.id,
      body: renderReleasedState(releasedState, releaseReason),
    });
    const parsed = parseStateComment(updated.data);
    if (!parsed || parsed.invalid || parsed.state.status !== "released") {
      throw new TransitionError("The released state record was not persisted.", "release_record");
    }
    return { outcome: "released", claimant };
  } catch (error) {
    let restored = false;
    try {
      let current = await getIssue(github, coordinates);
      if (
        current.assignees.length === 0 &&
        statusLabels(current).length === 1 &&
        statusLabels(current)[0] === READY_STATUS
      ) {
        await github.rest.issues.addAssignees({ ...coordinates, assignees: [claimant] });
        current = await getIssue(github, coordinates);
      }
      if (
        current.assignees.length === 1 &&
        current.assignees[0] === claimant &&
        statusLabels(current).length === 1 &&
        statusLabels(current)[0] === READY_STATUS
      ) {
        await transitionStatus({
          github,
          coordinates,
          from: READY_STATUS,
          to: IN_PROGRESS_STATUS,
          expectedAssignees: [claimant],
        });
      }
      await github.rest.issues.updateComment({
        ...coordinates,
        comment_id: record.comment.id,
        body: originalBody,
      });
      current = await getIssue(github, coordinates);
      restored = validateClaimed(current, claimant);
    } catch {
      restored = false;
    }

    const message = restored
      ? `@${claimant}, release could not be completed; your claim remains active.`
      : `@${claimant}, release needs maintainer recovery; the issue remains unavailable until reconciled.`;
    await createRequiredComment(github, coordinates, message);
    if (!restored) core.setFailed(`Release recovery incomplete: ${error.message}`);
    return { outcome: restored ? "rolled_back" : "recovery_required", error: error.message };
  }
}

async function updateLeaseState(github, coordinates, record, state, body) {
  const updated = await github.rest.issues.updateComment({
    ...coordinates,
    comment_id: record.comment.id,
    body,
  });
  const parsed = parseStateComment(updated.data);
  if (
    !parsed ||
    parsed.invalid ||
    parsed.state.generation !== state.generation ||
    parsed.state.status !== state.status ||
    parsed.state.lastActivityAt !== state.lastActivityAt ||
    parsed.state.remindedAt !== state.remindedAt ||
    JSON.stringify(parsed.state.reminderCleanup) !== JSON.stringify(state.reminderCleanup)
  ) {
    throw new TransitionError("GitHub did not persist the lease state.", "lease_state_not_applied");
  }
  return parsed;
}

function reminderCleanupFor(state) {
  if (state.reminderCleanup) return state.reminderCleanup;
  if (state.remindedAt === null) return null;
  return {
    generation: state.generation,
    claimant: state.claimant,
    lastActivityAt: state.lastActivityAt,
  };
}

async function finishReminderCleanup({ github, core, coordinates, record, state, renewedAt }) {
  if (!state.reminderCleanup) return { complete: true, record, state };
  const complete = await clearReminderRecords(
    github,
    core,
    coordinates,
    state.reminderCleanup,
    renewedAt,
  );
  if (!complete) return { complete: false, record, state };
  const cleaned = { ...state, reminderCleanup: null };
  const parsed = await updateLeaseState(
    github,
    coordinates,
    record,
    cleaned,
    renderActiveState(cleaned),
  );
  return { complete: true, record: parsed, state: cleaned };
}

async function renewLease({ github, core, coordinates, activityAt, actor }) {
  const issue = await getIssue(github, coordinates);
  if (!validateClaimed(issue, actor)) return { outcome: "ignored" };

  const records = await listStateRecords(github, coordinates);
  if (
    records.length !== 1 ||
    !records[0] ||
    records[0].invalid ||
    records[0].state.status !== "active" ||
    records[0].state.claimant !== actor
  ) {
    core.warning(`Issue #${coordinates.issue_number} has no unambiguous managed lease to renew.`);
    return { outcome: "manual_or_recovery" };
  }

  const record = records[0];
  if (Date.parse(activityAt) <= Date.parse(record.state.lastActivityAt)) {
    return { outcome: "unchanged" };
  }

  const current = await getIssue(github, coordinates);
  if (!validateClaimed(current, actor)) return { outcome: "manual_override" };
  const state = {
    ...record.state,
    lastActivityAt: activityAt,
    activityDeadlineAt: addDays(activityAt, ACTIVE_LEASE_DAYS),
    remindedAt: null,
    reminderCleanup: reminderCleanupFor(record.state),
  };
  const parsed = await updateLeaseState(
    github,
    coordinates,
    record,
    state,
    renderActiveState(state),
  );
  const cleanup = await finishReminderCleanup({
    github,
    core,
    coordinates,
    record: parsed,
    state,
    renewedAt: activityAt,
  });
  return {
    outcome: cleanup.complete ? "renewed" : "renewed_cleanup_pending",
    state: cleanup.state,
  };
}

async function listCrossReferencedPullRequestNumbers(github, coordinates) {
  const query = `
    query CrossReferencedPullRequests(
      $owner: String!
      $repo: String!
      $issueNumber: Int!
      $cursor: String
    ) {
      repository(owner: $owner, name: $repo) {
        issue(number: $issueNumber) {
          timelineItems(
            first: 100
            after: $cursor
            itemTypes: [CROSS_REFERENCED_EVENT]
          ) {
            nodes {
              ... on CrossReferencedEvent {
                source {
                  ... on PullRequest {
                    number
                    repository { nameWithOwner }
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const numbers = new Set();
  let cursor = null;
  do {
    const result = await github.graphql(query, {
      owner: coordinates.owner,
      repo: coordinates.repo,
      issueNumber: coordinates.issue_number,
      cursor,
    });
    const timeline = result.repository?.issue?.timelineItems;
    if (!timeline) break;
    for (const node of timeline.nodes || []) {
      const source = node?.source;
      if (
        source?.repository?.nameWithOwner?.toLowerCase() ===
        `${coordinates.owner}/${coordinates.repo}`.toLowerCase()
      ) {
        numbers.add(source.number);
      }
    }
    cursor = timeline.pageInfo.hasNextPage ? timeline.pageInfo.endCursor : null;
  } while (cursor);
  return [...numbers];
}

async function getClosingPullRequest(github, coordinates, pullNumber) {
  const query = `
    query ClosingReferences(
      $owner: String!
      $repo: String!
      $pullNumber: Int!
      $cursor: String
    ) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pullNumber) {
          number
          createdAt
          author { login }
          closingIssuesReferences(first: 100, after: $cursor) {
            nodes { number repository { nameWithOwner } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  let cursor = null;
  let pullRequest = null;
  let closesIssue = false;
  do {
    const result = await github.graphql(query, {
      owner: coordinates.owner,
      repo: coordinates.repo,
      pullNumber,
      cursor,
    });
    const current = result.repository?.pullRequest;
    if (!current) return null;
    pullRequest ||= {
      number: current.number,
      createdAt: current.createdAt,
      authorLogin: current.author?.login,
    };
    closesIssue ||= (current.closingIssuesReferences.nodes || []).some(
      (issue) =>
        issue.number === coordinates.issue_number &&
        issue.repository?.nameWithOwner?.toLowerCase() ===
          `${coordinates.owner}/${coordinates.repo}`.toLowerCase(),
    );
    cursor = current.closingIssuesReferences.pageInfo.hasNextPage
      ? current.closingIssuesReferences.pageInfo.endCursor
      : null;
  } while (cursor && !closesIssue);
  return closesIssue ? pullRequest : null;
}

function laterTimestamp(current, candidate) {
  if (!candidate || Number.isNaN(Date.parse(candidate))) return current;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

async function findLatestAllowedActivity(github, coordinates, state) {
  let latest = state.lastActivityAt;
  const issueComments = await github.paginate(github.rest.issues.listComments, {
    ...coordinates,
    per_page: 100,
  });
  for (const comment of issueComments) {
    if (comment.user?.login === state.claimant && comment.body?.trim() !== RELEASE_COMMAND) {
      latest = laterTimestamp(latest, comment.created_at);
    }
  }

  const pullNumbers = await listCrossReferencedPullRequestNumbers(github, coordinates);
  for (const pullNumber of pullNumbers) {
    const pullRequest = await getClosingPullRequest(github, coordinates, pullNumber);
    if (!pullRequest || pullRequest.authorLogin !== state.claimant) continue;
    latest = laterTimestamp(latest, pullRequest.createdAt);

    const pullComments = await github.paginate(github.rest.issues.listComments, {
      owner: coordinates.owner,
      repo: coordinates.repo,
      issue_number: pullNumber,
      per_page: 100,
    });
    for (const comment of pullComments) {
      if (comment.user?.login === state.claimant) {
        latest = laterTimestamp(latest, comment.created_at);
      }
    }
  }
  return latest;
}

async function ensureRecoveryNotice(github, coordinates, reason) {
  const marker = `<!-- moira-issue-claim-recovery:v1 issue=${coordinates.issue_number} -->`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...coordinates,
    per_page: 100,
  });
  if (comments.some((comment) => isTrustedBot(comment) && comment.body?.includes(marker))) return;
  await bestEffortComment(
    github,
    coordinates,
    `This managed claim needs maintainer recovery: ${reason}\n\n${marker}`,
  );
}

async function reconcileIssue({ github, core, coordinates, now }) {
  const issue = await getIssue(github, coordinates);
  const records = await listStateRecords(github, coordinates);
  if (records.length === 0) {
    core.warning(
      `Issue #${coordinates.issue_number} has no managed lease; preserving manual state.`,
    );
    return { outcome: "manual" };
  }
  if (records.length !== 1 || !records[0] || records[0].invalid) {
    await ensureRecoveryNotice(github, coordinates, "the trusted lease record is ambiguous");
    core.setFailed(`Issue #${coordinates.issue_number} has an ambiguous managed lease record.`);
    return { outcome: "recovery_required" };
  }

  let record = records[0];
  let state = record.state;
  if (state.status !== "active" || !validateClaimed(issue, state.claimant)) {
    core.warning(`Issue #${coordinates.issue_number} was changed manually; preserving that state.`);
    return { outcome: "manual_override" };
  }

  if (state.reminderCleanup) {
    const cleanup = await finishReminderCleanup({
      github,
      core,
      coordinates,
      record,
      state,
      renewedAt: state.lastActivityAt,
    });
    if (!cleanup.complete) return { outcome: "cleanup_pending", state: cleanup.state };
    record = cleanup.record;
    state = cleanup.state;
  }

  const latestActivity = await findLatestAllowedActivity(github, coordinates, state);
  if (Date.parse(latestActivity) > Date.parse(state.lastActivityAt)) {
    const renewed = {
      ...state,
      lastActivityAt: latestActivity,
      activityDeadlineAt: addDays(latestActivity, ACTIVE_LEASE_DAYS),
      remindedAt: null,
      reminderCleanup: reminderCleanupFor(state),
    };
    const parsed = await updateLeaseState(
      github,
      coordinates,
      record,
      renewed,
      renderActiveState(renewed),
    );
    const cleanup = await finishReminderCleanup({
      github,
      core,
      coordinates,
      record: parsed,
      state: renewed,
      renewedAt: latestActivity,
    });
    return {
      outcome: cleanup.complete ? "renewed" : "renewed_cleanup_pending",
      state: cleanup.state,
    };
  }

  if (Date.parse(now) < Date.parse(state.activityDeadlineAt)) {
    return { outcome: "active", state };
  }

  const reminders = await listReminderRecords(github, coordinates, state);
  if (reminders.length > 1) {
    await ensureRecoveryNotice(github, coordinates, "multiple trusted reminders exist");
    core.setFailed(`Issue #${coordinates.issue_number} has duplicate reminder records.`);
    return { outcome: "recovery_required" };
  }

  if (state.remindedAt === null) {
    let reminder = reminders[0];
    if (!reminder) {
      const response = await github.rest.issues.createComment({
        ...coordinates,
        body: [
          `@${state.claimant}, this claim has reached its inactivity deadline.`,
          "",
          "The exact release-eligibility time is being recorded from this GitHub comment.",
          "",
          reminderMarker(state),
        ].join("\n"),
      });
      reminder = response.data;
      if (!isTrustedBot(reminder) || !reminder.body?.includes(reminderMarker(state))) {
        throw new TransitionError("GitHub did not persist a trusted reminder.", "reminder_failed");
      }
    }
    const finalReminder = await github.rest.issues.updateComment({
      ...coordinates,
      comment_id: reminder.id,
      body: renderReminder(state, addDays(reminder.created_at, REMINDER_GRACE_DAYS)),
    });
    reminder = finalReminder.data;
    if (!isTrustedBot(reminder) || !reminder.body?.includes(reminderMarker(state))) {
      throw new TransitionError("GitHub did not finalize the trusted reminder.", "reminder_failed");
    }
    state = { ...state, remindedAt: reminder.created_at, reminderCleanup: null };
    await updateLeaseState(github, coordinates, record, state, renderRemindedState(state));
    return { outcome: "reminded", state };
  }

  if (
    reminders.length !== 1 ||
    reminders[0].created_at !== state.remindedAt ||
    !isTrustedBot(reminders[0])
  ) {
    await ensureRecoveryNotice(github, coordinates, "the reminder timestamp cannot be verified");
    core.setFailed(`Issue #${coordinates.issue_number} has an unverifiable reminder.`);
    return { outcome: "recovery_required" };
  }

  const releaseEligibleAt = addDays(state.remindedAt, REMINDER_GRACE_DAYS);
  if (Date.parse(now) < Date.parse(releaseEligibleAt)) {
    return { outcome: "grace", state, releaseEligibleAt };
  }

  // Re-read both product state and activity immediately before the destructive release transition.
  const currentIssue = await getIssue(github, coordinates);
  const currentRecords = await listStateRecords(github, coordinates);
  if (
    currentRecords.length !== 1 ||
    !currentRecords[0] ||
    currentRecords[0].invalid ||
    currentRecords[0].state.generation !== state.generation ||
    currentRecords[0].state.remindedAt !== state.remindedAt ||
    !validateClaimed(currentIssue, state.claimant)
  ) {
    core.warning(`Issue #${coordinates.issue_number} changed before expiry; preserving it.`);
    return { outcome: "manual_override" };
  }
  const activityBeforeRelease = await findLatestAllowedActivity(github, coordinates, state);
  if (Date.parse(activityBeforeRelease) > Date.parse(state.lastActivityAt)) {
    const renewed = {
      ...state,
      lastActivityAt: activityBeforeRelease,
      activityDeadlineAt: addDays(activityBeforeRelease, ACTIVE_LEASE_DAYS),
      remindedAt: null,
      reminderCleanup: reminderCleanupFor(state),
    };
    const parsed = await updateLeaseState(
      github,
      coordinates,
      currentRecords[0],
      renewed,
      renderActiveState(renewed),
    );
    const cleanup = await finishReminderCleanup({
      github,
      core,
      coordinates,
      record: parsed,
      state: renewed,
      renewedAt: activityBeforeRelease,
    });
    return {
      outcome: cleanup.complete ? "renewed" : "renewed_cleanup_pending",
      state: cleanup.state,
    };
  }

  return releaseIssue({
    github,
    core,
    coordinates,
    claimant: state.claimant,
    releaseReason: "released after the inactivity reminder and grace period",
  });
}

async function listClaimedIssueNumbers({ github, context }) {
  const requested = context.payload.inputs?.issue_number;
  if (requested !== undefined && requested !== "") {
    const issueNumber = Number(requested);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new TransitionError("issue_number must be a positive integer.", "invalid_issue_number");
    }
    return [issueNumber];
  }
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: "open",
    labels: IN_PROGRESS_STATUS,
    per_page: 100,
  });
  return issues.filter((issue) => !issue.pull_request).map((issue) => issue.number);
}

async function commandWasProcessed(github, coordinates, commentId) {
  const reactions = await github.paginate(github.rest.reactions.listForIssueComment, {
    owner: coordinates.owner,
    repo: coordinates.repo,
    comment_id: commentId,
    per_page: 100,
  });
  return reactions.some(
    (reaction) => isTrustedBot(reaction) && reaction.content === PROCESSED_REACTION,
  );
}

async function markCommandProcessed(github, coordinates, commentId) {
  const response = await github.rest.reactions.createForIssueComment({
    owner: coordinates.owner,
    repo: coordinates.repo,
    comment_id: commentId,
    content: PROCESSED_REACTION,
  });
  if (!isTrustedBot(response.data) || response.data.content !== PROCESSED_REACTION) {
    throw new TransitionError(
      `GitHub did not persist the processed marker for comment ${commentId}.`,
      "processed_marker_failed",
    );
  }
}

async function commandAlreadyApplied(github, coordinates, comment) {
  const records = await listStateRecords(github, coordinates);
  if (
    records.length !== 1 ||
    !records[0] ||
    records[0].invalid ||
    records[0].state.lastCompletedCommandId !== comment.id
  ) {
    return false;
  }
  const issue = await getIssue(github, coordinates);
  const command = parseCommand(comment.body);
  if (command === CLAIM_COMMAND) {
    return (
      records[0].state.status === "active" &&
      records[0].state.claimant === comment.user?.login &&
      validateClaimed(issue, records[0].state.claimant)
    );
  }
  if (command === RELEASE_COMMAND) {
    const statuses = statusLabels(issue);
    return (
      records[0].state.status === "released" &&
      issue.assignees.length === 0 &&
      statuses.length === 1 &&
      statuses[0] === READY_STATUS
    );
  }
  return false;
}

async function drainIssueCommands({ github, context, core, coordinates }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...coordinates,
    per_page: 100,
  });
  const commands = comments
    .filter((comment) => parseCommand(comment.body) !== null)
    .sort((left, right) => {
      const timeDifference = Date.parse(left.created_at) - Date.parse(right.created_at);
      return timeDifference || left.id - right.id;
    });
  const outcomes = [];

  for (const comment of commands) {
    if (await commandWasProcessed(github, coordinates, comment.id)) continue;
    if (await commandAlreadyApplied(github, coordinates, comment)) {
      await markCommandProcessed(github, coordinates, comment.id);
      outcomes.push({ commentId: comment.id, result: { outcome: "processed_marker_recovered" } });
      continue;
    }
    const syntheticContext = {
      ...context,
      payload: {
        ...context.payload,
        issue: { number: coordinates.issue_number },
        comment,
      },
    };
    const result = await handleIssueComment({ github, context: syntheticContext, core });
    await markCommandProcessed(github, coordinates, comment.id);
    outcomes.push({ commentId: comment.id, result });
  }
  return outcomes;
}

async function handleIssueEvent({ github, context, core }) {
  const event = context.payload;
  if (event.issue.pull_request) return { outcome: "ignored" };
  const coordinates = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: event.issue.number,
  };
  const commands = await drainIssueCommands({ github, context, core, coordinates });
  if (parseCommand(event.comment?.body) !== null) {
    return { outcome: "commands_drained", commands };
  }
  const renewal = await renewLease({
    github,
    core,
    coordinates,
    actor: event.comment.user.login,
    activityAt: event.comment.created_at,
  });
  return { outcome: "commands_drained", commands, renewal };
}

async function handleIssueComment({ github, context, core }) {
  const event = context.payload;
  const command = parseCommand(event.comment?.body);
  const coordinates = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: event.issue.number,
  };
  const claimant = event.comment.user.login;

  if (!command) {
    if (event.issue.pull_request) return { outcome: "ignored" };
    return renewLease({
      github,
      core,
      coordinates,
      actor: claimant,
      activityAt: event.comment.created_at,
    });
  }

  if (event.issue.pull_request) {
    await createRequiredComment(
      github,
      coordinates,
      `@${claimant}, issue claim commands do not run on pull requests.`,
    );
    return { outcome: "rejected", reason: "pull_request" };
  }
  if (command === "invalid") {
    await createRequiredComment(
      github,
      coordinates,
      `@${claimant}, use exactly \`${CLAIM_COMMAND}\` or \`${RELEASE_COMMAND}\` on its own line.`,
    );
    return { outcome: "rejected", reason: "invalid_command" };
  }

  if (command === CLAIM_COMMAND) {
    return claimIssue({
      github,
      core,
      coordinates,
      claimant,
      activityAt: event.comment.created_at,
      triggerCommentId: event.comment.id,
    });
  }
  return releaseIssue({
    github,
    core,
    coordinates,
    claimant,
    releaseCommandId: event.comment.id,
  });
}

module.exports = {
  ACTIVE_LEASE_DAYS,
  ALLOWED_TYPES,
  CLAIM_COMMAND,
  IN_PROGRESS_STATUS,
  KNOWN_STATUSES,
  KNOWN_TYPES,
  PROCESSED_REACTION,
  READY_STATUS,
  RELEASE_COMMAND,
  REMINDER_GRACE_DAYS,
  REMINDER_MARKER,
  STATE_MARKER,
  TRUSTED_BOT_ID,
  TRUSTED_BOT_LOGIN,
  TransitionError,
  addDays,
  bestEffortComment,
  claimIssue,
  clearReminderRecords,
  commandWasProcessed,
  commandAlreadyApplied,
  createRequiredComment,
  drainIssueCommands,
  ensureRecoveryNotice,
  findLatestAllowedActivity,
  finishReminderCleanup,
  getClosingPullRequest,
  handleIssueEvent,
  handleIssueComment,
  isTrustedBot,
  listClaimedIssueNumbers,
  listCrossReferencedPullRequestNumbers,
  listReminderRecords,
  listStateRecords,
  markCommandProcessed,
  normalizeLabels,
  parseCommand,
  parseStateComment,
  reconcileIssue,
  releaseIssue,
  renderActiveState,
  renderClearedReminder,
  renderRemindedState,
  renderReminder,
  renderReleasedState,
  reminderMarker,
  reminderCleanupFor,
  renewLease,
  stateMarker,
  statusLabels,
  transitionStatus,
  validateClaimable,
  validateClaimed,
};
