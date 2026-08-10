# Screenshot Validation Guide

Software Development Flow uses screenshot validation only when an approved plan
unit explicitly requires visual evidence and a `step-report.html`. The workflow
definition contains the execution contract; this document explains the resulting
project behavior and is not a runtime prompt dependency.

## Applicability

During planning, mark a unit for screenshot validation when its observable result
cannot be accepted reliably from tests or textual evidence alone. Typical cases
include changed layout, responsive behavior, visual states, or a user-facing flow.

An incidental change to a UI file does not enable screenshots automatically. Plan
review must reject an unjustified omission when visual evidence is necessary. If
that need is discovered only during implementation, architecture review requests a
reviewed plan revision instead of enabling screenshots ad hoc.

## Evidence ownership

The runtime-validation step owns capture and visual assessment:

1. Derive affected scenarios and representative states from the approved unit,
   requirements, project policy, actual diff, and behavior inventory.
2. Use the project's existing browser, authentication, fixture, and capture
   facilities. Do not create permanent capture machinery unless the project needs
   it independently.
3. Capture every required state under the current unit and evidence iteration.
4. Open the actual images with an available visual tool and compare expected with
   observed behavior. File existence or a successful capture command is not a
   visual pass.
5. Record scenarios, image paths, expected and observed behavior, and limitations
   in the current `runtime-validation.md`.

Use stable project-native selectors and deterministic state waits. Do not mask an
unstable scenario with sleeps, forced interaction, blind retries, or increased
timeouts.

## Failure classification

- A reproducible application defect is a repository failure.
- A defect in permanent project-owned capture tooling is a repository failure.
- Unavailable external browser or vision infrastructure is an external blocker.
- Missing capture or unfinished visual inspection is incomplete validation, not a
  routable pass or failure classification.

Repository repair returns through the full stale validation path. External retry
is allowed only after the external state changes.

## Workspace layout

Use deterministic paths under the correlated workspace. A typical layout is:

```text
moira-ws/<workspace>/
└── step-<unit>/
    ├── iteration-<evidence>/
    │   ├── runtime-validation.md
    │   └── screenshots/
    │       ├── initial-state.png
    │       └── completed-state.png
    ├── step-report.html
    └── acceptance.md
```

The exact screenshot names and scenario count follow the approved unit; they are
not fixed workflow metrics.

## Acceptance report

After runtime and conditional expensive checks stabilize, the unit user-review
step creates or regenerates `step-report.html`. No separate report-generation node
or screenshot-status global is used.

The report must be usable from its documented workspace location and include:

- the unit outcome and affected behavior;
- tested and manually verified scenarios;
- exact commands and review outcomes;
- limitations and warnings;
- expected versus observed assessment for every screenshot;
- concise manual-verification instructions;
- explicit PASS, FAIL, and warning states.

It must be a portable self-contained HTML document with embedded styling, no
external runtime dependency, responsive readability, and factual language.
Images should be embedded or referenced by reliable relative paths. Open the final
document and verify its image references before presenting it.

For an approved visual unit, the report is presented in the same substantive turn
as the acceptance request and `skip` is not allowed. Units without an approved
visual obligation do not create screenshot HTML.

## Project-specific commands

Follow the repository's standing instructions. In Moira itself, test commands run
through root `package.json` scripts; do not invoke Playwright or Jest directly.
Reuse the authentication helpers and fixtures documented by the test suite rather
than creating an independent login flow.
