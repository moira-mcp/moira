# Issue triage

Labels describe independent dimensions of an issue. Prefixes make each dimension
searchable and prevent labels with overlapping meanings.

## Status

Every open issue has exactly one `status:*` label. Replace the previous status when
the issue moves; do not accumulate lifecycle labels.

| Label                        | Meaning                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `status:needs-triage`        | A maintainer has not yet decided whether the issue is actionable.                                   |
| `status:waiting-for-author`  | A maintainer requested information, reproduction details, or a concrete use case from the reporter. |
| `status:needs-design`        | The problem is understood, but product, API, security, or architecture design is not accepted yet.  |
| `status:needs-investigation` | The issue is actionable enough to investigate, but its cause or solution is not established.        |
| `status:ready`               | Scope and acceptance are sufficient and the unassigned issue can be claimed.                        |
| `status:in-progress`         | Work is underway; ownership requires one assignee, not this label alone.                            |
| `status:blocked`             | Accepted work is waiting for a named dependency or decision. State that dependency in the issue.    |

When the reporter supplies requested information, remove
`status:waiting-for-author` and triage the issue again. Do not use `status:blocked`
for an untriaged proposal.

## Classification

- Use one `type:*` label: `type:bug`, `type:feature`, `type:chore`, `type:docs`,
  `type:question`, or `type:epic`.
- Add every applicable `component:*` label. Use `component:workflow-engine` for
  runtime orchestration and `component:workflows` for bundled workflow definitions
  and authoring contracts.
- Use `type:epic` when the requested outcome must be decomposed into independently
  deliverable child issues. Child issues use their own concrete type.
- Maintainers assign at most one `priority:*` label after triage. Absence of
  priority means it has not been scheduled, not that it is low priority.
- `good first issue` and `help wanted` describe contribution readiness and do not
  replace type, component, status, or priority.

## Contribution readiness and ownership

Mark an issue `status:ready` only when its scope and acceptance criteria support
independent implementation. Epics must be split first. A ready issue intended for
contributors is unassigned; an assignee means ownership even if a stale label says
otherwise.

Outside contributors reserve work through the exact `/claim` comment documented
in [`CONTRIBUTING.md`](../CONTRIBUTING.md). The automation moves a successful claim
to `status:in-progress`, records one assignee, and maintains a bounded activity
lease. `/release` and inactive-lease expiry return it to unassigned
`status:ready`. Do not manually assign a second contributor to a managed claim.

Manual maintainer ownership remains supported. An assigned in-progress issue
without a trusted bot lease record is left out of automatic expiry. When labels,
assignees, or bot records disagree, fail closed: preserve current work, coordinate
with the assignee, and follow the recovery procedure in `CONTRIBUTING.md` instead
of guessing or removing ownership.

## Closing

Use `resolution:duplicate`, `resolution:invalid`, `resolution:not-planned`, or
`resolution:cannot-reproduce` when they explain why an issue is closed. A merged
implementation is represented by the linked pull request and the closed issue; it
does not need a permanent resolution label.

Do not automatically close an accepted bug or feature merely because maintainers
have not acted on it. Stale automation should be limited to issues waiting on
reporter action. Claim-lease expiry releases ownership but does not close the
issue.

## Triage sequence

1. Confirm the problem and search for duplicates or an existing epic.
2. Ask for missing evidence or a concrete use case when it changes the API or
   acceptance criteria.
3. Set type and components, then choose one current status.
4. Split an epic before marking implementation work `status:ready`.
5. Add priority only after the issue is actionable and compared with the existing
   roadmap.
6. Leave a ready contributor issue unassigned so `/claim` can establish ownership.
